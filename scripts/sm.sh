#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Antigravity Control Center — `sm` CLI Management Menu & Daemon Controller
# ==============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${AGY_SM_INSTALL_DIR:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
ENV_FILE="${INSTALL_DIR}/.sm.env"
SERVICE_NAME="agy-control-center"
PID_FILE="${INSTALL_DIR}/data/service.pid"
LOG_FILE="${INSTALL_DIR}/data/service.log"
BIN_LINK="${SM_BIN_PATH:-/usr/local/bin/sm}"

# Defaults (overridden by .sm.env if present)
HOST="0.0.0.0"
PORT="8787"
AGY_API_TOKEN=""
AGY_CONFIG_DIR="${HOME}/.gemini/config"
BRANCH="main"
RUN_USER="${USER:-$(id -un)}"
RUN_HOME="${HOME}"

load_env() {
  if [[ -f "${ENV_FILE}" ]]; then
    # shellcheck disable=SC1090
    source "${ENV_FILE}"
  fi
  PID_FILE="${INSTALL_DIR}/data/service.pid"
  LOG_FILE="${INSTALL_DIR}/data/service.log"
}

save_env() {
  mkdir -p "${INSTALL_DIR}"
  local tmp_env
  tmp_env="$(mktemp)"
  cat > "${tmp_env}" <<EOF
INSTALL_DIR=${INSTALL_DIR}
REPO_URL=${REPO_URL:-https://github.com/Wangbaofushuai/agy-control-center.git}
BRANCH=${BRANCH:-main}
HOST=${HOST:-0.0.0.0}
PORT=${PORT:-8787}
AGY_API_TOKEN=${AGY_API_TOKEN:-}
AGY_CONFIG_DIR=${AGY_CONFIG_DIR:-${HOME}/.gemini/config}
RUN_USER=${RUN_USER:-$(id -un)}
RUN_HOME=${RUN_HOME:-${HOME}}
EOF
  mv "${tmp_env}" "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
}

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

SUDO=""
if [[ "${EUID:-$(id -u)}" -ne 0 ]] && command -v sudo >/dev/null 2>&1; then
  SUDO="sudo"
fi

use_systemd() {
  [[ -z "${SM_NO_SYSTEMD:-}" ]] \
    && [[ -d /run/systemd/system ]] \
    && command -v systemctl >/dev/null 2>&1 \
    && [[ -f "/etc/systemd/system/${SERVICE_NAME}.service" ]]
}

is_running() {
  if use_systemd; then
    systemctl is-active --quiet "${SERVICE_NAME}"
    return $?
  fi
  if [[ -f "${PID_FILE}" ]]; then
    local pid
    pid="$(cat "${PID_FILE}" 2>/dev/null || true)"
    if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
      return 0
    fi
  fi
  return 1
}

get_pid() {
  if use_systemd; then
    systemctl show -p MainPID --value "${SERVICE_NAME}" 2>/dev/null || echo "-"
    return
  fi
  if [[ -f "${PID_FILE}" ]]; then
    cat "${PID_FILE}" 2>/dev/null || echo "-"
  else
    echo "-"
  fi
}

get_git_version() {
  if [[ -d "${INSTALL_DIR}/.git" ]]; then
    local hash branch
    hash="$(git -C "${INSTALL_DIR}" rev-parse --short HEAD 2>/dev/null || echo "unknown")"
    branch="$(git -C "${INSTALL_DIR}" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "${BRANCH}")"
    echo "${branch}@${hash}"
  else
    echo "local"
  fi
}

cmd_start() {
  load_env
  if is_running; then
    printf "${YELLOW}服务已在运行中 (PID: %s, 端口: %s)${NC}\n" "$(get_pid)" "${PORT}"
    return 0
  fi

  if use_systemd; then
    ${SUDO} systemctl start "${SERVICE_NAME}"
  else
    mkdir -p "${INSTALL_DIR}/data"
    (
      cd "${INSTALL_DIR}"
      AGY_API_TOKEN="${AGY_API_TOKEN}" \
      AGY_CONFIG_DIR="${AGY_CONFIG_DIR}" \
      PYTHONUNBUFFERED=1 \
      nohup python3 -m manager.web_server \
        --host "${HOST}" \
        --port "${PORT}" \
        --config-dir "${AGY_CONFIG_DIR}" \
        >> "${LOG_FILE}" 2>&1 &
      echo $! > "${PID_FILE}"
    )
  fi

  local i
  for i in $(seq 1 15); do
    if python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:${PORT}/api/health', timeout=1)" >/dev/null 2>&1; then
      printf "${GREEN}服务启动成功！${NC} (PID: %s, 监听 %s:%s)\n" "$(get_pid)" "${HOST}" "${PORT}"
      return 0
    fi
    sleep 0.25
  done
  printf "${YELLOW}已发出启动命令，请用 sm logs 检查运行状态。${NC}\n"
}

cmd_stop() {
  load_env
  if ! is_running; then
    printf "${YELLOW}服务当前未运行。${NC}\n"
    rm -f "${PID_FILE}"
    return 0
  fi

  if use_systemd; then
    ${SUDO} systemctl stop "${SERVICE_NAME}"
  else
    local pid
    pid="$(cat "${PID_FILE}" 2>/dev/null || true)"
    if [[ -n "${pid}" ]]; then
      kill "${pid}" 2>/dev/null || true
      local i
      for i in $(seq 1 15); do
        kill -0 "${pid}" 2>/dev/null || break
        sleep 0.2
      done
      kill -9 "${pid}" 2>/dev/null || true
    fi
    rm -f "${PID_FILE}"
  fi
  printf "${GREEN}服务已停止。${NC}\n"
}

cmd_restart() {
  cmd_stop
  cmd_start
}

cmd_toggle() {
  if is_running; then
    cmd_stop
  else
    cmd_start
  fi
}

cmd_status() {
  load_env
  local status_str mode_str pub_ip lan_ip
  if is_running; then
    status_str="${GREEN}● 运行中${NC} (PID: $(get_pid))"
  else
    status_str="${RED}○ 已停止${NC}"
  fi
  mode_str="$(use_systemd && echo "systemd" || echo "nohup")"
  pub_ip="$(curl -fsS --max-time 2 https://api.ipify.org 2>/dev/null || true)"
  lan_ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"

  printf "\n${BOLD}Antigravity Control Center 状态${NC}\n"
  printf "  运行状态  : %b  [%s]\n" "${status_str}" "${mode_str}"
  printf "  代码版本  : %s\n" "$(get_git_version)"
  printf "  安装目录  : %s\n" "${INSTALL_DIR}"
  printf "  监听地址  : %s:%s\n" "${HOST}" "${PORT}"
  printf "  API Token : %s\n" "$([[ -n "${AGY_API_TOKEN}" ]] && echo "已启用" || echo "未设置（免密）")"
  if [[ -n "${pub_ip}" ]]; then
    printf "  公网面板  : ${CYAN}http://%s:%s${NC}\n" "${pub_ip}" "${PORT}"
    printf "  插件下载  : ${CYAN}http://%s:%s/api/extension.zip${NC}\n" "${pub_ip}" "${PORT}"
  fi
  if [[ -n "${lan_ip}" ]]; then
    printf "  内网面板  : http://%s:%s\n" "${lan_ip}" "${PORT}"
  fi
  printf "  本机面板  : http://127.0.0.1:%s\n\n" "${PORT}"
}

cmd_update() {
  load_env
  if [[ ! -d "${INSTALL_DIR}/.git" ]]; then
    printf "${RED}错误：${INSTALL_DIR} 不是 Git 仓库，无法自动更新。${NC}\n"
    return 1
  fi
  local before after
  before="$(git -C "${INSTALL_DIR}" rev-parse --short HEAD 2>/dev/null || echo "unknown")"
  printf "${CYAN}正在从 Git 仓库同步最新版本 (%s)...${NC}\n" "${BRANCH}"
  git -C "${INSTALL_DIR}" fetch origin "${BRANCH}" --depth 1
  git -C "${INSTALL_DIR}" reset --hard "origin/${BRANCH}"
  chmod +x \
    "${INSTALL_DIR}/start.sh" \
    "${INSTALL_DIR}/install.sh" \
    "${INSTALL_DIR}/scripts/sm.sh" \
    "${INSTALL_DIR}/plugins/agy-control-center/scripts/mcp_server.py"
  after="$(git -C "${INSTALL_DIR}" rev-parse --short HEAD 2>/dev/null || echo "unknown")"

  if [[ "${before}" == "${after}" ]]; then
    printf "${GREEN}当前已是最新版本 (%s)。${NC}\n" "${after}"
  else
    printf "${GREEN}更新完成：%s -> %s${NC}\n" "${before}" "${after}"
  fi
  printf "${CYAN}正在重启后台服务以生效...${NC}\n"
  cmd_restart
}

cmd_logs() {
  load_env
  if use_systemd; then
    printf "${DIM}按 Ctrl+C 退出实时日志${NC}\n"
    ${SUDO} journalctl -u "${SERVICE_NAME}" -n 60 -f
  else
    if [[ ! -f "${LOG_FILE}" ]]; then
      printf "${YELLOW}暂无日志文件: %s${NC}\n" "${LOG_FILE}"
      return 0
    fi
    printf "${DIM}最近 60 行日志 (%s)，按 Ctrl+C 退出${NC}\n" "${LOG_FILE}"
    tail -n 60 -f "${LOG_FILE}"
  fi
}

cmd_config_port_token() {
  load_env
  printf "当前端口: ${BOLD}%s${NC}，当前 Token: ${BOLD}%s${NC}\n" \
    "${PORT}" "$([[ -n "${AGY_API_TOKEN}" ]] && echo "已设置" || echo "未设置")"
  read -r -p "输入新端口 (回车保持 ${PORT}): " new_port || true
  if [[ -n "${new_port}" ]]; then
    if ! [[ "${new_port}" =~ ^[0-9]+$ ]] || (( new_port < 1 || new_port > 65535 )); then
      printf "${RED}无效端口号: %s${NC}\n" "${new_port}"
      return 1
    fi
    PORT="${new_port}"
  fi
  read -r -p "输入新 API Token (回车保持不变，输入 '-' 清空为免密): " new_token || true
  if [[ "${new_token}" == "-" ]]; then
    AGY_API_TOKEN=""
  elif [[ -n "${new_token}" ]]; then
    AGY_API_TOKEN="${new_token}"
  fi
  save_env
  printf "${GREEN}配置已保存，正在重启服务...${NC}\n"
  cmd_restart
}

cmd_uninstall() {
  load_env
  printf "${RED}${BOLD}警告：即将卸载 Antigravity Control Center！${NC}\n"
  printf "  将删除：服务单元、%s、%s\n" "${BIN_LINK}" "${INSTALL_DIR}"
  printf "  将保留：~/.gemini/config/ 及所有项目内的 .agents/ 配置（绝不误删）\n"
  read -r -p "确认卸载请输入 yes: " confirm || true
  if [[ "${confirm}" != "yes" ]]; then
    printf "已取消卸载。\n"
    return 0
  fi

  cmd_stop || true
  if use_systemd; then
    ${SUDO} systemctl disable "${SERVICE_NAME}" >/dev/null 2>&1 || true
    ${SUDO} rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
    ${SUDO} systemctl daemon-reload
  fi
  ${SUDO} rm -f "${BIN_LINK}"
  if [[ -d "${INSTALL_DIR}" && "${INSTALL_DIR}" != "/" && "${INSTALL_DIR}" != "${HOME}" ]]; then
    ${SUDO} rm -rf "${INSTALL_DIR}"
  fi
  printf "${GREEN}卸载完成！你的 Antigravity 配置完好保留。${NC}\n"
}

show_menu() {
  while true; do
    load_env
    local status_badge toggle_label
    if is_running; then
      status_badge="${GREEN}● 运行中${NC} (PID: $(get_pid) | 端口: ${PORT})"
      toggle_label="关闭服务"
    else
      status_badge="${RED}○ 已停止${NC} (端口: ${PORT})"
      toggle_label="启动服务"
    fi

    echo ""
    printf "${BOLD}${CYAN}╔══════════════════════════════════════════════════════╗${NC}\n"
    printf "${BOLD}${CYAN}║   Antigravity Control Center 管理菜单 (sm)           ║${NC}\n"
    printf "${BOLD}${CYAN}╚══════════════════════════════════════════════════════╝${NC}\n"
    printf "  状态: %b  |  版本: %s\n" "${status_badge}" "$(get_git_version)"
    printf "  目录: %s\n" "${INSTALL_DIR}"
    echo "────────────────────────────────────────────────────────"
    printf "  ${BOLD}1.${NC} %s（启动 / 关闭）\n" "${toggle_label}"
    printf "  ${BOLD}2.${NC} 重启服务\n"
    printf "  ${BOLD}3.${NC} 更新版本（同步 GitHub 最新代码并重启）\n"
    printf "  ${BOLD}4.${NC} 查看详细状态与远程访问地址\n"
    printf "  ${BOLD}5.${NC} 查看实时运行日志\n"
    printf "  ${BOLD}6.${NC} 修改端口 / API Token\n"
    printf "  ${BOLD}7.${NC} 卸载服务\n"
    printf "  ${BOLD}0.${NC} 退出\n"
    echo "────────────────────────────────────────────────────────"
    read -r -p "请输入选项 [0-7]: " choice || break
    echo ""
    case "${choice}" in
      1) cmd_toggle ;;
      2) cmd_restart ;;
      3) cmd_update ;;
      4) cmd_status ;;
      5) cmd_logs ;;
      6) cmd_config_port_token ;;
      7) cmd_uninstall; break ;;
      0|q|Q) break ;;
      *) printf "${RED}无效选项，请输入 0-7${NC}\n" ;;
    esac
  done
}

main() {
  load_env
  local sub="${1:-}"
  case "${sub}" in
    "")          show_menu ;;
    start)       cmd_start ;;
    stop)        cmd_stop ;;
    restart)     cmd_restart ;;
    toggle)      cmd_toggle ;;
    status)      cmd_status ;;
    update)      cmd_update ;;
    logs)        cmd_logs ;;
    config)      cmd_config_port_token ;;
    uninstall)   cmd_uninstall ;;
    -h|--help|help)
      echo "用法: sm [start|stop|restart|toggle|status|update|logs|config|uninstall]"
      echo "不带参数运行 'sm' 将打开交互式管理菜单。"
      ;;
    *)
      printf "${RED}未知子命令: %s${NC}\n" "${sub}"
      echo "用法: sm [start|stop|restart|toggle|status|update|logs|config|uninstall]"
      exit 1
      ;;
  esac
}

main "$@"

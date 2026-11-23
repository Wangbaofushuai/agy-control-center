#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Antigravity Control Center (MCP & Skills) — One-Click Installer
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Wangbaofushuai/agy-control-center/main/install.sh | bash
# Optional env overrides:
#   INSTALL_DIR=/opt/agy-control-center HOST=0.0.0.0 PORT=8787 AGY_API_TOKEN="" bash install.sh
# ==============================================================================

REPO_URL="${REPO_URL:-https://github.com/Wangbaofushuai/agy-control-center.git}"
BRANCH="${BRANCH:-main}"
INSTALL_DIR="${INSTALL_DIR:-/opt/agy-control-center}"
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8787}"
AGY_API_TOKEN="${AGY_API_TOKEN:-}"
SERVICE_NAME="agy-control-center"
BIN_LINK="${SM_BIN_PATH:-/usr/local/bin/sm}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()  { printf "${CYAN}[INFO]${NC} %s\n" "$*"; }
ok()    { printf "${GREEN}[OK]${NC} %s\n" "$*"; }
warn()  { printf "${YELLOW}[WARN]${NC} %s\n" "$*"; }
fail()  { printf "${RED}[ERROR]${NC} %s\n" "$*" >&2; exit 1; }

SUDO=""
if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  else
    warn "当前非 root 且未找到 sudo，将回退到用户目录安装。"
    INSTALL_DIR="${HOME}/.local/share/agy-control-center"
    BIN_LINK="${HOME}/.local/bin/sm"
  fi
fi

# Resolve target user whose ~/.gemini/config should be managed
TARGET_USER="${SUDO_USER:-$(id -un)}"
TARGET_HOME="$(eval echo "~${TARGET_USER}" 2>/dev/null || echo "${HOME}")"
CONFIG_DIR="${AGY_CONFIG_DIR:-${TARGET_HOME}/.gemini/config}"

check_deps() {
  info "检查运行依赖 (python3 / git)..."
  command -v git >/dev/null 2>&1 || fail "未检测到 git，请先安装 git（如 apt install -y git）"
  command -v python3 >/dev/null 2>&1 || fail "未检测到 python3，请先安装 Python 3.10+"
  python3 - <<'PY' || fail "Python 版本过低，需要 Python 3.10 及以上"
import sys
raise SystemExit(0 if sys.version_info >= (3, 10) else 1)
PY
  ok "依赖检测通过：$(python3 --version)，$(git --version)"
}

install_or_update_repo() {
  if [[ -d "${INSTALL_DIR}/.git" ]]; then
    info "检测到已有安装目录 ${INSTALL_DIR}，正在同步最新代码..."
    ${SUDO} git -c "safe.directory=${INSTALL_DIR}" -C "${INSTALL_DIR}" fetch origin "${BRANCH}" --depth 1
    ${SUDO} git -c "safe.directory=${INSTALL_DIR}" -C "${INSTALL_DIR}" checkout "${BRANCH}" 2>/dev/null || true
    ${SUDO} git -c "safe.directory=${INSTALL_DIR}" -C "${INSTALL_DIR}" reset --hard "origin/${BRANCH}"
  else
    info "正在拉取代码到 ${INSTALL_DIR}..."
    ${SUDO} mkdir -p "$(dirname "${INSTALL_DIR}")"
    if [[ -d "${INSTALL_DIR}" && -n "$(ls -A "${INSTALL_DIR}" 2>/dev/null || true)" ]]; then
      fail "目录 ${INSTALL_DIR} 已存在且非空，请指定其他 INSTALL_DIR 或先清理该目录"
    fi
    ${SUDO} git clone --depth 1 --branch "${BRANCH}" "${REPO_URL}" "${INSTALL_DIR}"
  fi

  ${SUDO} chmod +x \
    "${INSTALL_DIR}/start.sh" \
    "${INSTALL_DIR}/install.sh" \
    "${INSTALL_DIR}/scripts/sm.sh" \
    "${INSTALL_DIR}/plugins/agy-control-center/scripts/mcp_server.py"
  ${SUDO} mkdir -p "${INSTALL_DIR}/data"
  if [[ -n "${SUDO}" || "${EUID:-$(id -u)}" -eq 0 ]]; then
    ${SUDO} chown -R "${TARGET_USER}:${TARGET_USER}" "${INSTALL_DIR}" 2>/dev/null || true
  fi
  ok "代码已就绪：${INSTALL_DIR}"
}

write_env_file() {
  local env_file="${INSTALL_DIR}/.sm.env"
  info "写入服务配置 ${env_file}..."
  local tmp_env
  tmp_env="$(mktemp)"
  cat > "${tmp_env}" <<EOF
INSTALL_DIR=${INSTALL_DIR}
REPO_URL=${REPO_URL}
BRANCH=${BRANCH}
HOST=${HOST}
PORT=${PORT}
AGY_API_TOKEN=${AGY_API_TOKEN}
AGY_CONFIG_DIR=${CONFIG_DIR}
RUN_USER=${TARGET_USER}
RUN_HOME=${TARGET_HOME}
EOF
  ${SUDO} mv "${tmp_env}" "${env_file}"
  ${SUDO} chmod 600 "${env_file}"
  if [[ -n "${SUDO}" || "${EUID:-$(id -u)}" -eq 0 ]]; then
    ${SUDO} chown "${TARGET_USER}:${TARGET_USER}" "${env_file}" 2>/dev/null || true
  fi
}

install_sm_command() {
  info "注册快捷管理命令 sm -> ${BIN_LINK}..."
  ${SUDO} mkdir -p "$(dirname "${BIN_LINK}")"
  local tmp_bin
  tmp_bin="$(mktemp)"
  cat > "${tmp_bin}" <<EOF
#!/usr/bin/env bash
export AGY_SM_INSTALL_DIR="${INSTALL_DIR}"
exec "${INSTALL_DIR}/scripts/sm.sh" "\$@"
EOF
  ${SUDO} mv "${tmp_bin}" "${BIN_LINK}"
  ${SUDO} chmod 755 "${BIN_LINK}"
  ok "已安装全局快捷命令：sm"
}

has_systemd() {
  [[ -z "${SM_NO_SYSTEMD:-}" ]] && [[ -d /run/systemd/system ]] && command -v systemctl >/dev/null 2>&1
}

setup_systemd_service() {
  local unit_file="/etc/systemd/system/${SERVICE_NAME}.service"
  info "配置 systemd 后台守护服务 (${unit_file})..."
  local tmp_unit
  tmp_unit="$(mktemp)"
  cat > "${tmp_unit}" <<EOF
[Unit]
Description=Antigravity Control Center (MCP & Skills Manager)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${TARGET_USER}
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${INSTALL_DIR}/.sm.env
Environment=HOME=${TARGET_HOME}
Environment=PYTHONUNBUFFERED=1
ExecStart=/usr/bin/env python3 -m manager.web_server --host \${HOST} --port \${PORT} --config-dir \${AGY_CONFIG_DIR}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
  ${SUDO} mv "${tmp_unit}" "${unit_file}"
  ${SUDO} chmod 644 "${unit_file}"
  ${SUDO} systemctl daemon-reload
  ${SUDO} systemctl enable "${SERVICE_NAME}" >/dev/null 2>&1 || true
  ${SUDO} systemctl restart "${SERVICE_NAME}"
  ok "systemd 服务已启用并后台运行"
}

check_port_conflict() {
  # Stop our own existing service first if upgrading in place
  if has_systemd && [[ -f "/etc/systemd/system/${SERVICE_NAME}.service" ]]; then
    ${SUDO} systemctl stop "${SERVICE_NAME}" 2>/dev/null || true
  elif [[ -x "${INSTALL_DIR}/scripts/sm.sh" ]]; then
    ${SUDO} env AGY_SM_INSTALL_DIR="${INSTALL_DIR}" "${INSTALL_DIR}/scripts/sm.sh" stop >/dev/null 2>&1 || true
  fi

  if python3 - "${PORT}" <<'PY'
import socket, sys
port = int(sys.argv[1])
with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
    s.settimeout(0.5)
    raise SystemExit(0 if s.connect_ex(("127.0.0.1", port)) == 0 else 1)
PY
  then
    fail "端口 ${PORT} 已被其他进程占用！请先停止占用该端口的程序（如之前手动启动的 start.sh），或改用其他端口安装：curl -fsSL ... | PORT=8788 bash"
  fi
}

start_service() {
  check_port_conflict
  if has_systemd && [[ "${EUID:-$(id -u)}" -eq 0 || -n "${SUDO}" ]]; then
    setup_systemd_service
  else
    warn "当前环境不支持 systemd，使用后台 nohup 守护方式启动..."
    AGY_SM_INSTALL_DIR="${INSTALL_DIR}" "${INSTALL_DIR}/scripts/sm.sh" restart
  fi
}

wait_for_health() {
  info "等待服务启动健康检查 (http://127.0.0.1:${PORT}/api/health)..."
  local i
  for i in $(seq 1 20); do
    if has_systemd && [[ -f "/etc/systemd/system/${SERVICE_NAME}.service" ]]; then
      if ! systemctl is-active --quiet "${SERVICE_NAME}"; then
        sleep 0.3
        continue
      fi
    fi
    if python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:${PORT}/api/health', timeout=1)" >/dev/null 2>&1; then
      ok "服务健康检查通过！"
      return 0
    fi
    sleep 0.3
  done
  warn "服务未能通过健康检查，请执行 'sm status' 或 'sm logs' 查看详情。"
}

print_summary() {
  local pub_ip lan_ip
  pub_ip="$(curl -fsS --max-time 2 https://api.ipify.org 2>/dev/null || curl -fsS --max-time 2 https://ifconfig.me 2>/dev/null || true)"
  lan_ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"

  echo ""
  printf "${GREEN}${BOLD}======================================================================${NC}\n"
  printf "${GREEN}${BOLD}  Antigravity Control Center 安装并启动成功！${NC}\n"
  printf "${GREEN}${BOLD}======================================================================${NC}\n"
  printf "  安装目录      : %s\n" "${INSTALL_DIR}"
  printf "  Antigravity   : %s\n" "${CONFIG_DIR}"
  if [[ -n "${pub_ip}" ]]; then
    printf "  公网访问地址  : ${CYAN}http://%s:%s${NC}\n" "${pub_ip}" "${PORT}"
    printf "  浏览器插件下载: ${CYAN}http://%s:%s/api/extension.zip${NC}\n" "${pub_ip}" "${PORT}"
  fi
  if [[ -n "${lan_ip}" ]]; then
    printf "  内网访问地址  : http://%s:%s\n" "${lan_ip}" "${PORT}"
  fi
  printf "  本机访问地址  : http://127.0.0.1:%s\n" "${PORT}"
  if [[ -n "${AGY_API_TOKEN}" ]]; then
    printf "  API Token     : 已启用（详见 %s/.sm.env）\n" "${INSTALL_DIR}"
  else
    printf "  API Token     : 未设置（免密直连，可在 sm 菜单中随时开启）\n"
  fi
  echo ""
  printf "  ${BOLD}快捷管理菜单${NC}  : 终端随时输入 ${YELLOW}sm${NC} 调出交互菜单\n"
  printf "  常用子命令    : sm status | sm restart | sm update | sm logs | sm uninstall\n"
  printf "${YELLOW}  提醒：如无法公网访问，请在云服务器安全组/防火墙放行 TCP %s 端口。${NC}\n" "${PORT}"
  printf "${GREEN}${BOLD}======================================================================${NC}\n"
}

main() {
  check_deps
  install_or_update_repo
  write_env_file
  install_sm_command
  start_service
  wait_for_health
  print_summary
}

main "$@"

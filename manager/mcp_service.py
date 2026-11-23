"""MCP server configuration management and smart JSON snippet parsing."""

from __future__ import annotations

import json
import os
import re
import shlex
import shutil
from pathlib import Path
from typing import Any

from .config_store import ConfigStore

VALID_NAME_RE = re.compile(r"^[A-Za-z0-9._-]+$")

SYSTEM_FALLBACK_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"


def resolve_stdio_command(
    command: str,
    *,
    system_path: str | None = None,
    user_path: str | None = None,
    extra_dirs: list[Path] | None = None,
) -> tuple[str, str | None]:
    """Check if a stdio command is reachable by headless Antigravity daemons.

    Headless Antigravity processes typically only inherit minimal system PATH
    (/usr/local/bin, /usr/bin, /bin, etc.), NOT interactive shell PATH entries
    such as ~/.local/bin or ~/.nvm/.../bin. Therefore, any command that lives
    outside standard system directories is ALWAYS resolved to its absolute path.
    """
    cmd = command.strip()
    if not cmd:
        return cmd, None

    # Explicit relative/absolute path
    if "/" in cmd:
        p = Path(cmd).expanduser()
        if p.is_file() and os.access(p, os.X_OK):
            return str(p), None
        return cmd, f"未在服务器上找到可执行文件 `{cmd}`，请确认路径正确并具备执行权限"

    # 1. If available in minimal system PATH (/usr/bin, /usr/local/bin, etc.), bare name is safe
    sys_path = system_path if system_path is not None else SYSTEM_FALLBACK_PATH
    if shutil.which(cmd, path=sys_path):
        return cmd, None

    # 2. Otherwise search interactive shell PATH first, then common user bin dirs
    u_path = user_path if user_path is not None else os.environ.get("PATH", "")
    found_in_user_path = shutil.which(cmd, path=u_path) if u_path else None
    if found_in_user_path:
        return (
            found_in_user_path,
            f"检测到 `{cmd}` 位于用户目录而非系统默认 PATH，已自动替换为绝对路径 `{found_in_user_path}` 以确保 Antigravity 后台进程可正常启动",
        )

    search_dirs: list[Path] = []
    if extra_dirs is not None:
        search_dirs.extend(extra_dirs)
    else:
        home = Path.home()
        search_dirs.extend(
            [
                home / ".local" / "bin",
                home / ".cargo" / "bin",
                home / ".bun" / "bin",
                home / ".local" / "share" / "pnpm",
                home / ".pyenv" / "shims",
            ]
        )
        nvm_versions = home / ".nvm" / "versions" / "node"
        if nvm_versions.is_dir():
            for ver_dir in sorted(nvm_versions.iterdir(), reverse=True):
                bin_dir = ver_dir / "bin"
                if bin_dir.is_dir():
                    search_dirs.append(bin_dir)

    for directory in search_dirs:
        candidate = directory / cmd
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return (
                str(candidate),
                f"检测到 `{cmd}` 不在系统默认 PATH 中，已自动替换为绝对路径 `{candidate}` 以确保 Antigravity 可正常拉起",
            )

    return cmd, f"服务器系统 PATH 与常见用户目录中均未找到 `{cmd}`，请确认是否已安装或手动填写绝对路径"


class McpService:
    """Reads, parses, validates, and writes Antigravity mcp_config.json files."""

    def __init__(self, store: ConfigStore) -> None:
        self.store = store

    def list_servers(self) -> dict[str, Any]:
        projects = self.store.discover_projects()
        items: list[dict[str, Any]] = []

        # Global servers
        global_servers = self._read_mcp_map(self.store.global_mcp_path)
        for name, cfg in global_servers.items():
            items.append(
                self._format_server_item(
                    name=name,
                    cfg=cfg,
                    scope="global",
                    project_path=None,
                    project_name="所有项目（全局）",
                    config_path=self.store.global_mcp_path,
                )
            )

        # Project servers (primary: .agents/plugins/project-mcp/mcp_config.json, plus legacy .agents/mcp_config.json)
        for proj in projects:
            if not proj.get("exists"):
                continue
            mcp_path = self.store.project_mcp_path(proj["path"])
            proj_servers = self._read_mcp_map(mcp_path)
            seen: set[str] = set()
            for name, cfg in proj_servers.items():
                seen.add(name)
                items.append(
                    self._format_server_item(
                        name=name,
                        cfg=cfg,
                        scope="project",
                        project_path=proj["path"],
                        project_name=proj["name"],
                        config_path=mcp_path,
                    )
                )
            legacy_path = self.store.legacy_project_mcp_path(proj["path"])
            for name, cfg in self._read_mcp_map(legacy_path).items():
                if name in seen:
                    continue
                items.append(
                    self._format_server_item(
                        name=name,
                        cfg=cfg,
                        scope="project",
                        project_path=proj["path"],
                        project_name=proj["name"],
                        config_path=legacy_path,
                    )
                )

        return {
            "servers": items,
            "globalConfigPath": str(self.store.global_mcp_path),
            "projects": projects,
        }

    def save_server(
        self,
        *,
        scope: str,
        project_path: str | None,
        name: str,
        config: dict[str, Any],
        original_name: str | None = None,
        original_scope: str | None = None,
        original_project_path: str | None = None,
    ) -> dict[str, Any]:
        clean_name = name.strip()
        if not clean_name:
            raise ValueError("服务器名称不能为空")
        if not VALID_NAME_RE.match(clean_name):
            raise ValueError("服务器名称仅支持字母、数字、点、下划线和连字符")

        norm_scope, norm_project = self.store.resolve_scope_target(scope, project_path)
        target_path = (
            self.store.global_mcp_path
            if norm_scope == "global"
            else self.store.project_mcp_path(norm_project)  # type: ignore[arg-type]
        )

        # Preserve unknown extra properties if editing existing entry
        existing_entry: dict[str, Any] = {}
        if original_name and original_scope:
            orig_scope, orig_proj = self.store.resolve_scope_target(
                original_scope, original_project_path
            )
            orig_path = (
                self.store.global_mcp_path
                if orig_scope == "global"
                else self.store.project_mcp_path(orig_proj)  # type: ignore[arg-type]
            )
            orig_map = self._read_mcp_map(orig_path)
            if original_name not in orig_map and orig_scope == "project" and orig_proj is not None:
                orig_map = self._read_mcp_map(self.store.legacy_project_mcp_path(orig_proj))
            if original_name in orig_map and isinstance(orig_map[original_name], dict):
                existing_entry = dict(orig_map[original_name])

        normalized_entry, warnings = self.normalize_server_config(config, preserve_from=existing_entry)

        # Remove old entry if renamed or moved across scopes
        if original_name and original_scope:
            orig_scope, orig_proj = self.store.resolve_scope_target(
                original_scope, original_project_path
            )
            orig_path = (
                self.store.global_mcp_path
                if orig_scope == "global"
                else self.store.project_mcp_path(orig_proj)  # type: ignore[arg-type]
            )
            if orig_path != target_path or original_name != clean_name:
                orig_doc = self._read_mcp_doc(orig_path)
                orig_servers = orig_doc.setdefault("mcpServers", {})
                if original_name in orig_servers:
                    del orig_servers[original_name]
                    self.store.write_json_atomic(orig_path, orig_doc)
            if orig_scope == "project" and orig_proj is not None:
                self._remove_from_legacy_project_mcp(orig_proj, original_name)

        target_doc = self._read_mcp_doc(target_path)
        target_servers = target_doc.setdefault("mcpServers", {})
        target_servers[clean_name] = normalized_entry
        self._write_target_mcp_doc(norm_scope, norm_project, target_path, target_doc)
        if norm_scope == "project" and norm_project is not None:
            self._remove_from_legacy_project_mcp(norm_project, clean_name)

        return {
            "saved": self._format_server_item(
                name=clean_name,
                cfg=normalized_entry,
                scope=norm_scope,
                project_path=str(norm_project) if norm_project else None,
                project_name=norm_project.name if norm_project else "所有项目（全局）",
                config_path=target_path,
            ),
            "warnings": warnings,
        }

    def toggle_server(
        self, scope: str, project_path: str | None, name: str, enabled: bool
    ) -> dict[str, Any]:
        norm_scope, norm_project = self.store.resolve_scope_target(scope, project_path)
        target_path = (
            self.store.global_mcp_path
            if norm_scope == "global"
            else self.store.project_mcp_path(norm_project)  # type: ignore[arg-type]
        )
        doc = self._read_mcp_doc(target_path)
        servers = doc.setdefault("mcpServers", {})
        if name not in servers and norm_scope == "project" and norm_project is not None:
            legacy_map = self._read_mcp_map(self.store.legacy_project_mcp_path(norm_project))
            if name in legacy_map:
                servers[name] = legacy_map[name]
                self._remove_from_legacy_project_mcp(norm_project, name)
        if name not in servers or not isinstance(servers[name], dict):
            raise ValueError(f"未找到 MCP 服务器: {name}")

        entry = dict(servers[name])
        if enabled:
            entry.pop("disabled", None)
        else:
            entry["disabled"] = True
        servers[name] = entry
        self._write_target_mcp_doc(norm_scope, norm_project, target_path, doc)

        return self._format_server_item(
            name=name,
            cfg=entry,
            scope=norm_scope,
            project_path=str(norm_project) if norm_project else None,
            project_name=norm_project.name if norm_project else "所有项目（全局）",
            config_path=target_path,
        )

    def delete_server(self, scope: str, project_path: str | None, name: str) -> bool:
        norm_scope, norm_project = self.store.resolve_scope_target(scope, project_path)
        target_path = (
            self.store.global_mcp_path
            if norm_scope == "global"
            else self.store.project_mcp_path(norm_project)  # type: ignore[arg-type]
        )
        doc = self._read_mcp_doc(target_path)
        servers = doc.get("mcpServers", {})
        removed = False
        if isinstance(servers, dict) and name in servers:
            del servers[name]
            doc["mcpServers"] = servers
            self._write_target_mcp_doc(norm_scope, norm_project, target_path, doc)
            removed = True
        if norm_scope == "project" and norm_project is not None:
            if self._remove_from_legacy_project_mcp(norm_project, name):
                removed = True
        return removed

    def get_raw_config(self, scope: str, project_path: str | None) -> dict[str, Any]:
        norm_scope, norm_project = self.store.resolve_scope_target(scope, project_path)
        target_path = (
            self.store.global_mcp_path
            if norm_scope == "global"
            else self.store.project_mcp_path(norm_project)  # type: ignore[arg-type]
        )
        doc = self._read_mcp_doc(target_path)
        return {
            "path": str(target_path),
            "exists": target_path.exists(),
            "content": json.dumps(doc, ensure_ascii=False, indent=2) + "\n",
        }

    def save_raw_config(self, scope: str, project_path: str | None, raw_json: str) -> dict[str, Any]:
        norm_scope, norm_project = self.store.resolve_scope_target(scope, project_path)
        target_path = (
            self.store.global_mcp_path
            if norm_scope == "global"
            else self.store.project_mcp_path(norm_project)  # type: ignore[arg-type]
        )
        parsed = self._loads_lenient_json(raw_json)
        if not isinstance(parsed, dict):
            raise ValueError("mcp_config.json 根节点必须是 JSON 对象")
        if "mcpServers" not in parsed or not isinstance(parsed["mcpServers"], dict):
            raise ValueError("mcp_config.json 必须包含对象字段 mcpServers")
        self._write_target_mcp_doc(norm_scope, norm_project, target_path, parsed)
        return {
            "path": str(target_path),
            "serverCount": len(parsed["mcpServers"]),
        }

    def parse_json_snippet(self, raw_text: str) -> dict[str, Any]:
        """Parse MCP JSON from Antigravity, Claude, Cursor, or OpenCode formats."""
        data = self._loads_lenient_json(raw_text)
        if not isinstance(data, dict):
            raise ValueError("JSON 片段必须是对象（例如包含 mcpServers 或单个服务器配置）")

        candidates: dict[str, dict[str, Any]] = {}
        warnings: list[str] = []

        if isinstance(data.get("mcpServers"), dict):
            for key, val in data["mcpServers"].items():
                if isinstance(val, dict):
                    candidates[str(key)] = val
        elif isinstance(data.get("mcp"), dict):
            for key, val in data["mcp"].items():
                if isinstance(val, dict):
                    candidates[str(key)] = val
        elif isinstance(data.get("servers"), dict):
            for key, val in data["servers"].items():
                if isinstance(val, dict):
                    candidates[str(key)] = val
        elif self._looks_like_server_config(data):
            inferred_name = str(data.get("name") or self._infer_server_name(data))
            candidates[inferred_name] = data
        else:
            # Named map without wrapper: { "postgres": { "command": "npx", ... } }
            for key, val in data.items():
                if isinstance(val, dict) and self._looks_like_server_config(val):
                    candidates[str(key)] = val

        if not candidates:
            raise ValueError(
                "未识别到有效的 MCP 服务器配置。请粘贴包含 mcpServers、command 或 url/serverUrl 的 JSON 片段。"
            )

        parsed_servers: list[dict[str, Any]] = []
        for raw_name, raw_cfg in candidates.items():
            clean_name = re.sub(r"[^A-Za-z0-9._-]+", "-", raw_name.strip()).strip("-") or "mcp-server"
            normalized, entry_warnings = self.normalize_server_config(raw_cfg)
            warnings.extend(f"[{clean_name}] {w}" for w in entry_warnings)
            parsed_servers.append(
                {
                    "name": clean_name,
                    "transport": "http" if "serverUrl" in normalized else "stdio",
                    "enabled": not bool(normalized.get("disabled", False)),
                    "config": normalized,
                }
            )

        return {
            "servers": parsed_servers,
            "warnings": warnings,
        }

    def import_json_snippet(
        self,
        *,
        scope: str,
        project_path: str | None,
        raw_text: str,
        overwrite: bool = True,
    ) -> dict[str, Any]:
        parsed = self.parse_json_snippet(raw_text)
        norm_scope, norm_project = self.store.resolve_scope_target(scope, project_path)
        target_path = (
            self.store.global_mcp_path
            if norm_scope == "global"
            else self.store.project_mcp_path(norm_project)  # type: ignore[arg-type]
        )

        doc = self._read_mcp_doc(target_path)
        servers = doc.setdefault("mcpServers", {})

        imported: list[str] = []
        skipped: list[str] = []
        for item in parsed["servers"]:
            name = item["name"]
            if name in servers and not overwrite:
                skipped.append(name)
                continue
            servers[name] = item["config"]
            imported.append(name)

        self._write_target_mcp_doc(norm_scope, norm_project, target_path, doc)
        if norm_scope == "project" and norm_project is not None:
            for name in imported:
                self._remove_from_legacy_project_mcp(norm_project, name)
        return {
            "imported": imported,
            "skipped": skipped,
            "warnings": parsed["warnings"],
            "configPath": str(target_path),
        }

    def normalize_server_config(
        self, raw_cfg: dict[str, Any], preserve_from: dict[str, Any] | None = None
    ) -> tuple[dict[str, Any], list[str]]:
        """Normalize incoming form or pasted JSON into valid Antigravity mcp_config.json schema."""
        warnings: list[str] = []
        result: dict[str, Any] = {}

        # Preserve advanced keys (like oauth) that aren't edited in basic form
        if preserve_from:
            for extra_key in ("oauth", "variables"):
                if extra_key in preserve_from and extra_key not in raw_cfg:
                    result[extra_key] = preserve_from[extra_key]

        transport = str(raw_cfg.get("transport") or raw_cfg.get("type") or "").strip().lower()
        raw_url = raw_cfg.get("serverUrl") or raw_cfg.get("url") or raw_cfg.get("httpUrl")
        raw_command = raw_cfg.get("command")

        is_remote = transport in ("http", "remote", "streamable-http") or (
            bool(raw_url) and not raw_command
        )

        if is_remote:
            url = str(raw_url or "").strip()
            if not url:
                raise ValueError("远程 MCP 服务器必须填写 serverUrl")
            if raw_cfg.get("httpUrl") and not raw_cfg.get("serverUrl"):
                warnings.append("已将 httpUrl 自动转换为 Antigravity 标准字段 serverUrl")
            if url.rstrip("/").endswith("/sse"):
                warnings.append(
                    "检测到 /sse 路径：Antigravity 仅原生支持 Streamable HTTP（通常为 /mcp），旧版 SSE 建议改用 mcp-remote 的 Stdio 桥接。"
                )
            result["serverUrl"] = url

            headers = self._clean_str_map(raw_cfg.get("headers"))
            if headers:
                result["headers"] = headers

            auth_type = str(raw_cfg.get("authProviderType") or "").strip()
            if auth_type:
                result["authProviderType"] = auth_type
        else:
            command_str, args_list = self._normalize_command_and_args(
                raw_command, raw_cfg.get("args")
            )
            if not command_str:
                raise ValueError("本地 Stdio MCP 服务器必须填写启动命令 (command)")
            resolved_cmd, cmd_warning = resolve_stdio_command(command_str)
            if cmd_warning:
                warnings.append(cmd_warning)
            result["command"] = resolved_cmd
            if args_list:
                result["args"] = args_list

            env_map = self._clean_str_map(raw_cfg.get("env") or raw_cfg.get("environment"))
            if env_map:
                result["env"] = env_map

            cwd = str(raw_cfg.get("cwd") or "").strip()
            if cwd:
                result["cwd"] = cwd

        # Common Antigravity MCP properties
        enabled_flag = raw_cfg.get("enabled")
        disabled_flag = raw_cfg.get("disabled")
        if disabled_flag is True or enabled_flag is False:
            result["disabled"] = True

        timeout_val = raw_cfg.get("timeoutSeconds")
        if timeout_val is None and raw_cfg.get("timeout") is not None:
            # OpenCode uses ms (e.g. 5000); convert if >= 1000
            try:
                ms = int(raw_cfg["timeout"])
                timeout_val = max(1, ms // 1000) if ms >= 1000 else ms
                warnings.append(f"已将 timeout 自动转换为 timeoutSeconds={timeout_val}")
            except (ValueError, TypeError):
                pass
        if timeout_val is not None and str(timeout_val).strip() != "":
            try:
                parsed_timeout = int(timeout_val)
                if parsed_timeout != 0:
                    result["timeoutSeconds"] = parsed_timeout
            except (ValueError, TypeError) as exc:
                raise ValueError("timeoutSeconds 必须是整数") from exc

        enabled_tools = self._clean_str_list(raw_cfg.get("enabledTools"))
        if enabled_tools:
            result["enabledTools"] = enabled_tools

        disabled_tools = self._clean_str_list(raw_cfg.get("disabledTools"))
        if disabled_tools:
            result["disabledTools"] = disabled_tools

        if isinstance(raw_cfg.get("tools"), dict) and raw_cfg["tools"]:
            result["tools"] = raw_cfg["tools"]

        if isinstance(raw_cfg.get("oauth"), dict) and raw_cfg["oauth"]:
            result["oauth"] = raw_cfg["oauth"]

        return result, warnings

    def _normalize_command_and_args(
        self, raw_command: Any, raw_args: Any
    ) -> tuple[str, list[str]]:
        args_list: list[str] = []
        if isinstance(raw_args, list):
            args_list = [str(a) for a in raw_args if str(a) != ""]

        # OpenCode / OpenChamber array command format: ["npx", "-y", "..."]
        if isinstance(raw_command, list):
            parts = [str(p).strip() for p in raw_command if str(p).strip()]
            if not parts:
                return "", []
            return parts[0], parts[1:] + args_list

        cmd_text = str(raw_command or "").strip()
        if not cmd_text:
            return "", args_list

        # Multi-line textarea format (like OpenChamber UI: one arg per line)
        if "\n" in cmd_text and not args_list:
            lines = [line.strip() for line in cmd_text.splitlines() if line.strip()]
            if not lines:
                return "", []
            return lines[0], lines[1:]

        # Single line full command pasted into command field when args is empty
        if " " in cmd_text and not args_list and not Path(cmd_text).exists():
            try:
                parts = shlex.split(cmd_text)
                if parts:
                    return parts[0], parts[1:]
            except ValueError:
                parts = cmd_text.split()
                return parts[0], parts[1:]

        return cmd_text, args_list

    def _write_target_mcp_doc(
        self, scope: str, project_path: Path | None, target_path: Path, doc: dict[str, Any]
    ) -> None:
        if scope == "project" and project_path is not None:
            self.store.ensure_project_mcp_plugin_manifest(project_path)
        self.store.write_json_atomic(target_path, doc)

    def _remove_from_legacy_project_mcp(self, project_path: Path, name: str) -> bool:
        legacy_path = self.store.legacy_project_mcp_path(project_path)
        if not legacy_path.is_file():
            return False
        doc = self._read_mcp_doc(legacy_path)
        servers = doc.get("mcpServers", {})
        if not isinstance(servers, dict) or name not in servers:
            return False
        del servers[name]
        if servers:
            doc["mcpServers"] = servers
            self.store.write_json_atomic(legacy_path, doc)
        else:
            legacy_path.unlink(missing_ok=True)
        return True

    def _read_mcp_doc(self, path: Path) -> dict[str, Any]:
        try:
            data = self.store.read_json(path, {})
            if isinstance(data, dict):
                if not isinstance(data.get("mcpServers"), dict):
                    data["mcpServers"] = {}
                return data
        except Exception:
            pass
        return {"mcpServers": {}}

    def _read_mcp_map(self, path: Path) -> dict[str, dict[str, Any]]:
        doc = self._read_mcp_doc(path)
        servers = doc.get("mcpServers", {})
        if not isinstance(servers, dict):
            return {}
        return {
            str(k): v for k, v in servers.items() if isinstance(v, dict)
        }

    def _format_server_item(
        self,
        *,
        name: str,
        cfg: dict[str, Any],
        scope: str,
        project_path: str | None,
        project_name: str,
        config_path: Path,
    ) -> dict[str, Any]:
        url = cfg.get("serverUrl") or cfg.get("url")
        transport = "http" if url and not cfg.get("command") else "stdio"
        if transport == "http":
            summary = str(url)
        else:
            cmd = str(cfg.get("command") or "")
            args = cfg.get("args") if isinstance(cfg.get("args"), list) else []
            summary = " ".join([cmd, *[str(a) for a in args]]).strip()

        return {
            "name": name,
            "scope": scope,
            "projectPath": project_path,
            "projectName": project_name,
            "configPath": str(config_path),
            "transport": transport,
            "enabled": not bool(cfg.get("disabled", False)),
            "summary": summary,
            "config": cfg,
        }

    @staticmethod
    def _looks_like_server_config(obj: dict[str, Any]) -> bool:
        keys = set(obj.keys())
        return bool(keys & {"command", "serverUrl", "url", "httpUrl"})

    @staticmethod
    def _infer_server_name(obj: dict[str, Any]) -> str:
        url = str(obj.get("serverUrl") or obj.get("url") or "")
        if url:
            host = re.sub(r"^https?://", "", url).split("/")[0].split(":")[0]
            return re.sub(r"[^A-Za-z0-9._-]+", "-", host) or "remote-mcp"
        args = obj.get("args") if isinstance(obj.get("args"), list) else []
        for arg in args:
            text = str(arg)
            if "/" in text and not text.startswith("-"):
                tail = text.rstrip("/").split("/")[-1]
                tail = re.sub(r"^server-", "", tail)
                tail = re.sub(r"@.*$", "", tail)
                if tail:
                    return re.sub(r"[^A-Za-z0-9._-]+", "-", tail)
        return "new-mcp-server"

    @staticmethod
    def _clean_str_map(val: Any) -> dict[str, str]:
        if not isinstance(val, dict):
            return {}
        out: dict[str, str] = {}
        for k, v in val.items():
            key = str(k).strip()
            if key:
                out[key] = "" if v is None else str(v)
        return out

    @staticmethod
    def _clean_str_list(val: Any) -> list[str]:
        if isinstance(val, str):
            return [x.strip() for x in re.split(r"[\n,]+", val) if x.strip()]
        if isinstance(val, list):
            return [str(x).strip() for x in val if str(x).strip()]
        return []

    @staticmethod
    def _loads_lenient_json(raw_text: str) -> Any:
        text = raw_text.strip()
        if not text:
            raise ValueError("JSON 内容不能为空")
        # Strip markdown code fences if pasted from documentation
        fence_match = re.match(
            r"^```(?:jsonc?|javascript|js)?\s*\r?\n(.*?)\r?\n\s*```$", text, re.S
        )
        if fence_match:
            text = fence_match.group(1).strip()
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            # Try tolerating trailing commas or single-line comments
            cleaned = re.sub(r"(?m)^\s*//.*$", "", text)
            cleaned = re.sub(r",\s*([}\]])", r"\1", cleaned)
            try:
                return json.loads(cleaned)
            except json.JSONDecodeError as exc:
                raise ValueError(f"JSON 格式解析失败: {exc.msg}（第 {exc.lineno} 行）") from exc

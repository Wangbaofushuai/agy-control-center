"""Lightweight standalone Web Server + REST API for Antigravity Control Center."""

from __future__ import annotations

import argparse
import hmac
import io
import json
import mimetypes
import os
import shutil
import signal
import sys
import threading
import zipfile
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from .config_store import REPO_ROOT, ConfigStore
from .mcp_service import McpService
from .skill_service import SkillService, _get_repo_lock


class ReusableThreadingHTTPServer(ThreadingHTTPServer):
    """HTTP server that releases ports immediately and never hangs on keep-alive sockets."""

    allow_reuse_address = True
    daemon_threads = True

WEB_DIR = REPO_ROOT / "web"
PLUGIN_DIR = REPO_ROOT / "plugins" / "agy-control-center"
EXTENSION_DIR = REPO_ROOT / "extension"


def build_extension_zip_bytes() -> bytes:
    """Package extension/ directory into a ready-to-load Chrome/Edge ZIP archive."""
    if not EXTENSION_DIR.is_dir():
        raise FileNotFoundError("extension directory not found")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for file_path in sorted(EXTENSION_DIR.rglob("*")):
            if not file_path.is_file():
                continue
            if any(part in {".git", "__pycache__", ".DS_Store"} for part in file_path.parts):
                continue
            arcname = Path("agy-control-center-extension") / file_path.relative_to(EXTENSION_DIR)
            zf.write(file_path, arcname=str(arcname))
    return buf.getvalue()


class ControlCenterApp:
    """Shared application services container."""

    def __init__(self, store: ConfigStore) -> None:
        self.store = store
        self.mcp = McpService(store)
        self.skills = SkillService(store)

    def get_overview(self) -> dict[str, Any]:
        mcp_data = self.mcp.list_servers()
        skills_data = self.skills.list_installed_skills()
        catalogs_data = self.skills.list_catalogs()
        return {
            "globalConfigDir": str(self.store.global_config_dir),
            "globalMcpPath": str(self.store.global_mcp_path),
            "globalSkillsDir": str(self.store.global_skills_dir),
            "dataDir": str(self.store.data_dir),
            "pluginDir": str(PLUGIN_DIR),
            "pluginManifestExists": (PLUGIN_DIR / "plugin.json").is_file(),
            "extensionDir": str(EXTENSION_DIR),
            "extensionReady": (EXTENSION_DIR / "manifest.json").is_file(),
            "counts": {
                "projects": len(mcp_data["projects"]),
                "mcpServers": len(mcp_data["servers"]),
                "installedSkills": len(skills_data["skills"]),
                "catalogs": len(catalogs_data["catalogs"]),
            },
            "projects": mcp_data["projects"],
        }

    def _active_mcp_cache_names(self) -> set[str]:
        active: set[str] = set()
        # 1. Global mcp_config.json
        global_doc = self.store.read_json(self.store.global_mcp_path, {})
        if isinstance(global_doc, dict) and isinstance(global_doc.get("mcpServers"), dict):
            for name, cfg in global_doc["mcpServers"].items():
                if isinstance(cfg, dict) and not cfg.get("disabled"):
                    active.add(str(name))

        # 2. Global plugins (~/.gemini/config/plugins/<plugin>/mcp_config.json)
        self._collect_plugin_mcp_names(self.store.global_config_dir / "plugins", active)

        # 3. Project configs (isolated plugin + other project plugins + legacy .agents/mcp_config.json)
        for proj in self.store.discover_projects():
            if not proj.get("exists"):
                continue
            p_root = Path(proj["path"])
            self._collect_plugin_mcp_names(p_root / ".agents" / "plugins", active)
            legacy_path = self.store.legacy_project_mcp_path(p_root)
            legacy_doc = self.store.read_json(legacy_path, {})
            if isinstance(legacy_doc, dict) and isinstance(legacy_doc.get("mcpServers"), dict):
                for name, cfg in legacy_doc["mcpServers"].items():
                    if isinstance(cfg, dict) and not cfg.get("disabled"):
                        active.add(str(name))
        return active

    def _collect_plugin_mcp_names(self, plugins_dir: Path, out: set[str]) -> None:
        if not plugins_dir.is_dir():
            return
        for plugin_dir in plugins_dir.iterdir():
            if not plugin_dir.is_dir():
                continue
            mcp_file = plugin_dir / "mcp_config.json"
            if not mcp_file.is_file():
                continue
            plugin_name = plugin_dir.name
            manifest = plugin_dir / "plugin.json"
            if manifest.is_file():
                try:
                    m_data = self.store.read_json(manifest, {})
                    if isinstance(m_data, dict) and m_data.get("name"):
                        plugin_name = str(m_data["name"])
                except Exception:
                    pass
            try:
                doc = self.store.read_json(mcp_file, {})
            except Exception:
                continue
            if isinstance(doc, dict) and isinstance(doc.get("mcpServers"), dict):
                for srv_name, cfg in doc["mcpServers"].items():
                    if isinstance(cfg, dict) and not cfg.get("disabled"):
                        out.add(f"{plugin_name}_{srv_name}")

    @staticmethod
    def _dir_stats(path: Path) -> tuple[int, int]:
        file_count = 0
        total_bytes = 0
        if not path.is_dir():
            return 0, 0
        for item in path.rglob("*"):
            if item.is_file():
                file_count += 1
                try:
                    total_bytes += item.stat().st_size
                except OSError:
                    pass
        return file_count, total_bytes

    def get_cache_status(self) -> dict[str, Any]:
        active_names = self._active_mcp_cache_names()
        mcp_entries: list[dict[str, Any]] = []
        mcp_dirs = self.store.antigravity_mcp_cache_dirs

        for cache_dir in mcp_dirs:
            if not cache_dir.is_dir():
                continue
            for child in sorted(cache_dir.iterdir(), key=lambda p: p.name.lower()):
                if not child.is_dir():
                    continue
                files, size_bytes = self._dir_stats(child)
                try:
                    mtime_iso = datetime.fromtimestamp(
                        child.stat().st_mtime, tz=timezone.utc
                    ).isoformat()
                except OSError:
                    mtime_iso = None
                mcp_entries.append(
                    {
                        "name": child.name,
                        "path": str(child),
                        "cacheRoot": str(cache_dir),
                        "fileCount": files,
                        "sizeBytes": size_bytes,
                        "stale": child.name not in active_names,
                        "modifiedAt": mtime_iso,
                    }
                )

        repo_cache_dir = self.store.repo_cache_dir
        repo_dirs = (
            [p for p in repo_cache_dir.iterdir() if p.is_dir() and not p.name.startswith(".tmp-")]
            if repo_cache_dir.is_dir()
            else []
        )
        repo_files = 0
        repo_bytes = 0
        for rd in repo_dirs:
            f_cnt, b_cnt = self._dir_stats(rd)
            repo_files += f_cnt
            repo_bytes += b_cnt

        return {
            "mcpCacheDirs": [str(p) for p in mcp_dirs],
            "mcpEntries": mcp_entries,
            "mcpTotalCount": len(mcp_entries),
            "mcpStaleCount": sum(1 for e in mcp_entries if e["stale"]),
            "mcpTotalBytes": sum(e["sizeBytes"] for e in mcp_entries),
            "skillRepoCache": {
                "path": str(repo_cache_dir),
                "repoCount": len(repo_dirs),
                "fileCount": repo_files,
                "sizeBytes": repo_bytes,
            },
        }

    def clear_cache(self, target: str) -> dict[str, Any]:
        norm_target = (target or "").strip().lower()
        if norm_target not in ("mcp_stale", "mcp_all", "skill_repos"):
            raise ValueError(f"不支持的缓存清理目标: {target}")

        removed_names: list[str] = []
        freed_bytes = 0

        if norm_target in ("mcp_stale", "mcp_all"):
            status_before = self.get_cache_status()
            for entry in status_before["mcpEntries"]:
                if norm_target == "mcp_stale" and not entry["stale"]:
                    continue
                target_dir = Path(entry["path"]).resolve()
                cache_root = Path(entry["cacheRoot"]).resolve()
                if target_dir.parent != cache_root or not target_dir.is_dir():
                    continue
                freed_bytes += entry["sizeBytes"]
                shutil.rmtree(target_dir, ignore_errors=False)
                removed_names.append(entry["name"])
        elif norm_target == "skill_repos":
            repo_root = self.store.repo_cache_dir.resolve()
            if repo_root.is_dir():
                for child in sorted(repo_root.iterdir(), key=lambda p: p.name):
                    if child.name.startswith(".tmp-"):
                        continue
                    child_res = child.resolve()
                    if child_res.parent != repo_root:
                        continue
                    lock = _get_repo_lock(str(child_res))
                    with lock:
                        if not child_res.exists():
                            continue
                        _, sz = self._dir_stats(child_res)
                        freed_bytes += sz
                        if child_res.is_dir():
                            shutil.rmtree(child_res)
                        else:
                            child_res.unlink(missing_ok=True)
                        removed_names.append(child.name)

        return {
            "target": norm_target,
            "removedCount": len(removed_names),
            "removedNames": removed_names,
            "freedBytes": freed_bytes,
            "status": self.get_cache_status(),
        }


def make_handler(app: ControlCenterApp, api_token: str = "") -> type[BaseHTTPRequestHandler]:
    class RequestHandler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, format: str, *args: Any) -> None:
            sys.stderr.write(f"[web] {self.address_string()} - {format % args}\n")

        def _send_cors_headers(self) -> None:
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
            self.send_header(
                "Access-Control-Allow-Headers",
                "Content-Type, Authorization, X-API-Token",
            )

        def _check_auth(self, path: str) -> bool:
            if not api_token:
                return True
            if not path.startswith("/api/") or path in ("/api/health", "/api/extension.zip"):
                return True
            hdr_token = self.headers.get("X-API-Token", "").strip()
            auth_hdr = self.headers.get("Authorization", "").strip()
            bearer = auth_hdr[7:].strip() if auth_hdr.lower().startswith("bearer ") else ""
            if hmac.compare_digest(hdr_token, api_token) or hmac.compare_digest(bearer, api_token):
                return True
            self._send_json(HTTPStatus.UNAUTHORIZED, {"error": "API Token 校验失败"})
            return False

        def do_OPTIONS(self) -> None:
            self.send_response(HTTPStatus.NO_CONTENT)
            self._send_cors_headers()
            self.send_header("Content-Length", "0")
            self.end_headers()

        def _send_json(self, status: int, payload: Any) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _send_bytes(
            self, status: int, data: bytes, content_type: str, filename: str | None = None
        ) -> None:
            self.send_response(status)
            self._send_cors_headers()
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-cache")
            if filename:
                self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
            self.end_headers()
            self.wfile.write(data)

        def _send_file(self, path: Path) -> None:
            if not path.is_file():
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})
                return
            mime, _ = mimetypes.guess_type(str(path))
            mime = mime or "application/octet-stream"
            is_text = mime.startswith("text/") or mime in (
                "application/javascript",
                "application/json",
                "image/svg+xml",
            )
            content_type = f"{mime}; charset=utf-8" if is_text else mime
            data = path.read_bytes()
            self.send_response(HTTPStatus.OK)
            self._send_cors_headers()
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(data)

        def _read_json_body(self) -> dict[str, Any]:
            length = int(self.headers.get("Content-Length", "0") or "0")
            if length <= 0:
                return {}
            if length > 10 * 1024 * 1024:
                raise ValueError("请求体过大（上限 10MB）")
            raw = self.rfile.read(length).decode("utf-8")
            if not raw.strip():
                return {}
            parsed = json.loads(raw)
            if not isinstance(parsed, dict):
                raise ValueError("请求体必须是 JSON 对象")
            return parsed

        def do_GET(self) -> None:
            parsed = urlparse(self.path)
            path = parsed.path
            query = parse_qs(parsed.query)

            try:
                if not self._check_auth(path):
                    return
                if path == "/api/health":
                    self._send_json(HTTPStatus.OK, {"status": "ok", "authRequired": bool(api_token)})
                    return
                if path == "/api/extension.zip":
                    zip_bytes = build_extension_zip_bytes()
                    self._send_bytes(
                        HTTPStatus.OK,
                        zip_bytes,
                        "application/zip",
                        filename="agy-control-center-extension.zip",
                    )
                    return
                if path == "/api/overview":
                    self._send_json(HTTPStatus.OK, app.get_overview())
                    return
                if path == "/api/cache":
                    self._send_json(HTTPStatus.OK, app.get_cache_status())
                    return
                if path == "/api/projects":
                    self._send_json(HTTPStatus.OK, {"projects": app.store.discover_projects()})
                    return
                if path == "/api/mcp":
                    self._send_json(HTTPStatus.OK, app.mcp.list_servers())
                    return
                if path == "/api/mcp/raw":
                    scope = query.get("scope", ["global"])[0]
                    project_path = query.get("projectPath", [None])[0]
                    self._send_json(HTTPStatus.OK, app.mcp.get_raw_config(scope, project_path))
                    return
                if path == "/api/skills/installed":
                    self._send_json(HTTPStatus.OK, app.skills.list_installed_skills())
                    return
                if path == "/api/skills/detail":
                    scope = query.get("scope", ["global"])[0]
                    project_path = query.get("projectPath", [None])[0]
                    folder_name = query.get("folderName", [""])[0]
                    self._send_json(
                        HTTPStatus.OK,
                        app.skills.get_installed_skill_detail(scope, project_path, folder_name),
                    )
                    return
                if path == "/api/catalogs":
                    self._send_json(HTTPStatus.OK, app.skills.list_catalogs())
                    return
                if path == "/api/catalogs/skill-preview":
                    self._send_json(
                        HTTPStatus.OK,
                        app.skills.preview_catalog_skill(
                            catalog_id=query.get("catalogId", [None])[0],
                            repo=query.get("repo", [None])[0],
                            subpath=query.get("subpath", [""])[0],
                            branch=query.get("branch", [""])[0],
                            rel_path=query.get("relPath", [""])[0],
                        ),
                    )
                    return

                # Static web assets
                rel = "index.html" if path in ("/", "") else path.lstrip("/")
                target = (WEB_DIR / rel).resolve()
                if WEB_DIR.resolve() not in target.parents and target != WEB_DIR.resolve():
                    self._send_json(HTTPStatus.FORBIDDEN, {"error": "Forbidden"})
                    return
                self._send_file(target)
            except ValueError as exc:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            except Exception as exc:
                self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(exc)})

        def do_POST(self) -> None:
            path = urlparse(self.path).path
            try:
                if not self._check_auth(path):
                    return
                body = self._read_json_body()
                if path == "/api/projects":
                    proj = app.store.add_custom_project(
                        str(body.get("path", "")), str(body.get("name", ""))
                    )
                    self._send_json(HTTPStatus.OK, {"project": proj})
                    return
                if path == "/api/cache/clear":
                    result = app.clear_cache(str(body.get("target", "")))
                    self._send_json(HTTPStatus.OK, result)
                    return
                if path == "/api/mcp/parse":
                    result = app.mcp.parse_json_snippet(str(body.get("json", "")))
                    self._send_json(HTTPStatus.OK, result)
                    return
                if path == "/api/mcp/save":
                    result = app.mcp.save_server(
                        scope=str(body.get("scope", "global")),
                        project_path=body.get("projectPath"),
                        name=str(body.get("name", "")),
                        config=body.get("config") or {},
                        original_name=body.get("originalName"),
                        original_scope=body.get("originalScope"),
                        original_project_path=body.get("originalProjectPath"),
                    )
                    self._send_json(HTTPStatus.OK, result)
                    return
                if path == "/api/mcp/import":
                    result = app.mcp.import_json_snippet(
                        scope=str(body.get("scope", "global")),
                        project_path=body.get("projectPath"),
                        raw_text=str(body.get("json", "")),
                        overwrite=bool(body.get("overwrite", True)),
                    )
                    self._send_json(HTTPStatus.OK, result)
                    return
                if path == "/api/mcp/toggle":
                    item = app.mcp.toggle_server(
                        scope=str(body.get("scope", "global")),
                        project_path=body.get("projectPath"),
                        name=str(body.get("name", "")),
                        enabled=bool(body.get("enabled", True)),
                    )
                    self._send_json(HTTPStatus.OK, {"server": item})
                    return
                if path == "/api/mcp/raw":
                    result = app.mcp.save_raw_config(
                        scope=str(body.get("scope", "global")),
                        project_path=body.get("projectPath"),
                        raw_json=str(body.get("content", "")),
                    )
                    self._send_json(HTTPStatus.OK, result)
                    return
                if path == "/api/skills/transfer":
                    result = app.skills.transfer_installed_skill(
                        src_scope=str(body.get("srcScope", "global")),
                        src_project_path=body.get("srcProjectPath"),
                        folder_name=str(body.get("folderName", "")),
                        dst_scope=str(body.get("dstScope", "global")),
                        dst_project_path=body.get("dstProjectPath"),
                        move=bool(body.get("move", False)),
                        overwrite=bool(body.get("overwrite", False)),
                    )
                    self._send_json(HTTPStatus.OK, result)
                    return
                if path == "/api/catalogs":
                    result = app.skills.add_catalog(
                        name=str(body.get("name", "")),
                        repo=str(body.get("repo", "")),
                        subpath=str(body.get("subpath", "")),
                        branch=str(body.get("branch", "")),
                        token=str(body.get("token", "")),
                        auto_scan=bool(body.get("autoScan", True)),
                    )
                    self._send_json(HTTPStatus.OK, result)
                    return
                if path == "/api/catalogs/scan":
                    result = app.skills.scan_catalog(
                        catalog_id=body.get("catalogId"),
                        repo=body.get("repo"),
                        subpath=str(body.get("subpath", "")),
                        branch=str(body.get("branch", "")),
                        token=str(body.get("token", "")),
                        force_refresh=bool(body.get("forceRefresh", True)),
                    )
                    self._send_json(HTTPStatus.OK, result)
                    return
                if path == "/api/catalogs/install":
                    result = app.skills.install_skills(
                        catalog_id=body.get("catalogId"),
                        repo=body.get("repo"),
                        subpath=str(body.get("subpath", "")),
                        branch=str(body.get("branch", "")),
                        token=str(body.get("token", "")),
                        skill_rel_paths=list(body.get("skillRelPaths") or []),
                        scope=str(body.get("scope", "global")),
                        project_path=body.get("projectPath"),
                        overwrite=bool(body.get("overwrite", False)),
                    )
                    self._send_json(HTTPStatus.OK, result)
                    return
                self._send_json(HTTPStatus.NOT_FOUND, {"error": f"Unknown endpoint: {path}"})
            except ValueError as exc:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            except Exception as exc:
                self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(exc)})

        def do_DELETE(self) -> None:
            parsed = urlparse(self.path)
            path = parsed.path
            query = parse_qs(parsed.query)
            try:
                if not self._check_auth(path):
                    return
                if path == "/api/projects":
                    removed = app.store.remove_custom_project(query.get("path", [""])[0])
                    self._send_json(HTTPStatus.OK, {"removed": removed})
                    return
                if path == "/api/mcp":
                    removed = app.mcp.delete_server(
                        scope=query.get("scope", ["global"])[0],
                        project_path=query.get("projectPath", [None])[0],
                        name=query.get("name", [""])[0],
                    )
                    self._send_json(HTTPStatus.OK, {"removed": removed})
                    return
                if path == "/api/skills/installed":
                    removed = app.skills.delete_installed_skill(
                        scope=query.get("scope", ["global"])[0],
                        project_path=query.get("projectPath", [None])[0],
                        folder_name=query.get("folderName", [""])[0],
                    )
                    self._send_json(HTTPStatus.OK, {"removed": removed})
                    return
                if path == "/api/catalogs":
                    removed = app.skills.delete_catalog(query.get("id", [""])[0])
                    self._send_json(HTTPStatus.OK, {"removed": removed})
                    return
                self._send_json(HTTPStatus.NOT_FOUND, {"error": f"Unknown endpoint: {path}"})
            except ValueError as exc:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            except Exception as exc:
                self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(exc)})

    return RequestHandler


def create_server(
    host: str = "0.0.0.0",
    port: int = 8787,
    global_config_dir: str | None = None,
    data_dir: str | None = None,
    api_token: str | None = None,
) -> ThreadingHTTPServer:
    store = ConfigStore(global_config_dir=global_config_dir, data_dir=data_dir)
    app = ControlCenterApp(store)
    effective_token = (
        api_token if api_token is not None else os.environ.get("AGY_API_TOKEN", "")
    ).strip()
    return ReusableThreadingHTTPServer((host, port), make_handler(app, api_token=effective_token))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Antigravity MCP & Skill Control Center Web Server")
    parser.add_argument("--host", default="0.0.0.0", help="Bind host (default: 0.0.0.0)")
    parser.add_argument("--port", type=int, default=8787, help="Bind port (default: 8787)")
    parser.add_argument("--config-dir", default=None, help="Override Antigravity global config dir")
    parser.add_argument("--data-dir", default=None, help="Override local data/cache dir")
    parser.add_argument("--token", default=None, help="Optional API token (or env AGY_API_TOKEN)")
    args = parser.parse_args(argv)

    server = create_server(
        host=args.host,
        port=args.port,
        global_config_dir=args.config_dir,
        data_dir=args.data_dir,
        api_token=args.token,
    )

    def _handle_sigterm(_signum: int, _frame: Any) -> None:
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, _handle_sigterm)

    print(f"Antigravity Control Center running at http://{args.host}:{args.port}")
    print(f"Global config dir: {ConfigStore(args.config_dir, args.data_dir).global_config_dir}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

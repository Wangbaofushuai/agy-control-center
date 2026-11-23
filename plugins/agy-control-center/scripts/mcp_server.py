#!/usr/bin/env python3
"""Antigravity Plugin MCP Stdio Server + MCP Apps (ui://) Host Bridge.

Zero external dependencies (Python 3 standard library only).
Supports:
- Standard MCP tools for managing Global & Project MCP servers and Skills
- MCP Apps interactive UI resource (ui://agy-control-center/index.html)
  with aux_pane and global entrypoints for Antigravity App
- Plain-text fallback output for Antigravity CLI and non-UI surfaces
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

# Locate repository root containing manager/ and web/
SCRIPT_PATH = Path(__file__).resolve()
PLUGIN_ROOT = Path(os.environ.get("PLUGIN_ROOT") or SCRIPT_PATH.parent.parent).resolve()
CANDIDATE_ROOTS = [
    Path(os.environ["AGY_CONTROL_ROOT"]).resolve()
    for _ in [0]
    if os.environ.get("AGY_CONTROL_ROOT")
] + [
    PLUGIN_ROOT.parent.parent,  # <repo>/plugins/agy-control-center -> <repo>
    PLUGIN_ROOT,                # standalone bundled plugin copy
]

REPO_ROOT = next(
    (root for root in CANDIDATE_ROOTS if (root / "manager").is_dir()),
    PLUGIN_ROOT.parent.parent,
)
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from manager.config_store import ConfigStore  # noqa: E402
from manager.web_server import ControlCenterApp  # noqa: E402

UI_RESOURCE_URI = "ui://agy-control-center/index.html"
UI_MIME_TYPE = "text/html;profile=mcp-app"


def build_inlined_ui_html() -> str:
    """Bundle web/index.html, styles.css, and app.js into a single MCP App HTML file."""
    web_dir = REPO_ROOT / "web"
    html = (web_dir / "index.html").read_text(encoding="utf-8")
    css = (web_dir / "styles.css").read_text(encoding="utf-8")
    js = (web_dir / "app.js").read_text(encoding="utf-8")

    html = html.replace(
        '<link rel="stylesheet" href="/styles.css" />',
        f"<style>\n{css}\n</style>",
    )
    html = html.replace(
        '<script src="/app.js"></script>',
        f"<script>window.__MCP_APP_MODE__ = true;\n{js}\n</script>",
    )
    return html


class ControlCenterMcpServer:
    """Pure-Python MCP JSON-RPC 2.0 server over stdio."""

    def __init__(self, app: ControlCenterApp) -> None:
        self.app = app

    def handle_request(self, msg: dict[str, Any]) -> dict[str, Any] | None:
        method = msg.get("method")
        msg_id = msg.get("id")
        params = msg.get("params") or {}

        # Notifications have no id and expect no response
        if msg_id is None:
            return None

        try:
            if method == "initialize":
                return self._ok(
                    msg_id,
                    {
                        "protocolVersion": params.get("protocolVersion") or "2025-03-26",
                        "capabilities": {
                            "tools": {"listChanged": False},
                            "resources": {"subscribe": False, "listChanged": False},
                        },
                        "serverInfo": {
                            "name": "agy-control-center",
                            "version": "1.0.0",
                        },
                    },
                )
            if method == "ping":
                return self._ok(msg_id, {})
            if method == "tools/list":
                return self._ok(msg_id, {"tools": self._tool_definitions()})
            if method == "resources/list":
                return self._ok(
                    msg_id,
                    {
                        "resources": [
                            {
                                "uri": UI_RESOURCE_URI,
                                "name": "Antigravity Control Center UI",
                                "description": "Interactive MCP & Skill manager panel",
                                "mimeType": UI_MIME_TYPE,
                            }
                        ]
                    },
                )
            if method == "resources/read":
                uri = params.get("uri")
                if uri != UI_RESOURCE_URI:
                    return self._err(msg_id, -32602, f"Unknown resource URI: {uri}")
                return self._ok(
                    msg_id,
                    {
                        "contents": [
                            {
                                "uri": UI_RESOURCE_URI,
                                "mimeType": UI_MIME_TYPE,
                                "text": build_inlined_ui_html(),
                            }
                        ]
                    },
                )
            if method == "tools/call":
                name = str(params.get("name") or "")
                arguments = params.get("arguments") or {}
                result = self._call_tool(name, arguments)
                return self._ok(msg_id, result)
            return self._err(msg_id, -32601, f"Method not found: {method}")
        except Exception as exc:
            return self._ok(
                msg_id,
                {
                    "isError": True,
                    "content": [{"type": "text", "text": f"Error: {exc}"}],
                },
            )

    def _tool_definitions(self) -> list[dict[str, Any]]:
        return [
            {
                "name": "open_control_center",
                "description": "Open the interactive MCP & Skill Control Center UI and return a summary of configured MCP servers, installed skills, and discovered projects.",
                "inputSchema": {
                    "type": "object",
                    "properties": {},
                },
                "_meta": {
                    "ui": {"resourceUri": UI_RESOURCE_URI},
                    "com.google.antigravity/ui": {
                        "entrypoints": [
                            {"type": "aux_pane", "title": "MCP & Skills"},
                            {"type": "global", "title": "MCP & Skills"},
                        ]
                    },
                },
            },
            {
                "name": "control_center_action",
                "description": "Internal UI bridge action dispatcher for the Control Center MCP App.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "action": {"type": "string"},
                        "payload": {"type": "object"},
                    },
                    "required": ["action"],
                },
                "_meta": {
                    "ui": {"visibility": ["app"]},
                },
            },
            {
                "name": "list_mcp_servers",
                "description": "List all configured MCP servers across global (~/.gemini/config/mcp_config.json) and discovered project workspaces (.agents/mcp_config.json).",
                "inputSchema": {"type": "object", "properties": {}},
            },
            {
                "name": "import_mcp_json",
                "description": "Parse and import an MCP JSON snippet (Antigravity, Claude, Cursor, or OpenCode format) into global or project mcp_config.json.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "json": {"type": "string", "description": "Raw MCP JSON snippet"},
                        "scope": {
                            "type": "string",
                            "enum": ["global", "project"],
                            "default": "global",
                        },
                        "projectPath": {
                            "type": "string",
                            "description": "Required when scope is project",
                        },
                        "overwrite": {"type": "boolean", "default": True},
                    },
                    "required": ["json", "scope"],
                },
            },
            {
                "name": "list_installed_skills",
                "description": "List all installed skills across global (~/.gemini/config/skills) and project workspaces (.agents/skills).",
                "inputSchema": {"type": "object", "properties": {}},
            },
            {
                "name": "scan_skill_repo",
                "description": "Clone/sync a Git repository (owner/repo or Git URL) and scan for all SKILL.md skill folders.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "repo": {"type": "string", "description": "owner/repo or full Git URL"},
                        "subpath": {"type": "string", "default": ""},
                        "branch": {"type": "string", "default": ""},
                        "token": {"type": "string", "default": ""},
                    },
                    "required": ["repo"],
                },
            },
            {
                "name": "install_skills_from_repo",
                "description": "Install one or more scanned skills from a Git repository into global (~/.gemini/config/skills) or a project (.agents/skills).",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "repo": {"type": "string"},
                        "skillRelPaths": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "Relative skill folder paths returned by scan_skill_repo",
                        },
                        "scope": {"type": "string", "enum": ["global", "project"]},
                        "projectPath": {"type": "string"},
                        "subpath": {"type": "string", "default": ""},
                        "branch": {"type": "string", "default": ""},
                        "token": {"type": "string", "default": ""},
                        "overwrite": {"type": "boolean", "default": False},
                    },
                    "required": ["repo", "skillRelPaths", "scope"],
                },
            },
        ]

    def _call_tool(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        if name == "open_control_center":
            ov = self.app.get_overview()
            summary = (
                f"Antigravity Control Center 就绪：\n"
                f"- 全局配置目录: {ov['globalConfigDir']}\n"
                f"- 已发现项目: {ov['counts']['projects']} 个\n"
                f"- 已配置 MCP 服务器: {ov['counts']['mcpServers']} 个\n"
                f"- 已安装技能: {ov['counts']['installedSkills']} 个\n"
                f"- 技能目录来源: {ov['counts']['catalogs']} 个"
            )
            return {
                "content": [{"type": "text", "text": summary}],
                "structuredContent": ov,
            }

        if name == "control_center_action":
            action = str(args.get("action") or "")
            payload = args.get("payload") or {}
            data = self._dispatch_action(action, payload.get("body") or {}, payload.get("query") or {})
            return {
                "content": [{"type": "text", "text": json.dumps(data, ensure_ascii=False)}],
                "structuredContent": data,
            }

        if name == "list_mcp_servers":
            data = self.app.mcp.list_servers()
            return self._json_tool_result(data)

        if name == "import_mcp_json":
            data = self.app.mcp.import_json_snippet(
                scope=str(args.get("scope", "global")),
                project_path=args.get("projectPath"),
                raw_text=str(args.get("json", "")),
                overwrite=bool(args.get("overwrite", True)),
            )
            return self._json_tool_result(data)

        if name == "list_installed_skills":
            data = self.app.skills.list_installed_skills()
            return self._json_tool_result(data)

        if name == "scan_skill_repo":
            data = self.app.skills.scan_catalog(
                repo=str(args.get("repo", "")),
                subpath=str(args.get("subpath", "")),
                branch=str(args.get("branch", "")),
                token=str(args.get("token", "")),
                force_refresh=True,
            )
            return self._json_tool_result(data)

        if name == "install_skills_from_repo":
            data = self.app.skills.install_skills(
                repo=str(args.get("repo", "")),
                subpath=str(args.get("subpath", "")),
                branch=str(args.get("branch", "")),
                token=str(args.get("token", "")),
                skill_rel_paths=list(args.get("skillRelPaths") or []),
                scope=str(args.get("scope", "global")),
                project_path=args.get("projectPath"),
                overwrite=bool(args.get("overwrite", False)),
            )
            return self._json_tool_result(data)

        raise ValueError(f"Unknown tool: {name}")

    def _dispatch_action(
        self, action: str, body: dict[str, Any], query: dict[str, Any]
    ) -> dict[str, Any]:
        if action == "GET /api/overview":
            return self.app.get_overview()
        if action == "GET /api/cache":
            return self.app.get_cache_status()
        if action == "POST /api/cache/clear":
            return self.app.clear_cache(str(body.get("target", "")))
        if action == "GET /api/projects":
            return {"projects": self.app.store.discover_projects()}
        if action == "POST /api/projects":
            return {
                "project": self.app.store.add_custom_project(
                    str(body.get("path", "")), str(body.get("name", ""))
                )
            }
        if action == "DELETE /api/projects":
            return {"removed": self.app.store.remove_custom_project(str(query.get("path", "")))}
        if action == "GET /api/mcp":
            return self.app.mcp.list_servers()
        if action == "POST /api/mcp/parse":
            return self.app.mcp.parse_json_snippet(str(body.get("json", "")))
        if action == "POST /api/mcp/save":
            return self.app.mcp.save_server(
                scope=str(body.get("scope", "global")),
                project_path=body.get("projectPath"),
                name=str(body.get("name", "")),
                config=body.get("config") or {},
                original_name=body.get("originalName"),
                original_scope=body.get("originalScope"),
                original_project_path=body.get("originalProjectPath"),
            )
        if action == "POST /api/mcp/import":
            return self.app.mcp.import_json_snippet(
                scope=str(body.get("scope", "global")),
                project_path=body.get("projectPath"),
                raw_text=str(body.get("json", "")),
                overwrite=bool(body.get("overwrite", True)),
            )
        if action == "POST /api/mcp/toggle":
            return {
                "server": self.app.mcp.toggle_server(
                    scope=str(body.get("scope", "global")),
                    project_path=body.get("projectPath"),
                    name=str(body.get("name", "")),
                    enabled=bool(body.get("enabled", True)),
                )
            }
        if action == "DELETE /api/mcp":
            return {
                "removed": self.app.mcp.delete_server(
                    scope=str(query.get("scope", "global")),
                    project_path=query.get("projectPath"),
                    name=str(query.get("name", "")),
                )
            }
        if action == "GET /api/mcp/raw":
            return self.app.mcp.get_raw_config(
                str(query.get("scope", "global")), query.get("projectPath")
            )
        if action == "POST /api/mcp/raw":
            return self.app.mcp.save_raw_config(
                str(body.get("scope", "global")),
                body.get("projectPath"),
                str(body.get("content", "")),
            )
        if action == "GET /api/skills/installed":
            return self.app.skills.list_installed_skills()
        if action == "GET /api/skills/detail":
            return self.app.skills.get_installed_skill_detail(
                str(query.get("scope", "global")),
                query.get("projectPath"),
                str(query.get("folderName", "")),
            )
        if action == "DELETE /api/skills/installed":
            return {
                "removed": self.app.skills.delete_installed_skill(
                    str(query.get("scope", "global")),
                    query.get("projectPath"),
                    str(query.get("folderName", "")),
                )
            }
        if action == "POST /api/skills/transfer":
            return self.app.skills.transfer_installed_skill(
                src_scope=str(body.get("srcScope", "global")),
                src_project_path=body.get("srcProjectPath"),
                folder_name=str(body.get("folderName", "")),
                dst_scope=str(body.get("dstScope", "global")),
                dst_project_path=body.get("dstProjectPath"),
                move=bool(body.get("move", False)),
                overwrite=bool(body.get("overwrite", False)),
            )
        if action == "GET /api/catalogs":
            return self.app.skills.list_catalogs()
        if action == "POST /api/catalogs":
            return self.app.skills.add_catalog(
                name=str(body.get("name", "")),
                repo=str(body.get("repo", "")),
                subpath=str(body.get("subpath", "")),
                branch=str(body.get("branch", "")),
                token=str(body.get("token", "")),
                auto_scan=bool(body.get("autoScan", True)),
            )
        if action == "DELETE /api/catalogs":
            return {"removed": self.app.skills.delete_catalog(str(query.get("id", "")))}
        if action == "POST /api/catalogs/scan":
            return self.app.skills.scan_catalog(
                catalog_id=body.get("catalogId"),
                repo=body.get("repo"),
                subpath=str(body.get("subpath", "")),
                branch=str(body.get("branch", "")),
                token=str(body.get("token", "")),
                force_refresh=bool(body.get("forceRefresh", True)),
            )
        if action == "POST /api/catalogs/install":
            return self.app.skills.install_skills(
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
        if action == "GET /api/catalogs/skill-preview":
            return self.app.skills.preview_catalog_skill(
                catalog_id=query.get("catalogId"),
                repo=query.get("repo"),
                subpath=str(query.get("subpath", "")),
                branch=str(query.get("branch", "")),
                rel_path=str(query.get("relPath", "")),
            )
        raise ValueError(f"Unsupported action: {action}")

    @staticmethod
    def _json_tool_result(data: dict[str, Any]) -> dict[str, Any]:
        return {
            "content": [{"type": "text", "text": json.dumps(data, ensure_ascii=False, indent=2)}],
            "structuredContent": data,
        }

    @staticmethod
    def _ok(msg_id: Any, result: dict[str, Any]) -> dict[str, Any]:
        return {"jsonrpc": "2.0", "id": msg_id, "result": result}

    @staticmethod
    def _err(msg_id: Any, code: int, message: str) -> dict[str, Any]:
        return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": code, "message": message}}


def run_stdio_loop() -> int:
    store = ConfigStore()
    server = ControlCenterMcpServer(ControlCenterApp(store))

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        response = server.handle_request(msg)
        if response is not None:
            sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
            sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(run_stdio_loop())

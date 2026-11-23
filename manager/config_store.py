"""Configuration paths, Antigravity project discovery, and local state persistence."""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

REPO_ROOT = Path(__file__).resolve().parent.parent
PROJECT_MCP_PLUGIN_NAME = "project-mcp"

BUILTIN_CATALOGS: list[dict[str, Any]] = [
    {
        "id": "builtin-anthropic",
        "name": "Anthropic",
        "repo": "anthropics/skills",
        "subpath": "",
        "branch": "",
        "builtin": True,
        "hasToken": False,
    },
    {
        "id": "builtin-openai",
        "name": "OpenAI",
        "repo": "openai/skills",
        "subpath": "",
        "branch": "",
        "builtin": True,
        "hasToken": False,
    },
    {
        "id": "builtin-cursor",
        "name": "Cursor",
        "repo": "cursor/plugins",
        "subpath": "",
        "branch": "",
        "builtin": True,
        "hasToken": False,
    },
    {
        "id": "builtin-matt-pocock",
        "name": "Matt Pocock",
        "repo": "mattpocock/skills",
        "subpath": "",
        "branch": "",
        "builtin": True,
        "hasToken": False,
    },
]


class ConfigStore:
    """Manages Antigravity config paths, project discovery, and local tool state."""

    def __init__(
        self,
        global_config_dir: Path | str | None = None,
        data_dir: Path | str | None = None,
        current_workspace: Path | str | None = None,
    ) -> None:
        env_cfg = os.environ.get("AGY_CONFIG_DIR")
        env_data = os.environ.get("AGY_DATA_DIR") or os.environ.get("PLUGIN_DATA")

        self.global_config_dir = Path(
            global_config_dir or env_cfg or (Path.home() / ".gemini" / "config")
        ).expanduser().resolve()
        self.data_dir = Path(
            data_dir or env_data or (REPO_ROOT / "data")
        ).expanduser().resolve()
        self.current_workspace = Path(
            current_workspace or REPO_ROOT
        ).expanduser().resolve()

    @property
    def state_file(self) -> Path:
        return self.data_dir / "state.json"

    @property
    def repo_cache_dir(self) -> Path:
        return self.data_dir / "cache" / "repos"

    @property
    def antigravity_mcp_cache_dirs(self) -> list[Path]:
        env_override = os.environ.get("AGY_MCP_CACHE_DIR")
        if env_override:
            return [Path(env_override).expanduser().resolve()]
        gemini_root = self.global_config_dir.parent
        candidates = [
            gemini_root / "antigravity-cli" / "mcp",
            gemini_root / "antigravity" / "mcp",
        ]
        # Return existing dirs first, or default to antigravity-cli/mcp if none exist yet
        existing = [p for p in candidates if p.is_dir()]
        return existing if existing else [candidates[0]]

    @property
    def global_mcp_path(self) -> Path:
        return self.global_config_dir / "mcp_config.json"

    @property
    def global_skills_dir(self) -> Path:
        return self.global_config_dir / "skills"

    @property
    def global_projects_dir(self) -> Path:
        return self.global_config_dir / "projects"

    def project_mcp_plugin_dir(self, project_path: str | Path) -> Path:
        return Path(project_path).expanduser().resolve() / ".agents" / "plugins" / PROJECT_MCP_PLUGIN_NAME

    def project_mcp_path(self, project_path: str | Path) -> Path:
        return self.project_mcp_plugin_dir(project_path) / "mcp_config.json"

    def legacy_project_mcp_path(self, project_path: str | Path) -> Path:
        return Path(project_path).expanduser().resolve() / ".agents" / "mcp_config.json"

    def ensure_project_mcp_plugin_manifest(self, project_path: str | Path) -> Path:
        plugin_dir = self.project_mcp_plugin_dir(project_path)
        manifest_path = plugin_dir / "plugin.json"
        if not manifest_path.is_file():
            self.write_json_atomic(
                manifest_path,
                {
                    "$schema": "https://antigravity.google/schemas/v1/plugin.json",
                    "name": PROJECT_MCP_PLUGIN_NAME,
                    "displayName": "Project MCP",
                    "version": "1.0.0",
                    "description": "Workspace-scoped MCP servers isolated to this project.",
                },
            )
        return manifest_path

    def project_skills_dir(self, project_path: str | Path) -> Path:
        return Path(project_path).expanduser().resolve() / ".agents" / "skills"

    def read_json(self, path: Path, default: Any) -> Any:
        if not path.exists():
            return default
        raw = path.read_text(encoding="utf-8").strip()
        if not raw:
            return default
        return json.loads(raw)

    def write_json_atomic(self, path: Path, data: Any, *, private: bool = False) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        content = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
        fd, tmp_name = tempfile.mkstemp(prefix=".tmp-", suffix=".json", dir=str(path.parent))
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(content)
            os.chmod(tmp_name, 0o600 if private else 0o644)
            os.replace(tmp_name, path)
        except Exception:
            if os.path.exists(tmp_name):
                os.unlink(tmp_name)
            raise

    def load_state(self) -> dict[str, Any]:
        default = {
            "customProjects": [],
            "customCatalogs": [],
            "catalogCache": {},
        }
        try:
            data = self.read_json(self.state_file, default)
            if not isinstance(data, dict):
                return default
            for key, val in default.items():
                data.setdefault(key, val)
            return data
        except Exception:
            return default

    def save_state(self, state: dict[str, Any]) -> None:
        self.write_json_atomic(self.state_file, state, private=True)

    def discover_projects(self) -> list[dict[str, Any]]:
        """Discover Antigravity projects from ~/.gemini/config/projects + custom projects."""
        projects_by_path: dict[str, dict[str, Any]] = {}

        if self.global_projects_dir.is_dir():
            for entry in sorted(self.global_projects_dir.glob("*.json")):
                try:
                    data = self.read_json(entry, {})
                except Exception:
                    continue
                if not isinstance(data, dict):
                    continue
                name = str(data.get("name") or entry.stem)
                resources = (
                    data.get("projectResources", {}).get("resources", [])
                    if isinstance(data.get("projectResources"), dict)
                    else []
                )
                for res in resources:
                    if not isinstance(res, dict):
                        continue
                    uri = res.get("folderUri")
                    if not isinstance(uri, str) or not uri:
                        continue
                    folder_path = self._uri_to_path(uri)
                    if not folder_path:
                        continue
                    resolved = str(Path(folder_path).expanduser().resolve())
                    projects_by_path[resolved] = {
                        "id": str(data.get("id") or entry.stem),
                        "name": name,
                        "path": resolved,
                        "source": "antigravity",
                        "exists": Path(resolved).is_dir(),
                    }

        state = self.load_state()
        for item in state.get("customProjects", []):
            if not isinstance(item, dict) or not item.get("path"):
                continue
            resolved = str(Path(str(item["path"])).expanduser().resolve())
            if resolved in projects_by_path:
                continue
            projects_by_path[resolved] = {
                "id": item.get("id") or f"custom-{abs(hash(resolved))}",
                "name": str(item.get("name") or Path(resolved).name or resolved),
                "path": resolved,
                "source": "custom",
                "exists": Path(resolved).is_dir(),
            }

        result: list[dict[str, Any]] = []
        for path_str, proj in sorted(
            projects_by_path.items(), key=lambda pair: (pair[1]["name"].lower(), pair[0])
        ):
            p = Path(path_str)
            mcp_file = self.project_mcp_path(p)
            legacy_mcp_file = self.legacy_project_mcp_path(p)
            skills_dir = p / ".agents" / "skills"
            mcp_names: set[str] = set()
            for candidate_mcp in (mcp_file, legacy_mcp_file):
                if candidate_mcp.is_file():
                    try:
                        raw = self.read_json(candidate_mcp, {})
                        if isinstance(raw, dict) and isinstance(raw.get("mcpServers"), dict):
                            mcp_names.update(str(k) for k in raw["mcpServers"].keys())
                    except Exception:
                        pass
            mcp_count = len(mcp_names)
            skill_count = 0
            if skills_dir.is_dir():
                skill_count = sum(
                    1
                    for child in skills_dir.iterdir()
                    if child.is_dir() and (child / "SKILL.md").is_file()
                )
            proj["mcpConfigPath"] = str(mcp_file)
            proj["skillsDir"] = str(skills_dir)
            proj["mcpCount"] = mcp_count
            proj["skillCount"] = skill_count
            result.append(proj)
        return result

    def add_custom_project(self, path_str: str, name: str = "") -> dict[str, Any]:
        cleaned = path_str.strip()
        if not cleaned:
            raise ValueError("项目路径不能为空")
        resolved = Path(cleaned).expanduser().resolve()
        if not resolved.exists() or not resolved.is_dir():
            raise ValueError(f"目录不存在: {resolved}")

        state = self.load_state()
        custom_list = state.setdefault("customProjects", [])
        for existing in custom_list:
            if str(Path(existing.get("path", "")).expanduser().resolve()) == str(resolved):
                if name.strip():
                    existing["name"] = name.strip()
                    self.save_state(state)
                return self._find_project_or_fallback(str(resolved))

        entry = {
            "id": f"custom-{resolved.name}-{abs(hash(str(resolved))) % 100000}",
            "name": name.strip() or resolved.name or str(resolved),
            "path": str(resolved),
        }
        custom_list.append(entry)
        self.save_state(state)
        return self._find_project_or_fallback(str(resolved))

    def remove_custom_project(self, path_str: str) -> bool:
        resolved = str(Path(path_str).expanduser().resolve())
        state = self.load_state()
        before = len(state.get("customProjects", []))
        state["customProjects"] = [
            item
            for item in state.get("customProjects", [])
            if str(Path(item.get("path", "")).expanduser().resolve()) != resolved
        ]
        if len(state["customProjects"]) == before:
            return False
        self.save_state(state)
        return True

    def resolve_scope_target(
        self, scope: str, project_path: str | None = None
    ) -> tuple[str, Path | None]:
        normalized = (scope or "global").strip().lower()
        if normalized == "global":
            return "global", None
        if normalized == "project":
            if not project_path or not str(project_path).strip():
                raise ValueError("项目作用域必须指定项目路径")
            resolved = Path(project_path).expanduser().resolve()
            if not resolved.exists() or not resolved.is_dir():
                raise ValueError(f"项目目录不存在: {resolved}")
            return "project", resolved
        raise ValueError(f"不支持的作用域: {scope}")

    def _find_project_or_fallback(self, resolved: str) -> dict[str, Any]:
        for proj in self.discover_projects():
            if proj["path"] == resolved:
                return proj
        return {
            "id": f"custom-{abs(hash(resolved))}",
            "name": Path(resolved).name,
            "path": resolved,
            "source": "custom",
            "exists": Path(resolved).is_dir(),
            "mcpCount": 0,
            "skillCount": 0,
        }

    @staticmethod
    def _uri_to_path(uri: str) -> str | None:
        if uri.startswith("file://"):
            parsed = urlparse(uri)
            return unquote(parsed.path)
        if uri.startswith("/"):
            return uri
        return None

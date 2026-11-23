"""Skill discovery, Git repository catalog scanning, and installation service."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .config_store import BUILTIN_CATALOGS, ConfigStore

SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build"}
SAFE_FOLDER_RE = re.compile(r"^[A-Za-z0-9._-]+$")

_REPO_LOCKS_GUARD = threading.Lock()
_REPO_LOCKS: dict[str, threading.RLock] = {}


def _get_repo_lock(key: str) -> threading.RLock:
    with _REPO_LOCKS_GUARD:
        lock = _REPO_LOCKS.get(key)
        if lock is None:
            lock = threading.RLock()
            _REPO_LOCKS[key] = lock
        return lock


def _rmtree_force(path: Path) -> None:
    """Remove a directory tree robustly even if Git pack files or dirs are read-only."""
    if not path.exists() and not path.is_symlink():
        return
    if path.is_symlink() or path.is_file():
        path.unlink(missing_ok=True)
        return
    for root, dirs, files in os.walk(path, topdown=True):
        try:
            os.chmod(root, 0o700)
        except OSError:
            pass
        for d in dirs:
            dp = os.path.join(root, d)
            if not os.path.islink(dp):
                try:
                    os.chmod(dp, 0o700)
                except OSError:
                    pass
        for f in files:
            fp = os.path.join(root, f)
            if not os.path.islink(fp):
                try:
                    os.chmod(fp, 0o600)
                except OSError:
                    pass
    shutil.rmtree(path)


def parse_skill_markdown(text: str, fallback_name: str = "") -> dict[str, Any]:
    """Parse SKILL.md YAML frontmatter without external dependencies."""
    frontmatter: dict[str, str] = {}
    body = text
    match = re.match(r"^---\s*\r?\n(.*?)\r?\n---\s*(?:\r?\n(.*))?$", text, re.S)
    if match:
        raw_fm = match.group(1)
        body = match.group(2) or ""
        lines = raw_fm.splitlines()
        idx = 0
        while idx < len(lines):
            line = lines[idx]
            key_match = re.match(r"^([A-Za-z0-9_-]+)\s*:\s*(.*)$", line)
            if not key_match:
                idx += 1
                continue
            key = key_match.group(1).strip()
            val = key_match.group(2).strip()
            if val in (">", ">-", "|", "|-"):
                block_lines: list[str] = []
                idx += 1
                while idx < len(lines) and (lines[idx].startswith(" ") or lines[idx].startswith("\t") or lines[idx].strip() == ""):
                    block_lines.append(lines[idx].strip())
                    idx += 1
                joiner = "\n" if val.startswith("|") else " "
                frontmatter[key] = joiner.join(part for part in block_lines if part).strip()
                continue
            if (val.startswith('"') and val.endswith('"')) or (
                val.startswith("'") and val.endswith("'")
            ):
                val = val[1:-1]
            frontmatter[key] = val
            idx += 1

    name = frontmatter.get("name", "").strip() or fallback_name
    description = frontmatter.get("description", "").strip()
    if not description:
        for line in body.splitlines():
            stripped = line.strip()
            if stripped and not stripped.startswith("#"):
                description = stripped[:240]
                break
    return {
        "name": name,
        "description": description,
        "frontmatter": frontmatter,
        "body": body.strip(),
    }


def normalize_repo_input(
    repo_input: str, subpath: str = "", branch: str = ""
) -> dict[str, str]:
    """Normalize owner/repo, GitHub web URL, or Git SSH/HTTPS URL."""
    raw = repo_input.strip()
    if not raw:
        raise ValueError("仓库地址不能为空")

    clean_subpath = subpath.strip().strip("/")
    clean_branch = branch.strip()
    github_slug = ""
    web_url = ""

    # GitHub web tree URL: https://github.com/owner/repo/tree/main/skills
    tree_match = re.match(
        r"^https?://github\.com/([^/]+)/([^/]+)/tree/([^/]+)(?:/(.*))?$", raw
    )
    if tree_match:
        owner, repo, url_branch, url_subpath = tree_match.groups()
        repo = repo.removesuffix(".git")
        github_slug = f"{owner}/{repo}"
        clone_url = f"https://github.com/{owner}/{repo}.git"
        web_url = f"https://github.com/{owner}/{repo}"
        if not clean_branch:
            clean_branch = url_branch
        if not clean_subpath and url_subpath:
            clean_subpath = url_subpath.strip("/")
    elif re.match(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", raw):
        owner, repo = raw.split("/", 1)
        repo = repo.removesuffix(".git")
        github_slug = f"{owner}/{repo}"
        clone_url = f"https://github.com/{owner}/{repo}.git"
        web_url = f"https://github.com/{owner}/{repo}"
    elif raw.startswith("git@github.com:"):
        slug = raw.removeprefix("git@github.com:").removesuffix(".git").strip("/")
        github_slug = slug
        clone_url = raw
        web_url = f"https://github.com/{slug}"
    elif raw.startswith("http://") or raw.startswith("https://"):
        gh_match = re.match(r"^https?://github\.com/([^/]+)/([^/?#]+)", raw)
        if gh_match:
            owner, repo = gh_match.group(1), gh_match.group(2).removesuffix(".git")
            github_slug = f"{owner}/{repo}"
            clone_url = f"https://github.com/{owner}/{repo}.git"
            web_url = f"https://github.com/{owner}/{repo}"
        else:
            clone_url = raw
            web_url = raw.removesuffix(".git")
    elif raw.startswith("ssh://") or raw.startswith("git@") or raw.startswith("file://") or raw.startswith("/"):
        clone_url = raw
        web_url = raw
    else:
        raise ValueError("不支持的仓库地址格式，请输入 owner/repo 或完整的 Git URL")

    return {
        "repo": raw,
        "cloneUrl": clone_url,
        "webUrl": web_url,
        "githubSlug": github_slug,
        "subpath": clean_subpath,
        "branch": clean_branch,
    }


class SkillService:
    """Manages installed Antigravity skills and remote Git skill catalogs."""

    def __init__(self, store: ConfigStore) -> None:
        self.store = store

    # ------------------------------------------------------------------
    # Installed Skills
    # ------------------------------------------------------------------

    def list_installed_skills(self) -> dict[str, Any]:
        projects = self.store.discover_projects()
        installed: list[dict[str, Any]] = []

        installed.extend(
            self._scan_installed_dir(
                self.store.global_skills_dir,
                scope="global",
                project_path=None,
                project_name="所有项目（全局）",
            )
        )

        for proj in projects:
            if not proj.get("exists"):
                continue
            p_root = Path(proj["path"])
            installed.extend(
                self._scan_installed_dir(
                    p_root / ".agents" / "skills",
                    scope="project",
                    project_path=proj["path"],
                    project_name=proj["name"],
                )
            )
            # Backward-compatible .agent/skills
            legacy_dir = p_root / ".agent" / "skills"
            if legacy_dir.is_dir():
                installed.extend(
                    self._scan_installed_dir(
                        legacy_dir,
                        scope="project",
                        project_path=proj["path"],
                        project_name=f"{proj['name']} (.agent)",
                    )
                )

        return {
            "skills": installed,
            "globalSkillsDir": str(self.store.global_skills_dir),
            "projects": projects,
        }

    def get_installed_skill_detail(
        self, scope: str, project_path: str | None, folder_name: str
    ) -> dict[str, Any]:
        skill_dir = self._resolve_installed_skill_dir(
            scope, project_path, folder_name, allow_legacy_read=True
        )
        skill_md = skill_dir / "SKILL.md"
        if not skill_md.is_file():
            raise ValueError(f"未找到技能: {folder_name}")
        raw_md = skill_md.read_text(encoding="utf-8", errors="replace")
        parsed = parse_skill_markdown(raw_md, fallback_name=folder_name)
        files = sorted(
            str(p.relative_to(skill_dir))
            for p in skill_dir.rglob("*")
            if p.is_file() and ".git" not in p.parts
        )
        return {
            "folderName": folder_name,
            "name": parsed["name"],
            "description": parsed["description"],
            "frontmatter": parsed["frontmatter"],
            "markdown": raw_md,
            "path": str(skill_dir),
            "files": files,
        }

    def delete_installed_skill(
        self, scope: str, project_path: str | None, folder_name: str
    ) -> bool:
        skill_dir = self._resolve_installed_skill_dir(
            scope, project_path, folder_name, allow_legacy_read=True
        )
        if not skill_dir.is_dir():
            return False
        shutil.rmtree(skill_dir)
        return True

    def transfer_installed_skill(
        self,
        *,
        src_scope: str,
        src_project_path: str | None,
        folder_name: str,
        dst_scope: str,
        dst_project_path: str | None,
        move: bool = False,
        overwrite: bool = False,
    ) -> dict[str, Any]:
        src_dir = self._resolve_installed_skill_dir(
            src_scope, src_project_path, folder_name, allow_legacy_read=True
        )
        if not src_dir.is_dir():
            raise ValueError(f"源技能不存在: {folder_name}")

        dst_dir = self._resolve_installed_skill_dir(dst_scope, dst_project_path, folder_name)
        if src_dir == dst_dir:
            raise ValueError("源位置和目标位置相同")
        if dst_dir.exists():
            if not overwrite:
                raise ValueError(f"目标位置已存在同名技能: {folder_name}")
            shutil.rmtree(dst_dir)

        dst_dir.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(
            src_dir,
            dst_dir,
            ignore=shutil.ignore_patterns(".git"),
            ignore_dangling_symlinks=True,
        )
        if move:
            shutil.rmtree(src_dir)
        return {
            "folderName": folder_name,
            "destination": str(dst_dir),
            "moved": move,
        }

    def _resolve_installed_skill_dir(
        self,
        scope: str,
        project_path: str | None,
        folder_name: str,
        *,
        allow_legacy_read: bool = False,
    ) -> Path:
        clean = folder_name.strip()
        if not clean or "/" in clean or "\\" in clean or clean in (".", ".."):
            raise ValueError(f"非法的技能目录名: {folder_name}")
        norm_scope, norm_proj = self.store.resolve_scope_target(scope, project_path)
        base = (
            self.store.global_skills_dir
            if norm_scope == "global"
            else self.store.project_skills_dir(norm_proj)  # type: ignore[arg-type]
        )
        target = (base / clean).resolve()
        if target.parent != base.resolve():
            raise ValueError("非法技能路径")
        if allow_legacy_read and not target.is_dir() and norm_scope == "project" and norm_proj is not None:
            legacy_base = (norm_proj / ".agent" / "skills").resolve()
            legacy_target = (legacy_base / clean).resolve()
            if legacy_target.parent == legacy_base and legacy_target.is_dir():
                return legacy_target
        return target

    def _scan_installed_dir(
        self,
        skills_dir: Path,
        *,
        scope: str,
        project_path: str | None,
        project_name: str,
    ) -> list[dict[str, Any]]:
        if not skills_dir.is_dir():
            return []
        items: list[dict[str, Any]] = []
        for child in sorted(skills_dir.iterdir(), key=lambda p: p.name.lower()):
            if not child.is_dir():
                continue
            skill_md = child / "SKILL.md"
            if not skill_md.is_file():
                continue
            try:
                raw = skill_md.read_text(encoding="utf-8", errors="replace")
            except Exception:
                continue
            parsed = parse_skill_markdown(raw, fallback_name=child.name)
            file_count = sum(1 for p in child.rglob("*") if p.is_file() and ".git" not in p.parts)
            items.append(
                {
                    "folderName": child.name,
                    "name": parsed["name"],
                    "description": parsed["description"],
                    "scope": scope,
                    "projectPath": project_path,
                    "projectName": project_name,
                    "path": str(child),
                    "hasScripts": (child / "scripts").is_dir(),
                    "hasReferences": (child / "references").is_dir(),
                    "fileCount": file_count,
                }
            )
        return items

    # ------------------------------------------------------------------
    # Catalogs & Git Scanning
    # ------------------------------------------------------------------

    def list_catalogs(self) -> dict[str, Any]:
        state = self.store.load_state()
        cache = state.get("catalogCache", {})
        installed_lookup = self._build_installed_lookup()

        all_sources: list[dict[str, Any]] = []
        for src in BUILTIN_CATALOGS:
            all_sources.append(dict(src))
        for custom in state.get("customCatalogs", []):
            if isinstance(custom, dict) and custom.get("id"):
                all_sources.append(dict(custom))

        catalogs_out: list[dict[str, Any]] = []
        for src in all_sources:
            cid = src["id"]
            cached = cache.get(cid, {}) if isinstance(cache, dict) else {}
            skills = cached.get("skills", []) if isinstance(cached, dict) else []
            enriched_skills = [
                self._enrich_catalog_skill(sk, installed_lookup) for sk in skills
            ]
            catalogs_out.append(
                {
                    "id": cid,
                    "name": src.get("name") or src.get("repo"),
                    "repo": src.get("repo", ""),
                    "subpath": src.get("subpath", ""),
                    "branch": src.get("branch", ""),
                    "builtin": bool(src.get("builtin", False)),
                    "hasToken": bool(src.get("token") or src.get("hasToken")),
                    "skillCount": len(enriched_skills),
                    "stars": cached.get("stars"),
                    "updatedAt": cached.get("updatedAt"),
                    "lastScannedAt": cached.get("lastScannedAt"),
                    "error": cached.get("error"),
                    "webUrl": cached.get("webUrl") or self._safe_web_url(src.get("repo", "")),
                    "skills": enriched_skills,
                }
            )

        return {
            "catalogs": catalogs_out,
            "projects": self.store.discover_projects(),
        }

    def add_catalog(
        self,
        *,
        name: str,
        repo: str,
        subpath: str = "",
        branch: str = "",
        token: str = "",
        auto_scan: bool = True,
    ) -> dict[str, Any]:
        norm = normalize_repo_input(repo, subpath=subpath, branch=branch)
        display_name = name.strip() or norm["githubSlug"] or Path(norm["cloneUrl"]).stem
        raw_key = f"{norm['cloneUrl']}|{norm['subpath']}|{norm['branch']}"
        cid = f"custom-{hashlib.sha1(raw_key.encode('utf-8')).hexdigest()[:10]}"

        def _save_catalog(state: dict[str, Any]) -> None:
            customs = state.setdefault("customCatalogs", [])
            customs = [c for c in customs if c.get("id") != cid]
            customs.append(
                {
                    "id": cid,
                    "name": display_name,
                    "repo": norm["githubSlug"] or norm["repo"],
                    "cloneUrl": norm["cloneUrl"],
                    "subpath": norm["subpath"],
                    "branch": norm["branch"],
                    "token": token.strip(),
                    "builtin": False,
                }
            )
            state["customCatalogs"] = customs

        self.store.update_state(_save_catalog)

        scan_result = None
        if auto_scan:
            scan_result = self.scan_catalog(catalog_id=cid, force_refresh=True)

        return {
            "catalog": self._get_catalog_public(cid),
            "scan": scan_result,
        }

    def delete_catalog(self, catalog_id: str) -> bool:
        def _remove(state: dict[str, Any]) -> bool:
            customs = state.get("customCatalogs", [])
            new_customs = [c for c in customs if c.get("id") != catalog_id]
            if len(new_customs) == len(customs):
                return False
            state["customCatalogs"] = new_customs
            if isinstance(state.get("catalogCache"), dict):
                state["catalogCache"].pop(catalog_id, None)
            return True

        return bool(self.store.update_state(_remove))

    def scan_catalog(
        self,
        *,
        catalog_id: str | None = None,
        repo: str | None = None,
        subpath: str = "",
        branch: str = "",
        token: str = "",
        force_refresh: bool = True,
    ) -> dict[str, Any]:
        norm, effective_token, repo_dir = self._resolve_repo_target(
            catalog_id=catalog_id,
            repo=repo,
            subpath=subpath,
            branch=branch,
            token=token,
        )
        error_msg: str | None = None
        skills: list[dict[str, Any]] = []
        gh_meta: dict[str, Any] = {}

        try:
            with _get_repo_lock(str(repo_dir.resolve())):
                self._sync_git_repo(
                    clone_url=norm["cloneUrl"],
                    target_dir=repo_dir,
                    branch=norm["branch"],
                    token=effective_token,
                    force_refresh=force_refresh,
                )
                skills = self._scan_repo_for_skills(
                    repo_dir=repo_dir,
                    subpath=norm["subpath"],
                    repo_label=norm["githubSlug"] or norm["repo"],
                    web_url=norm["webUrl"],
                    branch=self._detect_repo_branch(repo_dir) or norm["branch"] or "main",
                )
            if norm["githubSlug"]:
                gh_meta = self._fetch_github_meta(norm["githubSlug"], effective_token)
        except Exception as exc:
            error_msg = str(exc)

        now_iso = datetime.now(timezone.utc).isoformat()
        if catalog_id:
            def _save_scan(state: dict[str, Any]) -> None:
                cache = state.setdefault("catalogCache", {})
                prev = cache.get(catalog_id, {}) if isinstance(cache.get(catalog_id), dict) else {}
                cache[catalog_id] = {
                    "skills": skills if not error_msg else prev.get("skills", []),
                    "stars": gh_meta.get("stars", prev.get("stars")),
                    "updatedAt": gh_meta.get("updatedAt", prev.get("updatedAt")),
                    "webUrl": norm["webUrl"],
                    "lastScannedAt": now_iso,
                    "error": error_msg,
                }

            self.store.update_state(_save_scan)

        installed_lookup = self._build_installed_lookup()
        enriched = [self._enrich_catalog_skill(sk, installed_lookup) for sk in skills]

        return {
            "catalogId": catalog_id,
            "repo": norm["githubSlug"] or norm["repo"],
            "subpath": norm["subpath"],
            "branch": norm["branch"],
            "webUrl": norm["webUrl"],
            "stars": gh_meta.get("stars"),
            "updatedAt": gh_meta.get("updatedAt"),
            "lastScannedAt": now_iso,
            "error": error_msg,
            "skillCount": len(enriched),
            "skills": enriched,
        }

    def preview_catalog_skill(
        self,
        *,
        catalog_id: str | None = None,
        repo: str | None = None,
        subpath: str = "",
        branch: str = "",
        token: str = "",
        rel_path: str,
    ) -> dict[str, Any]:
        _, _, resolved_repo_dir = self._resolve_repo_target(
            catalog_id=catalog_id,
            repo=repo,
            subpath=subpath,
            branch=branch,
            token=token,
        )
        with _get_repo_lock(str(resolved_repo_dir.resolve())):
            repo_dir = self._ensure_repo_for_operation(
                catalog_id=catalog_id,
                repo=repo,
                subpath=subpath,
                branch=branch,
                token=token,
            )
            skill_dir = self._safe_subpath(repo_dir, rel_path)
            skill_md = skill_dir / "SKILL.md"
            if not skill_md.is_file():
                raise ValueError("未找到 SKILL.md")
            raw = skill_md.read_text(encoding="utf-8", errors="replace")
            parsed = parse_skill_markdown(raw, fallback_name=skill_dir.name)
            files = sorted(
                str(p.relative_to(skill_dir))
                for p in skill_dir.rglob("*")
                if p.is_file() and ".git" not in p.parts
            )
            return {
                "name": parsed["name"],
                "description": parsed["description"],
                "markdown": raw,
                "relPath": rel_path,
                "files": files,
            }

    def install_skills(
        self,
        *,
        catalog_id: str | None = None,
        repo: str | None = None,
        subpath: str = "",
        branch: str = "",
        token: str = "",
        skill_rel_paths: list[str],
        scope: str,
        project_path: str | None = None,
        overwrite: bool = False,
    ) -> dict[str, Any]:
        if not skill_rel_paths:
            raise ValueError("请至少选择一个要安装的技能")

        norm_scope, norm_proj = self.store.resolve_scope_target(scope, project_path)
        target_root = (
            self.store.global_skills_dir
            if norm_scope == "global"
            else self.store.project_skills_dir(norm_proj)  # type: ignore[arg-type]
        )
        target_root.mkdir(parents=True, exist_ok=True)

        installed: list[dict[str, Any]] = []
        skipped: list[dict[str, Any]] = []
        errors: list[dict[str, Any]] = []

        _, _, resolved_repo_dir = self._resolve_repo_target(
            catalog_id=catalog_id,
            repo=repo,
            subpath=subpath,
            branch=branch,
            token=token,
        )
        with _get_repo_lock(str(resolved_repo_dir.resolve())):
            repo_dir = self._ensure_repo_for_operation(
                catalog_id=catalog_id,
                repo=repo,
                subpath=subpath,
                branch=branch,
                token=token,
            )

            for rel in skill_rel_paths:
                try:
                    src_dir = self._safe_subpath(repo_dir, rel)
                    skill_md = src_dir / "SKILL.md"
                    if not skill_md.is_file():
                        raise ValueError(f"目录 {rel} 缺少 SKILL.md")
                    parsed = parse_skill_markdown(
                        skill_md.read_text(encoding="utf-8", errors="replace"),
                        fallback_name=src_dir.name,
                    )
                    folder_name = self._sanitize_folder_name(parsed["name"] or src_dir.name)
                    dst_dir = (target_root / folder_name).resolve()
                    if dst_dir.parent != target_root.resolve():
                        raise ValueError(f"非法安装目录名: {folder_name}")

                    if dst_dir.exists():
                        if not overwrite:
                            skipped.append(
                                {
                                    "name": folder_name,
                                    "relPath": rel,
                                    "reason": "目标位置已存在同名技能",
                                }
                            )
                            continue
                        shutil.rmtree(dst_dir)

                    shutil.copytree(
                        src_dir,
                        dst_dir,
                        ignore=shutil.ignore_patterns(".git"),
                        ignore_dangling_symlinks=True,
                    )
                    installed.append(
                        {
                            "name": folder_name,
                            "relPath": rel,
                            "destination": str(dst_dir),
                        }
                    )
                except Exception as exc:
                    errors.append({"relPath": rel, "error": str(exc)})

        return {
            "scope": norm_scope,
            "projectPath": str(norm_proj) if norm_proj else None,
            "targetRoot": str(target_root),
            "installed": installed,
            "skipped": skipped,
            "errors": errors,
        }

    # ------------------------------------------------------------------
    # Internal Git & Helper Utilities
    # ------------------------------------------------------------------

    def _find_catalog_source(self, catalog_id: str) -> dict[str, Any] | None:
        for src in BUILTIN_CATALOGS:
            if src["id"] == catalog_id:
                return dict(src)
        state = self.store.load_state()
        for custom in state.get("customCatalogs", []):
            if custom.get("id") == catalog_id:
                return dict(custom)
        return None

    def _get_catalog_public(self, catalog_id: str) -> dict[str, Any] | None:
        for item in self.list_catalogs()["catalogs"]:
            if item["id"] == catalog_id:
                return item
        return None

    def _resolve_repo_target(
        self,
        *,
        catalog_id: str | None,
        repo: str | None,
        subpath: str,
        branch: str,
        token: str,
    ) -> tuple[dict[str, str], str, Path]:
        if catalog_id:
            source = self._find_catalog_source(catalog_id)
            if not source:
                raise ValueError(f"未找到技能目录: {catalog_id}")
            norm = normalize_repo_input(
                source.get("cloneUrl") or source["repo"],
                subpath=source.get("subpath", ""),
                branch=source.get("branch", ""),
            )
            effective_token = token.strip() or str(source.get("token") or "").strip()
        else:
            norm = normalize_repo_input(repo or "", subpath=subpath, branch=branch)
            effective_token = token.strip()

        repo_dir = self._cache_dir_for_repo(norm["cloneUrl"], norm["branch"])
        return norm, effective_token, repo_dir

    def _ensure_repo_for_operation(
        self,
        *,
        catalog_id: str | None,
        repo: str | None,
        subpath: str,
        branch: str,
        token: str,
    ) -> Path:
        norm, effective_token, repo_dir = self._resolve_repo_target(
            catalog_id=catalog_id,
            repo=repo,
            subpath=subpath,
            branch=branch,
            token=token,
        )
        with _get_repo_lock(str(repo_dir.resolve())):
            if not (repo_dir / ".git").exists():
                self._sync_git_repo(
                    clone_url=norm["cloneUrl"],
                    target_dir=repo_dir,
                    branch=norm["branch"],
                    token=effective_token,
                    force_refresh=True,
                )
        return repo_dir

    def _cache_dir_for_repo(self, clone_url: str, branch: str) -> Path:
        digest = hashlib.sha1(f"{clone_url}#{branch}".encode("utf-8")).hexdigest()[:16]
        return self.store.repo_cache_dir / digest

    def _sync_git_repo(
        self,
        *,
        clone_url: str,
        target_dir: Path,
        branch: str,
        token: str,
        force_refresh: bool,
    ) -> None:
        lock = _get_repo_lock(str(target_dir.resolve()))
        with lock:
            target_dir.parent.mkdir(parents=True, exist_ok=True)
            env = dict(os.environ)
            env["GIT_TERMINAL_PROMPT"] = "0"

            auth_args: list[str] = []
            if token and clone_url.startswith(("https://", "http://")):
                basic = base64.b64encode(f"x-access-token:{token}".encode("utf-8")).decode("ascii")
                auth_args = ["-c", f"http.extraHeader=AUTHORIZATION: basic {basic}"]

            if (target_dir / ".git").exists():
                if not force_refresh:
                    return
                fetch_cmd = ["git", *auth_args, "-C", str(target_dir), "fetch", "--depth", "1", "origin"]
                if branch:
                    fetch_cmd.append(branch)
                proc = self._run_git(fetch_cmd, env=env)
                if proc.returncode == 0:
                    reset_proc = self._run_git(
                        ["git", "-C", str(target_dir), "reset", "--hard", "FETCH_HEAD"], env=env
                    )
                    if reset_proc.returncode == 0:
                        return

            # Clone cleanly into a unique staging directory, then swap atomically
            staging_dir = target_dir.parent / f".tmp-{target_dir.name}-{uuid.uuid4().hex[:8]}"
            clone_cmd = ["git", *auth_args, "clone", "--depth", "1", "--single-branch"]
            if branch:
                clone_cmd.extend(["--branch", branch])
            clone_cmd.extend([clone_url, str(staging_dir)])

            try:
                proc = self._run_git(clone_cmd, env=env)
                if proc.returncode != 0:
                    raise RuntimeError(self._friendly_git_error(proc.stderr or proc.stdout))

                if target_dir.exists() or target_dir.is_symlink():
                    _rmtree_force(target_dir)
                os.replace(staging_dir, target_dir)
            finally:
                if staging_dir.exists() or staging_dir.is_symlink():
                    try:
                        _rmtree_force(staging_dir)
                    except OSError:
                        shutil.rmtree(staging_dir, ignore_errors=True)

    @staticmethod
    def _run_git(cmd: list[str], env: dict[str, str]) -> subprocess.CompletedProcess[str]:
        try:
            return subprocess.run(
                cmd,
                env=env,
                capture_output=True,
                text=True,
                timeout=90,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError("Git 仓库扫描超时，请检查网络或仓库地址") from exc

    @staticmethod
    def _friendly_git_error(stderr: str) -> str:
        low = stderr.lower()
        if (
            "authentication failed" in low
            or "could not read username" in low
            or "permission denied" in low
            or "repository not found" in low
            or "terminal prompts disabled" in low
        ):
            return "Authentication required to access this repository（私有仓库请填写 Token 或检查仓库地址）"
        if "could not resolve host" in low or "unable to access" in low:
            return f"无法连接到 Git 仓库：{stderr.strip().splitlines()[-1] if stderr.strip() else '网络错误'}"
        return stderr.strip() or "Git 扫描失败"

    @staticmethod
    def _detect_repo_branch(repo_dir: Path) -> str:
        proc = subprocess.run(
            ["git", "-C", str(repo_dir), "rev-parse", "--abbrev-ref", "HEAD"],
            capture_output=True,
            text=True,
            check=False,
        )
        branch = proc.stdout.strip()
        return "" if branch in ("", "HEAD") else branch

    def _scan_repo_for_skills(
        self,
        *,
        repo_dir: Path,
        subpath: str,
        repo_label: str,
        web_url: str,
        branch: str,
    ) -> list[dict[str, Any]]:
        search_root = self._safe_subpath(repo_dir, subpath) if subpath else repo_dir
        if not search_root.is_dir():
            raise ValueError(f"仓库中不存在子路径: {subpath}")

        found: list[dict[str, Any]] = []
        for root, dirs, files in os.walk(search_root):
            dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
            if "SKILL.md" not in files:
                continue
            skill_dir = Path(root)
            rel_path = str(skill_dir.relative_to(repo_dir))
            if rel_path == ".":
                rel_path = ""
            skill_md = skill_dir / "SKILL.md"
            try:
                raw = skill_md.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            fallback = skill_dir.name if rel_path else Path(repo_label).name
            parsed = parse_skill_markdown(raw, fallback_name=fallback)
            folder_name = self._sanitize_folder_name(parsed["name"] or fallback)

            browse_url = ""
            if web_url.startswith("https://github.com/"):
                browse_url = (
                    f"{web_url}/tree/{branch}/{rel_path}" if rel_path else web_url
                )

            found.append(
                {
                    "name": parsed["name"] or folder_name,
                    "folderName": folder_name,
                    "description": parsed["description"],
                    "relPath": rel_path or ".",
                    "repoLabel": repo_label,
                    "browseUrl": browse_url,
                    "hasScripts": (skill_dir / "scripts").is_dir(),
                    "hasReferences": (skill_dir / "references").is_dir(),
                }
            )
            # Don't descend into nested folders inside an already-matched skill package
            dirs.clear()

        found.sort(key=lambda s: s["name"].lower())
        return found

    def _fetch_github_meta(self, slug: str, token: str = "") -> dict[str, Any]:
        req = urllib.request.Request(
            f"https://api.github.com/repos/{slug}",
            headers={
                "Accept": "application/vnd.github+json",
                "User-Agent": "agy-control-center",
                **({"Authorization": f"Bearer {token}"} if token else {}),
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=4) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                return {
                    "stars": data.get("stargazers_count"),
                    "updatedAt": data.get("pushed_at") or data.get("updated_at"),
                }
        except (urllib.error.URLError, TimeoutError, ValueError):
            return {}

    def _build_installed_lookup(self) -> dict[str, list[dict[str, Any]]]:
        lookup: dict[str, list[dict[str, Any]]] = {}
        for item in self.list_installed_skills()["skills"]:
            key = item["folderName"].lower()
            lookup.setdefault(key, []).append(
                {
                    "scope": item["scope"],
                    "projectName": item["projectName"],
                    "projectPath": item["projectPath"],
                }
            )
        return lookup

    @staticmethod
    def _enrich_catalog_skill(
        skill: dict[str, Any], lookup: dict[str, list[dict[str, Any]]]
    ) -> dict[str, Any]:
        out = dict(skill)
        key = str(skill.get("folderName") or skill.get("name") or "").lower()
        out["installedIn"] = lookup.get(key, [])
        return out

    @staticmethod
    def _safe_subpath(base: Path, rel: str) -> Path:
        base_res = base.resolve()
        if not rel or rel == ".":
            return base_res
        target = (base_res / rel).resolve()
        if target != base_res and base_res not in target.parents:
            raise ValueError(f"非法子路径: {rel}")
        return target

    @staticmethod
    def _sanitize_folder_name(raw: str) -> str:
        cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", raw.strip().lower()).strip("-")
        return cleaned or f"skill-{int(time.time())}"

    @staticmethod
    def _safe_web_url(repo: str) -> str:
        try:
            return normalize_repo_input(repo)["webUrl"]
        except Exception:
            return ""

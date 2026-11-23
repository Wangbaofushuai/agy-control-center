"""Isolated end-to-end tests for Antigravity Control Center (Web API + MCP Plugin)."""

from __future__ import annotations

import io
import json
import re
import struct
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "plugins" / "agy-control-center" / "scripts"))

from manager.config_store import ConfigStore
from manager.mcp_service import McpService, resolve_stdio_command
from manager.skill_service import SkillService, normalize_repo_input, parse_skill_markdown
from manager.web_server import ControlCenterApp, create_server
import mcp_server


class ControlCenterTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="agy-cc-test-")
        self.root = Path(self._tmp.name)
        self.global_cfg = self.root / "global_config"
        self.data_dir = self.root / "data"
        self.proj_a = self.root / "project_alpha"
        self.proj_b = self.root / "project_beta"
        self.proj_a.mkdir(parents=True)
        self.proj_b.mkdir(parents=True)

        # Simulate Antigravity discovered project JSON
        projects_dir = self.global_cfg / "projects"
        projects_dir.mkdir(parents=True)
        (projects_dir / "alpha.json").write_text(
            json.dumps(
                {
                    "id": "alpha-id",
                    "name": "Alpha",
                    "projectResources": {
                        "resources": [{"folderUri": f"file://{self.proj_a}"}]
                    },
                }
            ),
            encoding="utf-8",
        )
        # Empty global mcp_config.json (matching real Antigravity fresh install)
        (self.global_cfg / "mcp_config.json").write_text("", encoding="utf-8")

        self.store = ConfigStore(
            global_config_dir=self.global_cfg,
            data_dir=self.data_dir,
            current_workspace=self.proj_a,
        )
        self.mcp = McpService(self.store)
        self.skills = SkillService(self.store)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _create_sample_skill_git_repo(self) -> Path:
        repo = self.root / "sample-skills-repo"
        repo.mkdir()
        s1 = repo / "skills" / "code-review"
        (s1 / "scripts").mkdir(parents=True)
        (s1 / "SKILL.md").write_text(
            "---\nname: code-review\ndescription: >-\n  Review pull requests thoroughly.\n---\n# Code Review\n",
            encoding="utf-8",
        )
        (s1 / "scripts" / "check.sh").write_text("#!/bin/sh\necho ok\n", encoding="utf-8")
        (s1 / "scripts" / "check.sh").chmod(0o755)

        s2 = repo / "skills" / "sql-helper"
        s2.mkdir(parents=True)
        (s2 / "SKILL.md").write_text(
            "---\nname: sql-helper\ndescription: Optimize SQL queries.\n---\n# SQL Helper\n",
            encoding="utf-8",
        )

        subprocess.run(["git", "init", "-b", "main", str(repo)], check=True, capture_output=True)
        subprocess.run(["git", "-C", str(repo), "config", "--local", "user.name", "test"], check=True)
        subprocess.run(["git", "-C", str(repo), "config", "--local", "user.email", "test@local"], check=True)
        subprocess.run(["git", "-C", str(repo), "add", "."], check=True)
        subprocess.run(["git", "-C", str(repo), "commit", "-m", "init"], check=True, capture_output=True)
        return repo

    def test_project_discovery_and_custom_project(self) -> None:
        projects = self.store.discover_projects()
        paths = [p["path"] for p in projects]
        self.assertIn(str(self.proj_a.resolve()), paths)

        # Fresh install with empty projects dir must NOT inject app install dir as fake workspace
        empty_cfg = self.root / "empty_cfg"
        empty_cfg.mkdir()
        empty_store = ConfigStore(
            global_config_dir=empty_cfg,
            data_dir=self.root / "empty_data",
            current_workspace=self.proj_b,
        )
        self.assertEqual(empty_store.discover_projects(), [])

        added = self.store.add_custom_project(str(self.proj_b), "Beta")
        self.assertEqual(added["name"], "Beta")
        self.assertIn(str(self.proj_b.resolve()), [p["path"] for p in self.store.discover_projects()])

        self.assertTrue(self.store.remove_custom_project(str(self.proj_b)))
        self.assertNotIn(str(self.proj_b.resolve()), [p["path"] for p in self.store.discover_projects()])

    def test_concurrent_skill_repo_scan_is_race_free(self) -> None:
        repo_path = self._create_sample_skill_git_repo()
        added = self.skills.add_catalog(
            name="Concurrent Repo",
            repo=str(repo_path),
            subpath="skills",
            auto_scan=False,
        )
        cid = added["catalog"]["id"]
        results: list[dict] = []
        errors: list[Exception] = []

        def worker() -> None:
            try:
                results.append(self.skills.scan_catalog(catalog_id=cid, force_refresh=True))
            except Exception as exc:
                errors.append(exc)

        threads = [threading.Thread(target=worker) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=30)

        self.assertEqual(errors, [])
        self.assertEqual(len(results), 4)
        for res in results:
            self.assertIsNone(res["error"])
            self.assertEqual(res["skillCount"], 2)

    def test_mcp_json_parse_variants(self) -> None:
        # 1. Antigravity / Claude mcpServers wrapped in markdown fence
        raw_fence = """```json
        {
          "mcpServers": {
            "postgres": {
              "command": "npx",
              "args": ["-y", "@modelcontextprotocol/server-postgres"]
            }
          }
        }
        ```"""
        parsed = self.mcp.parse_json_snippet(raw_fence)
        self.assertEqual(len(parsed["servers"]), 1)
        self.assertEqual(parsed["servers"][0]["name"], "postgres")
        self.assertTrue(parsed["servers"][0]["config"]["command"].endswith("npx"))

        # 2. OpenCode / OpenChamber mcp format + legacy SSE warning
        opencode_raw = json.dumps(
            {
                "mcp": {
                    "local-tool": {
                        "type": "local",
                        "command": ["python3", "server.py"],
                        "environment": {"TOKEN": "abc"},
                        "timeout": 15000,
                    },
                    "remote-sse": {
                        "type": "remote",
                        "url": "https://example.com/sse",
                    },
                }
            }
        )
        parsed2 = self.mcp.parse_json_snippet(opencode_raw)
        self.assertEqual(len(parsed2["servers"]), 2)
        by_name = {s["name"]: s for s in parsed2["servers"]}
        self.assertEqual(by_name["local-tool"]["config"]["command"], "python3")
        self.assertEqual(by_name["local-tool"]["config"]["args"], ["server.py"])
        self.assertEqual(by_name["local-tool"]["config"]["env"], {"TOKEN": "abc"})
        self.assertEqual(by_name["local-tool"]["config"]["timeoutSeconds"], 15)
        self.assertEqual(by_name["remote-sse"]["config"]["serverUrl"], "https://example.com/sse")
        self.assertTrue(any("/sse" in w for w in parsed2["warnings"]))

    def test_mcp_crud_global_and_project(self) -> None:
        # Save to global
        self.mcp.save_server(
            scope="global",
            project_path=None,
            name="pg",
            config={"command": "npx\n-y\n@modelcontextprotocol/server-postgres", "env": {"PG": "1"}},
        )
        # Save to project (must create isolated project-mcp plugin + manifest)
        self.mcp.save_server(
            scope="project",
            project_path=str(self.proj_a),
            name="remote-api",
            config={"serverUrl": "https://api.example.com/mcp", "headers": {"X-Key": "k"}},
        )
        plugin_dir = self.proj_a / ".agents" / "plugins" / "project-mcp"
        self.assertTrue((plugin_dir / "plugin.json").is_file())
        self.assertTrue((plugin_dir / "mcp_config.json").is_file())

        listed = self.mcp.list_servers()["servers"]
        self.assertEqual(len(listed), 2)

        # Toggle disabled
        toggled = self.mcp.toggle_server("global", None, "pg", False)
        self.assertFalse(toggled["enabled"])
        self.assertTrue(toggled["config"].get("disabled"))

        # Move from project to global
        self.mcp.save_server(
            scope="global",
            project_path=None,
            name="remote-api-global",
            config={"serverUrl": "https://api.example.com/mcp"},
            original_name="remote-api",
            original_scope="project",
            original_project_path=str(self.proj_a),
        )
        proj_doc = json.loads((plugin_dir / "mcp_config.json").read_text(encoding="utf-8"))
        self.assertEqual(proj_doc["mcpServers"], {})

        # Legacy .agents/mcp_config.json entry is discoverable and auto-cleaned on migration
        legacy_file = self.proj_a / ".agents" / "mcp_config.json"
        legacy_file.write_text(
            json.dumps({"mcpServers": {"legacy-srv": {"command": "echo", "args": ["ok"]}}}),
            encoding="utf-8",
        )
        self.assertIn("legacy-srv", [s["name"] for s in self.mcp.list_servers()["servers"]])
        self.mcp.save_server(
            scope="project",
            project_path=str(self.proj_a),
            name="legacy-srv",
            config={"command": "echo", "args": ["migrated"]},
            original_name="legacy-srv",
            original_scope="project",
            original_project_path=str(self.proj_a),
        )
        self.assertFalse(legacy_file.exists())
        self.assertIn(
            "legacy-srv",
            json.loads((plugin_dir / "mcp_config.json").read_text(encoding="utf-8"))["mcpServers"],
        )

        # Delete
        self.assertTrue(self.mcp.delete_server("global", None, "pg"))
        self.assertTrue(self.mcp.delete_server("project", str(self.proj_a), "legacy-srv"))
        self.assertEqual(len(self.mcp.list_servers()["servers"]), 1)

    def test_skill_scan_install_transfer_and_delete(self) -> None:
        repo_path = self._create_sample_skill_git_repo()

        # Normalize helper check
        norm = normalize_repo_input("https://github.com/anthropics/skills/tree/main/skills")
        self.assertEqual(norm["githubSlug"], "anthropics/skills")
        self.assertEqual(norm["branch"], "main")
        self.assertEqual(norm["subpath"], "skills")

        # Add local git repo as custom catalog and auto-scan
        added = self.skills.add_catalog(
            name="Local Test Repo",
            repo=str(repo_path),
            subpath="skills",
            auto_scan=True,
        )
        self.assertEqual(added["scan"]["skillCount"], 2)
        names = [s["name"] for s in added["scan"]["skills"]]
        self.assertEqual(names, ["code-review", "sql-helper"])
        cid = added["catalog"]["id"]

        # Install code-review to global and sql-helper to project
        res_global = self.skills.install_skills(
            catalog_id=cid,
            skill_rel_paths=["skills/code-review"],
            scope="global",
        )
        self.assertEqual(len(res_global["installed"]), 1)
        self.assertTrue((self.global_cfg / "skills" / "code-review" / "scripts" / "check.sh").is_file())

        res_proj = self.skills.install_skills(
            catalog_id=cid,
            skill_rel_paths=["skills/sql-helper"],
            scope="project",
            project_path=str(self.proj_a),
        )
        self.assertEqual(len(res_proj["installed"]), 1)
        self.assertTrue((self.proj_a / ".agents" / "skills" / "sql-helper" / "SKILL.md").is_file())

        # Conflict skip when overwrite=False
        res_dup = self.skills.install_skills(
            catalog_id=cid,
            skill_rel_paths=["skills/code-review"],
            scope="global",
            overwrite=False,
        )
        self.assertEqual(len(res_dup["skipped"]), 1)

        # Transfer copy global -> project
        self.skills.transfer_installed_skill(
            src_scope="global",
            src_project_path=None,
            folder_name="code-review",
            dst_scope="project",
            dst_project_path=str(self.proj_a),
            move=False,
        )
        self.assertTrue((self.proj_a / ".agents" / "skills" / "code-review" / "SKILL.md").is_file())

        # Uninstall
        self.assertTrue(self.skills.delete_installed_skill("global", None, "code-review"))
        self.assertFalse((self.global_cfg / "skills" / "code-review").exists())

    def test_web_server_http_api(self) -> None:
        server = create_server(
            host="127.0.0.1",
            port=0,
            global_config_dir=str(self.global_cfg),
            data_dir=str(self.data_dir),
        )
        port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/overview", timeout=5) as resp:
                self.assertEqual(resp.status, 200)
                ov = json.loads(resp.read().decode("utf-8"))
                self.assertIn("counts", ov)

            with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=5) as resp:
                self.assertEqual(resp.status, 200)
                html = resp.read().decode("utf-8")
                self.assertIn("Antigravity 控制中心", html)

            req = urllib.request.Request(
                f"http://127.0.0.1:{port}/api/mcp/import",
                data=json.dumps(
                    {
                        "scope": "project",
                        "projectPath": str(self.proj_a),
                        "json": '{"mcpServers":{"demo":{"command":"echo","args":["hi"]}}}',
                    }
                ).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=5) as resp:
                body = json.loads(resp.read().decode("utf-8"))
                self.assertEqual(body["imported"], ["demo"])
        finally:
            server.shutdown()
            server.server_close()

    def test_mcp_plugin_server_protocol(self) -> None:
        app = ControlCenterApp(self.store)
        srv = mcp_server.ControlCenterMcpServer(app)

        init_res = srv.handle_request({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
        self.assertEqual(init_res["result"]["serverInfo"]["name"], "agy-control-center")

        tools_res = srv.handle_request({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
        tool_names = [t["name"] for t in tools_res["result"]["tools"]]
        self.assertIn("open_control_center", tool_names)
        self.assertIn("import_mcp_json", tool_names)
        self.assertIn("scan_skill_repo", tool_names)

        ui_res = srv.handle_request(
            {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "resources/read",
                "params": {"uri": mcp_server.UI_RESOURCE_URI},
            }
        )
        content_item = ui_res["result"]["contents"][0]
        self.assertEqual(content_item["mimeType"], "text/html;profile=mcp-app")
        self.assertIn("window.__MCP_APP_MODE__ = true;", content_item["text"])

        action_res = srv.handle_request(
            {
                "jsonrpc": "2.0",
                "id": 4,
                "method": "tools/call",
                "params": {
                    "name": "control_center_action",
                    "arguments": {"action": "GET /api/overview", "payload": {}},
                },
            }
        )
        self.assertIn("globalConfigDir", action_res["result"]["structuredContent"])

    def test_parse_skill_markdown(self) -> None:
        md = "---\nname: my-skill\ndescription: >-\n  Line one\n  Line two.\n---\n# Body"
        parsed = parse_skill_markdown(md)
        self.assertEqual(parsed["name"], "my-skill")
        self.assertEqual(parsed["description"], "Line one Line two.")

    def test_cors_token_and_extension_zip(self) -> None:
        server = create_server(
            host="127.0.0.1",
            port=0,
            global_config_dir=str(self.global_cfg),
            data_dir=str(self.data_dir),
            api_token="secret-123",
        )
        port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            # OPTIONS preflight
            opt_req = urllib.request.Request(f"http://127.0.0.1:{port}/api/overview", method="OPTIONS")
            with urllib.request.urlopen(opt_req, timeout=5) as resp:
                self.assertEqual(resp.status, 204)
                self.assertEqual(resp.headers.get("Access-Control-Allow-Origin"), "*")

            # Unauthorized without token
            with self.assertRaises(urllib.error.HTTPError) as ctx:
                urllib.request.urlopen(f"http://127.0.0.1:{port}/api/overview", timeout=5)
            self.assertEqual(ctx.exception.code, 401)

            # Authorized with X-API-Token
            auth_req = urllib.request.Request(
                f"http://127.0.0.1:{port}/api/overview",
                headers={"X-API-Token": "secret-123"},
            )
            with urllib.request.urlopen(auth_req, timeout=5) as resp:
                self.assertEqual(resp.status, 200)
                ov = json.loads(resp.read().decode("utf-8"))
                self.assertTrue(ov["extensionReady"])

            # Extension ZIP download (publicly downloadable)
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/extension.zip", timeout=5) as resp:
                self.assertEqual(resp.status, 200)
                zf = zipfile.ZipFile(io.BytesIO(resp.read()))
                names = set(zf.namelist())
                self.assertIn("agy-control-center-extension/manifest.json", names)
                self.assertIn("agy-control-center-extension/background.js", names)
                self.assertIn("agy-control-center-extension/sidepanel/sidepanel.html", names)
                self.assertIn("agy-control-center-extension/icons/icon-128.png", names)
        finally:
            server.shutdown()
            server.server_close()

    def test_chrome_extension_mv3_integrity(self) -> None:
        ext_dir = REPO_ROOT / "extension"
        manifest = json.loads((ext_dir / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["manifest_version"], 3)
        self.assertNotIn("default_popup", manifest.get("action", {}))
        self.assertTrue((ext_dir / manifest["side_panel"]["default_path"]).is_file())
        self.assertTrue((ext_dir / manifest["background"]["service_worker"]).is_file())

        # Verify every declared PNG icon exists and matches exact dimensions
        for size_str, rel_path in manifest["icons"].items():
            icon_file = ext_dir / rel_path
            self.assertTrue(icon_file.is_file(), f"Missing icon: {rel_path}")
            raw = icon_file.read_bytes()
            self.assertEqual(raw[:8], b"\x89PNG\r\n\x1a\n")
            w, h = struct.unpack(">II", raw[16:24])
            self.assertEqual((w, h), (int(size_str), int(size_str)))

        # Verify strict MV3 CSP (no inline script or inline event handlers in HTML)
        html = (ext_dir / "sidepanel" / "sidepanel.html").read_text(encoding="utf-8")
        self.assertIsNone(re.search(r"<script(?![^>]*\bsrc=)[^>]*>", html, re.I))
        self.assertIsNone(re.search(r"\son[a-z]+\s*=", html, re.I))

    def test_resolve_stdio_command_user_bin_fallback(self) -> None:
        fake_bin = self.root / "user_bin"
        fake_bin.mkdir()
        fake_uvx = fake_bin / "fake-uvx"
        fake_uvx.write_text("#!/bin/sh\necho ok\n", encoding="utf-8")
        fake_uvx.chmod(0o755)

        # Even if interactive shell PATH contains fake_bin, it is not in system_path -> must resolve
        resolved_from_shell, warn_shell = resolve_stdio_command(
            "fake-uvx", system_path="/nonexistent", user_path=str(fake_bin), extra_dirs=[]
        )
        self.assertEqual(resolved_from_shell, str(fake_uvx))
        self.assertIn("绝对路径", warn_shell or "")

        # Also resolves from extra_dirs when absent from both system_path and user_path
        resolved, warn = resolve_stdio_command(
            "fake-uvx", system_path="/nonexistent", user_path="", extra_dirs=[fake_bin]
        )
        self.assertEqual(resolved, str(fake_uvx))
        self.assertIsNotNone(warn)
        self.assertIn("绝对路径", warn or "")

        missing, warn2 = resolve_stdio_command(
            "definitely-not-installed-cmd",
            system_path="/nonexistent",
            user_path="",
            extra_dirs=[fake_bin],
        )
        self.assertEqual(missing, "definitely-not-installed-cmd")
        self.assertIsNotNone(warn2)
        self.assertIn("未找到", warn2 or "")

    def test_cache_status_and_cleanup(self) -> None:
        # Configure one active isolated project MCP: project-mcp_demo
        self.mcp.save_server(
            scope="project",
            project_path=str(self.proj_a),
            name="demo",
            config={"command": "echo", "args": ["hi"]},
        )

        # Populate isolated mock antigravity-cli/mcp cache dir (sibling of global_config)
        mcp_cache = self.global_cfg.parent / "antigravity-cli" / "mcp"
        active_dir = mcp_cache / "project-mcp_demo"
        stale_dir = mcp_cache / "old-removed-server"
        active_dir.mkdir(parents=True)
        stale_dir.mkdir(parents=True)
        (active_dir / "tool_a.json").write_text('{"name":"a"}', encoding="utf-8")
        (stale_dir / "tool_b.json").write_text('{"name":"b"}', encoding="utf-8")

        # Populate mock skill repo cache
        repo_cache = self.data_dir / "cache" / "repos" / "abc123"
        repo_cache.mkdir(parents=True)
        (repo_cache / "SKILL.md").write_text("# cached", encoding="utf-8")

        app = ControlCenterApp(self.store)
        status = app.get_cache_status()
        self.assertEqual(status["mcpTotalCount"], 2)
        self.assertEqual(status["mcpStaleCount"], 1)
        by_name = {e["name"]: e for e in status["mcpEntries"]}
        self.assertFalse(by_name["project-mcp_demo"]["stale"])
        self.assertTrue(by_name["old-removed-server"]["stale"])
        self.assertEqual(status["skillRepoCache"]["repoCount"], 1)

        # 1. Clear stale only -> preserves active project-mcp_demo
        res_stale = app.clear_cache("mcp_stale")
        self.assertEqual(res_stale["removedNames"], ["old-removed-server"])
        self.assertFalse(stale_dir.exists())
        self.assertTrue(active_dir.exists())

        # 2. Clear all MCP cache
        res_all = app.clear_cache("mcp_all")
        self.assertEqual(res_all["removedNames"], ["project-mcp_demo"])
        self.assertFalse(active_dir.exists())

        # 3. Clear skill repo cache
        res_repos = app.clear_cache("skill_repos")
        self.assertEqual(res_repos["removedCount"], 1)
        self.assertFalse(repo_cache.exists())

    def test_install_and_sm_scripts_syntax_and_daemon(self) -> None:
        install_sh = REPO_ROOT / "install.sh"
        sm_sh = REPO_ROOT / "scripts" / "sm.sh"
        self.assertTrue(install_sh.is_file())
        self.assertTrue(sm_sh.is_file())

        # Syntax check both shell scripts with bash -n
        for script in (install_sh, sm_sh):
            proc = subprocess.run(["bash", "-n", str(script)], capture_output=True, text=True)
            self.assertEqual(proc.returncode, 0, f"Syntax error in {script}: {proc.stderr}")

        # Exercise sm.sh start / status / stop in isolated nohup mode (no host touch)
        import socket
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            free_port = sock.getsockname()[1]

        sandbox_dir = self.root / "sm_install"
        sandbox_dir.mkdir()
        (sandbox_dir / "data").mkdir()
        # Symlink code dirs so python3 -m manager.web_server works cleanly in sandbox
        for name in ("manager", "web", "extension", "plugins", "scripts"):
            (sandbox_dir / name).symlink_to(REPO_ROOT / name)
        (sandbox_dir / ".sm.env").write_text(
            f"INSTALL_DIR={sandbox_dir}\n"
            f"HOST=127.0.0.1\n"
            f"PORT={free_port}\n"
            f"AGY_CONFIG_DIR={self.global_cfg}\n"
            f"AGY_API_TOKEN=\n",
            encoding="utf-8",
        )
        env = {
            **dict(subprocess.os.environ),
            "AGY_SM_INSTALL_DIR": str(sandbox_dir),
            "SM_NO_SYSTEMD": "1",
        }
        try:
            start_res = subprocess.run(
                ["bash", str(sm_sh), "start"], env=env, capture_output=True, text=True, timeout=15
            )
            self.assertEqual(start_res.returncode, 0, start_res.stdout + start_res.stderr)
            with urllib.request.urlopen(f"http://127.0.0.1:{free_port}/api/health", timeout=5) as r:
                self.assertEqual(r.status, 200)

            status_res = subprocess.run(
                ["bash", str(sm_sh), "status"], env=env, capture_output=True, text=True, timeout=10
            )
            self.assertEqual(status_res.returncode, 0)
            self.assertIn("运行中", status_res.stdout)
        finally:
            subprocess.run(
                ["bash", str(sm_sh), "stop"], env=env, capture_output=True, text=True, timeout=10
            )

    def test_concurrent_state_updates_preserve_all_writes(self) -> None:
        dirs = []
        for idx in range(8):
            d = self.root / f"proj_{idx}"
            d.mkdir()
            dirs.append(d)

        errors: list[Exception] = []

        def worker(p: Path, label: str) -> None:
            try:
                self.store.add_custom_project(str(p), label)
            except Exception as exc:
                errors.append(exc)

        threads = [
            threading.Thread(target=worker, args=(d, f"P{i}"))
            for i, d in enumerate(dirs)
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=15)

        self.assertEqual(errors, [])
        saved_paths = {p["path"] for p in self.store.discover_projects()}
        for d in dirs:
            self.assertIn(str(d.resolve()), saved_paths)

    def test_legacy_dot_agent_skill_detail_transfer_and_delete(self) -> None:
        legacy_dir = self.proj_a / ".agent" / "skills" / "legacy-helper"
        legacy_dir.mkdir(parents=True)
        (legacy_dir / "SKILL.md").write_text(
            "---\nname: legacy-helper\ndescription: Legacy skill.\n---\n# Legacy\n",
            encoding="utf-8",
        )

        installed = self.skills.list_installed_skills()["skills"]
        self.assertIn("legacy-helper", [s["folderName"] for s in installed])

        detail = self.skills.get_installed_skill_detail("project", str(self.proj_a), "legacy-helper")
        self.assertEqual(detail["name"], "legacy-helper")
        self.assertIn("# Legacy", detail["markdown"])

        self.skills.transfer_installed_skill(
            src_scope="project",
            src_project_path=str(self.proj_a),
            folder_name="legacy-helper",
            dst_scope="global",
            dst_project_path=None,
            move=False,
        )
        self.assertTrue((self.global_cfg / "skills" / "legacy-helper" / "SKILL.md").is_file())

        self.assertTrue(self.skills.delete_installed_skill("project", str(self.proj_a), "legacy-helper"))
        self.assertFalse(legacy_dir.exists())

    def test_cache_ignores_active_tmp_staging_dirs(self) -> None:
        repos_root = self.data_dir / "cache" / "repos"
        real_repo = repos_root / "deadbeef"
        tmp_repo = repos_root / ".tmp-in-flight-clone"
        real_repo.mkdir(parents=True)
        tmp_repo.mkdir(parents=True)
        (real_repo / "SKILL.md").write_text("# cached", encoding="utf-8")
        (tmp_repo / "SKILL.md").write_text("# cloning", encoding="utf-8")

        app = ControlCenterApp(self.store)
        status = app.get_cache_status()
        self.assertEqual(status["skillRepoCache"]["repoCount"], 1)

        res = app.clear_cache("skill_repos")
        self.assertEqual(res["removedCount"], 1)
        self.assertFalse(real_repo.exists())
        self.assertTrue(tmp_repo.exists())

    def test_resolve_stdio_command_uses_target_user_home(self) -> None:
        fake_home = self.root / "target_user"
        volta_bin = fake_home / ".volta" / "bin"
        volta_bin.mkdir(parents=True)
        fake_npx = volta_bin / "fake-npx"
        fake_npx.write_text("#!/bin/sh\necho ok\n", encoding="utf-8")
        fake_npx.chmod(0o755)

        resolved, warn = resolve_stdio_command(
            "fake-npx",
            system_path="/nonexistent",
            user_path="",
            user_home=fake_home,
        )
        self.assertEqual(resolved, str(fake_npx))
        self.assertIn("绝对路径", warn or "")

    def test_mcp_stdio_supports_jsonl_and_content_length_framing(self) -> None:
        script = REPO_ROOT / "plugins" / "agy-control-center" / "scripts" / "mcp_server.py"
        env = {
            **dict(subprocess.os.environ),
            "AGY_CONFIG_DIR": str(self.global_cfg),
            "AGY_DATA_DIR": str(self.data_dir),
        }
        msg1 = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}).encode("utf-8")
        msg2 = json.dumps({"jsonrpc": "2.0", "id": 2, "method": "ping", "params": {}}).encode("utf-8")
        stdin_payload = (
            msg1 + b"\n" + f"Content-Length: {len(msg2)}\r\n\r\n".encode("ascii") + msg2
        )
        proc = subprocess.run(
            [sys.executable, str(script)],
            input=stdin_payload,
            capture_output=True,
            env=env,
            timeout=10,
            check=True,
        )
        out = proc.stdout
        first_nl = out.index(b"\n")
        resp1 = json.loads(out[:first_nl].decode("utf-8"))
        self.assertEqual(resp1["id"], 1)
        self.assertEqual(resp1["result"]["serverInfo"]["name"], "agy-control-center")

        rest = out[first_nl + 1 :]
        self.assertTrue(rest.startswith(b"Content-Length:"))
        header, body = rest.split(b"\r\n\r\n", 1)
        declared_len = int(header.split(b":", 1)[1].strip())
        self.assertEqual(len(body), declared_len)
        resp2 = json.loads(body.decode("utf-8"))
        self.assertEqual(resp2["id"], 2)
        self.assertEqual(resp2["result"], {})


if __name__ == "__main__":
    unittest.main()

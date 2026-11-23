---
name: agy-control-center
description: >-
  Manage global and project-scoped Antigravity MCP servers and Git-based Agent Skills.
  Use when the user asks to import MCP JSON configs, scan a Git skill repository,
  install or move skills between global and project scope, or launch the Control Center web panel.
---

# Antigravity Control Center Skill

Use this skill when the user wants to manage MCP servers or Agent Skills across global (`~/.gemini/config/`) and project (`.agents/`) scopes.

## Available Capabilities

1. **Interactive Panel (MCP App / Standalone Web)**:
   - Call the `open_control_center` MCP tool (renders an interactive UI in Antigravity App, or prints a structured summary in CLI/Web).
   - Or launch the standalone Web panel with `./start.sh` (defaults to `http://0.0.0.0:8787`).

2. **MCP Management via MCP Tools**:
   - `list_mcp_servers`: Inspect all global and project MCP servers.
   - `import_mcp_json`: Parse Antigravity / Claude / Cursor / OpenCode MCP JSON snippets and write to `~/.gemini/config/mcp_config.json` (`scope="global"`) or `<project>/.agents/mcp_config.json` (`scope="project"`).

3. **Skill Catalog Scanning & Installation**:
   - `list_installed_skills`: Inspect installed global and project skills.
   - `scan_skill_repo`: Clone/update any Git repository (`owner/repo` or Git URL) and discover all `SKILL.md` directories.
   - `install_skills_from_repo`: Install selected skill folders to global (`~/.gemini/config/skills/`) or a specific project (`<project>/.agents/skills/`).

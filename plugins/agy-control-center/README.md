# Antigravity Control Center Plugin

OpenChamber-inspired MCP & Skill management plugin for Google Antigravity.

## Included Components

- **MCP Server (`mcp_config.json` + `scripts/mcp_server.py`)**:
  - `open_control_center`: Opens the embedded MCP App (`ui://agy-control-center/index.html`) in Antigravity App (`aux_pane` / `global`) or returns a plain-text overview in CLI.
  - `list_mcp_servers`, `import_mcp_json`, `list_installed_skills`, `scan_skill_repo`, `install_skills_from_repo`: Direct agent-callable tools.
- **Skill (`skills/agy-control-center/SKILL.md`)**: Teaches the agent to manage global and project MCP/Skill configs cleanly.

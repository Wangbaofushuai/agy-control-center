# Antigravity Control Center（MCP & Skills 可视化控制中心）

参考 [OpenChamber](https://github.com/openchamber/openchamber) 的 MCP 与技能目录交互体验，为 Google Antigravity 打造的**零外部依赖、三端合一**可视化管理工具：

1. **Linux 一键部署 + `sm` 快捷管理菜单**：类 1Panel 一行命令安装、自动后台守护（`systemd` / `nohup`）、自动输出公网/内网地址与插件下载链接，终端随时输入 `sm` 启停、更新、改端口、看日志。
2. **Chrome / Edge 侧边栏插件（双模合一）**：支持**零后端对话桥接**（发给朋友装完即用，无需部署任何服务端）与**直连后端模式**（双向实时管理，不占对话轮次）。
3. **独立 Web 管理面板 + 标准 Antigravity Plugin（含 MCP App）**：纯 Python 3.10+ 标准库 + 现代原生前端，零 Node.js 构建依赖。

---

## 一、Linux 一键部署（推荐）

在你的 Linux 服务器上执行以下单行命令即可自动拉取仓库、注册 `sm` 快捷指令、后台启动服务并输出访问地址：

```bash
curl -fsSL https://raw.githubusercontent.com/Wangbaofushuai/agy-control-center/main/install.sh | bash
```

如需自定义端口、安装目录或开启访问 Token：

```bash
PORT=9090 AGY_API_TOKEN=your-secret curl -fsSL https://raw.githubusercontent.com/Wangbaofushuai/agy-control-center/main/install.sh | bash
```

### `sm` 快捷管理命令

安装完成后，在服务器终端任意位置输入 **`sm`** 即可呼出交互式管理菜单：

```text
1. 启动 / 关闭服务
2. 重启服务
3. 更新版本（同步 GitHub 最新代码并自动重启）
4. 查看详细状态与远程访问地址
5. 查看实时运行日志
6. 修改端口 / API Token
7. 卸载服务（保留 ~/.gemini/config/ 与所有项目 .agents/ 配置）
0. 退出
```

也支持直接命令行调用：

```bash
sm status     # 查看运行状态、公网/内网地址与插件下载链接
sm restart    # 重启后台服务
sm update     # 一键 git 同步最新版并自动重启
sm logs       # 查看实时运行日志
sm stop       # 停止后台服务
sm uninstall  # 卸载服务
```

---

## 二、Chrome / Edge 侧边栏插件安装

1. 浏览器访问 `http://<服务器IP>:8787/api/extension.zip`（或在 Web 面板左侧 **插件 → 下载 Chrome / Edge 插件 (.zip)**）下载并解压到本地；也可直接把该 `.zip` 发给朋友使用。
2. 在 Chrome 打开 `chrome://extensions`（Edge 打开 `edge://extensions`）→ 开启 **开发者模式** → 点 **加载已解压的扩展程序** → 选中解压后的目录。
3. 点击浏览器右上角图标即可在 Antigravity Web 右侧打开侧边栏：
   - **⚡ 零后端（对话桥接）模式（默认，发给朋友装完即用）**：纯前端解析 MCP JSON、直连 GitHub API 扫描任意仓库的 `SKILL.md`，点击「填入对话应用/安装」自动填进 Antigravity Web 聊天输入框（并同步复制到剪贴板兜底），回车确认即落盘。
   - **🔌 直连后端模式**：在「连接」页填写 `http://<服务器IP>:8787`（以及可选 Token），立刻升级为双向实时同步管理。

---

## 三、核心功能一览

### 1. MCP 服务器管理（全局 & 严格项目隔离）
- **配置路径映射**：
  - **全局**：`~/.gemini/config/mcp_config.json`
  - **项目（严格单项目隔离插件）**：`<项目路径>/.agents/plugins/project-mcp/mcp_config.json`（自动生成配套 `plugin.json`，并自动兼容/迁移旧版裸 `.agents/mcp_config.json`，避免 MCP 跨项目串联）
- **智能 JSON 片段导入**：兼容 Antigravity / Claude / Cursor（`mcpServers`）、OpenCode / OpenChamber（`mcp`）、单服务器对象与带 Markdown 代码块的粘贴片段，支持解析填充表单精细微调或一键批量导入。
- **Stdio 命令路径自动探测**：针对 `uvx`、`npx`、`bunx` 等安装在用户目录而不在后台系统默认 `PATH` 的命令，自动探测真实可执行路径并替换为绝对路径，彻底避免 `executable file not found in $PATH`。
- **精细化配置**：支持 Stdio（多行/单行命令拆分、`cwd`、`env` 及 `.env` 批量粘贴）、Streamable HTTP（`serverUrl`、`headers`、`authProviderType`）、启用/禁用开关、`timeoutSeconds`、`enabledTools`、`disabledTools`、`tools` 与原始 JSON 编辑器。

### 2. Skill 技能目录扫描与安装（全局 & 多项目）
- **配置路径映射**：
  - **全局**：`~/.gemini/config/skills/<skill-name>/`
  - **项目**：`<项目路径>/.agents/skills/<skill-name>/`
- **预置精选来源 + 自定义 Git 仓库**：内置 Anthropic、OpenAI、Cursor、Matt Pocock 仓库，支持添加任意 `owner/repo`、GitHub Tree URL、HTTPS/SSH Git 地址、可选子路径/分支与私有仓库 Token（仅存在本地 `data/`，不污染宿主机全局 Git 配置）。
- **整目录完整安装**：自动扫描 `SKILL.md` 并预览内容，勾选单个或批量安装时完整复制 `SKILL.md`、`scripts/`、`references/` 等全部关联文件，支持跨作用域复制/移动与卸载。

### 3. 缓存管理与多项目自动发现
- 自动发现 `~/.gemini/config/projects/*.json` 中已有 Antigravity 项目，并支持手动添加/移除服务器上任意目录。
- 内置 **清理缓存** 面板：精准识别并清理 `~/.gemini/antigravity-cli/mcp/` 下的失效残留 MCP Schema 缓存、支持一键清空全部 MCP 缓存以及清理本地 Skill Git 仓库克隆缓存。

---

## 四、手动开发启动与插件注册

### 手动前台运行（不安装系统服务）

```bash
git clone https://github.com/Wangbaofushuai/agy-control-center.git
cd agy-control-center
./start.sh
# 默认监听 http://0.0.0.0:8787
```

### 作为 Antigravity 原生插件注册（可选）

插件包位于 `plugins/agy-control-center/`：

- **项目级注册**：在目标项目的 `.agents/plugins.json` 中写入：
  ```json
  {
    "entries": [
      { "path": "/path/to/agy-control-center/plugins" }
    ]
  }
  ```
- **全局注册**：写入 `~/.gemini/config/plugins.json`，或执行 `agy plugin install /path/to/agy-control-center/plugins/agy-control-center`。

### 运行隔离单元测试

所有测试均在临时目录隔离运行，不会修改宿主机 `~/.gemini/config/`：

```bash
python3 -m unittest discover -s tests -v
```

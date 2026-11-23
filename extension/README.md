# Antigravity 控制中心 · Chrome / Edge 侧边栏插件

支持 **Google Chrome** 与 **Microsoft Edge**（Manifest V3），无需上架商店即可直接加载分享给朋友使用。

## 3 步安装

1. 将本目录（或从 Web 面板下载的 `agy-control-center-extension.zip` 解压后的文件夹）放到本地电脑。
2. 打开浏览器扩展管理页：
   - Chrome：地址栏输入 `chrome://extensions`
   - Edge：地址栏输入 `edge://extensions`
3. 打开右上角 **开发者模式** → 点击 **加载已解压的扩展程序** → 选择本文件夹即可。

## 两种使用模式

### 1. 零后端模式（默认，发给朋友装完即用）
- **无需部署任何服务端**！
- 点击浏览器右上角插件图标打开右侧边栏：
  - **MCP**：粘贴任意 MCP JSON 片段自动解析，精细微调后选择全局或项目，点击「填入对话应用」自动填入当前 Antigravity Web 聊天输入框（并同步复制到剪贴板兜底），按回车即可让 Agent 写盘生效。
  - **技能目录**：内置 Anthropic / OpenAI / Cursor / Matt Pocock 精选仓库，也可输入任意 GitHub 仓库（`owner/repo` 或链接）直接通过 GitHub API 扫描 `SKILL.md`、预览内容、单选或批量选择安装到全局或项目。

### 2. 直连后端模式（进阶，完整双向实时管理）
- 若 Linux 服务器已运行本项目 `./start.sh`（默认端口 `8787`），在侧边栏「连接」页填入 `http://<服务器IP>:8787`（以及可选 Token）并点「保存并启用直连」。
- 即可实时读写全局 `~/.gemini/config/` 与多项目 `.agents/` 配置，支持一键启停 MCP、卸载技能、扫描非 GitHub / SSH 私有仓库，完全不占用对话轮次。

/**
 * Pure client-side logic for Zero-Backend mode:
 * - Smart MCP JSON parser (Antigravity / Claude / Cursor / OpenCode)
 * - SKILL.md YAML frontmatter parser
 * - GitHub API repository scanner (public & token-authenticated)
 * - Deterministic Antigravity Chat Bridge prompt/command generator
 */
(() => {
  "use strict";

  const BUILTIN_CATALOGS = [
    { id: "builtin-anthropic", name: "Anthropic", repo: "anthropics/skills", subpath: "", branch: "", builtin: true },
    { id: "builtin-openai", name: "OpenAI", repo: "openai/skills", subpath: "", branch: "", builtin: true },
    { id: "builtin-cursor", name: "Cursor", repo: "cursor/plugins", subpath: "", branch: "", builtin: true },
    { id: "builtin-matt-pocock", name: "Matt Pocock", repo: "mattpocock/skills", subpath: "", branch: "", builtin: true },
  ];

  function stripCodeFences(rawText) {
    const text = String(rawText || "").trim();
    const match = text.match(/^```(?:jsonc?|javascript|js)?\s*\r?\n([\s\S]*?)\r?\n\s*```$/);
    return match ? match[1].trim() : text;
  }

  function parseLenientJson(rawText) {
    const text = stripCodeFences(rawText);
    if (!text) throw new Error("JSON 内容不能为空");
    try {
      return JSON.parse(text);
    } catch {
      const cleaned = text
        .replace(/^\s*\/\/.*$/gm, "")
        .replace(/,\s*([}\]])/g, "$1");
      try {
        return JSON.parse(cleaned);
      } catch (err) {
        throw new Error(`JSON 格式解析失败: ${err.message}`);
      }
    }
  }

  function tokenizeShellLine(line) {
    const tokens = line.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
    return tokens.map((t) => t.replace(/^["']|["']$/g, ""));
  }

  function normalizeCommandArgs(rawCommand, rawArgs) {
    const extraArgs = Array.isArray(rawArgs) ? rawArgs.map((a) => String(a)).filter((a) => a !== "") : [];
    if (Array.isArray(rawCommand)) {
      const parts = rawCommand.map((p) => String(p).trim()).filter(Boolean);
      return parts.length ? { command: parts[0], args: [...parts.slice(1), ...extraArgs] } : { command: "", args: [] };
    }
    const text = String(rawCommand || "").trim();
    if (!text) return { command: "", args: extraArgs };
    if (text.includes("\n") && extraArgs.length === 0) {
      const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      return { command: lines[0] || "", args: lines.slice(1) };
    }
    if (text.includes(" ") && extraArgs.length === 0) {
      const parts = tokenizeShellLine(text);
      return { command: parts[0] || "", args: parts.slice(1) };
    }
    return { command: text, args: extraArgs };
  }

  function cleanStrMap(obj) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      const key = String(k).trim();
      if (key) out[key] = v === null || v === undefined ? "" : String(v);
    }
    return out;
  }

  function cleanStrList(val) {
    if (typeof val === "string") {
      return val.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
    }
    if (Array.isArray(val)) {
      return val.map((s) => String(s).trim()).filter(Boolean);
    }
    return [];
  }

  function normalizeServerConfig(rawCfg) {
    const warnings = [];
    const result = {};
    const transportHint = String(rawCfg.transport || rawCfg.type || "").toLowerCase();
    const rawUrl = rawCfg.serverUrl || rawCfg.url || rawCfg.httpUrl;
    const isRemote =
      ["http", "remote", "streamable-http"].includes(transportHint) ||
      (Boolean(rawUrl) && !rawCfg.command);

    if (isRemote) {
      const url = String(rawUrl || "").trim();
      if (!url) throw new Error("远程 MCP 服务器必须填写 serverUrl");
      if (rawCfg.httpUrl && !rawCfg.serverUrl) {
        warnings.push("已将 httpUrl 自动转换为 serverUrl");
      }
      if (url.replace(/\/+$/, "").endsWith("/sse")) {
        warnings.push("检测到 /sse 路径：Antigravity 原生支持 Streamable HTTP（通常为 /mcp），旧版 SSE 建议使用 mcp-remote 桥接");
      }
      result.serverUrl = url;
      const headers = cleanStrMap(rawCfg.headers);
      if (Object.keys(headers).length) result.headers = headers;
      if (rawCfg.authProviderType) result.authProviderType = String(rawCfg.authProviderType).trim();
    } else {
      const { command, args } = normalizeCommandArgs(rawCfg.command, rawCfg.args);
      if (!command) throw new Error("本地 Stdio MCP 服务器必须填写启动命令 (command)");
      result.command = command;
      if (args.length) result.args = args;
      const env = cleanStrMap(rawCfg.env || rawCfg.environment);
      if (Object.keys(env).length) result.env = env;
      if (rawCfg.cwd && String(rawCfg.cwd).trim()) result.cwd = String(rawCfg.cwd).trim();
    }

    if (rawCfg.disabled === true || rawCfg.enabled === false) {
      result.disabled = true;
    }

    let timeoutVal = rawCfg.timeoutSeconds;
    if ((timeoutVal === undefined || timeoutVal === null || timeoutVal === "") && rawCfg.timeout !== undefined) {
      const num = Number(rawCfg.timeout);
      if (!Number.isNaN(num)) {
        timeoutVal = num >= 1000 ? Math.max(1, Math.floor(num / 1000)) : num;
        warnings.push(`已将 timeout 转换为 timeoutSeconds=${timeoutVal}`);
      }
    }
    if (timeoutVal !== undefined && timeoutVal !== null && String(timeoutVal).trim() !== "") {
      const parsedTimeout = Number(timeoutVal);
      if (!Number.isInteger(parsedTimeout)) throw new Error("timeoutSeconds 必须是整数");
      if (parsedTimeout !== 0) result.timeoutSeconds = parsedTimeout;
    }

    const enabledTools = cleanStrList(rawCfg.enabledTools);
    if (enabledTools.length) result.enabledTools = enabledTools;
    const disabledTools = cleanStrList(rawCfg.disabledTools);
    if (disabledTools.length) result.disabledTools = disabledTools;
    if (rawCfg.tools && typeof rawCfg.tools === "object" && Object.keys(rawCfg.tools).length) {
      result.tools = rawCfg.tools;
    }
    if (rawCfg.oauth && typeof rawCfg.oauth === "object" && Object.keys(rawCfg.oauth).length) {
      result.oauth = rawCfg.oauth;
    }

    return { config: result, warnings };
  }

  function looksLikeServerObj(obj) {
    return Boolean(obj && typeof obj === "object" && (obj.command || obj.serverUrl || obj.url || obj.httpUrl));
  }

  function inferServerName(obj) {
    const url = String(obj.serverUrl || obj.url || "");
    if (url) {
      const host = url.replace(/^https?:\/\//, "").split("/")[0].split(":")[0];
      return host.replace(/[^A-Za-z0-9._-]+/g, "-") || "remote-mcp";
    }
    const args = Array.isArray(obj.args) ? obj.args : [];
    for (const arg of args) {
      const text = String(arg);
      if (text.includes("/") && !text.startsWith("-")) {
        const tail = text.replace(/\/+$/, "").split("/").pop().replace(/^server-/, "").replace(/@.*$/, "");
        if (tail) return tail.replace(/[^A-Za-z0-9._-]+/g, "-");
      }
    }
    return "new-mcp-server";
  }

  function parseMcpJsonSnippet(rawText) {
    const data = parseLenientJson(rawText);
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("JSON 片段必须是对象");
    }
    const candidates = {};
    if (data.mcpServers && typeof data.mcpServers === "object") {
      Object.assign(candidates, data.mcpServers);
    } else if (data.mcp && typeof data.mcp === "object") {
      Object.assign(candidates, data.mcp);
    } else if (data.servers && typeof data.servers === "object") {
      Object.assign(candidates, data.servers);
    } else if (looksLikeServerObj(data)) {
      candidates[String(data.name || inferServerName(data))] = data;
    } else {
      for (const [k, v] of Object.entries(data)) {
        if (looksLikeServerObj(v)) candidates[k] = v;
      }
    }

    const entries = Object.entries(candidates).filter(([, v]) => v && typeof v === "object");
    if (!entries.length) {
      throw new Error("未识别到有效的 MCP 服务器配置（需包含 mcpServers、command 或 url/serverUrl）");
    }

    const servers = [];
    const warnings = [];
    for (const [rawName, rawCfg] of entries) {
      const cleanName = rawName.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "mcp-server";
      const { config, warnings: w } = normalizeServerConfig(rawCfg);
      for (const msg of w) warnings.push(`[${cleanName}] ${msg}`);
      servers.push({
        name: cleanName,
        transport: config.serverUrl ? "http" : "stdio",
        enabled: !config.disabled,
        config,
      });
    }
    return { servers, warnings };
  }

  function parseSkillMarkdown(text, fallbackName = "") {
    const frontmatter = {};
    let body = String(text || "");
    const match = body.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n([\s\S]*))?$/);
    if (match) {
      const lines = match[1].split(/\r?\n/);
      body = match[2] || "";
      let idx = 0;
      while (idx < lines.length) {
        const km = lines[idx].match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
        if (!km) {
          idx += 1;
          continue;
        }
        const key = km[1].trim();
        let val = km[2].trim();
        if ([">", ">-", "|", "|-"].includes(val)) {
          const block = [];
          idx += 1;
          while (idx < lines.length && (/^\s+/.test(lines[idx]) || lines[idx].trim() === "")) {
            block.push(lines[idx].trim());
            idx += 1;
          }
          frontmatter[key] = block.filter(Boolean).join(val.startsWith("|") ? "\n" : " ").trim();
          continue;
        }
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        frontmatter[key] = val;
        idx += 1;
      }
    }
    const name = (frontmatter.name || "").trim() || fallbackName;
    let description = (frontmatter.description || "").trim();
    if (!description) {
      const firstLine = body.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
      description = firstLine ? firstLine.slice(0, 220) : "";
    }
    return { name, description, frontmatter, body: body.trim() };
  }

  function parseGitHubRepoInput(repoInput, subpath = "", branch = "") {
    const raw = String(repoInput || "").trim();
    if (!raw) throw new Error("仓库地址不能为空");
    let slug = "";
    let outSubpath = String(subpath || "").trim().replace(/^\/+|\/+$/g, "");
    let outBranch = String(branch || "").trim();

    const treeMatch = raw.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)(?:\/(.*))?$/);
    if (treeMatch) {
      slug = `${treeMatch[1]}/${treeMatch[2].replace(/\.git$/, "")}`;
      if (!outBranch) outBranch = treeMatch[3];
      if (!outSubpath && treeMatch[4]) outSubpath = treeMatch[4].replace(/^\/+|\/+$/g, "");
    } else if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw)) {
      const [o, r] = raw.split("/");
      slug = `${o}/${r.replace(/\.git$/, "")}`;
    } else if (raw.startsWith("git@github.com:")) {
      slug = raw.slice("git@github.com:".length).replace(/\.git$/, "").replace(/^\/+|\/+$/g, "");
    } else {
      const gh = raw.match(/^https?:\/\/github\.com\/([^/]+)\/([^/?#]+)/);
      if (gh) {
        slug = `${gh[1]}/${gh[2].replace(/\.git$/, "")}`;
      }
    }

    return {
      raw,
      githubSlug: slug,
      cloneUrl: slug ? `https://github.com/${slug}.git` : raw,
      webUrl: slug ? `https://github.com/${slug}` : raw.replace(/\.git$/, ""),
      subpath: outSubpath,
      branch: outBranch,
    };
  }

  async function proxyFetch(url, options = {}) {
    const resp = await chrome.runtime.sendMessage({
      type: "PROXY_FETCH",
      payload: {
        url,
        method: options.method || "GET",
        headers: options.headers || {},
        body: options.body ?? null,
      },
    });
    if (!resp || !resp.ok) {
      throw new Error(resp?.error || "网络请求失败");
    }
    return resp.data;
  }

  /**
   * Zero-backend GitHub repository SKILL.md scanner via GitHub REST API.
   */
  async function scanGitHubRepoDirect({ repo, subpath = "", branch = "", token = "" }) {
    const norm = parseGitHubRepoInput(repo, subpath, branch);
    if (!norm.githubSlug) {
      throw new Error("零后端模式仅支持 GitHub 仓库（owner/repo 或 github.com URL）；非 GitHub 仓库请切换到「直连后端模式」");
    }
    const headers = {
      Accept: "application/vnd.github+json",
      "User-Agent": "agy-control-center-extension",
    };
    if (token && token.trim()) {
      headers.Authorization = `Bearer ${token.trim()}`;
    }

    const metaRes = await proxyFetch(`https://api.github.com/repos/${norm.githubSlug}`, { headers });
    if (!metaRes.ok) {
      if (metaRes.status === 401 || metaRes.status === 403 || metaRes.status === 404) {
        const msg = metaRes.json?.message || "";
        if (metaRes.status === 403 && msg.toLowerCase().includes("rate limit")) {
          throw new Error("GitHub API 匿名速率受限，请填写 GitHub Token 或切换到直连后端模式");
        }
        throw new Error("Authentication required to access this repository（私有仓库请填写 Token 或检查仓库地址）");
      }
      throw new Error(`GitHub 请求失败 (${metaRes.status}): ${metaRes.json?.message || metaRes.statusText}`);
    }

    const repoMeta = metaRes.json || {};
    const targetBranch = norm.branch || repoMeta.default_branch || "main";

    const treeRes = await proxyFetch(
      `https://api.github.com/repos/${norm.githubSlug}/git/trees/${encodeURIComponent(targetBranch)}?recursive=1`,
      { headers }
    );
    if (!treeRes.ok) {
      throw new Error(`无法读取仓库目录树 (${treeRes.status}): ${treeRes.json?.message || treeRes.statusText}`);
    }

    const tree = Array.isArray(treeRes.json?.tree) ? treeRes.json.tree : [];
    const prefix = norm.subpath ? `${norm.subpath}/` : "";
    const skillMdEntries = tree.filter((item) => {
      if (item.type !== "blob") return false;
      const p = String(item.path || "");
      if (!(p === "SKILL.md" || p.endsWith("/SKILL.md"))) return false;
      if (prefix && !p.startsWith(prefix) && p !== `${norm.subpath}/SKILL.md`) return false;
      return true;
    });

    // Fetch each SKILL.md content (parallel chunks of 8)
    const skills = [];
    const CHUNK = 8;
    for (let i = 0; i < skillMdEntries.length; i += CHUNK) {
      const slice = skillMdEntries.slice(i, i + CHUNK);
      const loaded = await Promise.all(
        slice.map(async (entry) => {
          const mdPath = entry.path;
          const relDir = mdPath === "SKILL.md" ? "." : mdPath.slice(0, -"/SKILL.md".length);
          const fallbackName = relDir === "." ? norm.githubSlug.split("/")[1] : relDir.split("/").pop();
          let rawMd = "";
          try {
            if (token && token.trim()) {
              const fileRes = await proxyFetch(
                `https://api.github.com/repos/${norm.githubSlug}/contents/${mdPath.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(targetBranch)}`,
                { headers: { ...headers, Accept: "application/vnd.github.raw+json" } }
              );
              if (fileRes.ok) rawMd = fileRes.text || "";
            } else {
              const encodedBranch = targetBranch.split("/").map(encodeURIComponent).join("/");
              const rawUrl = `https://raw.githubusercontent.com/${norm.githubSlug}/${encodedBranch}/${mdPath.split("/").map(encodeURIComponent).join("/")}`;
              const rawRes = await proxyFetch(rawUrl);
              if (rawRes.ok) rawMd = rawRes.text || "";
            }
          } catch {
            rawMd = "";
          }
          const parsed = parseSkillMarkdown(rawMd, fallbackName);
          const folderName = (parsed.name || fallbackName)
            .toLowerCase()
            .replace(/[^a-z0-9._-]+/g, "-")
            .replace(/^-+|-+$/g, "") || fallbackName;
          const dirPrefix = relDir === "." ? "" : `${relDir}/`;
          const hasScripts = tree.some((t) => t.path.startsWith(`${dirPrefix}scripts/`));
          const hasReferences = tree.some((t) => t.path.startsWith(`${dirPrefix}references/`));
          return {
            name: parsed.name || folderName,
            folderName,
            description: parsed.description,
            relPath: relDir,
            repoLabel: norm.githubSlug,
            cloneUrl: norm.cloneUrl,
            branch: targetBranch,
            browseUrl: relDir === "." ? norm.webUrl : `${norm.webUrl}/tree/${targetBranch}/${relDir}`,
            hasScripts,
            hasReferences,
            markdown: rawMd,
          };
        })
      );
      skills.push(...loaded);
    }

    skills.sort((a, b) => a.name.localeCompare(b.name));
    return {
      repo: norm.githubSlug,
      cloneUrl: norm.cloneUrl,
      webUrl: norm.webUrl,
      branch: targetBranch,
      subpath: norm.subpath,
      stars: repoMeta.stargazers_count ?? null,
      updatedAt: repoMeta.pushed_at || repoMeta.updated_at || null,
      lastScannedAt: new Date().toISOString(),
      skillCount: skills.length,
      skills,
      error: null,
    };
  }

  // -------------------------------------------------------------------------
  // Chat Bridge Prompt Generators (Zero-Backend Mode)
  // -------------------------------------------------------------------------
  function buildMcpSyncPrompt({ scope, projectPath, serversMap }) {
    const snippet = JSON.stringify({ mcpServers: serversMap }, null, 2);
    const names = Object.keys(serversMap).join(", ");
    if (scope === "global") {
      return [
        `请帮我把以下 MCP 服务器配置合并写入到 Antigravity 的全局配置文件 \`~/.gemini/config/mcp_config.json\` 中（保留该文件里已有的其他 \`mcpServers\` 条目，如文件或父目录不存在则自动创建，仅更新/新增 \`${names}\`；若命令如 uvx/npx 不在系统默认 PATH 请自动写为绝对路径）：`,
        "",
        "```json",
        snippet,
        "```",
        "",
        "写入完成后请校验 JSON 格式合法性并简要汇报结果。",
      ].join("\n");
    }

    const base = (projectPath || "<当前项目根目录>").replace(/\/+$/, "");
    const pluginDir = `${base}/.agents/plugins/project-mcp`;
    const targetPath = `${pluginDir}/mcp_config.json`;
    return [
      `请帮我把以下 MCP 服务器配置以**项目插件隔离模式**写入当前项目（${projectPath || "当前项目"}）：`,
      `1. 确保 \`${pluginDir}/plugin.json\` 存在（若不存在请创建，包含 \`{"$schema":"https://antigravity.google/schemas/v1/plugin.json","name":"project-mcp","displayName":"Project MCP","version":"1.0.0","description":"Workspace-scoped MCP servers isolated to this project."}\`）；`,
      `2. 将以下 \`mcpServers\` 合并写入 \`${targetPath}\`（保留其中已有其他条目，仅更新/新增 \`${names}\`；若命令如 uvx/npx 不在系统默认 PATH 请自动写为绝对路径）；`,
      `3. 若 \`${base}/.agents/mcp_config.json\` 中存在同名条目，请一并清理避免重复加载。`,
      "",
      "```json",
      snippet,
      "```",
      "",
      "写入完成后请校验 JSON 格式合法性并简要汇报结果。",
    ].join("\n");
  }

  function buildSkillInstallPrompt({ repoLabel, cloneUrl, branch, skills, scope, projectPath, overwrite }) {
    const targetDir =
      scope === "global"
        ? "~/.gemini/config/skills"
        : `${(projectPath || "<当前项目根目录>").replace(/\/+$/, "")}/.agents/skills`;
    const scopeLabel = scope === "global" ? "全局技能目录" : `项目技能目录 (${projectPath || "当前项目"})`;
    const skillLines = skills
      .map((s) => `- 技能名: \`${s.folderName || s.name}\`（仓库内路径: \`${s.relPath}\`）`)
      .join("\n");

    return [
      `请帮我从 Git 仓库 \`${cloneUrl || repoLabel}\`${branch ? `（分支 \`${branch}\`）` : ""} 安装以下技能到 Antigravity ${scopeLabel} \`${targetDir}\`：`,
      "",
      skillLines,
      "",
      "具体要求：",
      `1. 使用临时目录浅克隆（\`git clone --depth 1\`）仓库后，将上述技能目录完整复制到 \`${targetDir}/<技能名>/\`（保留 \`SKILL.md\`、\`scripts/\`、\`references/\` 等全部文件及脚本可执行权限，排除 \`.git\`）；`,
      `2. ${overwrite ? "如果目标位置已存在同名技能，请直接覆盖更新；" : "如果目标位置已存在同名技能，请先保留并提示我；"}`,
      "3. 安装完成后清理临时克隆目录，并列出已安装的技能路径确认生效。",
    ].join("\n");
  }

  function buildInspectPrompt() {
    return "请帮我检查并汇总当前 Antigravity 已配置的全部 MCP 服务器（全局 `~/.gemini/config/mcp_config.json` 与当前项目 `.agents/plugins/project-mcp/mcp_config.json`）以及已安装的全部技能（`~/.gemini/config/skills/` 与 `.agents/skills/`），以清晰列表展示名称、作用域和状态。";
  }

  function buildClearCachePrompt(mode) {
    if (mode === "mcp_all") {
      return "请帮我清空 Antigravity 的 MCP 工具 Schema 历史缓存目录 `~/.gemini/antigravity-cli/mcp/` 下的所有子目录（仅清理缓存，不要修改任何 `mcp_config.json` 配置文件），清理后汇报删除了哪些目录。";
    }
    return "请帮我检查 `~/.gemini/antigravity-cli/mcp/` 下的 MCP 缓存目录，对比当前全局 `~/.gemini/config/mcp_config.json` 与各项目的 `.agents/plugins/*/mcp_config.json`，仅删除已经失效/不再配置的历史残留缓存目录，保留仍在活跃使用的缓存目录，并汇报清理结果。";
  }

  window.AgyExtLib = {
    BUILTIN_CATALOGS,
    parseMcpJsonSnippet,
    normalizeServerConfig,
    parseSkillMarkdown,
    parseGitHubRepoInput,
    scanGitHubRepoDirect,
    proxyFetch,
    buildMcpSyncPrompt,
    buildSkillInstallPrompt,
    buildInspectPrompt,
    buildClearCachePrompt,
  };
})();

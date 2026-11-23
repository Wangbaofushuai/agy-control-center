(() => {
  "use strict";

  // =========================================================================
  // Dual-Mode Transport: HTTP REST API + MCP Apps JSON-RPC postMessage Bridge
  // =========================================================================
  const isMcpAppMode = Boolean(
    window.__MCP_APP_MODE__ ||
      (window.parent !== window &&
        (window.location.protocol === "about:" || window.location.protocol === "blob:"))
  );

  class McpAppBridge {
    constructor() {
      this._id = 1;
      this._pending = new Map();
      this._readyPromise = null;
      window.addEventListener("message", (event) => {
        const msg = event.data;
        if (!msg || typeof msg !== "object") return;
        if (msg.id && this._pending.has(msg.id)) {
          const { resolve, reject } = this._pending.get(msg.id);
          this._pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          else resolve(msg.result);
        }
      });
    }

    init() {
      if (this._readyPromise) return this._readyPromise;
      this._readyPromise = this.request("ui/initialize", {
        appInfo: { name: "agy-control-center", version: "1.0.0" },
        appCapabilities: {},
        protocolVersion: "2026-01-26",
      }).then((res) => {
        window.parent.postMessage(
          { jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} },
          "*"
        );
        return res;
      });
      return this._readyPromise;
    }

    request(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = this._id++;
        this._pending.set(id, { resolve, reject });
        window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
      });
    }

    async callAction(action, payload = {}) {
      await this.init();
      const result = await this.request("tools/call", {
        name: "control_center_action",
        arguments: { action, payload },
      });
      if (result?.isError) {
        const text = result.content?.[0]?.text || "操作失败";
        throw new Error(text);
      }
      if (result?.structuredContent) return result.structuredContent;
      const text = result?.content?.[0]?.text || "{}";
      return JSON.parse(text);
    }
  }

  const mcpBridge = isMcpAppMode ? new McpAppBridge() : null;

  async function apiRequest(method, path, body = null, query = null) {
    if (isMcpAppMode && mcpBridge) {
      return mcpBridge.callAction(`${method} ${path}`, { body, query });
    }
    let url = path;
    if (query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== null && v !== undefined && v !== "") params.set(k, String(v));
      }
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }
    const opts = { method, headers: {} };
    if (body !== null) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    const resp = await fetch(url, opts);
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error(data.error || `请求失败 (${resp.status})`);
    }
    return data;
  }

  // =========================================================================
  // Application State
  // =========================================================================
  const state = {
    view: "mcp",
    search: "",
    overview: null,
    projects: [],
    mcpServers: [],
    mcpScopeFilter: "all", // all | global | project:<path>
    editingMcp: null, // null for create, or existing server object
    transport: "stdio",
    lastParsedImport: null,
    installedSkills: [],
    skillScopeFilter: "all",
    catalogs: [],
    activeCatalogId: null,
    catalogSearch: "",
    selectedSkillPaths: new Set(),
    installContext: null, // { catalogId, skills: [{name, relPath}] }
    transferContext: null, // installed skill item
  };

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  // =========================================================================
  // Utilities
  // =========================================================================
  function escHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function showToast(msg, type = "info") {
    const region = $("#toastRegion");
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.textContent = msg;
    region.appendChild(el);
    setTimeout(() => el.remove(), 3400);
  }

  function formatStars(count) {
    if (count === null || count === undefined) return "";
    if (count >= 10000) return `☆ ${(count / 10000).toFixed(1).replace(/\.0$/, "")}万`;
    if (count >= 1000) return `☆ ${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
    return `☆ ${count}`;
  }

  function formatRelativeTime(iso) {
    if (!iso) return "";
    const diffMs = Date.now() - new Date(iso).getTime();
    if (Number.isNaN(diffMs)) return "";
    const days = Math.floor(diffMs / 86400000);
    if (days <= 0) return "更新于今天";
    if (days < 30) return `更新于 ${days} 天前`;
    const months = Math.floor(days / 30);
    if (months < 12) return `更新于 ${months} 个月前`;
    return `更新于 ${Math.floor(months / 12)} 年前`;
  }

  function formatBytes(bytes) {
    const n = Number(bytes || 0);
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  }

  function scopeKey(scope, projectPath) {
    return scope === "global" ? "global" : `project:${projectPath}`;
  }

  function parseScopeKey(val) {
    if (!val || val === "global") return { scope: "global", projectPath: null };
    return { scope: "project", projectPath: val.slice("project:".length) };
  }

  function populateScopeSelect(selectEl, selectedKey = "global") {
    selectEl.innerHTML = "";
    const globalOpt = document.createElement("option");
    globalOpt.value = "global";
    globalOpt.textContent = "在所有项目中可用（全局）";
    selectEl.appendChild(globalOpt);

    for (const proj of state.projects) {
      const opt = document.createElement("option");
      opt.value = `project:${proj.path}`;
      opt.textContent = `项目：${proj.name} (${proj.path})`;
      selectEl.appendChild(opt);
    }
    selectEl.value = selectedKey;
    if (!selectEl.value) selectEl.value = "global";
  }

  function populateProjectOnlySelect(selectEl, preferredPath = null) {
    selectEl.innerHTML = "";
    for (const proj of state.projects) {
      const opt = document.createElement("option");
      opt.value = proj.path;
      opt.textContent = `${proj.name} — ${proj.path}`;
      selectEl.appendChild(opt);
    }
    if (preferredPath && state.projects.some((p) => p.path === preferredPath)) {
      selectEl.value = preferredPath;
    }
  }

  function openModal(id) {
    const dlg = $(`#${id}`);
    if (dlg && !dlg.open) dlg.showModal();
  }

  function closeModal(id) {
    const dlg = $(`#${id}`);
    if (dlg && dlg.open) dlg.close();
  }

  // =========================================================================
  // Data Loading
  // =========================================================================
  async function loadAllData() {
    try {
      const [overview, mcpData, skillsData, catalogData] = await Promise.all([
        apiRequest("GET", "/api/overview"),
        apiRequest("GET", "/api/mcp"),
        apiRequest("GET", "/api/skills/installed"),
        apiRequest("GET", "/api/catalogs"),
      ]);
      state.overview = overview;
      state.projects = overview.projects || [];
      state.mcpServers = mcpData.servers || [];
      state.installedSkills = skillsData.skills || [];
      state.catalogs = catalogData.catalogs || [];

      if (!state.activeCatalogId && state.catalogs.length > 0) {
        state.activeCatalogId = state.catalogs[0].id;
      }

      updateSidebarMeta();
      renderCurrentView();
    } catch (err) {
      showToast(`加载数据失败: ${err.message}`, "error");
    }
  }

  async function refreshMcp() {
    const data = await apiRequest("GET", "/api/mcp");
    state.mcpServers = data.servers || [];
    state.projects = data.projects || state.projects;
    updateSidebarMeta();
    renderMcpList();
  }

  async function refreshSkills() {
    const [skillsData, catalogData] = await Promise.all([
      apiRequest("GET", "/api/skills/installed"),
      apiRequest("GET", "/api/catalogs"),
    ]);
    state.installedSkills = skillsData.skills || [];
    state.catalogs = catalogData.catalogs || [];
    state.projects = skillsData.projects || state.projects;
    updateSidebarMeta();
    renderInstalledSkills();
    renderCatalogView();
  }

  function updateSidebarMeta() {
    $("#navCountProjects").textContent = String(state.projects.length);
    $("#navCountMcp").textContent = String(state.mcpServers.length);
    $("#navCountSkills").textContent = String(state.installedSkills.length);
    $("#navCountCatalogs").textContent = String(state.catalogs.length);
    if (state.overview?.globalConfigDir) {
      $("#sidebarConfigDir").textContent = state.overview.globalConfigDir;
    }
    if (isMcpAppMode) {
      $("#modeBadge").textContent = "MCP App 内嵌模式";
    }
  }

  // =========================================================================
  // Navigation
  // =========================================================================
  function switchView(viewName) {
    state.view = viewName;
    $$(".view").forEach((el) => el.classList.remove("active"));
    const target = $(`#view-${viewName}`);
    if (target) target.classList.add("active");

    const navView = viewName === "mcp-editor" ? "mcp" : viewName;
    $$(".nav-item").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.view === navView);
    });
    renderCurrentView();
  }

  function renderCurrentView() {
    if (state.view === "mcp") renderMcpList();
    else if (state.view === "skills") renderInstalledSkills();
    else if (state.view === "catalog") renderCatalogView();
    else if (state.view === "projects") renderProjectsView();
    else if (state.view === "plugin") renderPluginView();
  }

  // =========================================================================
  // VIEW 1: MCP List & Editor
  // =========================================================================
  function renderScopeFilterBar(container, currentVal, onChange) {
    container.innerHTML = "";
    const options = [
      { key: "all", label: "全部" },
      { key: "global", label: "全局" },
      ...state.projects.map((p) => ({ key: `project:${p.path}`, label: p.name })),
    ];
    for (const opt of options) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `seg-btn ${currentVal === opt.key ? "active" : ""}`;
      btn.textContent = opt.label;
      btn.addEventListener("click", () => onChange(opt.key));
      container.appendChild(btn);
    }
  }

  function renderMcpList() {
    renderScopeFilterBar($("#mcpScopeTabs"), state.mcpScopeFilter, (key) => {
      state.mcpScopeFilter = key;
      renderMcpList();
    });

    const q = state.search.trim().toLowerCase();
    const filtered = state.mcpServers.filter((item) => {
      if (state.mcpScopeFilter === "global" && item.scope !== "global") return false;
      if (state.mcpScopeFilter.startsWith("project:")) {
        if (item.scope !== "project" || `project:${item.projectPath}` !== state.mcpScopeFilter) {
          return false;
        }
      }
      if (q) {
        const hay = `${item.name} ${item.summary} ${item.projectName}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const container = $("#mcpListContainer");
    if (!filtered.length) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-title">暂无 MCP 服务器配置</div>
          <div>点击右上角「新建 MCP 服务器」或「从 JSON 导入」快速添加。</div>
        </div>
      `;
      return;
    }

    container.innerHTML = "";
    for (const srv of filtered) {
      const card = document.createElement("div");
      card.className = `item-card ${srv.enabled ? "" : "is-disabled"}`;
      card.innerHTML = `
        <div class="item-main">
          <div class="item-title-row">
            <span class="item-name">${escHtml(srv.name)}</span>
            <span class="badge ${srv.scope === "global" ? "badge-global" : "badge-project"}">
              ${srv.scope === "global" ? "全局" : `项目 · ${escHtml(srv.projectName)}`}
            </span>
            <span class="badge">${srv.transport === "http" ? "Streamable HTTP" : "Stdio 命令"}</span>
            ${srv.enabled ? "" : '<span class="badge badge-muted">已禁用</span>'}
          </div>
          <div class="item-summary" title="${escHtml(srv.summary)}">${escHtml(srv.summary || "(未配置命令/地址)")}</div>
          <div class="item-meta">
            <span>${escHtml(srv.configPath)}</span>
            ${srv.config?.timeoutSeconds ? `<span>超时: ${srv.config.timeoutSeconds}s</span>` : ""}
            ${srv.config?.env ? `<span>环境变量: ${Object.keys(srv.config.env).length} 项</span>` : ""}
          </div>
        </div>
        <div class="item-actions">
          <label class="switch" title="${srv.enabled ? "禁用服务器" : "启用服务器"}">
            <input type="checkbox" ${srv.enabled ? "checked" : ""} data-action="toggle" />
            <span class="switch-slider"></span>
          </label>
          <button type="button" class="btn btn-secondary btn-sm" data-action="edit">编辑</button>
          <button type="button" class="btn btn-ghost btn-sm" data-action="copy">复制 JSON</button>
          <button type="button" class="btn btn-danger-ghost btn-sm" data-action="delete">删除</button>
        </div>
      `;

      card.querySelector('[data-action="toggle"]').addEventListener("change", async (e) => {
        try {
          await apiRequest("POST", "/api/mcp/toggle", {
            scope: srv.scope,
            projectPath: srv.projectPath,
            name: srv.name,
            enabled: e.target.checked,
          });
          showToast(`${srv.name} 已${e.target.checked ? "启用" : "禁用"}`, "success");
          await refreshMcp();
        } catch (err) {
          e.target.checked = !e.target.checked;
          showToast(err.message, "error");
        }
      });

      card.querySelector('[data-action="edit"]').addEventListener("click", () => openMcpEditor(srv));
      card.querySelector('[data-action="copy"]').addEventListener("click", async () => {
        const snippet = JSON.stringify({ mcpServers: { [srv.name]: srv.config } }, null, 2);
        try {
          await navigator.clipboard.writeText(snippet);
          showToast("已复制 MCP JSON 片段", "success");
        } catch {
          showToast("剪贴板不可用，请从编辑页复制", "error");
        }
      });
      card.querySelector('[data-action="delete"]').addEventListener("click", async () => {
        if (!window.confirm(`确定要删除 MCP 服务器「${srv.name}」吗？`)) return;
        try {
          await apiRequest("DELETE", "/api/mcp", null, {
            scope: srv.scope,
            projectPath: srv.projectPath,
            name: srv.name,
          });
          showToast(`已删除 ${srv.name}`, "success");
          await refreshMcp();
        } catch (err) {
          showToast(err.message, "error");
        }
      });

      container.appendChild(card);
    }
  }

  function openMcpEditor(existing = null) {
    state.editingMcp = existing;
    $("#mcpEditorHeading").textContent = existing ? `编辑 MCP 服务器 · ${existing.name}` : "新建 MCP 服务器";

    const defaultScope = existing
      ? scopeKey(existing.scope, existing.projectPath)
      : state.mcpScopeFilter === "all"
      ? "global"
      : state.mcpScopeFilter;
    populateScopeSelect($("#mcpScopeSelect"), defaultScope);

    const cfg = existing?.config || {};
    $("#mcpNameInput").value = existing?.name || "";
    $("#mcpEnabledCheck").checked = existing ? existing.enabled : true;

    const isHttp = Boolean((cfg.serverUrl || cfg.url) && !cfg.command);
    setTransport(isHttp ? "http" : "stdio");

    // Stdio command lines
    if (cfg.command) {
      const lines = [cfg.command, ...(Array.isArray(cfg.args) ? cfg.args : [])];
      $("#mcpCommandTextarea").value = lines.join("\n");
    } else {
      $("#mcpCommandTextarea").value = "";
    }

    $("#mcpUrlInput").value = cfg.serverUrl || cfg.url || "";
    $("#mcpAuthTypeSelect").value = cfg.authProviderType || "";
    $("#mcpCwdInput").value = cfg.cwd || "";
    $("#mcpTimeoutInput").value = cfg.timeoutSeconds ?? "";
    $("#mcpEnabledToolsInput").value = Array.isArray(cfg.enabledTools) ? cfg.enabledTools.join(", ") : "";
    $("#mcpDisabledToolsInput").value = Array.isArray(cfg.disabledTools) ? cfg.disabledTools.join(", ") : "";
    $("#mcpToolsJsonInput").value = cfg.tools ? JSON.stringify(cfg.tools, null, 2) : "";

    renderKvList($("#mcpEnvList"), cfg.env || {}, "API_KEY", "输入值");
    renderKvList($("#mcpHeadersList"), cfg.headers || {}, "Authorization", "Bearer ...");

    const hasAdvanced = Boolean(cfg.cwd || cfg.timeoutSeconds || cfg.enabledTools || cfg.disabledTools || cfg.tools);
    $("#mcpAdvancedDetails").open = hasAdvanced;

    updateMcpLivePreview();
    switchView("mcp-editor");
  }

  function setTransport(mode) {
    state.transport = mode;
    $$(".transport-tabs .seg-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.transport === mode);
    });
    $("#transportStdioPanel").classList.toggle("hidden", mode !== "stdio");
    $("#transportHttpPanel").classList.toggle("hidden", mode !== "http");
    $("#envSectionWrap").classList.toggle("hidden", mode !== "stdio");
    $("#cwdFieldWrap").classList.toggle("hidden", mode !== "stdio");
    updateMcpLivePreview();
  }

  function renderKvList(container, mapObj, keyPlaceholder, valPlaceholder) {
    container.innerHTML = "";
    const entries = Object.entries(mapObj || {});
    if (!entries.length) {
      addKvRow(container, "", "", keyPlaceholder, valPlaceholder);
      return;
    }
    for (const [k, v] of entries) {
      addKvRow(container, k, v, keyPlaceholder, valPlaceholder);
    }
  }

  function addKvRow(container, key = "", val = "", keyPlaceholder = "KEY", valPlaceholder = "VALUE") {
    const row = document.createElement("div");
    row.className = "kv-row";
    row.innerHTML = `
      <input type="text" class="input code-input kv-key" placeholder="${escHtml(keyPlaceholder)}" value="${escHtml(key)}" />
      <input type="text" class="input code-input kv-val" placeholder="${escHtml(valPlaceholder)}" value="${escHtml(val)}" />
      <button type="button" class="icon-btn" title="删除">&times;</button>
    `;
    row.querySelector(".kv-key").addEventListener("input", updateMcpLivePreview);
    row.querySelector(".kv-val").addEventListener("input", updateMcpLivePreview);
    row.querySelector("button").addEventListener("click", () => {
      row.remove();
      updateMcpLivePreview();
    });
    container.appendChild(row);
  }

  function collectKvMap(container) {
    const out = {};
    container.querySelectorAll(".kv-row").forEach((row) => {
      const k = row.querySelector(".kv-key").value.trim();
      const v = row.querySelector(".kv-val").value;
      if (k) out[k] = v;
    });
    return out;
  }

  function parseCommandBox(text) {
    const trimmed = text.trim();
    if (!trimmed) return { command: "", args: [] };
    if (trimmed.includes("\n")) {
      const lines = trimmed
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      return { command: lines[0] || "", args: lines.slice(1) };
    }
    // Simple shell-like tokenizing for single-line paste
    const tokens = trimmed.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
    const cleaned = tokens.map((t) => t.replace(/^["']|["']$/g, ""));
    return { command: cleaned[0] || "", args: cleaned.slice(1) };
  }

  function buildMcpPayloadFromForm() {
    const name = $("#mcpNameInput").value.trim() || "new-mcp-server";
    const { scope, projectPath } = parseScopeKey($("#mcpScopeSelect").value);
    const enabled = $("#mcpEnabledCheck").checked;
    const cfg = { transport: state.transport, enabled };

    if (state.transport === "stdio") {
      const { command, args } = parseCommandBox($("#mcpCommandTextarea").value);
      cfg.command = command;
      if (args.length) cfg.args = args;
      const env = collectKvMap($("#mcpEnvList"));
      if (Object.keys(env).length) cfg.env = env;
      const cwd = $("#mcpCwdInput").value.trim();
      if (cwd) cfg.cwd = cwd;
    } else {
      cfg.serverUrl = $("#mcpUrlInput").value.trim();
      const headers = collectKvMap($("#mcpHeadersList"));
      if (Object.keys(headers).length) cfg.headers = headers;
      const authType = $("#mcpAuthTypeSelect").value;
      if (authType) cfg.authProviderType = authType;
    }

    const timeoutRaw = $("#mcpTimeoutInput").value.trim();
    if (timeoutRaw !== "") cfg.timeoutSeconds = Number(timeoutRaw);

    const enabledTools = $("#mcpEnabledToolsInput")
      .value.split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (enabledTools.length) cfg.enabledTools = enabledTools;

    const disabledTools = $("#mcpDisabledToolsInput")
      .value.split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (disabledTools.length) cfg.disabledTools = disabledTools;

    const toolsJsonRaw = $("#mcpToolsJsonInput").value.trim();
    if (toolsJsonRaw) {
      cfg.tools = JSON.parse(toolsJsonRaw);
    }

    return { name, scope, projectPath, config: cfg };
  }

  function updateMcpLivePreview() {
    const { scope, projectPath } = parseScopeKey($("#mcpScopeSelect").value);
    const targetFile =
      scope === "global"
        ? state.overview?.globalMcpPath || "~/.gemini/config/mcp_config.json"
        : `${projectPath}/.agents/plugins/project-mcp/mcp_config.json`;
    $("#mcpTargetFilePreview").textContent = targetFile;

    if (state.transport === "stdio") {
      const { command, args } = parseCommandBox($("#mcpCommandTextarea").value);
      $("#stdioParsedPreview").textContent = command
        ? `command: ${JSON.stringify(command)}   args: ${JSON.stringify(args)}`
        : "等待输入启动命令...";
    }

    try {
      const built = buildMcpPayloadFromForm();
      const displayCfg = { ...built.config };
      delete displayCfg.transport;
      if (displayCfg.enabled) delete displayCfg.enabled;
      else {
        delete displayCfg.enabled;
        displayCfg.disabled = true;
      }
      $("#mcpLiveJsonPreview").textContent = JSON.stringify(
        { mcpServers: { [built.name]: displayCfg } },
        null,
        2
      );
    } catch (err) {
      $("#mcpLiveJsonPreview").textContent = `配置 JSON 格式有误: ${err.message}`;
    }
  }

  function applyParsedServerToForm(parsedServer) {
    $("#mcpNameInput").value = parsedServer.name || "new-mcp-server";
    $("#mcpEnabledCheck").checked = parsedServer.enabled !== false;
    const cfg = parsedServer.config || {};
    const isHttp = parsedServer.transport === "http" || Boolean(cfg.serverUrl && !cfg.command);
    setTransport(isHttp ? "http" : "stdio");

    if (isHttp) {
      $("#mcpUrlInput").value = cfg.serverUrl || cfg.url || "";
      renderKvList($("#mcpHeadersList"), cfg.headers || {}, "Authorization", "Bearer ...");
      $("#mcpAuthTypeSelect").value = cfg.authProviderType || "";
    } else {
      const lines = [cfg.command || "", ...(Array.isArray(cfg.args) ? cfg.args : [])].filter(Boolean);
      $("#mcpCommandTextarea").value = lines.join("\n");
      renderKvList($("#mcpEnvList"), cfg.env || {}, "API_KEY", "输入值");
      $("#mcpCwdInput").value = cfg.cwd || "";
    }

    $("#mcpTimeoutInput").value = cfg.timeoutSeconds ?? "";
    $("#mcpEnabledToolsInput").value = Array.isArray(cfg.enabledTools) ? cfg.enabledTools.join(", ") : "";
    $("#mcpDisabledToolsInput").value = Array.isArray(cfg.disabledTools) ? cfg.disabledTools.join(", ") : "";
    $("#mcpToolsJsonInput").value = cfg.tools ? JSON.stringify(cfg.tools, null, 2) : "";
    updateMcpLivePreview();
  }

  async function runImportJsonPreview() {
    const raw = $("#importJsonTextarea").value.trim();
    const box = $("#importParseResult");
    const batchBtn = $("#btnBatchImportConfirm");
    const scopeRow = $("#importBatchScopeRow");
    if (!raw) {
      box.classList.add("hidden");
      batchBtn.classList.add("hidden");
      scopeRow.classList.add("hidden");
      state.lastParsedImport = null;
      return null;
    }
    try {
      const res = await apiRequest("POST", "/api/mcp/parse", { json: raw });
      state.lastParsedImport = res;
      const count = res.servers.length;
      const listHtml = res.servers
        .map(
          (s) =>
            `<div>• <strong>${escHtml(s.name)}</strong> <span class="badge">${
              s.transport === "http" ? "HTTP" : "Stdio"
            }</span></div>`
        )
        .join("");
      const warnHtml = (res.warnings || [])
        .map((w) => `<div class="parse-warning">⚠ ${escHtml(w)}</div>`)
        .join("");
      box.innerHTML = `<div>已成功解析 <strong>${count}</strong> 个 MCP 服务器：</div>${listHtml}${warnHtml}`;
      box.classList.remove("hidden");

      const showBatch = count > 1 || state.view !== "mcp-editor";
      batchBtn.classList.toggle("hidden", !showBatch);
      scopeRow.classList.toggle("hidden", !showBatch);
      if (showBatch) {
        batchBtn.textContent = count > 1 ? `一键批量导入全部 (${count})` : "直接导入到目标作用域";
      }
      return res;
    } catch (err) {
      state.lastParsedImport = null;
      box.innerHTML = `<div style="color:var(--danger)">解析失败：${escHtml(err.message)}</div>`;
      box.classList.remove("hidden");
      batchBtn.classList.add("hidden");
      return null;
    }
  }

  // =========================================================================
  // VIEW 2: Installed Skills
  // =========================================================================
  function renderInstalledSkills() {
    renderScopeFilterBar($("#skillScopeTabs"), state.skillScopeFilter, (key) => {
      state.skillScopeFilter = key;
      renderInstalledSkills();
    });

    const q = state.search.trim().toLowerCase();
    const filtered = state.installedSkills.filter((sk) => {
      if (state.skillScopeFilter === "global" && sk.scope !== "global") return false;
      if (state.skillScopeFilter.startsWith("project:")) {
        if (sk.scope !== "project" || `project:${sk.projectPath}` !== state.skillScopeFilter) {
          return false;
        }
      }
      if (q) {
        const hay = `${sk.name} ${sk.folderName} ${sk.description} ${sk.projectName}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const container = $("#installedSkillsContainer");
    if (!filtered.length) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-title">当前作用域暂无已安装技能</div>
          <div>前往「技能目录」输入 Git 仓库即可扫描并一键安装技能。</div>
        </div>
      `;
      return;
    }

    container.innerHTML = "";
    for (const sk of filtered) {
      const card = document.createElement("div");
      card.className = "item-card";
      card.innerHTML = `
        <div class="item-main">
          <div class="item-title-row">
            <span class="item-name">${escHtml(sk.name)}</span>
            <span class="badge ${sk.scope === "global" ? "badge-global" : "badge-project"}">
              ${sk.scope === "global" ? "全局" : `项目 · ${escHtml(sk.projectName)}`}
            </span>
            ${sk.hasScripts ? '<span class="badge">含 scripts/</span>' : ""}
            ${sk.hasReferences ? '<span class="badge">含 references/</span>' : ""}
          </div>
          <div class="item-desc">${escHtml(sk.description || "无描述")}</div>
          <div class="item-meta">
            <span>${escHtml(sk.path)}</span>
            <span>${sk.fileCount} 个文件</span>
          </div>
        </div>
        <div class="item-actions">
          <button type="button" class="btn btn-secondary btn-sm" data-action="preview">预览</button>
          <button type="button" class="btn btn-ghost btn-sm" data-action="transfer">复制/移动</button>
          <button type="button" class="btn btn-danger-ghost btn-sm" data-action="delete">卸载</button>
        </div>
      `;

      card.querySelector('[data-action="preview"]').addEventListener("click", async () => {
        try {
          const detail = await apiRequest("GET", "/api/skills/detail", null, {
            scope: sk.scope,
            projectPath: sk.projectPath,
            folderName: sk.folderName,
          });
          openSkillPreviewModal(detail.name, detail.path, detail.files, detail.markdown);
        } catch (err) {
          showToast(err.message, "error");
        }
      });

      card.querySelector('[data-action="transfer"]').addEventListener("click", () => {
        state.transferContext = sk;
        $("#transferSkillSubtitle").textContent = `技能「${sk.name}」当前位于 ${sk.scope === "global" ? "全局" : sk.projectName}`;
        populateScopeSelect(
          $("#transferTargetScopeSelect"),
          sk.scope === "global" && state.projects[0] ? `project:${state.projects[0].path}` : "global"
        );
        $("#transferMoveCheck").checked = false;
        $("#transferOverwriteCheck").checked = false;
        openModal("modalTransferSkill");
      });

      card.querySelector('[data-action="delete"]').addEventListener("click", async () => {
        if (!window.confirm(`确定卸载技能「${sk.name}」(${sk.path}) 吗？`)) return;
        try {
          await apiRequest("DELETE", "/api/skills/installed", null, {
            scope: sk.scope,
            projectPath: sk.projectPath,
            folderName: sk.folderName,
          });
          showToast(`已卸载 ${sk.name}`, "success");
          await refreshSkills();
        } catch (err) {
          showToast(err.message, "error");
        }
      });

      container.appendChild(card);
    }
  }

  function openSkillPreviewModal(title, path, files, markdown) {
    $("#previewSkillTitle").textContent = title;
    $("#previewSkillPath").textContent = path;
    const filesEl = $("#previewSkillFiles");
    filesEl.innerHTML = (files || [])
      .map((f) => `<span class="badge">${escHtml(f)}</span>`)
      .join("");
    $("#previewSkillMarkdown").textContent = markdown || "";
    openModal("modalSkillPreview");
  }

  // =========================================================================
  // VIEW 3: Skill Catalog (OpenChamber Style)
  // =========================================================================
  function renderCatalogView() {
    const grid = $("#catalogCardsGrid");
    grid.innerHTML = "";

    for (const cat of state.catalogs) {
      const card = document.createElement("div");
      card.className = `catalog-card ${state.activeCatalogId === cat.id ? "active" : ""}`;
      const countText = cat.lastScannedAt ? `技能数: ${cat.skillCount}` : "点击扫描";
      const metaParts = [];
      if (cat.stars !== null && cat.stars !== undefined) metaParts.push(formatStars(cat.stars));
      if (cat.updatedAt) metaParts.push(formatRelativeTime(cat.updatedAt));
      if (cat.subpath) metaParts.push(`子路径: ${cat.subpath}`);
      if (cat.hasToken) metaParts.push("已配 Token");

      card.innerHTML = `
        <div class="catalog-card-top">
          <div class="catalog-card-title">
            <span class="catalog-name">${escHtml(cat.name)}</span>
            <span class="catalog-count">${escHtml(countText)}</span>
          </div>
          <div>
            ${
              cat.builtin
                ? ""
                : `<button type="button" class="icon-btn" data-action="remove-cat" title="删除自定义来源">&times;</button>`
            }
          </div>
        </div>
        <div class="catalog-repo" title="${escHtml(cat.repo)}">${escHtml(cat.repo)}</div>
        <div class="catalog-meta">${metaParts.map((m) => `<span>${escHtml(m)}</span>`).join("") || "<span>Git 技能仓库</span>"}</div>
      `;

      card.addEventListener("click", async (e) => {
        if (e.target.closest('[data-action="remove-cat"]')) return;
        state.activeCatalogId = cat.id;
        state.selectedSkillPaths.clear();
        renderCatalogView();
        if (!cat.lastScannedAt && !cat.error) {
          await triggerCatalogScan(cat.id, true);
        }
      });

      const removeBtn = card.querySelector('[data-action="remove-cat"]');
      if (removeBtn) {
        removeBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          if (!window.confirm(`确定移除自定义技能目录「${cat.name}」吗？`)) return;
          try {
            await apiRequest("DELETE", "/api/catalogs", null, { id: cat.id });
            if (state.activeCatalogId === cat.id) {
              state.activeCatalogId = state.catalogs[0]?.id || null;
            }
            showToast("已移除目录来源", "success");
            await refreshSkills();
          } catch (err) {
            showToast(err.message, "error");
          }
        });
      }

      grid.appendChild(card);
    }

    // "+ Add your own source" card
    const addCard = document.createElement("div");
    addCard.className = "catalog-card catalog-card-add";
    addCard.innerHTML = `
      <div class="catalog-card-add-inner">
        <div class="catalog-card-add-plus">+</div>
        <div>
          <div class="catalog-name">添加自己的来源</div>
          <div class="catalog-count">任何包含技能（SKILL.md）的 Git 仓库</div>
        </div>
      </div>
    `;
    addCard.addEventListener("click", () => openAddCatalogModal());
    grid.appendChild(addCard);

    renderActiveCatalogSkills();
  }

  function renderActiveCatalogSkills() {
    const query = (state.catalogSearch || state.search).trim().toLowerCase();
    const activeCat = state.catalogs.find((c) => c.id === state.activeCatalogId);

    const errBanner = $("#catalogErrorBanner");
    if (activeCat?.error) {
      $("#catalogErrorText").textContent = activeCat.error;
      errBanner.classList.remove("hidden");
    } else {
      errBanner.classList.add("hidden");
    }

    const listEl = $("#catalogSkillList");
    const selectAllRow = $("#catalogSelectAllRow");
    const batchBtn = $("#btnBatchInstallSkills");

    let skillsToShow = [];
    if (query) {
      for (const cat of state.catalogs) {
        for (const sk of cat.skills || []) {
          const hay = `${sk.name} ${sk.description} ${sk.relPath} ${cat.name} ${cat.repo}`.toLowerCase();
          if (hay.includes(query)) {
            skillsToShow.push({ ...sk, _catalogId: cat.id, _catalogName: cat.name });
          }
        }
      }
      $("#catalogResultsTitle").textContent = `全部来源搜索结果 · 找到 ${skillsToShow.length} 个技能`;
    } else if (activeCat) {
      skillsToShow = (activeCat.skills || []).map((sk) => ({
        ...sk,
        _catalogId: activeCat.id,
        _catalogName: activeCat.name,
      }));
      $("#catalogResultsTitle").textContent = activeCat.lastScannedAt
        ? `${activeCat.name} · 找到 ${skillsToShow.length} 个技能`
        : `${activeCat.name} · 尚未扫描（点击右侧刷新按钮开始扫描）`;
    } else {
      $("#catalogResultsTitle").textContent = "请选择一个来源";
    }

    if (!skillsToShow.length) {
      selectAllRow.classList.add("hidden");
      batchBtn.classList.add("hidden");
      listEl.innerHTML = activeCat && !activeCat.lastScannedAt
        ? `<div class="empty-state"><div class="empty-state-title">尚未扫描该仓库</div><div>点击上方刷新图标自动扫描仓库中的所有 <code>SKILL.md</code>。</div></div>`
        : `<div class="empty-state"><div class="empty-state-title">未找到匹配的技能</div><div>可尝试重新扫描仓库或切换其他来源。</div></div>`;
      return;
    }

    const canBatch = !query && Boolean(activeCat);
    selectAllRow.classList.toggle("hidden", !canBatch);
    updateBatchInstallButton(skillsToShow);

    listEl.innerHTML = "";
    for (const sk of skillsToShow) {
      const row = document.createElement("div");
      row.className = "catalog-skill-row";
      const installedBadges = (sk.installedIn || [])
        .map(
          (loc) =>
            `<span class="badge badge-success">已装 · ${
              loc.scope === "global" ? "全局" : escHtml(loc.projectName)
            }</span>`
        )
        .join("");

      row.innerHTML = `
        ${canBatch ? `<input type="checkbox" ${state.selectedSkillPaths.has(sk.relPath) ? "checked" : ""} />` : ""}
        <div class="catalog-skill-body">
          <div class="catalog-skill-head">
            <span class="catalog-skill-name">${escHtml(sk.name)}</span>
            ${installedBadges}
            ${sk.hasScripts ? '<span class="badge">scripts</span>' : ""}
          </div>
          <div class="catalog-skill-desc">${escHtml(sk.description || "无描述")}</div>
          <div class="catalog-skill-path">${escHtml(sk.repoLabel)} · ${escHtml(sk.relPath)}</div>
        </div>
        <div class="catalog-skill-actions">
          <button type="button" class="icon-btn" data-action="preview" title="预览 SKILL.md">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>
          ${
            sk.browseUrl
              ? `<a class="icon-btn" href="${escHtml(sk.browseUrl)}" target="_blank" rel="noopener" title="在仓库中打开">
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                    <path d="M15 3h6v6M10 14 21 3" />
                  </svg>
                </a>`
              : ""
          }
          <button type="button" class="btn btn-secondary btn-sm" data-action="install">安装</button>
        </div>
      `;

      const cb = row.querySelector('input[type="checkbox"]');
      if (cb) {
        cb.addEventListener("change", () => {
          if (cb.checked) state.selectedSkillPaths.add(sk.relPath);
          else state.selectedSkillPaths.delete(sk.relPath);
          updateBatchInstallButton(skillsToShow);
        });
      }

      row.querySelector('[data-action="preview"]').addEventListener("click", async () => {
        try {
          const preview = await apiRequest("GET", "/api/catalogs/skill-preview", null, {
            catalogId: sk._catalogId,
            relPath: sk.relPath,
          });
          openSkillPreviewModal(preview.name, `${sk.repoLabel} · ${preview.relPath}`, preview.files, preview.markdown);
        } catch (err) {
          showToast(err.message, "error");
        }
      });

      row.querySelector('[data-action="install"]').addEventListener("click", () => {
        openInstallSkillModal(sk._catalogId, [{ name: sk.name, relPath: sk.relPath }]);
      });

      listEl.appendChild(row);
    }
  }

  function updateBatchInstallButton(skillsToShow) {
    const count = state.selectedSkillPaths.size;
    const btn = $("#btnBatchInstallSkills");
    btn.classList.toggle("hidden", count === 0);
    btn.textContent = `安装已选 (${count})`;
    const allChecked = skillsToShow.length > 0 && skillsToShow.every((s) => state.selectedSkillPaths.has(s.relPath));
    $("#catalogSelectAll").checked = allChecked;
    $("#catalogSelectionHint").textContent = count > 0 ? `已选择 ${count} 个技能` : "";
  }

  async function triggerCatalogScan(catalogId, forceRefresh = true) {
    const icon = $("#btnRescanActiveCatalog svg");
    icon.classList.add("spinning");
    try {
      const res = await apiRequest("POST", "/api/catalogs/scan", { catalogId, forceRefresh });
      await refreshSkills();
      if (res.error) showToast(`扫描完成但存在错误: ${res.error}`, "error");
      else showToast(`扫描完成，发现 ${res.skillCount} 个技能`, "success");
    } catch (err) {
      showToast(`扫描失败: ${err.message}`, "error");
    } finally {
      icon.classList.remove("spinning");
    }
  }

  function openAddCatalogModal() {
    $("#catalogNameInput").value = "";
    $("#catalogRepoInput").value = "";
    $("#catalogSubpathInput").value = "";
    $("#catalogBranchInput").value = "";
    $("#catalogAuthMode").value = "default";
    $("#catalogTokenInput").value = "";
    $("#catalogTokenWrap").classList.add("hidden");
    $("#catalogScanPreviewBox").classList.add("hidden");
    openModal("modalAddCatalog");
  }

  function openInstallSkillModal(catalogId, skillsList) {
    state.installContext = { catalogId, skills: skillsList };
    const names = skillsList.map((s) => s.name);
    $("#installSkillSubtitle").textContent =
      skillsList.length === 1
        ? `将 ${names[0]} 安装到全局或指定项目位置。`
        : `将已选的 ${skillsList.length} 个技能批量安装到全局或指定项目位置。`;

    populateProjectOnlySelect($("#installProjectSelect"));
    $$('input[name="installScope"]').forEach((r) => {
      r.checked = r.value === "global";
    });
    $("#installOverwriteCheck").checked = false;
    updateInstallTargetPreview();
    openModal("modalInstallSkill");
  }

  function updateInstallTargetPreview() {
    const scope = $('input[name="installScope"]:checked')?.value || "global";
    const projRow = $("#installProjectRow");
    projRow.classList.toggle("hidden", scope !== "project");
    const targetPath =
      scope === "global"
        ? state.overview?.globalSkillsDir || "~/.gemini/config/skills"
        : `${$("#installProjectSelect").value || "<项目>"}/.agents/skills`;
    $("#installTargetPathPreview").textContent = `目标目录：${targetPath}`;
  }

  // =========================================================================
  // VIEW 4: Projects & VIEW 5: Plugin Info
  // =========================================================================
  function renderProjectsView() {
    const container = $("#projectsListContainer");
    if (!state.projects.length) {
      container.innerHTML = `<div class="empty-state"><div class="empty-state-title">未发现项目</div><div>点击右上角添加服务器上的项目路径。</div></div>`;
      return;
    }

    container.innerHTML = "";
    for (const proj of state.projects) {
      const card = document.createElement("div");
      card.className = "item-card";
      card.innerHTML = `
        <div class="item-main">
          <div class="item-title-row">
            <span class="item-name">${escHtml(proj.name)}</span>
            <span class="badge">${
              proj.source === "antigravity"
                ? "Antigravity 自动发现"
                : proj.source === "workspace"
                ? "当前工作区"
                : "手动添加"
            }</span>
            ${proj.exists ? "" : '<span class="badge badge-muted">目录不存在</span>'}
          </div>
          <div class="item-summary">${escHtml(proj.path)}</div>
          <div class="item-meta">
            <span>MCP: ${proj.mcpCount} 个</span>
            <span>Skills: ${proj.skillCount} 个</span>
          </div>
        </div>
        <div class="item-actions">
          <button type="button" class="btn btn-secondary btn-sm" data-action="mcp">管理 MCP</button>
          <button type="button" class="btn btn-secondary btn-sm" data-action="skills">管理技能</button>
          ${
            proj.source === "custom"
              ? '<button type="button" class="btn btn-danger-ghost btn-sm" data-action="remove">移除</button>'
              : ""
          }
        </div>
      `;

      card.querySelector('[data-action="mcp"]').addEventListener("click", () => {
        state.mcpScopeFilter = `project:${proj.path}`;
        switchView("mcp");
      });
      card.querySelector('[data-action="skills"]').addEventListener("click", () => {
        state.skillScopeFilter = `project:${proj.path}`;
        switchView("skills");
      });
      const rmBtn = card.querySelector('[data-action="remove"]');
      if (rmBtn) {
        rmBtn.addEventListener("click", async () => {
          try {
            await apiRequest("DELETE", "/api/projects", null, { path: proj.path });
            showToast("已移除自定义项目", "success");
            await loadAllData();
          } catch (err) {
            showToast(err.message, "error");
          }
        });
      }
      container.appendChild(card);
    }
  }

  function renderPluginView() {
    const ov = state.overview || {};
    $("#pluginPathInfo").innerHTML = `
      <dt>全局 MCP 配置</dt><dd>${escHtml(ov.globalMcpPath || "~/.gemini/config/mcp_config.json")}</dd>
      <dt>全局 Skills 目录</dt><dd>${escHtml(ov.globalSkillsDir || "~/.gemini/config/skills")}</dd>
      <dt>项目 MCP 配置（隔离插件）</dt><dd>&lt;project&gt;/.agents/plugins/project-mcp/mcp_config.json</dd>
      <dt>项目 Skills 目录</dt><dd>&lt;project&gt;/.agents/skills/&lt;skill-name&gt;/</dd>
      <dt>本地缓存与自定义源</dt><dd>${escHtml(ov.dataDir || "./data")}</dd>
      <dt>Antigravity 插件目录</dt><dd>${escHtml(ov.pluginDir || "./plugins/agy-control-center")}</dd>
    `;

    const pluginsJson = JSON.stringify(
      {
        entries: [{ path: ov.pluginDir ? ov.pluginDir.replace(/\/agy-control-center$/, "") : "plugins" }],
      },
      null,
      2
    );
    $("#pluginInstallSnippet").textContent =
      `# 方式 1：在任意项目的 .agents/plugins.json 或 ~/.gemini/config/plugins.json 中注册：\n${pluginsJson}\n\n# 方式 2：若使用 agy CLI 安装：\nagy plugin validate --strict "${ov.pluginDir || "./plugins/agy-control-center"}"\nagy plugin install "${ov.pluginDir || "./plugins/agy-control-center"}"`;
  }

  // =========================================================================
  // Event Binding
  // =========================================================================
  function bindEvents() {
    // Theme toggle
    const savedTheme = localStorage.getItem("agy-cc-theme");
    if (savedTheme === "dark") document.documentElement.setAttribute("data-theme", "dark");
    $("#themeToggle").addEventListener("click", () => {
      const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      try {
        localStorage.setItem("agy-cc-theme", next);
      } catch {}
    });

    // Sidebar navigation
    $$(".nav-item").forEach((btn) => {
      btn.addEventListener("click", () => switchView(btn.dataset.view));
    });

    $("#globalSearch").addEventListener("input", (e) => {
      state.search = e.target.value;
      renderCurrentView();
    });

    // Modal close buttons
    $$("[data-close]").forEach((btn) => {
      btn.addEventListener("click", () => closeModal(btn.dataset.close));
    });

    // MCP actions
    $("#btnNewMcp").addEventListener("click", () => openMcpEditor(null));
    $("#btnRefreshMcp").addEventListener("click", () => refreshMcp().then(() => showToast("已刷新", "success")));
    $("#btnBackToMcp").addEventListener("click", () => switchView("mcp"));
    $("#btnCancelMcpEdit").addEventListener("click", () => switchView("mcp"));

    $$(".transport-tabs .seg-btn").forEach((btn) => {
      btn.addEventListener("click", () => setTransport(btn.dataset.transport));
    });

    [
      "#mcpNameInput",
      "#mcpScopeSelect",
      "#mcpEnabledCheck",
      "#mcpCommandTextarea",
      "#mcpUrlInput",
      "#mcpAuthTypeSelect",
      "#mcpCwdInput",
      "#mcpTimeoutInput",
      "#mcpEnabledToolsInput",
      "#mcpDisabledToolsInput",
      "#mcpToolsJsonInput",
    ].forEach((sel) => {
      $(sel).addEventListener("input", updateMcpLivePreview);
      $(sel).addEventListener("change", updateMcpLivePreview);
    });

    $("#btnAddEnv").addEventListener("click", () => addKvRow($("#mcpEnvList"), "", "", "API_KEY", "输入值"));
    $("#btnAddHeader").addEventListener("click", () =>
      addKvRow($("#mcpHeadersList"), "", "", "Authorization", "Bearer ...")
    );
    $("#btnPasteEnv").addEventListener("click", () => {
      const text = window.prompt("粘贴 KEY=VALUE 格式的环境变量（支持多行）：");
      if (!text) return;
      for (const line of text.split(/\r?\n/)) {
        const clean = line.trim().replace(/^export\s+/, "");
        const idx = clean.indexOf("=");
        if (idx > 0 && !clean.startsWith("#")) {
          const k = clean.slice(0, idx).trim();
          const v = clean.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
          addKvRow($("#mcpEnvList"), k, v, "API_KEY", "输入值");
        }
      }
      updateMcpLivePreview();
    });

    $("#btnSaveMcp").addEventListener("click", async () => {
      try {
        const built = buildMcpPayloadFromForm();
        const res = await apiRequest("POST", "/api/mcp/save", {
          scope: built.scope,
          projectPath: built.projectPath,
          name: built.name,
          config: built.config,
          originalName: state.editingMcp?.name || null,
          originalScope: state.editingMcp?.scope || null,
          originalProjectPath: state.editingMcp?.projectPath || null,
        });
        const warnText = res.warnings?.length ? `（提示：${res.warnings[0]}）` : "";
        showToast(`已保存 MCP 服务器 ${built.name}${warnText}`, "success");
        await refreshMcp();
        switchView("mcp");
      } catch (err) {
        showToast(err.message, "error");
      }
    });

    // Import JSON modal triggers
    const openImportDialog = () => {
      $("#importJsonTextarea").value = "";
      $("#importParseResult").classList.add("hidden");
      $("#btnBatchImportConfirm").classList.add("hidden");
      $("#importBatchScopeRow").classList.add("hidden");
      state.lastParsedImport = null;
      const defaultScope = state.mcpScopeFilter === "all" ? "global" : state.mcpScopeFilter;
      populateScopeSelect($("#importBatchScopeSelect"), defaultScope);
      openModal("modalImportJson");
    };
    $("#btnQuickImportMcp").addEventListener("click", openImportDialog);
    $("#btnFormImportJson").addEventListener("click", openImportDialog);

    $("#btnPasteClipboard").addEventListener("click", async () => {
      try {
        const text = await navigator.clipboard.readText();
        $("#importJsonTextarea").value = text;
        await runImportJsonPreview();
      } catch {
        showToast("浏览器拒绝读取剪贴板，请直接 Ctrl+V 粘贴", "error");
      }
    });

    $("#btnParsePreview").addEventListener("click", runImportJsonPreview);
    $("#importJsonTextarea").addEventListener("paste", () => setTimeout(runImportJsonPreview, 50));

    $("#btnApplyParsedToForm").addEventListener("click", async () => {
      const parsed = state.lastParsedImport || (await runImportJsonPreview());
      if (!parsed || !parsed.servers?.length) return;
      if (state.view !== "mcp-editor") {
        openMcpEditor(null);
      }
      applyParsedServerToForm(parsed.servers[0]);
      closeModal("modalImportJson");
      showToast(
        parsed.servers.length > 1
          ? `已将第 1 个服务器「${parsed.servers[0].name}」填充到表单（共识别 ${parsed.servers.length} 个）`
          : `已解析「${parsed.servers[0].name}」并填充到表单`,
        "success"
      );
    });

    $("#btnBatchImportConfirm").addEventListener("click", async () => {
      const raw = $("#importJsonTextarea").value.trim();
      const { scope, projectPath } = parseScopeKey($("#importBatchScopeSelect").value);
      try {
        const res = await apiRequest("POST", "/api/mcp/import", {
          scope,
          projectPath,
          json: raw,
          overwrite: true,
        });
        closeModal("modalImportJson");
        showToast(`成功导入 ${res.imported.length} 个 MCP 服务器`, "success");
        await refreshMcp();
        switchView("mcp");
      } catch (err) {
        showToast(err.message, "error");
      }
    });

    // Raw MCP editor modal
    const loadRawMcp = async () => {
      const { scope, projectPath } = parseScopeKey($("#rawMcpScopeSelect").value);
      const data = await apiRequest("GET", "/api/mcp/raw", null, { scope, projectPath });
      $("#rawMcpPathLabel").textContent = data.path;
      $("#rawMcpTextarea").value = data.content;
    };
    $("#btnOpenRawMcp").addEventListener("click", async () => {
      const def = state.mcpScopeFilter === "all" ? "global" : state.mcpScopeFilter;
      populateScopeSelect($("#rawMcpScopeSelect"), def);
      try {
        await loadRawMcp();
        openModal("modalRawMcp");
      } catch (err) {
        showToast(err.message, "error");
      }
    });
    $("#rawMcpScopeSelect").addEventListener("change", () => loadRawMcp().catch((e) => showToast(e.message, "error")));
    $("#btnSaveRawMcp").addEventListener("click", async () => {
      const { scope, projectPath } = parseScopeKey($("#rawMcpScopeSelect").value);
      try {
        await apiRequest("POST", "/api/mcp/raw", {
          scope,
          projectPath,
          content: $("#rawMcpTextarea").value,
        });
        closeModal("modalRawMcp");
        showToast("已保存原始 mcp_config.json", "success");
        await refreshMcp();
      } catch (err) {
        showToast(err.message, "error");
      }
    });

    // Skills actions
    $("#btnRefreshSkills").addEventListener("click", () => refreshSkills().then(() => showToast("已刷新技能列表", "success")));
    $("#btnGoCatalogFromSkills").addEventListener("click", () => switchView("catalog"));
    $("#btnConfirmTransferSkill").addEventListener("click", async () => {
      const sk = state.transferContext;
      if (!sk) return;
      const { scope, projectPath } = parseScopeKey($("#transferTargetScopeSelect").value);
      try {
        await apiRequest("POST", "/api/skills/transfer", {
          srcScope: sk.scope,
          srcProjectPath: sk.projectPath,
          folderName: sk.folderName,
          dstScope: scope,
          dstProjectPath: projectPath,
          move: $("#transferMoveCheck").checked,
          overwrite: $("#transferOverwriteCheck").checked,
        });
        closeModal("modalTransferSkill");
        showToast(`技能 ${sk.name} 已${$("#transferMoveCheck").checked ? "移动" : "复制"}`, "success");
        await refreshSkills();
      } catch (err) {
        showToast(err.message, "error");
      }
    });

    // Catalog actions
    $("#btnOpenAddCatalog").addEventListener("click", openAddCatalogModal);
    $("#catalogSearchInput").addEventListener("input", (e) => {
      state.catalogSearch = e.target.value;
      renderActiveCatalogSkills();
    });
    $("#btnRescanActiveCatalog").addEventListener("click", () => {
      if (state.activeCatalogId) triggerCatalogScan(state.activeCatalogId, true);
    });

    $("#catalogSelectAll").addEventListener("change", (e) => {
      const activeCat = state.catalogs.find((c) => c.id === state.activeCatalogId);
      if (!activeCat) return;
      state.selectedSkillPaths.clear();
      if (e.target.checked) {
        for (const sk of activeCat.skills || []) state.selectedSkillPaths.add(sk.relPath);
      }
      renderActiveCatalogSkills();
    });

    $("#btnBatchInstallSkills").addEventListener("click", () => {
      const activeCat = state.catalogs.find((c) => c.id === state.activeCatalogId);
      if (!activeCat) return;
      const selected = (activeCat.skills || []).filter((s) => state.selectedSkillPaths.has(s.relPath));
      if (!selected.length) return;
      openInstallSkillModal(
        activeCat.id,
        selected.map((s) => ({ name: s.name, relPath: s.relPath }))
      );
    });

    $("#catalogAuthMode").addEventListener("change", (e) => {
      $("#catalogTokenWrap").classList.toggle("hidden", e.target.value !== "token");
    });

    $("#btnPreviewScanCatalog").addEventListener("click", async () => {
      const repo = $("#catalogRepoInput").value.trim();
      if (!repo) {
        showToast("请先输入仓库地址", "error");
        return;
      }
      const btn = $("#btnPreviewScanCatalog");
      btn.disabled = true;
      btn.textContent = "扫描中...";
      const box = $("#catalogScanPreviewBox");
      try {
        const res = await apiRequest("POST", "/api/catalogs/scan", {
          repo,
          subpath: $("#catalogSubpathInput").value.trim(),
          branch: $("#catalogBranchInput").value.trim(),
          token: $("#catalogAuthMode").value === "token" ? $("#catalogTokenInput").value.trim() : "",
          forceRefresh: true,
        });
        if (res.error) {
          box.innerHTML = `<div style="color:var(--danger)">扫描失败：${escHtml(res.error)}</div>`;
        } else {
          const sample = (res.skills || [])
            .slice(0, 6)
            .map((s) => `<code>${escHtml(s.name)}</code>`)
            .join(" ");
          box.innerHTML = `<div>扫描成功！共发现 <strong>${res.skillCount}</strong> 个技能。</div><div style="margin-top:6px">${sample}${
            res.skillCount > 6 ? " ..." : ""
          }</div>`;
        }
        box.classList.remove("hidden");
      } catch (err) {
        box.innerHTML = `<div style="color:var(--danger)">${escHtml(err.message)}</div>`;
        box.classList.remove("hidden");
      } finally {
        btn.disabled = false;
        btn.textContent = "扫描";
      }
    });

    $("#btnConfirmAddCatalog").addEventListener("click", async () => {
      const repo = $("#catalogRepoInput").value.trim();
      if (!repo) {
        showToast("请输入仓库地址", "error");
        return;
      }
      const btn = $("#btnConfirmAddCatalog");
      btn.disabled = true;
      btn.textContent = "添加并扫描中...";
      try {
        const res = await apiRequest("POST", "/api/catalogs", {
          name: $("#catalogNameInput").value.trim(),
          repo,
          subpath: $("#catalogSubpathInput").value.trim(),
          branch: $("#catalogBranchInput").value.trim(),
          token: $("#catalogAuthMode").value === "token" ? $("#catalogTokenInput").value.trim() : "",
          autoScan: true,
        });
        closeModal("modalAddCatalog");
        if (res.catalog?.id) state.activeCatalogId = res.catalog.id;
        await refreshSkills();
        const foundCount = res.scan?.skillCount ?? 0;
        if (res.scan?.error) showToast(`已添加来源，但扫描报错: ${res.scan.error}`, "error");
        else showToast(`已添加来源并扫描到 ${foundCount} 个技能`, "success");
      } catch (err) {
        showToast(err.message, "error");
      } finally {
        btn.disabled = false;
        btn.textContent = "添加目录";
      }
    });

    // Install skill modal
    $$('input[name="installScope"]').forEach((r) => r.addEventListener("change", updateInstallTargetPreview));
    $("#installProjectSelect").addEventListener("change", updateInstallTargetPreview);
    $("#btnConfirmInstallSkill").addEventListener("click", async () => {
      const ctx = state.installContext;
      if (!ctx) return;
      const scope = $('input[name="installScope"]:checked')?.value || "global";
      const projectPath = scope === "project" ? $("#installProjectSelect").value : null;
      const overwrite = $("#installOverwriteCheck").checked;
      const btn = $("#btnConfirmInstallSkill");
      btn.disabled = true;
      btn.textContent = "安装中...";
      try {
        const res = await apiRequest("POST", "/api/catalogs/install", {
          catalogId: ctx.catalogId,
          skillRelPaths: ctx.skills.map((s) => s.relPath),
          scope,
          projectPath,
          overwrite,
        });
        closeModal("modalInstallSkill");
        state.selectedSkillPaths.clear();
        await refreshSkills();

        const parts = [];
        if (res.installed?.length) parts.push(`已安装 ${res.installed.length} 个`);
        if (res.skipped?.length) parts.push(`跳过 ${res.skipped.length} 个（已存在）`);
        if (res.errors?.length) parts.push(`失败 ${res.errors.length} 个`);
        showToast(parts.join("，") || "操作完成", res.errors?.length ? "error" : "success");
      } catch (err) {
        showToast(err.message, "error");
      } finally {
        btn.disabled = false;
        btn.textContent = "安装";
      }
    });

    // Projects modal
    $("#btnOpenAddProject").addEventListener("click", () => {
      $("#newProjectPathInput").value = "";
      $("#newProjectNameInput").value = "";
      openModal("modalAddProject");
    });
    $("#btnConfirmAddProject").addEventListener("click", async () => {
      try {
        await apiRequest("POST", "/api/projects", {
          path: $("#newProjectPathInput").value.trim(),
          name: $("#newProjectNameInput").value.trim(),
        });
        closeModal("modalAddProject");
        showToast("已添加项目", "success");
        await loadAllData();
      } catch (err) {
        showToast(err.message, "error");
      }
    });

    // Copy plugin config
    $("#btnCopyPluginConfig").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText($("#pluginInstallSnippet").textContent);
        showToast("已复制插件配置片段", "success");
      } catch {
        showToast("请手动选中上方文本复制", "error");
      }
    });

    // Cache Manager Modal
    const renderCacheStatus = (data) => {
      $("#cacheMcpRootText").textContent = (data.mcpCacheDirs || []).join(" , ") || "~/.gemini/antigravity-cli/mcp";
      const staleCount = data.mcpStaleCount || 0;
      const totalCount = data.mcpTotalCount || 0;
      const btnStale = $("#btnClearMcpStale");
      btnStale.textContent = `清理失效 MCP 缓存 (${staleCount})`;
      btnStale.disabled = staleCount === 0;
      const btnAll = $("#btnClearMcpAll");
      btnAll.disabled = totalCount === 0;

      const listEl = $("#cacheMcpList");
      if (!data.mcpEntries?.length) {
        listEl.innerHTML = '<div class="muted-text" style="padding:8px 0">当前无 MCP 缓存目录。</div>';
      } else {
        listEl.innerHTML = data.mcpEntries
          .map(
            (e) => `
          <div class="item-card" style="padding:10px 12px">
            <div class="item-main">
              <div class="item-title-row">
                <span class="item-name">${escHtml(e.name)}</span>
                <span class="badge ${e.stale ? "badge-global" : "badge-success"}">
                  ${e.stale ? "失效残留" : "活跃配置"}
                </span>
              </div>
              <div class="item-meta">
                <span>${escHtml(e.path)}</span>
                <span>${e.fileCount} 个文件 · ${formatBytes(e.sizeBytes)}</span>
              </div>
            </div>
          </div>`
          )
          .join("");
      }

      const repoInfo = data.skillRepoCache || {};
      $("#cacheRepoMetaText").textContent = `${repoInfo.path || "./data/cache/repos"} · ${
        repoInfo.repoCount || 0
      } 个缓存仓库 · ${formatBytes(repoInfo.sizeBytes || 0)}`;
      $("#btnClearSkillRepos").disabled = (repoInfo.repoCount || 0) === 0;
    };

    const loadCacheModal = async (shouldOpen = false) => {
      try {
        const data = await apiRequest("GET", "/api/cache");
        renderCacheStatus(data);
        if (shouldOpen) openModal("modalCacheManager");
      } catch (err) {
        showToast(`获取缓存状态失败: ${err.message}`, "error");
      }
    };

    const runClearCache = async (target, confirmMsg) => {
      if (confirmMsg && !window.confirm(confirmMsg)) return;
      try {
        const res = await apiRequest("POST", "/api/cache/clear", { target });
        renderCacheStatus(res.status);
        showToast(
          res.removedCount > 0
            ? `已清理 ${res.removedCount} 项缓存，释放 ${formatBytes(res.freedBytes)}`
            : "没有需要清理的缓存项",
          "success"
        );
      } catch (err) {
        showToast(`清理失败: ${err.message}`, "error");
      }
    };

    $("#btnOpenCacheModal").addEventListener("click", () => loadCacheModal(true));
    $("#btnOpenCacheFromCatalog").addEventListener("click", () => loadCacheModal(true));
    $("#btnRefreshCacheModal").addEventListener("click", () => loadCacheModal(false));
    $("#btnClearMcpStale").addEventListener("click", () => runClearCache("mcp_stale", null));
    $("#btnClearMcpAll").addEventListener("click", () =>
      runClearCache("mcp_all", "确定清空全部 Antigravity MCP 工具 Schema 缓存吗？（不影响配置，下次连接时会自动重建）")
    );
    $("#btnClearSkillRepos").addEventListener("click", () =>
      runClearCache("skill_repos", "确定清理本地 Skill Git 仓库克隆缓存吗？（保留来源列表，下次扫描会重新浅克隆）")
    );
  }

  // Bootstrap
  bindEvents();
  loadAllData();
})();

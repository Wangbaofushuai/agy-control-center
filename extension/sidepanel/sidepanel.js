(() => {
  "use strict";

  const Lib = window.AgyExtLib;
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const STORAGE_KEY = "agyControlCenterExtStateV1";

  const state = {
    mode: "bridge", // "bridge" (Zero-Backend) | "backend" (Direct Server)
    tab: "mcp",
    theme: "light",
    backendUrl: "",
    backendToken: "",
    defaultProjectPath: "",
    githubToken: "",
    // Local zero-backend persisted collections
    localMcpDrafts: [],
    localCustomCatalogs: [],
    localCatalogCache: {},
    // Backend live collections
    backendProjects: [],
    backendMcpServers: [],
    backendInstalledSkills: [],
    backendCatalogs: [],
    // UI state
    mcpScopeFilter: "all",
    installedScopeFilter: "all",
    editingMcp: null,
    transport: "stdio",
    activeCatalogId: "builtin-anthropic",
    scanningCatalogIds: new Set(),
    selectedSkillRelPaths: new Set(),
    installContext: null,
    lastParsedImport: null,
  };

  function esc(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function toast(msg, kind = "info") {
    const el = document.createElement("div");
    el.className = `toast ${kind}`;
    el.textContent = msg;
    $("#toastArea").appendChild(el);
    setTimeout(() => el.remove(), 3400);
  }

  function fmtStars(n) {
    if (n === null || n === undefined) return "";
    if (n >= 10000) return `☆ ${(n / 10000).toFixed(1).replace(/\.0$/, "")}万`;
    if (n >= 1000) return `☆ ${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
    return `☆ ${n}`;
  }

  function fmtBytes(bytes) {
    const n = Number(bytes || 0);
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  }

  function openDlg(id) {
    const dlg = $(`#${id}`);
    if (dlg && !dlg.open) dlg.showModal();
  }

  function closeDlg(id) {
    const dlg = $(`#${id}`);
    if (dlg && dlg.open) dlg.close();
  }

  // =========================================================================
  // Persistence (chrome.storage.local)
  // =========================================================================
  async function loadPersisted() {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const saved = stored?.[STORAGE_KEY] || {};
    state.mode = saved.mode || "bridge";
    state.theme = saved.theme || "light";
    state.backendUrl = saved.backendUrl || "";
    state.backendToken = saved.backendToken || "";
    state.defaultProjectPath = saved.defaultProjectPath || "";
    state.githubToken = saved.githubToken || "";
    state.localMcpDrafts = Array.isArray(saved.localMcpDrafts) ? saved.localMcpDrafts : [];
    state.localCustomCatalogs = Array.isArray(saved.localCustomCatalogs) ? saved.localCustomCatalogs : [];
    state.localCatalogCache = saved.localCatalogCache && typeof saved.localCatalogCache === "object"
      ? saved.localCatalogCache
      : {};

    document.documentElement.setAttribute("data-theme", state.theme);
    $("#sBackendUrl").value = state.backendUrl;
    $("#sBackendToken").value = state.backendToken;
    $("#sDefaultProject").value = state.defaultProjectPath;
    $("#sGithubToken").value = state.githubToken;
  }

  async function savePersisted() {
    await chrome.storage.local.set({
      [STORAGE_KEY]: {
        mode: state.mode,
        theme: state.theme,
        backendUrl: state.backendUrl,
        backendToken: state.backendToken,
        defaultProjectPath: state.defaultProjectPath,
        githubToken: state.githubToken,
        localMcpDrafts: state.localMcpDrafts,
        localCustomCatalogs: state.localCustomCatalogs,
        localCatalogCache: state.localCatalogCache,
      },
    });
  }

  // =========================================================================
  // Backend HTTP Proxy & Chat Bridge Helper
  // =========================================================================
  function cleanBaseUrl(url) {
    return String(url || "").trim().replace(/\/+$/, "");
  }

  async function backendApi(method, path, body = null, query = null) {
    const base = cleanBaseUrl(state.backendUrl);
    if (!base) throw new Error("请先在「连接」页填写后端服务器地址");
    let fullUrl = `${base}${path}`;
    if (query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== null && v !== undefined && v !== "") qs.set(k, String(v));
      }
      const str = qs.toString();
      if (str) fullUrl += `?${str}`;
    }
    const headers = {};
    if (body !== null) headers["Content-Type"] = "application/json";
    if (state.backendToken) headers["X-API-Token"] = state.backendToken;

    const res = await Lib.proxyFetch(fullUrl, { method, headers, body });
    if (!res.ok) {
      throw new Error(res.json?.error || `请求失败 (${res.status})`);
    }
    return res.json || {};
  }

  async function sendToAntigravityChat(promptText) {
    let copied = false;
    try {
      await navigator.clipboard.writeText(promptText);
      copied = true;
    } catch {
      copied = false;
    }

    const resp = await chrome.runtime.sendMessage({
      type: "FILL_ACTIVE_CHAT",
      text: promptText,
    });

    if (resp?.ok && resp.data?.filled) {
      toast("已自动填入当前对话输入框（并同步复制到剪贴板），请确认后按回车发送", "ok");
      return true;
    }
    if (copied) {
      toast(
        `${resp?.data?.reason || "未定位到输入框"}，已复制到剪贴板，直接 Ctrl+V 粘贴到 Antigravity 即可`,
        "ok"
      );
      return true;
    }
    toast(resp?.error || "自动填入与剪贴板均失败", "err");
    return false;
  }

  // =========================================================================
  // Mode & Data Refresh
  // =========================================================================
  async function setMode(nextMode) {
    state.mode = nextMode;
    $$(".mode-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === nextMode));
    await savePersisted();
    updateConnectionSubtitle();

    if (nextMode === "backend") {
      if (!cleanBaseUrl(state.backendUrl)) {
        switchTab("settings");
        toast("请先填写并测试后端服务器地址", "info");
        return;
      }
      await refreshBackendAll();
    } else {
      renderAll();
    }
  }

  function updateConnectionSubtitle() {
    if (state.mode === "bridge") {
      $("#connectionSubtitle").textContent = "零后端模式 · 填入 Antigravity 对话即可执行";
    } else if (state.backendUrl) {
      $("#connectionSubtitle").textContent = `直连后端 · ${cleanBaseUrl(state.backendUrl)}`;
    } else {
      $("#connectionSubtitle").textContent = "直连后端 · 未配置地址";
    }
  }

  async function refreshBackendAll() {
    try {
      const [mcpData, skillsData, catData] = await Promise.all([
        backendApi("GET", "/api/mcp"),
        backendApi("GET", "/api/skills/installed"),
        backendApi("GET", "/api/catalogs"),
      ]);
      state.backendProjects = mcpData.projects || [];
      state.backendMcpServers = mcpData.servers || [];
      state.backendInstalledSkills = skillsData.skills || [];
      state.backendCatalogs = catData.catalogs || [];
      if (!state.activeCatalogId && state.backendCatalogs.length) {
        state.activeCatalogId = state.backendCatalogs[0].id;
      }
      renderAll();
    } catch (err) {
      toast(`连接后端失败: ${err.message}`, "err");
    }
  }

  function switchTab(tabName) {
    state.tab = tabName;
    $$(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tabName));
    $$(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${tabName}`));
    renderAll();
  }

  function renderAll() {
    updateConnectionSubtitle();
    renderMcpTab();
    renderCatalogTab();
    renderInstalledTab();
  }

  // =========================================================================
  // TAB 1: MCP Management
  // =========================================================================
  function populateScopeSelect(selectEl, selected = "global") {
    selectEl.innerHTML = "";
    const optGlobal = document.createElement("option");
    optGlobal.value = "global";
    optGlobal.textContent = "全局 (~/.gemini/config/mcp_config.json)";
    selectEl.appendChild(optGlobal);

    if (state.mode === "backend" && state.backendProjects.length) {
      for (const proj of state.backendProjects) {
        const opt = document.createElement("option");
        opt.value = `project:${proj.path}`;
        opt.textContent = `项目 · ${proj.name}`;
        selectEl.appendChild(opt);
      }
    } else {
      const optProj = document.createElement("option");
      optProj.value = "project:__custom__";
      optProj.textContent = "项目隔离 (.agents/plugins/project-mcp/)";
      selectEl.appendChild(optProj);
    }
    selectEl.value = selected;
    if (!selectEl.value) selectEl.value = "global";
  }

  function renderMcpTab() {
    const scopeBar = $("#mcpScopeBar");
    scopeBar.innerHTML = "";

    const scopes = [{ key: "all", label: "全部" }, { key: "global", label: "全局" }];
    if (state.mode === "backend") {
      for (const p of state.backendProjects) scopes.push({ key: `project:${p.path}`, label: p.name });
    } else {
      scopes.push({ key: "project", label: "项目" });
    }
    for (const s of scopes) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = `chip ${state.mcpScopeFilter === s.key ? "active" : ""}`;
      chip.textContent = s.label;
      chip.addEventListener("click", () => {
        state.mcpScopeFilter = s.key;
        renderMcpTab();
      });
      scopeBar.appendChild(chip);
    }

    const items = state.mode === "backend" ? state.backendMcpServers : state.localMcpDrafts;
    const filtered = items.filter((it) => {
      if (state.mcpScopeFilter === "all") return true;
      if (state.mcpScopeFilter === "global") return it.scope === "global";
      if (state.mcpScopeFilter === "project") return it.scope === "project";
      return `project:${it.projectPath}` === state.mcpScopeFilter;
    });

    const list = $("#mcpList");
    if (!filtered.length) {
      list.innerHTML = `<div class="empty-box">${
        state.mode === "bridge"
          ? "暂无本地 MCP 配置草稿。点上方「从 JSON 导入」或「新建 MCP」，配置完一键填入 Antigravity 对话即可生效！"
          : "当前作用域暂无 MCP 服务器。"
      }</div>`;
      return;
    }

    list.innerHTML = "";
    for (const srv of filtered) {
      const card = document.createElement("div");
      card.className = "card";
      const summary =
        srv.summary ||
        srv.config?.serverUrl ||
        [srv.config?.command, ...(srv.config?.args || [])].filter(Boolean).join(" ");
      card.innerHTML = `
        <div class="card-top">
          <span class="card-title">${esc(srv.name)}</span>
          <span class="badge ${srv.scope === "global" ? "badge-global" : ""}">
            ${srv.scope === "global" ? "全局" : esc(srv.projectName || srv.projectPath || "当前项目")}
          </span>
        </div>
        <div class="card-sub" title="${esc(summary)}">${esc(summary || "(未配置命令/URL)")}</div>
        <div class="card-actions">
          ${
            state.mode === "bridge"
              ? '<button type="button" class="btn btn-primary btn-xs" data-act="send">填入对话应用</button>'
              : `<button type="button" class="btn btn-secondary btn-xs" data-act="toggle">${srv.enabled ? "禁用" : "启用"}</button>`
          }
          <button type="button" class="btn btn-secondary btn-xs" data-act="edit">编辑</button>
          <button type="button" class="btn btn-danger btn-xs" data-act="delete">删除</button>
        </div>
      `;

      if (state.mode === "bridge") {
        card.querySelector('[data-act="send"]').addEventListener("click", async () => {
          const prompt = Lib.buildMcpSyncPrompt({
            scope: srv.scope,
            projectPath: srv.projectPath || state.defaultProjectPath,
            serversMap: { [srv.name]: srv.config },
          });
          await sendToAntigravityChat(prompt);
        });
      } else {
        card.querySelector('[data-act="toggle"]').addEventListener("click", async () => {
          try {
            await backendApi("POST", "/api/mcp/toggle", {
              scope: srv.scope,
              projectPath: srv.projectPath,
              name: srv.name,
              enabled: !srv.enabled,
            });
            toast(`${srv.name} 已${srv.enabled ? "禁用" : "启用"}`, "ok");
            await refreshBackendAll();
          } catch (err) {
            toast(err.message, "err");
          }
        });
      }

      card.querySelector('[data-act="edit"]').addEventListener("click", () => openMcpEditor(srv));
      card.querySelector('[data-act="delete"]').addEventListener("click", async () => {
        if (state.mode === "bridge") {
          state.localMcpDrafts = state.localMcpDrafts.filter((x) => x.id !== srv.id);
          await savePersisted();
          toast("已删除本地草稿", "ok");
          renderMcpTab();
        } else {
          if (!window.confirm(`确定删除 MCP 服务器「${srv.name}」吗？`)) return;
          try {
            await backendApi("DELETE", "/api/mcp", null, {
              scope: srv.scope,
              projectPath: srv.projectPath,
              name: srv.name,
            });
            toast(`已删除 ${srv.name}`, "ok");
            await refreshBackendAll();
          } catch (err) {
            toast(err.message, "err");
          }
        }
      });

      list.appendChild(card);
    }
  }

  function addKvRow(container, key = "", val = "", kPh = "KEY", vPh = "VALUE") {
    const row = document.createElement("div");
    row.className = "kv-row";
    row.innerHTML = `
      <input type="text" class="input mono kv-k" placeholder="${esc(kPh)}" value="${esc(key)}" />
      <input type="text" class="input mono kv-v" placeholder="${esc(vPh)}" value="${esc(val)}" />
      <button type="button" class="icon-btn">&times;</button>
    `;
    row.querySelector("button").addEventListener("click", () => row.remove());
    container.appendChild(row);
  }

  function collectKv(container) {
    const out = {};
    container.querySelectorAll(".kv-row").forEach((r) => {
      const k = r.querySelector(".kv-k").value.trim();
      const v = r.querySelector(".kv-v").value;
      if (k) out[k] = v;
    });
    return out;
  }

  function setTransport(mode) {
    state.transport = mode;
    $$(".segmented-sm .seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.transport === mode));
    $("#fStdioWrap").classList.toggle("hidden", mode !== "stdio");
    $("#fHttpWrap").classList.toggle("hidden", mode !== "http");
  }

  function updateCustomProjectFieldVisibility() {
    const val = $("#fMcpScope").value;
    $("#fMcpCustomProjectWrap").classList.toggle("hidden", val !== "project:__custom__");
  }

  function openMcpEditor(existing = null) {
    state.editingMcp = existing;
    $("#mcpEditorTitle").textContent = existing ? `编辑 · ${existing.name}` : "新建 MCP 服务器";
    $("#btnSaveDraftOnly").classList.toggle("hidden", state.mode !== "bridge");
    $("#btnSubmitMcp").textContent = state.mode === "bridge" ? "保存并填入对话" : "保存到服务器";

    const selScope = existing
      ? existing.scope === "global"
        ? "global"
        : state.mode === "backend"
        ? `project:${existing.projectPath}`
        : "project:__custom__"
      : "global";
    populateScopeSelect($("#fMcpScope"), selScope);
    $("#fMcpCustomProject").value = existing?.projectPath || state.defaultProjectPath || "";
    updateCustomProjectFieldVisibility();

    const cfg = existing?.config || {};
    $("#fMcpName").value = existing?.name || "";
    $("#fMcpEnabled").checked = existing ? existing.enabled !== false : true;
    const isHttp = Boolean((cfg.serverUrl || cfg.url) && !cfg.command);
    setTransport(isHttp ? "http" : "stdio");

    $("#fMcpCommand").value = cfg.command
      ? [cfg.command, ...(Array.isArray(cfg.args) ? cfg.args : [])].join("\n")
      : "";
    $("#fMcpUrl").value = cfg.serverUrl || cfg.url || "";
    $("#fMcpCwd").value = cfg.cwd || "";
    $("#fMcpTimeout").value = cfg.timeoutSeconds ?? "";
    $("#fMcpEnabledTools").value = Array.isArray(cfg.enabledTools) ? cfg.enabledTools.join(", ") : "";
    $("#fMcpDisabledTools").value = Array.isArray(cfg.disabledTools) ? cfg.disabledTools.join(", ") : "";

    $("#fEnvList").innerHTML = "";
    const envEntries = Object.entries(cfg.env || {});
    if (envEntries.length) envEntries.forEach(([k, v]) => addKvRow($("#fEnvList"), k, v, "API_KEY", "值"));
    else addKvRow($("#fEnvList"), "", "", "API_KEY", "值");

    $("#fHeaderList").innerHTML = "";
    const hdrEntries = Object.entries(cfg.headers || {});
    if (hdrEntries.length) hdrEntries.forEach(([k, v]) => addKvRow($("#fHeaderList"), k, v, "Authorization", "Bearer ..."));
    else addKvRow($("#fHeaderList"), "", "", "Authorization", "Bearer ...");

    $("#mcpEditorBox").classList.remove("hidden");
    $("#mcpEditorBox").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function readMcpEditorForm() {
    const name = $("#fMcpName").value.trim();
    if (!name) throw new Error("请输入服务器名称");

    const scopeVal = $("#fMcpScope").value;
    let scope = "global";
    let projectPath = null;
    if (scopeVal === "project:__custom__") {
      scope = "project";
      projectPath = $("#fMcpCustomProject").value.trim() || state.defaultProjectPath || null;
    } else if (scopeVal.startsWith("project:")) {
      scope = "project";
      projectPath = scopeVal.slice("project:".length);
    }

    const rawCfg = {
      transport: state.transport,
      enabled: $("#fMcpEnabled").checked,
      timeoutSeconds: $("#fMcpTimeout").value.trim(),
      enabledTools: $("#fMcpEnabledTools").value,
      disabledTools: $("#fMcpDisabledTools").value,
    };
    if (state.transport === "stdio") {
      rawCfg.command = $("#fMcpCommand").value;
      rawCfg.env = collectKv($("#fEnvList"));
      rawCfg.cwd = $("#fMcpCwd").value.trim();
    } else {
      rawCfg.serverUrl = $("#fMcpUrl").value.trim();
      rawCfg.headers = collectKv($("#fHeaderList"));
    }

    const { config, warnings } = Lib.normalizeServerConfig(rawCfg);
    return { name, scope, projectPath, enabled: !config.disabled, config, warnings };
  }

  async function submitMcpForm(sendToChatIfBridge) {
    try {
      const form = readMcpEditorForm();
      if (state.mode === "backend") {
        const saveRes = await backendApi("POST", "/api/mcp/save", {
          scope: form.scope,
          projectPath: form.projectPath,
          name: form.name,
          config: form.config,
          originalName: state.editingMcp?.name || null,
          originalScope: state.editingMcp?.scope || null,
          originalProjectPath: state.editingMcp?.projectPath || null,
        });
        $("#mcpEditorBox").classList.add("hidden");
        const warnText = saveRes.warnings?.length ? `（${saveRes.warnings[0]}）` : "";
        toast(`已保存 ${form.name} 到服务器${warnText}`, "ok");
        await refreshBackendAll();
      } else {
        const entry = {
          id: state.editingMcp?.id || `draft-${Date.now()}`,
          name: form.name,
          scope: form.scope,
          projectPath: form.projectPath,
          enabled: form.enabled,
          config: form.config,
        };
        const idx = state.localMcpDrafts.findIndex((x) => x.id === entry.id);
        if (idx >= 0) state.localMcpDrafts[idx] = entry;
        else state.localMcpDrafts.unshift(entry);
        await savePersisted();
        $("#mcpEditorBox").classList.add("hidden");
        renderMcpTab();
        if (sendToChatIfBridge) {
          const prompt = Lib.buildMcpSyncPrompt({
            scope: form.scope,
            projectPath: form.projectPath,
            serversMap: { [form.name]: form.config },
          });
          await sendToAntigravityChat(prompt);
        } else {
          toast(`已保存本地草稿 ${form.name}`, "ok");
        }
      }
    } catch (err) {
      toast(err.message, "err");
    }
  }

  // =========================================================================
  // TAB 2: Skill Catalog (Dual Mode: GitHub API Direct vs Backend Git Clone)
  // =========================================================================
  function getActiveCatalogsList() {
    if (state.mode === "backend") return state.backendCatalogs;
    const sources = [...Lib.BUILTIN_CATALOGS, ...state.localCustomCatalogs];
    return sources.map((src) => {
      const cached = state.localCatalogCache[src.id] || {};
      return {
        ...src,
        skillCount: (cached.skills || []).length,
        stars: cached.stars ?? null,
        updatedAt: cached.updatedAt ?? null,
        lastScannedAt: cached.lastScannedAt ?? null,
        error: cached.error ?? null,
        skills: cached.skills || [],
      };
    });
  }

  function renderCatalogTab() {
    const catalogs = getActiveCatalogsList();
    if (catalogs.length && !catalogs.some((c) => c.id === state.activeCatalogId)) {
      state.activeCatalogId = catalogs[0].id;
    }

    const grid = $("#catalogGrid");
    grid.innerHTML = "";
    for (const cat of catalogs) {
      const card = document.createElement("div");
      card.className = `cat-card ${cat.id === state.activeCatalogId ? "active" : ""}`;
      card.innerHTML = `
        <div class="card-top">
          <span class="cat-name">${esc(cat.name)}</span>
          ${cat.builtin ? "" : '<button type="button" class="icon-btn" data-rm="1" title="删除">&times;</button>'}
        </div>
        <div class="cat-repo" title="${esc(cat.repo)}">${esc(cat.repo)}</div>
        <div class="cat-meta">${cat.lastScannedAt ? `技能: ${cat.skillCount}` : "点击扫描"} ${fmtStars(cat.stars)}</div>
      `;

      card.addEventListener("click", async (e) => {
        if (e.target.closest("[data-rm]")) return;
        state.activeCatalogId = cat.id;
        state.selectedSkillRelPaths.clear();
        renderCatalogTab();
        if (!cat.lastScannedAt && !cat.error) {
          await scanCatalogById(cat.id);
        }
      });

      const rmBtn = card.querySelector("[data-rm]");
      if (rmBtn) {
        rmBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          if (state.mode === "backend") {
            await backendApi("DELETE", "/api/catalogs", null, { id: cat.id });
            await refreshBackendAll();
          } else {
            state.localCustomCatalogs = state.localCustomCatalogs.filter((c) => c.id !== cat.id);
            delete state.localCatalogCache[cat.id];
            await savePersisted();
            renderCatalogTab();
          }
          toast("已移除仓库来源", "ok");
        });
      }

      grid.appendChild(card);
    }

    const activeCat = catalogs.find((c) => c.id === state.activeCatalogId);
    const errBox = $("#catalogErrBox");
    if (activeCat?.error) {
      $("#catalogErrMsg").textContent = activeCat.error;
      errBox.classList.remove("hidden");
    } else {
      errBox.classList.add("hidden");
    }

    const q = $("#catalogSearch").value.trim().toLowerCase();
    let skills = [];
    if (q) {
      for (const cat of catalogs) {
        for (const sk of cat.skills || []) {
          if (`${sk.name} ${sk.description} ${sk.relPath} ${cat.repo}`.toLowerCase().includes(q)) {
            skills.push({ ...sk, _cat: cat });
          }
        }
      }
      $("#catalogListTitle").textContent = `搜索结果 (${skills.length})`;
    } else if (activeCat) {
      skills = (activeCat.skills || []).map((sk) => ({ ...sk, _cat: activeCat }));
      $("#catalogListTitle").textContent = activeCat.lastScannedAt
        ? `${activeCat.name} · 找到 ${skills.length} 个技能`
        : `${activeCat.name} · 未扫描`;
    }

    const list = $("#catalogSkillsList");
    const selectAllWrap = $("#selectAllWrap");
    const batchBtn = $("#btnBatchInstall");

    if (!skills.length) {
      selectAllWrap.classList.add("hidden");
      batchBtn.classList.add("hidden");
      list.innerHTML = `<div class="empty-box">${
        activeCat && !activeCat.lastScannedAt ? "点击「刷新扫描」自动读取该仓库中的 SKILL.md" : "未找到匹配的技能"
      }</div>`;
      return;
    }

    const canBatch = !q && Boolean(activeCat);
    selectAllWrap.classList.toggle("hidden", !canBatch);
    updateBatchInstallBtn(skills);

    list.innerHTML = "";
    for (const sk of skills) {
      const row = document.createElement("div");
      row.className = "skill-item";
      const installedBadges = (sk.installedIn || [])
        .map((loc) => `<span class="badge badge-ok">已装·${loc.scope === "global" ? "全局" : esc(loc.projectName)}</span>`)
        .join("");

      row.innerHTML = `
        ${canBatch ? `<input type="checkbox" ${state.selectedSkillRelPaths.has(sk.relPath) ? "checked" : ""} />` : ""}
        <div class="flex-1">
          <div class="card-top">
            <span class="card-title">${esc(sk.name)}</span>
            ${installedBadges}
          </div>
          <div class="card-desc">${esc(sk.description || "无描述")}</div>
          <div class="card-sub">${esc(sk.repoLabel || sk._cat.repo)} · ${esc(sk.relPath)}</div>
          <div class="card-actions" style="margin-top:6px">
            <button type="button" class="btn btn-primary btn-xs" data-act="install">安装</button>
            <button type="button" class="btn btn-ghost btn-xs" data-act="preview">预览 SKILL.md</button>
          </div>
        </div>
      `;

      const cb = row.querySelector('input[type="checkbox"]');
      if (cb) {
        cb.addEventListener("change", () => {
          if (cb.checked) state.selectedSkillRelPaths.add(sk.relPath);
          else state.selectedSkillRelPaths.delete(sk.relPath);
          updateBatchInstallBtn(skills);
        });
      }

      row.querySelector('[data-act="install"]').addEventListener("click", () => {
        openInstallDialog(sk._cat, [sk]);
      });

      row.querySelector('[data-act="preview"]').addEventListener("click", async () => {
        try {
          if (state.mode === "backend") {
            const p = await backendApi("GET", "/api/catalogs/skill-preview", null, {
              catalogId: sk._cat.id,
              relPath: sk.relPath,
            });
            $("#previewTitle").textContent = p.name;
            $("#previewContent").textContent = p.markdown;
          } else {
            $("#previewTitle").textContent = sk.name;
            $("#previewContent").textContent = sk.markdown || "无预览内容";
          }
          openDlg("dlgPreviewSkill");
        } catch (err) {
          toast(err.message, "err");
        }
      });

      list.appendChild(row);
    }
  }

  function updateBatchInstallBtn(skills) {
    const n = state.selectedSkillRelPaths.size;
    const btn = $("#btnBatchInstall");
    btn.classList.toggle("hidden", n === 0);
    btn.textContent = `安装已选 (${n})`;
    $("#cbSelectAllSkills").checked = skills.length > 0 && skills.every((s) => state.selectedSkillRelPaths.has(s.relPath));
  }

  async function scanCatalogById(catalogId) {
    if (state.scanningCatalogIds.has(catalogId)) return;
    state.scanningCatalogIds.add(catalogId);
    const btn = $("#btnRescanCatalog");
    btn.disabled = true;
    btn.textContent = "扫描中...";
    try {
      if (state.mode === "backend") {
        const res = await backendApi("POST", "/api/catalogs/scan", { catalogId, forceRefresh: true });
        await refreshBackendAll();
        if (res.error) toast(`扫描出错: ${res.error}`, "err");
        else toast(`扫描完成，发现 ${res.skillCount} 个技能`, "ok");
      } else {
        const cat = getActiveCatalogsList().find((c) => c.id === catalogId);
        if (!cat) return;
        try {
          const res = await Lib.scanGitHubRepoDirect({
            repo: cat.repo,
            subpath: cat.subpath || "",
            branch: cat.branch || "",
            token: cat.token || state.githubToken || "",
          });
          state.localCatalogCache[catalogId] = res;
          await savePersisted();
          renderCatalogTab();
          toast(`扫描完成，发现 ${res.skillCount} 个技能`, "ok");
        } catch (err) {
          state.localCatalogCache[catalogId] = {
            ...(state.localCatalogCache[catalogId] || {}),
            lastScannedAt: new Date().toISOString(),
            error: err.message,
          };
          await savePersisted();
          renderCatalogTab();
          toast(err.message, "err");
        }
      }
    } finally {
      state.scanningCatalogIds.delete(catalogId);
      btn.disabled = false;
      btn.textContent = "刷新扫描";
    }
  }

  function openInstallDialog(catalog, skills) {
    state.installContext = { catalog, skills };
    $("#installDescText").textContent =
      skills.length === 1
        ? `将技能「${skills[0].name}」安装到全局或项目目录。`
        : `将已选的 ${skills.length} 个技能安装到全局或项目目录。`;

    $$('input[name="instScope"]').forEach((r) => {
      r.checked = r.value === "global";
    });
    $("#instOverwrite").checked = false;
    $("#instProjectInput").value = state.defaultProjectPath || "";

    const sel = $("#instProjectSelect");
    sel.innerHTML = "";
    for (const p of state.backendProjects) {
      const opt = document.createElement("option");
      opt.value = p.path;
      opt.textContent = `${p.name} (${p.path})`;
      sel.appendChild(opt);
    }

    $("#btnConfirmInstall").textContent = state.mode === "bridge" ? "填入对话安装" : "立即安装到服务器";
    updateInstallScopeFields();
    openDlg("dlgInstallSkill");
  }

  function updateInstallScopeFields() {
    const scope = $('input[name="instScope"]:checked')?.value || "global";
    const isProject = scope === "project";
    const useSelect = isProject && state.mode === "backend" && state.backendProjects.length > 0;
    $("#instProjectSelectWrap").classList.toggle("hidden", !useSelect);
    $("#instProjectInputWrap").classList.toggle("hidden", !isProject || useSelect);
  }

  // =========================================================================
  // TAB 3: Installed Skills
  // =========================================================================
  function renderInstalledTab() {
    const isBridge = state.mode === "bridge";
    $("#installedBridgeHint").classList.toggle("hidden", !isBridge);
    $("#installedBackendWrap").classList.toggle("hidden", isBridge);
    if (isBridge) return;

    const bar = $("#installedScopeBar");
    bar.innerHTML = "";
    const scopes = [
      { key: "all", label: "全部" },
      { key: "global", label: "全局" },
      ...state.backendProjects.map((p) => ({ key: `project:${p.path}`, label: p.name })),
    ];
    for (const s of scopes) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = `chip ${state.installedScopeFilter === s.key ? "active" : ""}`;
      chip.textContent = s.label;
      chip.addEventListener("click", () => {
        state.installedScopeFilter = s.key;
        renderInstalledTab();
      });
      bar.appendChild(chip);
    }

    const filtered = state.backendInstalledSkills.filter((sk) => {
      if (state.installedScopeFilter === "all") return true;
      if (state.installedScopeFilter === "global") return sk.scope === "global";
      return `project:${sk.projectPath}` === state.installedScopeFilter;
    });

    const list = $("#installedSkillsList");
    if (!filtered.length) {
      list.innerHTML = '<div class="empty-box">当前作用域暂无已安装技能</div>';
      return;
    }

    list.innerHTML = "";
    for (const sk of filtered) {
      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML = `
        <div class="card-top">
          <span class="card-title">${esc(sk.name)}</span>
          <span class="badge ${sk.scope === "global" ? "badge-global" : ""}">
            ${sk.scope === "global" ? "全局" : esc(sk.projectName)}
          </span>
        </div>
        <div class="card-desc">${esc(sk.description || "无描述")}</div>
        <div class="card-sub">${esc(sk.path)}</div>
        <div class="card-actions">
          <button type="button" class="btn btn-secondary btn-xs" data-act="preview">预览</button>
          <button type="button" class="btn btn-danger btn-xs" data-act="delete">卸载</button>
        </div>
      `;
      card.querySelector('[data-act="preview"]').addEventListener("click", async () => {
        try {
          const d = await backendApi("GET", "/api/skills/detail", null, {
            scope: sk.scope,
            projectPath: sk.projectPath,
            folderName: sk.folderName,
          });
          $("#previewTitle").textContent = d.name;
          $("#previewContent").textContent = d.markdown;
          openDlg("dlgPreviewSkill");
        } catch (err) {
          toast(err.message, "err");
        }
      });
      card.querySelector('[data-act="delete"]').addEventListener("click", async () => {
        if (!window.confirm(`确定卸载技能「${sk.name}」吗？`)) return;
        try {
          await backendApi("DELETE", "/api/skills/installed", null, {
            scope: sk.scope,
            projectPath: sk.projectPath,
            folderName: sk.folderName,
          });
          toast(`已卸载 ${sk.name}`, "ok");
          await refreshBackendAll();
        } catch (err) {
          toast(err.message, "err");
        }
      });
      list.appendChild(card);
    }
  }

  // =========================================================================
  // Event Binding
  // =========================================================================
  function bindEvents() {
    $("#btnTheme").addEventListener("click", async () => {
      state.theme = state.theme === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", state.theme);
      await savePersisted();
    });

    $$(".mode-btn").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
    $$(".tab-btn").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));
    $$("[data-close]").forEach((b) => b.addEventListener("click", () => closeDlg(b.dataset.close)));

    // MCP events
    $("#btnNewMcp").addEventListener("click", () => openMcpEditor(null));
    $("#btnCancelMcp").addEventListener("click", () => $("#mcpEditorBox").classList.add("hidden"));
    $("#btnSaveDraftOnly").addEventListener("click", () => submitMcpForm(false));
    $("#btnSubmitMcp").addEventListener("click", () => submitMcpForm(true));
    $("#fMcpScope").addEventListener("change", updateCustomProjectFieldVisibility);
    $$(".segmented-sm .seg-btn").forEach((b) => b.addEventListener("click", () => setTransport(b.dataset.transport)));
    $("#btnAddEnvRow").addEventListener("click", () => addKvRow($("#fEnvList"), "", "", "API_KEY", "值"));
    $("#btnAddHeaderRow").addEventListener("click", () => addKvRow($("#fHeaderList"), "", "", "Authorization", "Bearer ..."));
    $("#btnInspectState").addEventListener("click", () => sendToAntigravityChat(Lib.buildInspectPrompt()));
    $("#btnAskAgentListSkills").addEventListener("click", () => sendToAntigravityChat(Lib.buildInspectPrompt()));

    // Import JSON dialog
    const openImport = () => {
      $("#importJsonInput").value = "";
      $("#importPreviewBox").classList.add("hidden");
      $("#btnBatchApplyJson").classList.add("hidden");
      $("#importScopeWrap").classList.add("hidden");
      state.lastParsedImport = null;
      populateScopeSelect($("#importScopeSelect"), "global");
      openDlg("dlgImportJson");
    };
    $("#btnOpenImportJson").addEventListener("click", openImport);
    $("#btnEditorImportJson").addEventListener("click", openImport);

    const runParsePreview = () => {
      const raw = $("#importJsonInput").value.trim();
      const box = $("#importPreviewBox");
      if (!raw) {
        box.classList.add("hidden");
        return null;
      }
      try {
        const parsed = Lib.parseMcpJsonSnippet(raw);
        state.lastParsedImport = parsed;
        const lines = parsed.servers.map((s) => `• <strong>${esc(s.name)}</strong> (${s.transport})`).join("<br/>");
        const warns = parsed.warnings.map((w) => `<div style="color:var(--accent);margin-top:4px">⚠ ${esc(w)}</div>`).join("");
        box.innerHTML = `<div>已解析 <strong>${parsed.servers.length}</strong> 个服务器：</div>${lines}${warns}`;
        box.classList.remove("hidden");
        $("#importScopeWrap").classList.remove("hidden");
        $("#btnBatchApplyJson").classList.remove("hidden");
        $("#btnBatchApplyJson").textContent =
          state.mode === "bridge"
            ? `一键填入对话应用 (${parsed.servers.length})`
            : `一键导入到服务器 (${parsed.servers.length})`;
        return parsed;
      } catch (err) {
        state.lastParsedImport = null;
        box.innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`;
        box.classList.remove("hidden");
        $("#btnBatchApplyJson").classList.add("hidden");
        return null;
      }
    };

    $("#btnParseJsonNow").addEventListener("click", runParsePreview);
    $("#importJsonInput").addEventListener("paste", () => setTimeout(runParsePreview, 50));
    $("#btnPasteJsonClip").addEventListener("click", async () => {
      try {
        $("#importJsonInput").value = await navigator.clipboard.readText();
        runParsePreview();
      } catch {
        toast("请直接 Ctrl+V 粘贴到输入框", "err");
      }
    });

    $("#btnFillParsedForm").addEventListener("click", () => {
      const parsed = state.lastParsedImport || runParsePreview();
      if (!parsed || !parsed.servers.length) return;
      const first = parsed.servers[0];
      openMcpEditor({ name: first.name, scope: "global", enabled: first.enabled, config: first.config });
      closeDlg("dlgImportJson");
      toast(`已将 ${first.name} 填充到表单`, "ok");
    });

    $("#btnBatchApplyJson").addEventListener("click", async () => {
      const parsed = state.lastParsedImport || runParsePreview();
      if (!parsed || !parsed.servers.length) return;
      const scopeVal = $("#importScopeSelect").value;
      const scope = scopeVal === "global" ? "global" : "project";
      const projectPath =
        scope === "project"
          ? scopeVal.startsWith("project:") && scopeVal !== "project:__custom__"
            ? scopeVal.slice("project:".length)
            : state.defaultProjectPath || null
          : null;

      if (state.mode === "backend") {
        try {
          const res = await backendApi("POST", "/api/mcp/import", {
            scope,
            projectPath,
            json: $("#importJsonInput").value,
            overwrite: true,
          });
          closeDlg("dlgImportJson");
          toast(`已导入 ${res.imported.length} 个 MCP 服务器`, "ok");
          await refreshBackendAll();
        } catch (err) {
          toast(err.message, "err");
        }
      } else {
        const serversMap = {};
        for (const s of parsed.servers) {
          serversMap[s.name] = s.config;
          state.localMcpDrafts.unshift({
            id: `draft-${Date.now()}-${s.name}`,
            name: s.name,
            scope,
            projectPath,
            enabled: s.enabled,
            config: s.config,
          });
        }
        await savePersisted();
        closeDlg("dlgImportJson");
        renderMcpTab();
        const prompt = Lib.buildMcpSyncPrompt({ scope, projectPath, serversMap });
        await sendToAntigravityChat(prompt);
      }
    });

    // Catalog events
    $("#catalogSearch").addEventListener("input", renderCatalogTab);
    $("#btnRescanCatalog").addEventListener("click", () => {
      if (state.activeCatalogId) scanCatalogById(state.activeCatalogId);
    });
    $("#cbSelectAllSkills").addEventListener("change", (e) => {
      const cat = getActiveCatalogsList().find((c) => c.id === state.activeCatalogId);
      state.selectedSkillRelPaths.clear();
      if (e.target.checked && cat) {
        for (const s of cat.skills || []) state.selectedSkillRelPaths.add(s.relPath);
      }
      renderCatalogTab();
    });
    $("#btnBatchInstall").addEventListener("click", () => {
      const cat = getActiveCatalogsList().find((c) => c.id === state.activeCatalogId);
      if (!cat) return;
      const picked = (cat.skills || []).filter((s) => state.selectedSkillRelPaths.has(s.relPath));
      if (picked.length) openInstallDialog(cat, picked);
    });
    $("#btnAddCatalog").addEventListener("click", () => {
      $("#cNameInput").value = "";
      $("#cRepoInput").value = "";
      $("#cSubpathInput").value = "";
      $("#cBranchInput").value = "";
      $("#cTokenInput").value = "";
      openDlg("dlgAddCatalog");
    });

    $("#btnConfirmAddCat").addEventListener("click", async () => {
      const repo = $("#cRepoInput").value.trim();
      if (!repo) {
        toast("请输入仓库地址", "err");
        return;
      }
      const btn = $("#btnConfirmAddCat");
      btn.disabled = true;
      btn.textContent = "扫描中...";
      try {
        if (state.mode === "backend") {
          const res = await backendApi("POST", "/api/catalogs", {
            name: $("#cNameInput").value.trim(),
            repo,
            subpath: $("#cSubpathInput").value.trim(),
            branch: $("#cBranchInput").value.trim(),
            token: $("#cTokenInput").value.trim(),
            autoScan: true,
          });
          if (res.catalog?.id) state.activeCatalogId = res.catalog.id;
          closeDlg("dlgAddCatalog");
          await refreshBackendAll();
          toast(`已添加并发现 ${res.scan?.skillCount ?? 0} 个技能`, res.scan?.error ? "err" : "ok");
        } else {
          const norm = Lib.parseGitHubRepoInput(repo, $("#cSubpathInput").value, $("#cBranchInput").value);
          const id = `custom-${Date.now()}`;
          state.localCustomCatalogs.push({
            id,
            name: $("#cNameInput").value.trim() || norm.githubSlug || repo,
            repo: norm.githubSlug || repo,
            subpath: norm.subpath,
            branch: norm.branch,
            token: $("#cTokenInput").value.trim(),
            builtin: false,
          });
          state.activeCatalogId = id;
          await savePersisted();
          closeDlg("dlgAddCatalog");
          renderCatalogTab();
          await scanCatalogById(id);
        }
      } catch (err) {
        toast(err.message, "err");
      } finally {
        btn.disabled = false;
        btn.textContent = "添加并扫描";
      }
    });

    // Install dialog
    $$('input[name="instScope"]').forEach((r) => r.addEventListener("change", updateInstallScopeFields));
    $("#btnConfirmInstall").addEventListener("click", async () => {
      const ctx = state.installContext;
      if (!ctx) return;
      const scope = $('input[name="instScope"]:checked')?.value || "global";
      const overwrite = $("#instOverwrite").checked;
      const projectPath =
        scope === "project"
          ? state.mode === "backend" && state.backendProjects.length
            ? $("#instProjectSelect").value
            : $("#instProjectInput").value.trim() || state.defaultProjectPath || null
          : null;

      if (state.mode === "backend") {
        const btn = $("#btnConfirmInstall");
        btn.disabled = true;
        btn.textContent = "安装中...";
        try {
          const res = await backendApi("POST", "/api/catalogs/install", {
            catalogId: ctx.catalog.id,
            skillRelPaths: ctx.skills.map((s) => s.relPath),
            scope,
            projectPath,
            overwrite,
          });
          closeDlg("dlgInstallSkill");
          state.selectedSkillRelPaths.clear();
          await refreshBackendAll();
          toast(
            `已安装 ${res.installed?.length || 0} 个${res.skipped?.length ? `，跳过 ${res.skipped.length} 个` : ""}`,
            res.errors?.length ? "err" : "ok"
          );
        } catch (err) {
          toast(err.message, "err");
        } finally {
          btn.disabled = false;
          btn.textContent = "立即安装到服务器";
        }
      } else {
        closeDlg("dlgInstallSkill");
        state.selectedSkillRelPaths.clear();
        renderCatalogTab();
        const prompt = Lib.buildSkillInstallPrompt({
          repoLabel: ctx.catalog.repo,
          cloneUrl: ctx.skills[0]?.cloneUrl || Lib.parseGitHubRepoInput(ctx.catalog.repo).cloneUrl,
          branch: ctx.skills[0]?.branch || ctx.catalog.branch || "",
          skills: ctx.skills,
          scope,
          projectPath,
          overwrite,
        });
        await sendToAntigravityChat(prompt);
      }
    });

    // Installed refresh
    $("#btnRefreshInstalled").addEventListener("click", () => refreshBackendAll());

    // Settings
    $("#btnTestBackend").addEventListener("click", async () => {
      const url = cleanBaseUrl($("#sBackendUrl").value);
      const token = $("#sBackendToken").value.trim();
      const note = $("#backendTestResult");
      if (!url) {
        note.textContent = "请输入服务器地址";
        note.className = "status-note err";
        return;
      }
      note.textContent = "连接测试中...";
      note.className = "status-note";
      try {
        const headers = token ? { "X-API-Token": token } : {};
        const health = await Lib.proxyFetch(`${url}/api/health`, { headers });
        if (!health.ok) throw new Error(`HTTP ${health.status}`);
        const ov = await Lib.proxyFetch(`${url}/api/overview`, { headers });
        if (!ov.ok) throw new Error(ov.json?.error || `认证失败 (${ov.status})`);
        const c = ov.json?.counts || {};
        note.textContent = `连接成功！已发现 ${c.projects || 0} 个项目、${c.mcpServers || 0} 个 MCP、${c.installedSkills || 0} 个已安装技能。`;
        note.className = "status-note ok";
      } catch (err) {
        note.textContent = `连接失败：${err.message}`;
        note.className = "status-note err";
      }
    });

    $("#btnSaveBackend").addEventListener("click", async () => {
      state.backendUrl = cleanBaseUrl($("#sBackendUrl").value);
      state.backendToken = $("#sBackendToken").value.trim();
      await savePersisted();
      await setMode("backend");
      switchTab("mcp");
      toast("已切换到直连后端模式", "ok");
    });

    $("#btnSaveLocalPrefs").addEventListener("click", async () => {
      state.defaultProjectPath = $("#sDefaultProject").value.trim();
      state.githubToken = $("#sGithubToken").value.trim();
      await savePersisted();
      toast("本地偏好已保存", "ok");
    });

    // Cache Manager Dialog
    const renderExtCacheStatus = (data) => {
      $("#extCacheMcpRoot").textContent = (data.mcpCacheDirs || []).join(", ") || "~/.gemini/antigravity-cli/mcp";
      $("#extCacheMcpCount").textContent = `共 ${data.mcpTotalCount || 0} 项 · 失效 ${data.mcpStaleCount || 0} 项`;
      const btnStale = $("#btnExtClearMcpStale");
      btnStale.textContent = `清理失效 MCP 缓存 (${data.mcpStaleCount || 0})`;
      btnStale.disabled = (data.mcpStaleCount || 0) === 0;
      $("#btnExtClearMcpAll").disabled = (data.mcpTotalCount || 0) === 0;

      const listEl = $("#extCacheMcpList");
      if (!data.mcpEntries?.length) {
        listEl.innerHTML = '<div class="muted">当前没有 MCP 缓存目录</div>';
      } else {
        listEl.innerHTML = data.mcpEntries
          .map(
            (e) => `
          <div class="card-top" style="padding:4px 0;border-top:1px solid var(--border)">
            <span class="mono">${esc(e.name)} (${e.fileCount})</span>
            <span class="badge ${e.stale ? "badge-global" : "badge-ok"}">${e.stale ? "失效残留" : "活跃"}</span>
          </div>`
          )
          .join("");
      }

      const repo = data.skillRepoCache || {};
      $("#extCacheRepoBadge").textContent = `${repo.repoCount || 0} 个 · ${fmtBytes(repo.sizeBytes || 0)}`;
      $("#extCacheRepoMeta").textContent = repo.path || "data/cache/repos";
      $("#btnExtClearSkillRepos").disabled = (repo.repoCount || 0) === 0;
    };

    const runBackendClearCache = async (target, confirmMsg) => {
      if (confirmMsg && !window.confirm(confirmMsg)) return;
      try {
        const res = await backendApi("POST", "/api/cache/clear", { target });
        renderExtCacheStatus(res.status);
        toast(
          res.removedCount > 0
            ? `已清理 ${res.removedCount} 项缓存，释放 ${fmtBytes(res.freedBytes)}`
            : "没有需要清理的缓存",
          "ok"
        );
      } catch (err) {
        toast(`清理失败: ${err.message}`, "err");
      }
    };

    $("#btnOpenCacheDlg").addEventListener("click", async () => {
      const isBackend = state.mode === "backend";
      $("#extCacheBackendWrap").classList.toggle("hidden", !isBackend);
      $("#extCacheBridgeWrap").classList.toggle("hidden", isBackend);
      if (isBackend) {
        try {
          const data = await backendApi("GET", "/api/cache");
          renderExtCacheStatus(data);
        } catch (err) {
          toast(`读取缓存状态失败: ${err.message}`, "err");
          return;
        }
      }
      openDlg("dlgCacheManager");
    });

    $("#btnExtClearMcpStale").addEventListener("click", () => runBackendClearCache("mcp_stale", null));
    $("#btnExtClearMcpAll").addEventListener("click", () =>
      runBackendClearCache("mcp_all", "确定清空全部 Antigravity MCP 工具缓存？（不影响配置，下次连接自动重建）")
    );
    $("#btnExtClearSkillRepos").addEventListener("click", () =>
      runBackendClearCache("skill_repos", "确定清理 Skill Git 仓库克隆缓存？（保留来源列表）")
    );

    $("#btnBridgeClearStale").addEventListener("click", async () => {
      closeDlg("dlgCacheManager");
      await sendToAntigravityChat(Lib.buildClearCachePrompt("mcp_stale"));
    });
    $("#btnBridgeClearAll").addEventListener("click", async () => {
      closeDlg("dlgCacheManager");
      await sendToAntigravityChat(Lib.buildClearCachePrompt("mcp_all"));
    });
    $("#btnBridgeClearLocalExtCache").addEventListener("click", async () => {
      state.localCatalogCache = {};
      await savePersisted();
      closeDlg("dlgCacheManager");
      renderCatalogTab();
      toast("已清理插件本地 GitHub 扫描缓存", "ok");
    });
  }

  // Bootstrap
  async function init() {
    await loadPersisted();
    bindEvents();
    $$(".mode-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === state.mode));
    if (state.mode === "backend" && cleanBaseUrl(state.backendUrl)) {
      await refreshBackendAll();
    } else {
      state.mode = "bridge";
      $$(".mode-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === "bridge"));
      renderAll();
    }
  }

  void init();
})();

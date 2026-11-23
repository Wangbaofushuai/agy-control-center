"use strict";

async function configureSidePanelBehavior() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (err) {
    console.error("Failed to configure side panel behavior:", err);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void configureSidePanelBehavior();
});

chrome.runtime.onStartup.addListener(() => {
  void configureSidePanelBehavior();
});

void configureSidePanelBehavior();

/**
 * Executed inside the active webpage to locate a chat composer input
 * (textarea / contenteditable / Shadow DOM) and fill text without submitting.
 */
function injectTextIntoPageComposer(textToFill) {
  function collectEditableCandidates(root, out) {
    const nodes = root.querySelectorAll(
      'textarea, [contenteditable="true"], [contenteditable=""], [role="textbox"]'
    );
    for (const el of nodes) {
      if (el.disabled || el.readOnly) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 80 || rect.height < 18) continue;
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
        continue;
      }
      out.push({ el, rect });
    }
    const allElements = root.querySelectorAll("*");
    for (const host of allElements) {
      if (host.shadowRoot) {
        collectEditableCandidates(host.shadowRoot, out);
      }
    }
  }

  const candidates = [];
  collectEditableCandidates(document, candidates);
  if (!candidates.length) {
    return { filled: false, reason: "未在当前页面检测到可输入的对话框" };
  }

  // Prefer the bottom-most wide composer box (standard chat UI pattern)
  candidates.sort((a, b) => {
    const scoreA = a.rect.bottom + a.rect.width * 0.25;
    const scoreB = b.rect.bottom + b.rect.width * 0.25;
    return scoreB - scoreA;
  });

  const target = candidates[0].el;
  target.focus();

  if (target.tagName === "TEXTAREA" || target.tagName === "INPUT") {
    const proto = Object.getPrototypeOf(target);
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    if (descriptor && descriptor.set) {
      descriptor.set.call(target, textToFill);
    } else {
      target.value = textToFill;
    }
    target.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    target.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    return { filled: true, kind: target.tagName.toLowerCase() };
  }

  // contenteditable / role="textbox" (ProseMirror, Lexical, Quill, Slate, plain div)
  try {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(target);
    selection.removeAllRanges();
    selection.addRange(range);
    const inserted = document.execCommand("insertText", false, textToFill);
    if (!inserted) {
      target.textContent = textToFill;
      target.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          composed: true,
          inputType: "insertText",
          data: textToFill,
        })
      );
    }
    return { filled: true, kind: "contenteditable" };
  } catch (err) {
    target.textContent = textToFill;
    target.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    return { filled: true, kind: "contenteditable-fallback" };
  }
}

async function handleProxyFetch(payload) {
  const { url, method = "GET", headers = {}, body = null } = payload || {};
  if (!url || typeof url !== "string") {
    throw new Error("缺少请求地址");
  }
  const init = {
    method,
    headers: { ...headers },
  };
  if (body !== null && body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  const resp = await fetch(url, init);
  const text = await resp.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return {
    ok: resp.ok,
    status: resp.status,
    statusText: resp.statusText,
    text,
    json,
  };
}

async function handleFillActiveChat(text) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !tab.id) {
    return { filled: false, reason: "未找到当前活动标签页" };
  }
  if (!tab.url || /^(chrome|edge|about|chrome-extension):/i.test(tab.url)) {
    return { filled: false, reason: "当前标签页不是网页，已复制到剪贴板，请切到 Antigravity Web 后粘贴" };
  }
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: injectTextIntoPageComposer,
    args: [text],
  });
  return results?.[0]?.result || { filled: false, reason: "页面注入未返回结果" };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return undefined;

  if (message.type === "PROXY_FETCH") {
    (async () => {
      try {
        const result = await handleProxyFetch(message.payload);
        sendResponse({ ok: true, data: result });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();
    return true;
  }

  if (message.type === "FILL_ACTIVE_CHAT") {
    (async () => {
      try {
        const result = await handleFillActiveChat(String(message.text || ""));
        sendResponse({ ok: true, data: result });
      } catch (err) {
        sendResponse({
          ok: false,
          error: err?.message || "无法向当前页面注入文本，请使用剪贴板粘贴",
        });
      }
    })();
    return true;
  }

  return undefined;
});

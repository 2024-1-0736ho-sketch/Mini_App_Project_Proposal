// background.js — PasteScope v3.3
// The alarm is a safety net for away-time when Chrome throttles content
// scripts in hidden tabs. content.js handles all active/idle/paused tracking.

const TIME_TICK_S    = 30;
const IDLE_THRESHOLD = 120_000; // 2 min

// ─── Tab URL tracking (S11 paste source fallback) ────────────────────────────
// When a user copies text from a webpage and then pastes into Google Docs,
// the "source" tab is usually the last active non-Docs tab. We track it here
// so content.js can request it as a fallback when clipboard metadata has no URL.
//
// We store { url, title, favicon } so the PDF and UI can show a rich label.
let lastNonDocsTab = null;

function _recordTab(tab) {
  if (!tab || !tab.url) return;
  const url = tab.url;
  // Only track real HTTP/S pages — skip chrome://, about:, extensions, and Docs itself
  if (!url.startsWith("http")) return;
  if (url.includes("docs.google.com")) return;
  lastNonDocsTab = {
    url:     url,
    title:   tab.title   || "",
    favicon: tab.favIconUrl || "",
  };
}

// Track whenever a tab becomes active
chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab) return;
    _recordTab(tab);
  });
});

// Track URL changes in the active tab (e.g. SPA navigation)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  if (!tab.active) return;
  _recordTab(tab);
});

// ─── Periodic alarm (away-time safety net for hidden tabs) ───────────────────
chrome.alarms.create("ps-time-tick", { periodInMinutes: TIME_TICK_S / 60 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "ps-time-tick") return;
  chrome.storage.local.get(["timeStats", "lastActivityTime", "isTabVisible", "isPaused"], (data) => {
    // Only increment away-time via alarm when tab is hidden AND not paused.
    if (data.isTabVisible === false && !data.isPaused) {
      const ts  = data.timeStats || { activeMs: 0, idleMs: 0, awayMs: 0 };
      ts.awayMs = (ts.awayMs || 0) + TIME_TICK_S * 1000;
      chrome.storage.local.set({ timeStats: ts });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  MAIN MESSAGE HANDLER
// ═══════════════════════════════════════════════════════════════════════════════
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const VALID = [
    "SYNC_MAP", "GET_STATS", "RESET_STATS", "TOGGLE_HUD",
    "GET_HUD_STATE", "INCREMENT_PASTE",
    "ACTIVITY_PING", "TAB_VISIBLE", "TAB_HIDDEN", "GET_TIME_STATS",
    "PAUSE_TRACKING", "RESUME_TRACKING", "FETCH_DOC_TEXT", "GET_TAB_ID",
    "GET_LAST_SOURCE_URL"
  ];
  if (!VALID.includes(msg.type)) return false;

  // ── GET_TAB_ID: return the sender tab's id to content.js ───────────────────
  if (msg.type === "GET_TAB_ID") {
    sendResponse({ tabId: sender.tab ? sender.tab.id : null });
    return true;
  }

  // ── GET_LAST_SOURCE_URL: return the last non-Docs tab URL ──────────────────
  // Used by content.js as paste source strategy S11 when clipboard metadata
  // does not carry a URL (e.g. copy from PDF viewer, terminal, local app).
  if (msg.type === "GET_LAST_SOURCE_URL") {
    sendResponse(lastNonDocsTab
      ? { url: lastNonDocsTab.url, title: lastNonDocsTab.title, favicon: lastNonDocsTab.favicon }
      : { url: null }
    );
    return true;
  }

  // ── FETCH_DOC_TEXT: run fetch in the MAIN world of the Docs tab ─────────────
  // Content-script fetches get redirected to Google login.
  // Service-worker fetches don't carry the browser session cookie.
  // The only reliable way is to inject a fetch() call into the page's MAIN
  // world — it runs with the page's own credentials and Google session.
  if (msg.type === "FETCH_DOC_TEXT") {
    const { docId, tabId } = msg;
    if (!docId || !tabId) { sendResponse({ error: "Missing docId or tabId" }); return true; }

    chrome.scripting.executeScript({
      target: { tabId: tabId },
      world: "MAIN",           // ← runs in page context, inherits session cookies
      func: async (id) => {
        try {
          const url = `https://docs.google.com/document/d/${id}/export?format=txt`;
          const res = await fetch(url, { credentials: "same-origin" });
          if (!res.ok) return { error: `HTTP ${res.status}` };
          const ct = res.headers.get("content-type") || "";
          if (ct.includes("text/html")) return { error: "redirect" };
          const raw = await res.text();
          if (raw.trimStart().startsWith("<!")) return { error: "html_redirect" };
          return { text: raw };
        } catch (e) {
          return { error: e.message };
        }
      },
      args: [docId],
    }, (results) => {
      if (chrome.runtime.lastError || !results || !results[0]) {
        sendResponse({ error: chrome.runtime.lastError?.message || "Script injection failed" });
        return;
      }
      const result = results[0].result;
      if (!result || result.error) {
        sendResponse({ error: result?.error || "No result" });
        return;
      }
      const text = (result.text || "")
        .replace(/^\uFEFF/, "")
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n")
        .trim();
      sendResponse({ text });
    });
    return true;
  }

  // ── Fast-path lightweight messages ──────────────────────────────────────────
  if (msg.type === "ACTIVITY_PING") {
    chrome.storage.local.set({ lastActivityTime: Date.now(), isTabVisible: true });
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === "TAB_VISIBLE") {
    chrome.storage.local.set({ isTabVisible: true, lastActivityTime: Date.now() });
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === "TAB_HIDDEN") {
    chrome.storage.local.set({ isTabVisible: false });
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === "PAUSE_TRACKING") {
    chrome.storage.local.set({ isPaused: true });
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === "RESUME_TRACKING") {
    chrome.storage.local.set({ isPaused: false, lastActivityTime: Date.now() });
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === "GET_TIME_STATS") {
    chrome.storage.local.get(["timeStats", "lastActivityTime", "isTabVisible", "isPaused"], (data) => {
      sendResponse({
        timeStats:        data.timeStats || { activeMs: 0, idleMs: 0, awayMs: 0 },
        lastActivityTime: data.lastActivityTime || 0,
        isTabVisible:     data.isTabVisible !== false,
        isPaused:         data.isPaused === true,
      });
    });
    return true;
  }

  // ── Full-path: originality + HUD state ──────────────────────────────────────
  chrome.storage.local.get(
    ["charMap", "hudVisible", "stats", "cursorIdx", "timeStats", "lastActivityTime", "isTabVisible", "isPaused"],
    (data) => {
      let charMap    = data.charMap    || [];
      let hudVisible = data.hudVisible !== undefined ? data.hudVisible : true;
      let stats      = data.stats      || { pasteCount: 0 };
      let cursorIdx  = data.cursorIdx  !== undefined ? data.cursorIdx : 0;
      let timeStats  = data.timeStats  || { activeMs: 0, idleMs: 0, awayMs: 0 };

      switch (msg.type) {
        case "SYNC_MAP":
          charMap   = msg.charMap   || [];
          cursorIdx = msg.cursorIdx !== undefined ? msg.cursorIdx : charMap.length;
          break;
        case "INCREMENT_PASTE":
          stats = { ...stats, pasteCount: (stats.pasteCount || 0) + 1 };
          chrome.storage.local.set({ stats });
          sendResponse({ pasteCount: stats.pasteCount });
          return;
        case "RESET_STATS":
          charMap   = [];
          stats     = { pasteCount: 0 };
          cursorIdx = 0;
          timeStats = { activeMs: 0, idleMs: 0, awayMs: 0 };
          chrome.storage.local.set({
            lastActivityTime: Date.now(),
            isTabVisible: true,
            isPaused: false,
            pasteEvents: [],
            sessionStartTime: null,
            sessionStart: null,
          });
          break;
        case "TOGGLE_HUD":
          hudVisible = !hudVisible;
          break;
        case "GET_STATS":
        case "GET_HUD_STATE":
          break;
      }

      let typed = 0, pasted = 0;
      for (const entry of charMap) {
        if (entry.type === "typed")       typed++;
        else if (entry.type === "pasted") pasted++;
      }
      const total       = typed + pasted;
      const originality = total === 0 ? 100 : Math.round((typed / total) * 100);

      const segments = [];
      for (const entry of charMap) {
        const last = segments[segments.length - 1];
        if (last && last.type === entry.type) last.text += entry.char;
        else segments.push({ type: entry.type, text: entry.char });
      }

      // Cap total charMap size. We always preserve all "existing" entries at the
      // front (they are the pre-loaded document baseline) and trim only from the
      // typed/pasted tail if needed.
      const CAP = 50_000;
      if (charMap.length > CAP) {
        // Find where typed/pasted content starts (after existing prefix)
        let existingEnd = 0;
        while (existingEnd < charMap.length && charMap[existingEnd].type === "existing") existingEnd++;
        const newOnly = charMap.slice(existingEnd);
        const trimmed = newOnly.slice(-(CAP - existingEnd));
        charMap = charMap.slice(0, existingEnd).concat(trimmed);
      }

      const newStats = { typed, pasted, total, originality, pasteCount: stats.pasteCount || 0 };

      const now          = Date.now();
      const lastActivity = data.lastActivityTime || 0;
      const isVisible    = data.isTabVisible !== false;
      const isPaused     = data.isPaused === true;

      let trackingState = "active";
      if (isPaused)                                                       trackingState = "paused";
      else if (!isVisible)                                                trackingState = "away";
      else if (!lastActivity || now - lastActivity > IDLE_THRESHOLD)      trackingState = "idle";

      chrome.storage.local.set({ charMap, hudVisible, stats: newStats, cursorIdx, timeStats }, () => {
        sendResponse({
          typed, pasted, total, originality, segments, hudVisible,
          pasteCount: newStats.pasteCount, cursorIdx,
          timeStats, trackingState,
        });
      });

      const badgeColor = originality >= 75 ? "#34d399" : originality >= 50 ? "#fbbf24" : "#f87171";
      chrome.action.setBadgeText({ text: total > 0 ? `${originality}%` : "" });
      chrome.action.setBadgeBackgroundColor({ color: badgeColor });
    }
  );
  return true;
});
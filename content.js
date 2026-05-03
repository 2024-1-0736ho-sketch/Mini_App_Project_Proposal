// content.js — PasteScope v3.3
//
// FIXES vs v2.4:
//   • Time tracker no longer stops when user clicks into Google Docs.
//     Root cause: window "blur" fired when focus moved from HUD → Docs iframe.
//     Fix: blur only sets Away if the new focused element is OUTSIDE the Docs
//     origin (using document.hasFocus() debounce + iframe focus guard).
//   • Cursor sync now reads selection from the Docs iframe's contentDocument,
//     not the top-level document — fixes the permanent cursor mismatch.
//   • Pause / Resume button added to Time Tracker section in the HUD.
//   • Time tracker now auto-starts on the first click inside Google Docs
//     (not just on keypresses), so opening a file and clicking triggers Active.

let shadow, hudEl, hudScore, hudTyped, hudPasted, hudBar, logPanel, logContent;
let hudRingFill;
let hudVisible  = true;
let isMinimized = false;
let isDragging  = false;
let dragOffsetX = 0;
let dragOffsetY = 0;
let toastTimer  = null;

// ── NEW: Paste source tracking ──────────────────────────────────────────────
// Each paste event is stored as { text, sourceUrl, timestamp }
let pasteEvents = [];
// Session start time (ms) — set when tracking first begins
let sessionStartTime = null;

// Pre-existing document content (loaded on open — shown in log but NOT counted in stats)
let existingDocText = "";

// Reset coordination: prevents async RESET_STATS response from re-drawing old data
let _skipNextRender    = false;
let _resetLocalCharMap = () => {}; // overwritten by attachListeners

// Module-level hook: applyExisting (a top-level function) needs to write into
// the charMap/cursorIdx that live inside attachListeners' closure.
// attachListeners sets this to a function that injects existing entries.
let _applyExistingToCharMap = (_text) => {}; // overwritten by attachListeners

// Hook: forces a cursor re-sync + SYNC_MAP event from within attachListeners'
// closure. Used when the log panel is opened so the cursor immediately jumps
// to the right position in the log.
let _forceSyncMap = () => {}; // overwritten by attachListeners

// Time tracker DOM refs (set after buildUI)
let hudTimeActive, hudTimeIdle, hudTimeAway;
let hudTbarActive, hudTbarIdle, hudTbarAway;
let hudTrackingDot, hudTrackingLabel;
let hudPauseBtn; // NEW: pause button ref

const CIRC = 2 * Math.PI * 30;

if (window.top === window.self) {
  chrome.storage.local.get(["hudPos", "hudMinimized", "hudVisible"], (data) => {
    hudVisible  = data.hudVisible  !== false;
    isMinimized = data.hudMinimized === true;
    buildUI(data.hudPos || { top: 20, right: 20 });
    sendEvent({ type: "GET_HUD_STATE" });
    chrome.runtime.sendMessage({ type: "GET_TIME_STATS" }, (res) => {
      if (chrome.runtime.lastError || !res) return;
      updateHUDTime(res.timeStats, "active");
    });
    // If existingDocText was already fetched before buildUI finished,
    // push it into the log now that logContent exists.
    if (existingDocText) forceExistingTextRender();
  });
}

// ─── BUILD UI ────────────────────────────────────────────────────────────────
function buildUI(pos) {
  const host = document.createElement("div");
  host.id = "pastescope-host";
  host.style.cssText =
    "all:unset;display:block;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;";
  document.body.appendChild(host);
  shadow = host.attachShadow({ mode: "open" });

  const posStyle =
    pos.left !== undefined
      ? `top:${pos.top}px;left:${pos.left}px;right:auto;`
      : `top:${pos.top}px;right:${pos.right !== undefined ? pos.right : 20}px;left:auto;`;

  shadow.innerHTML = `
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;700&display=swap');
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

      :host {
        --bg:        #ffffff;
        --surface:   #f8f9fa;
        --surface2:  #f1f3f4;
        --border:    #dadce0;
        --border2:   #c5cae9;
        --text:      #202124;
        --muted:     #5f6368;
        --muted2:    #9aa0a6;
        --green:     #188038;
        --yellow:    #f29900;
        --red:       #d93025;
        --blue:      #1a73e8;
        --accent:    #1a73e8;
        --docs-canvas: #f0f2f5;
        --docs-page:   #ffffff;
        --docs-text:   #202124;
      }

      #ps-hud {
        position: fixed;
        ${posStyle}
        z-index: 2147483647;
        width: 200px;
        background: var(--bg);
        border: 1px solid var(--border);
        border-radius: 16px;
        font-family: 'Space Grotesk', sans-serif;
        color: var(--text);
        box-shadow: 0 4px 16px rgba(0,0,0,0.12), 0 1px 4px rgba(0,0,0,0.08);
        user-select: none;
        pointer-events: auto;
        overflow: hidden;
        transition: opacity 0.25s, transform 0.3s cubic-bezier(0.4,0,0.2,1), width 0.25s, border-radius 0.25s;
      }

      #ps-hud::before {
        content: '';
        position: absolute;
        inset: 0;
        background: none;
        pointer-events: none;
      }

      #ps-hud.ps-hidden { opacity: 0; pointer-events: none; transform: translateY(-10px) scale(0.96); }

      #ps-hud.ps-minimized { width: 158px; border-radius: 99px; }
      #ps-hud.ps-minimized #ps-body   { display: none; }
      #ps-hud.ps-minimized #ps-header { padding: 8px 12px; border-bottom: none; }
      #ps-hud.ps-minimized .ps-title  { display: none; }
      #ps-hud.ps-minimized #ps-mini   { display: flex !important; }

      #ps-header {
        display: flex; align-items: center; justify-content: space-between;
        gap: 6px; padding: 10px 12px 9px;
        border-bottom: 1px solid var(--border);
        cursor: grab;
        background: linear-gradient(180deg, rgba(26,115,232,0.05) 0%, transparent 100%);
        transition: background 0.15s, padding 0.2s, border 0.2s;
        position: relative;
      }
      #ps-header:hover   { background: linear-gradient(180deg, rgba(26,115,232,0.09) 0%, transparent 100%); }
      #ps-header.dragging { cursor: grabbing; }

      .ps-title { font-size: 10px; font-weight: 600; letter-spacing: 0.04em; color: var(--muted); flex: 1; white-space: nowrap; }

      #ps-mini { display: none; align-items: center; gap: 7px; flex: 1; }
      #ps-mini-pct { font-size: 13px; font-weight: 700; font-family: 'JetBrains Mono', monospace; white-space: nowrap; transition: color 0.4s; }
      #ps-mini-bar { flex: 1; height: 3px; background: var(--surface2); border-radius: 99px; overflow: hidden; }
      #ps-mini-fill { height: 100%; border-radius: 99px; width: 100%; transition: width 0.5s ease, background 0.4s; }

      .ps-btns { display: flex; align-items: center; gap: 3px; flex-shrink: 0; }
      .ps-icon-btn {
        background: none; border: none;
        color: var(--muted); cursor: pointer;
        font-size: 13px; width: 22px; height: 22px;
        display: flex; align-items: center; justify-content: center;
        border-radius: 6px; pointer-events: auto;
        transition: color 0.15s, background 0.15s;
      }
      .ps-icon-btn:hover { color: var(--text); background: var(--surface2); }

      #ps-body { padding: 14px 14px 12px; position: relative; }

      .ps-ring-wrap { display: flex; align-items: center; justify-content: center; margin-bottom: 10px; position: relative; }
      .ps-ring-wrap svg { overflow: visible; }
      .ring-track { fill: none; stroke: var(--surface2); stroke-width: 5; }
      .ring-fill {
        fill: none; stroke-width: 5; stroke-linecap: round;
        transition: stroke-dashoffset 0.6s cubic-bezier(0.4,0,0.2,1), stroke 0.4s;
        stroke-dasharray: ${CIRC.toFixed(1)};
        stroke-dashoffset: ${CIRC.toFixed(1)};
        transform: rotate(-90deg); transform-origin: center;
      }
      .ring-glow {
        fill: none; stroke-width: 10; stroke-linecap: round; opacity: 0.15;
        stroke-dasharray: ${CIRC.toFixed(1)};
        stroke-dashoffset: ${CIRC.toFixed(1)};
        transition: stroke-dashoffset 0.6s cubic-bezier(0.4,0,0.2,1), stroke 0.4s;
        transform: rotate(-90deg); transform-origin: center;
      }
      .ring-center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px; }
      .ps-score { font-size: 22px; font-weight: 700; font-family: 'JetBrains Mono', monospace; line-height: 1; transition: color 0.4s; }
      .ps-score-lbl { font-size: 8px; color: var(--muted); letter-spacing: 0.1em; text-transform: uppercase; }

      .ps-badge { display: flex; align-items: center; justify-content: center; gap: 5px; margin-bottom: 10px; }
      .ps-badge-inner { display: inline-flex; align-items: center; gap: 4px; padding: 3px 9px; border-radius: 99px; font-size: 9px; font-weight: 600; letter-spacing: 0.05em; border: 1px solid transparent; transition: all 0.4s; }
      .ps-badge-dot { width: 5px; height: 5px; border-radius: 50%; animation: ps-pulse 2s ease-in-out infinite; }
      @keyframes ps-pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }

      .ps-badge-green  { background: rgba(24,128,56,0.10); color: var(--green);  border-color: rgba(24,128,56,0.25); }
      .ps-badge-green  .ps-badge-dot { background: var(--green); }
      .ps-badge-yellow { background: rgba(242,153,0,0.10); color: var(--yellow); border-color: rgba(242,153,0,0.25); }
      .ps-badge-yellow .ps-badge-dot { background: var(--yellow); }
      .ps-badge-red    { background: rgba(217,48,37,0.10); color: var(--red);   border-color: rgba(217,48,37,0.25); }
      .ps-badge-red    .ps-badge-dot { background: var(--red); }

      .ps-stats { display: flex; flex-direction: column; gap: 5px; margin-bottom: 10px; }
      .ps-row { display: flex; justify-content: space-between; align-items: center; font-size: 11px; padding: 5px 8px; border-radius: 7px; cursor: pointer; background: var(--surface); border: 1px solid var(--border); transition: all 0.15s; }
      .ps-row:hover { background: var(--surface2); transform: translateX(2px); }
      .ps-row .ps-row-label { color: var(--muted); display: flex; align-items: center; gap: 5px; }
      .ps-row .ps-row-val   { font-weight: 700; font-family: 'JetBrains Mono', monospace; font-size: 12px; }
      .ps-row .ps-row-words { font-size: 8px; color: var(--muted2); margin-left: 3px; }
      .typed-row  .ps-row-val { color: var(--green); }
      .pasted-row .ps-row-val { color: var(--red);   }
      .ps-row-sub { font-size: 8px; color: var(--muted2); margin-left: 2px; }

      .ps-divider { height: 1px; background: var(--border); margin: 8px 0; }

      .ps-save-btn { display: block; width: 100%; padding: 7px 0; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; color: var(--muted); font-family: 'Space Grotesk', sans-serif; font-size: 10px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; cursor: pointer; pointer-events: auto; transition: all 0.2s; }
      .ps-save-btn:hover { background: rgba(24,128,56,0.08); color: var(--green); border-color: rgba(24,128,56,0.3); }

      .ps-shortcut { text-align: center; font-size: 8px; color: var(--muted2); margin-top: 8px; letter-spacing: 0.05em; font-family: 'JetBrains Mono', monospace; }

      #ps-toast {
        position: fixed; z-index: 2147483647;
        padding: 7px 13px; border-radius: 99px;
        background: rgba(217,48,37,0.10); border: 1px solid rgba(217,48,37,0.25);
        color: var(--red); font-family: 'Space Grotesk', sans-serif;
        font-size: 11px; font-weight: 600;
        display: flex; align-items: center; gap: 7px;
        pointer-events: none; opacity: 0; transform: translateY(4px);
        transition: opacity 0.2s, transform 0.2s; white-space: nowrap;
      }
      #ps-toast.visible { opacity: 1; transform: translateY(0); }
      .toast-icon { font-size: 12px; }

      #ps-log {
        position: fixed; z-index: 2147483646;
        width: 300px; max-height: 500px;
        background: var(--bg); border: 1px solid var(--border); border-radius: 16px;
        font-family: 'Space Grotesk', sans-serif; color: var(--text);
        box-shadow: 0 4px 20px rgba(0,0,0,0.12), 0 1px 4px rgba(0,0,0,0.06);
        display: flex; flex-direction: column; overflow: hidden;
        pointer-events: auto;
        transition: opacity 0.25s, transform 0.3s cubic-bezier(0.4,0,0.2,1);
      }
      #ps-log.hidden { opacity: 0; pointer-events: none; transform: translateX(12px) scale(0.98); }
      #ps-log::before { content: none; }

      .log-header { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px 10px; border-bottom: 1px solid var(--border); flex-shrink: 0; background: linear-gradient(180deg, rgba(26,115,232,0.05) 0%, transparent 100%); position: relative; }
      .log-title { font-size: 11px; font-weight: 600; color: var(--muted); letter-spacing: 0.04em; }

      .log-legend { display: flex; gap: 12px; padding: 8px 14px; border-bottom: 1px solid var(--border); flex-shrink: 0; align-items: center; position: relative; }
      .log-legend-item { display: flex; align-items: center; gap: 5px; font-size: 10px; color: var(--muted); font-weight: 500; cursor: pointer; transition: color 0.15s; padding: 2px 6px; border-radius: 5px; }
      .log-legend-item:hover { background: var(--surface2); }
      .log-legend-item.active-filter { color: var(--text); background: var(--surface2); }
      .dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
      .dot.typed  { background: var(--green); box-shadow: 0 0 5px var(--green); }
      .dot.pasted { background: var(--red);   box-shadow: 0 0 5px var(--red); }

      .log-filter-clear { margin-left: auto; font-size: 9px; color: var(--muted2); cursor: pointer; display: none; padding: 2px 6px; border-radius: 4px; transition: all 0.15s; }
      .log-filter-clear:hover { color: var(--text); background: var(--surface2); }
      .log-filter-clear.visible { display: block; }

      #ps-log-content {
        overflow-y: auto; flex: 1; padding: 12px 16px;
        font-size: 13px; line-height: 1.5; word-break: break-word;
        font-family: var(--docs-font, Arial, sans-serif); position: relative;
        white-space: pre-wrap;
        background: #ffffff !important;
        color: #202124 !important;
        margin: 15px 25px;
        box-shadow: 0 1px 3px rgba(0,0,0,0.2);
        border-radius: 2px;
      }
      #ps-log-content::-webkit-scrollbar { width: 4px; }
      #ps-log-content::-webkit-scrollbar-thumb { background: var(--border2); border-radius: 99px; }

      .seg { display: inline; border-radius: 3px; padding: 1px 2px; transition: opacity 0.25s; }
      .seg.typed    { color: #0d7a4e; background: rgba(52,211,153,0.15); font-weight: 500; }
      .seg.pasted   { color: #c0392b; background: rgba(248,113,113,0.15); text-decoration: underline; text-decoration-color: rgba(248,113,113,0.4); font-weight: 500; }
      .seg.existing { color: #202124; background: transparent; }
      .seg.dim      { opacity: 0.2; }

      .dot.existing { background: var(--blue); box-shadow: 0 0 5px var(--blue); }

      .ps-cursor { display: inline-block; width: 2px; height: 1.1em; background: var(--accent); border-radius: 1px; vertical-align: text-bottom; margin: 0 1px; animation: ps-blink 1.1s step-start infinite; box-shadow: 0 0 6px rgba(99,102,241,0.7); pointer-events: none; }
      @keyframes ps-blink { 0%,100%{opacity:1} 50%{opacity:0} }

      .log-empty { color: var(--muted2); font-size: 10px; text-align: center; padding: 40px 0; letter-spacing: 0.05em; line-height: 1.8; }
      .log-empty-icon { font-size: 28px; margin-bottom: 10px; opacity: 0.4; display: block; }

      .log-stats-footer { padding: 8px 14px; border-top: 1px solid var(--border); display: flex; gap: 12px; flex-shrink: 0; background: var(--surface); position: relative; }
      .log-stat { font-size: 9px; color: var(--muted); font-family: 'JetBrains Mono', monospace; }
      .log-stat strong { color: var(--text); }

      /* ── TIME TRACKER SECTION ── */
      .ps-time-section { margin-bottom: 8px; background: var(--surface); border: 1px solid var(--border); border-radius: 9px; padding: 8px 10px 7px; }
      .ps-time-title { font-size: 8px; color: var(--muted); letter-spacing: 0.12em; text-transform: uppercase; font-family: 'JetBrains Mono', monospace; margin-bottom: 5px; display: flex; align-items: center; gap: 5px; }
      .ps-time-title-state { display: flex; align-items: center; gap: 3px; margin-left: auto; font-size: 8px; font-weight: 600; text-transform: none; letter-spacing: 0.02em; }
      .ps-tracking-dot { width: 5px; height: 5px; border-radius: 50%; animation: ps-pulse 2s ease-in-out infinite; }
      .ps-time-row { display: flex; align-items: center; gap: 5px; margin-bottom: 3px; }
      .ps-time-dot { width: 5px; height: 5px; border-radius: 50%; flex-shrink: 0; }
      .ps-time-dot.active { background: var(--green); box-shadow: 0 0 4px rgba(52,211,153,0.5); }
      .ps-time-dot.idle   { background: var(--yellow); }
      .ps-time-dot.away   { background: var(--red); }
      .ps-time-lbl { color: var(--muted); font-size: 9px; flex: 1; font-family: 'JetBrains Mono', monospace; }
      .ps-time-bar-wrap { flex: 2; height: 3px; background: var(--surface2); border-radius: 99px; overflow: hidden; }
      .ps-time-bar { height: 100%; border-radius: 99px; width: 0%; transition: width 0.6s cubic-bezier(0.4,0,0.2,1); }
      .ps-time-bar.active { background: var(--green); }
      .ps-time-bar.idle   { background: var(--yellow); }
      .ps-time-bar.away   { background: var(--red); }
      .ps-time-val { font-family: 'JetBrains Mono', monospace; font-size: 9px; font-weight: 700; color: var(--text); min-width: 24px; text-align: right; }

      /* NEW: Pause button */
      #ps-pause-btn {
        display: block; width: 100%; padding: 5px 0; margin-top: 6px;
        background: var(--surface); border: 1px solid var(--border);
        border-radius: 6px; color: var(--muted);
        font-family: 'Space Grotesk', sans-serif; font-size: 9px;
        font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase;
        cursor: pointer; pointer-events: auto; transition: all 0.2s;
        text-align: center;
      }
      #ps-pause-btn:hover { background: rgba(26,115,232,0.08); color: var(--accent); border-color: rgba(26,115,232,0.3); }
      #ps-pause-btn.paused { background: rgba(242,153,0,0.08); color: var(--yellow); border-color: rgba(242,153,0,0.3); }

      /* ── SOURCES PANEL ── */
      #ps-sources-panel {
        position: fixed; z-index: 2147483645;
        width: 320px; max-height: 420px;
        background: var(--bg); border: 1px solid var(--border); border-radius: 14px;
        font-family: 'Space Grotesk', sans-serif; color: var(--text);
        box-shadow: 0 4px 20px rgba(0,0,0,0.12);
        display: flex; flex-direction: column; overflow: hidden;
        pointer-events: auto;
        transition: opacity 0.25s, transform 0.3s cubic-bezier(0.4,0,0.2,1);
      }
      #ps-sources-panel.hidden { opacity: 0; pointer-events: none; transform: translateX(12px) scale(0.98); }
      .sources-header { display: flex; align-items: center; justify-content: space-between; padding: 10px 13px 9px; border-bottom: 1px solid var(--border); background: linear-gradient(180deg, rgba(26,115,232,0.05) 0%, transparent 100%); }
      .sources-title { font-size: 11px; font-weight: 600; color: var(--muted); letter-spacing: 0.04em; }
      .sources-list { overflow-y: auto; flex: 1; padding: 10px 12px; }
      .sources-list::-webkit-scrollbar { width: 4px; }
      .sources-list::-webkit-scrollbar-thumb { background: var(--border2); border-radius: 99px; }
      .source-entry {
        margin-bottom: 8px; padding: 8px 10px; border-radius: 8px;
        border: 1px solid var(--border); background: var(--surface);
        font-size: 10px; line-height: 1.5;
      }
      .source-entry-meta { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
      .source-entry-num { font-weight: 700; color: var(--accent); font-family: 'JetBrains Mono', monospace; font-size: 9px; }
      .source-entry-time { color: var(--muted2); font-family: 'JetBrains Mono', monospace; font-size: 9px; }
      .source-entry-url { color: var(--blue); word-break: break-all; font-size: 10px; margin-bottom: 3px; }
      .source-entry-url a { color: var(--blue); text-decoration: underline; }
      .source-entry-preview { color: var(--muted); font-style: italic; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 9px; }
      .source-empty { color: var(--muted2); font-size: 10px; text-align: center; padding: 30px 0; letter-spacing: 0.04em; }
      .source-start-time { font-size: 9px; color: var(--muted2); text-align: center; padding: 4px 0 8px; border-bottom: 1px solid var(--border); margin-bottom: 6px; font-family: 'JetBrains Mono', monospace; }

      /* ── SESSION START chip inside HUD ── */
      .ps-session-start { font-size: 8px; color: var(--muted2); text-align: center; padding: 3px 0 1px; font-family: 'JetBrains Mono', monospace; letter-spacing: 0.03em; }

      /* ── LOG TABS ── */
      .log-tabs { display: flex; border-bottom: 1px solid var(--border); flex-shrink: 0; background: var(--surface); }
      .log-tab { flex: 1; padding: 7px 0; font-size: 9px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); cursor: pointer; text-align: center; font-family: 'JetBrains Mono', monospace; border: none; background: none; transition: color 0.15s, border-bottom 0.15s; border-bottom: 2px solid transparent; pointer-events: auto; }
      .log-tab.active { color: var(--accent); border-bottom-color: var(--accent); }
      .log-tab-panel { display: none; flex: 1; overflow: hidden; flex-direction: column; min-height: 0; }
      .log-tab-panel.active { display: flex; }

      /* ── FULL LOG (color-coded) ── */
      #ps-fulllog-content { overflow-y: auto; flex: 1; padding: 12px 14px; font-family: Arial, sans-serif; font-size: 13px; line-height: 1.65; word-break: break-word; white-space: pre-wrap; background: #ffffff; color: #202124; }
      #ps-fulllog-content::-webkit-scrollbar { width: 4px; }
      #ps-fulllog-content::-webkit-scrollbar-thumb { background: #dadce0; border-radius: 99px; }
      .fl-seg { display: inline; border-radius: 3px; padding: 1px 2px; }
      .fl-seg.typed { color: #0d7a4e; background: rgba(52,211,153,0.15); font-weight: 500; }
      .fl-seg.pasted { color: #c0392b; background: rgba(248,113,113,0.15); text-decoration: underline; text-decoration-color: rgba(248,113,113,0.4); font-weight: 500; }
      .fl-seg.existing { color: #202124; background: transparent; }
      .fl-legend { display: flex; gap: 10px; padding: 6px 14px; border-bottom: 1px solid #e8eaed; background: #f8f9fa; flex-shrink: 0; }
      .fl-legend-item { display: flex; align-items: center; gap: 4px; font-size: 10px; color: #5f6368; font-weight: 500; }
      .fl-legend-dot { width: 8px; height: 8px; border-radius: 50%; }

      /* ── PASTE LOG ENTRIES ── */
      #ps-log-content { overflow-y: auto; flex: 1; padding: 10px 12px; font-size: 12px; line-height: 1.5; word-break: break-word; position: relative; background: #ffffff; }
      #ps-log-content::-webkit-scrollbar { width: 4px; }
      #ps-log-content::-webkit-scrollbar-thumb { background: var(--border); border-radius: 99px; }

      /* ── SOURCE TYPE BADGES ── */
      .src-type-badge { display: inline-flex; align-items: center; gap: 3px; font-size: 8px; font-weight: 700; letter-spacing: 0.05em; padding: 1px 5px; border-radius: 4px; text-transform: uppercase; font-family: 'JetBrains Mono', monospace; flex-shrink: 0; }
      .src-type-website { background: rgba(59,130,246,0.15); color: #3b82f6; border: 1px solid rgba(59,130,246,0.3); }
      .src-type-gdoc { background: rgba(52,211,153,0.15); color: #1a9e6e; border: 1px solid rgba(52,211,153,0.3); }
      .src-type-local { background: rgba(251,191,36,0.15); color: #b45309; border: 1px solid rgba(251,191,36,0.3); }
      .src-type-unknown { background: rgba(74,96,128,0.15); color: var(--muted); border: 1px solid var(--border2); }

      .paste-entry {
        margin-bottom: 10px; border-radius: 10px;
        border: 1px solid rgba(217,48,37,0.2);
        background: rgba(217,48,37,0.03);
        overflow: hidden;
      }
      .paste-entry-header {
        display: flex; align-items: center; gap: 7px;
        padding: 7px 10px 6px;
        background: rgba(217,48,37,0.06);
        border-bottom: 1px solid rgba(217,48,37,0.10);
        flex-wrap: wrap;
      }
      .paste-entry-num {
        font-size: 9px; font-weight: 700; color: var(--red);
        font-family: 'JetBrains Mono', monospace;
        background: rgba(217,48,37,0.10); border-radius: 4px;
        padding: 1px 5px; flex-shrink: 0;
      }
      .paste-entry-source { flex: 1; min-width: 0; }
      .paste-entry-domain {
        font-size: 10px; font-weight: 600; color: var(--blue);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        font-family: 'JetBrains Mono', monospace;
      }
      .paste-entry-domain a { color: var(--blue); text-decoration: none; }
      .paste-entry-domain a:hover { text-decoration: underline; }
      .paste-entry-url-full {
        font-size: 8px; color: var(--muted2); white-space: nowrap;
        overflow: hidden; text-overflow: ellipsis; max-width: 220px;
        font-family: 'JetBrains Mono', monospace;
      }
      .paste-entry-unknown { font-size: 10px; color: var(--muted); font-style: italic; }
      .paste-entry-meta {
        display: flex; gap: 8px; align-items: center; flex-shrink: 0;
        font-size: 8px; color: var(--muted); font-family: 'JetBrains Mono', monospace;
      }
      .paste-entry-body {
        padding: 8px 10px;
        font-family: Arial, sans-serif;
        font-size: 12px; line-height: 1.6;
        color: #b91c1c;
        white-space: pre-wrap; word-break: break-word;
        max-height: 100px; overflow: hidden; position: relative;
      }
      .paste-entry-body.expanded { max-height: none; }
      .paste-entry-body:not(.expanded)::after {
        content: '';
        position: absolute; bottom: 0; left: 0; right: 0; height: 28px;
        background: linear-gradient(transparent, rgba(255,248,248,0.97));
        pointer-events: none;
      }
      .paste-entry-expand {
        display: block; width: 100%; padding: 4px 0;
        background: none; border: none; border-top: 1px solid rgba(217,48,37,0.08);
        color: var(--muted); font-size: 9px; cursor: pointer;
        font-family: 'Space Grotesk', sans-serif;
        text-align: center; transition: color 0.15s, background 0.15s;
        pointer-events: auto; letter-spacing: 0.04em;
      }
      .paste-entry-expand:hover { color: var(--red); background: rgba(217,48,37,0.05); }
    </style>

    <!-- ── HUD ── -->
    <div id="ps-hud">
      <div id="ps-header">
        <span class="ps-title">PasteScope</span>
        <div id="ps-mini">
          <span id="ps-mini-pct">100%</span>
          <div id="ps-mini-bar"><div id="ps-mini-fill"></div></div>
        </div>
        <div class="ps-btns">
          <button class="ps-icon-btn" id="ps-log-btn"  title="Text log (≡)">≡</button>
          <button class="ps-icon-btn" id="ps-min-btn"  title="Minimize">−</button>
        </div>
      </div>

      <div id="ps-body">
        <!-- Ring -->
        <div class="ps-ring-wrap">
          <svg width="76" height="76" viewBox="0 0 76 76">
            <circle class="ring-track" cx="38" cy="38" r="30"/>
            <circle class="ring-glow"  id="ps-ring-glow" cx="38" cy="38" r="30"/>
            <circle class="ring-fill"  id="ps-ring-fill" cx="38" cy="38" r="30"/>
          </svg>
          <div class="ring-center">
            <div class="ps-score" id="ps-score">—</div>
            <div class="ps-score-lbl">original</div>
          </div>
        </div>

        <!-- Status badge -->
        <div class="ps-badge">
          <div class="ps-badge-inner ps-badge-green" id="ps-badge">
            <span class="ps-badge-dot"></span>
            <span id="ps-badge-text">Excellent</span>
          </div>
        </div>

        <!-- Stats rows -->
        <div class="ps-stats">
          <div class="ps-row typed-row"  id="ps-typed-row" title="Click to filter log">
            <span class="ps-row-label">⌨ Typed</span>
            <span>
              <span class="ps-row-val" id="ps-typed">0</span><span class="ps-row-sub">ch</span>
              <span class="ps-row-words" id="ps-typed-words"></span>
            </span>
          </div>
          <div class="ps-row pasted-row" id="ps-pasted-row" title="Click to filter log">
            <span class="ps-row-label">📋 Pasted</span>
            <span>
              <span class="ps-row-val" id="ps-pasted">0</span><span class="ps-row-sub">ch</span>
              <span class="ps-row-words" id="ps-pasted-words"></span>
            </span>
          </div>
        </div>

        <div class="ps-divider"></div>

        <!-- Time Tracker -->
        <div class="ps-time-section">
          <div class="ps-time-title">
            ⏱ Time
            <span class="ps-time-title-state" id="ps-tracking-state">
              <span class="ps-tracking-dot" id="ps-tracking-dot" style="background:#34d399"></span>
              <span id="ps-tracking-label">Waiting…</span>
            </span>
          </div>
          <div class="ps-time-row">
            <span class="ps-time-dot active"></span>
            <span class="ps-time-lbl">Active</span>
            <div class="ps-time-bar-wrap"><div class="ps-time-bar active" id="ps-tbar-active"></div></div>
            <span class="ps-time-val" id="ps-time-active">0s</span>
          </div>
          <div class="ps-time-row">
            <span class="ps-time-dot idle"></span>
            <span class="ps-time-lbl">Idle</span>
            <div class="ps-time-bar-wrap"><div class="ps-time-bar idle" id="ps-tbar-idle"></div></div>
            <span class="ps-time-val" id="ps-time-idle">0s</span>
          </div>
          <div class="ps-time-row">
            <span class="ps-time-dot away"></span>
            <span class="ps-time-lbl">Away</span>
            <div class="ps-time-bar-wrap"><div class="ps-time-bar away" id="ps-tbar-away"></div></div>
            <span class="ps-time-val" id="ps-time-away">0s</span>
          </div>
          <!-- NEW: Pause / Resume button -->
          <button id="ps-pause-btn">⏸ Pause Tracking</button>
        </div>

        <div class="ps-divider"></div>
        <button class="ps-save-btn" id="ps-save-btn">⬇ Save as PDF</button>
        <button class="ps-save-btn" id="ps-sources-btn" style="margin-top:4px;">🔗 Paste Sources (<span id="ps-source-count">0</span>)</button>
        <div class="ps-session-start" id="ps-session-start-chip">Session: —</div>
        <div class="ps-shortcut">drag to move · Alt+Shift+P toggle</div>
      </div>
    </div>

    <!-- ── TOAST ── -->
    <div id="ps-toast">
      <span class="toast-icon">📋</span>
      <span id="ps-toast-msg">Paste detected</span>
    </div>

    <!-- ── LOG PANEL (Tabbed: Full Log + Paste Log) ── -->
    <div id="ps-log" class="hidden">
      <div class="log-header">
        <span class="log-title">📋 Content Log</span>
        <div style="display:flex;align-items:center;gap:6px;">
          <span id="log-paste-count-badge" style="font-size:9px;background:rgba(248,113,113,0.15);color:var(--red);border:1px solid rgba(248,113,113,0.3);padding:2px 8px;border-radius:99px;font-family:'JetBrains Mono',monospace;font-weight:700;">0 pastes</span>
          <button class="ps-icon-btn" id="ps-close-log">✕</button>
        </div>
      </div>
      <!-- Tabs -->
      <div class="log-tabs">
        <button class="log-tab active" id="log-tab-full">⌨ Full Log</button>
        <button class="log-tab" id="log-tab-pastes">📋 Pastes</button>
      </div>
      <!-- Tab: Full color-coded log -->
      <div class="log-tab-panel active" id="log-panel-full">
        <div class="fl-legend">
          <span class="fl-legend-item"><span class="fl-legend-dot" style="background:#34d399;box-shadow:0 0 4px rgba(52,211,153,0.4);"></span>Typed</span>
          <span class="fl-legend-item"><span class="fl-legend-dot" style="background:#f87171;box-shadow:0 0 4px rgba(248,113,113,0.4);"></span>Pasted</span>
          <span class="fl-legend-item"><span class="fl-legend-dot" style="background:#9ca3af;"></span>Existing</span>
        </div>
        <div id="ps-fulllog-content">
          <div class="log-empty"><span class="log-empty-icon">⌨</span>Start typing or pasting<br/>to see content here.</div>
        </div>
      </div>
      <!-- Tab: Paste entries -->
      <div class="log-tab-panel" id="log-panel-pastes">
        <div id="ps-log-content">
          <div class="log-empty">
            <span class="log-empty-icon">📋</span>
            No pasted content yet.<br/>Paste something to see it here.
          </div>
        </div>
      </div>
      <div class="log-stats-footer">
        <span class="log-stat">Pastes: <strong id="log-pasted-ct">0</strong></span>
        <span class="log-stat">Chars: <strong id="log-pasted-chars">0</strong></span>
        <span class="log-stat">Sources: <strong id="log-sources-ct">0</strong></span>
      </div>
    </div>

    <!-- ── SOURCES PANEL ── -->
    <div id="ps-sources-panel" class="hidden">
      <div class="sources-header">
        <span class="sources-title">🔗 Paste Sources</span>
        <button class="ps-icon-btn" id="ps-close-sources">✕</button>
      </div>
      <div class="sources-list" id="ps-sources-list">
        <div class="source-empty">No pastes detected yet</div>
      </div>
    </div>
  `;

  // ── Cache refs ──────────────────────────────────────────────────────────────
  hudEl       = shadow.getElementById("ps-hud");
  hudScore    = shadow.getElementById("ps-score");
  hudTyped    = shadow.getElementById("ps-typed");
  hudPasted   = shadow.getElementById("ps-pasted");
  hudRingFill = shadow.getElementById("ps-ring-fill");
  logPanel    = shadow.getElementById("ps-log");
  logContent  = shadow.getElementById("ps-log-content");

  // ── Tab switching ──────────────────────────────────────────────────────────
  const logTabFull     = shadow.getElementById("log-tab-full");
  const logTabPastes   = shadow.getElementById("log-tab-pastes");
  const logPanelFull   = shadow.getElementById("log-panel-full");
  const logPanelPastes = shadow.getElementById("log-panel-pastes");
  if (logTabFull && logTabPastes) {
    logTabFull.addEventListener("click", () => {
      logTabFull.classList.add("active");   logTabPastes.classList.remove("active");
      logPanelFull.classList.add("active"); logPanelPastes.classList.remove("active");
    });
    logTabPastes.addEventListener("click", () => {
      logTabPastes.classList.add("active"); logTabFull.classList.remove("active");
      logPanelPastes.classList.add("active"); logPanelFull.classList.remove("active");
    });
  }

  hudTimeActive    = shadow.getElementById("ps-time-active");
  hudTimeIdle      = shadow.getElementById("ps-time-idle");
  hudTimeAway      = shadow.getElementById("ps-time-away");
  hudTbarActive    = shadow.getElementById("ps-tbar-active");
  hudTbarIdle      = shadow.getElementById("ps-tbar-idle");
  hudTbarAway      = shadow.getElementById("ps-tbar-away");
  hudTrackingDot   = shadow.getElementById("ps-tracking-dot");
  hudTrackingLabel = shadow.getElementById("ps-tracking-label");
  hudPauseBtn      = shadow.getElementById("ps-pause-btn");

  const header    = shadow.getElementById("ps-header");
  const minBtn    = shadow.getElementById("ps-min-btn");
  const miniPct   = shadow.getElementById("ps-mini-pct");
  const miniFill  = shadow.getElementById("ps-mini-fill");
  const ringGlow  = shadow.getElementById("ps-ring-glow");
  const badge     = shadow.getElementById("ps-badge");
  const badgeText = shadow.getElementById("ps-badge-text");
  const toast     = shadow.getElementById("ps-toast");
  const toastMsg  = shadow.getElementById("ps-toast-msg");

  shadow._mini  = { miniPct, miniFill };
  shadow._badge = { badge, badgeText };
  shadow._ring  = { ringGlow };
  shadow._toast = { toast, toastMsg };

  if (!hudVisible)  hudEl.classList.add("ps-hidden");
  if (isMinimized)  applyMinimized(true, minBtn);

  // ── Minimize ────────────────────────────────────────────────────────────────
  minBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    isMinimized = !isMinimized;
    applyMinimized(isMinimized, minBtn);
    chrome.storage.local.set({ hudMinimized: isMinimized });
    if (isMinimized) logPanel.classList.add("hidden");
  });

  function applyMinimized(state, btn) {
    hudEl.classList.toggle("ps-minimized", state);
    if (btn) { btn.textContent = state ? "+" : "−"; btn.title = state ? "Maximize" : "Minimize"; }
    if (state && hudScore) {
      miniPct.textContent  = hudScore.textContent;
      miniPct.style.color  = hudScore.style.color;
      const pct = parseFloat(hudRingFill?.getAttribute("data-pct") ?? 100);
      miniFill.style.width      = pct + "%";
      miniFill.style.background = hudScore.style.color;
    }
  }

  // ── Sources panel ────────────────────────────────────────────────────────────
  const sourcesPanel     = shadow.getElementById("ps-sources-panel");
  const sourcesBtn       = shadow.getElementById("ps-sources-btn");
  const sourceCount      = shadow.getElementById("ps-source-count");
  const sessionStartChip = shadow.getElementById("ps-session-start-chip");

  shadow.getElementById("ps-close-sources").addEventListener("click", () => {
    sourcesPanel.classList.add("hidden");
  });

  sourcesBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    sourcesPanel.classList.toggle("hidden");
    if (!sourcesPanel.classList.contains("hidden")) renderSourcesPanel();
  });

  // Position sources panel next to HUD (similar to log panel)
  function syncSourcesPosition(hudLeft, hudTop) {
    const gap  = 10;
    const panW = 320;
    let panLeft = hudLeft - panW - gap;
    if (panLeft < 0) panLeft = hudLeft + hudEl.offsetWidth + gap;
    sourcesPanel.style.left  = panLeft + "px";
    sourcesPanel.style.top   = (hudTop + 200) + "px";
    sourcesPanel.style.right = "auto";
  }

  function renderSourcesPanel() {
    const list = shadow.getElementById("ps-sources-list");
    if (!list) return;

    if (pasteEvents.length === 0) {
      list.innerHTML = `<div class="source-empty">No pastes detected yet</div>`;
      return;
    }

    const startStr = sessionStartTime
      ? `Session started: ${new Date(sessionStartTime).toLocaleString()}`
      : "";

    const srcTypeLabels = {
      website: { label: "Website",    cls: "src-type-website", icon: "🌐" },
      gdoc:    { label: "Google Doc", cls: "src-type-gdoc",    icon: "📄" },
      gdrive:  { label: "Drive",      cls: "src-type-gdoc",    icon: "📁" },
      local:   { label: "Local App",  cls: "src-type-local",   icon: "💻" },
      unknown: { label: "Unknown",    cls: "src-type-unknown",  icon: "❓" },
    };

    let html = startStr ? `<div class="source-start-time">${startStr}</div>` : "";

    pasteEvents.forEach((ev, i) => {
      const timeStr   = new Date(ev.timestamp).toLocaleTimeString();
      const preview   = (ev.text || "").replace(/\n/g, " ").slice(0, 80) + (ev.text.length > 80 ? "…" : "");
      const typeInfo  = srcTypeLabels[ev.sourceType || "unknown"] || srcTypeLabels.unknown;
      const typeBadge = `<span class="src-type-badge ${typeInfo.cls}">${typeInfo.icon} ${typeInfo.label}</span>`;

      const urlHtml = ev.sourceUrl
        ? `<div class="source-entry-url" style="display:flex;align-items:center;gap:5px;">${typeBadge}<a href="${ev.sourceUrl}" target="_blank" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;">${ev.sourceUrl}</a></div>`
        : `<div class="source-entry-url" style="display:flex;align-items:center;gap:5px;">${typeBadge}<span style="color:var(--muted2);">No URL detected</span></div>`;

      html += `
        <div class="source-entry">
          <div class="source-entry-meta">
            <span class="source-entry-num">Paste #${i + 1}</span>
            <span class="source-entry-time">${timeStr}</span>
          </div>
          ${urlHtml}
          <div class="source-entry-preview">"${preview}"</div>
        </div>`;
    });

    list.innerHTML = html;
  }

  // ── Pause button ────────────────────────────────────────────────────────────
  hudPauseBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    tmTogglePause();
  });

  // ── Drag ────────────────────────────────────────────────────────────────────
  header.addEventListener("mousedown", (e) => {
    if (e.target.classList.contains("ps-icon-btn")) return;
    isDragging = true;
    const rect = hudEl.getBoundingClientRect();
    dragOffsetX = e.clientX - rect.left;
    dragOffsetY = e.clientY - rect.top;
    hudEl.style.right = "auto";
    hudEl.style.left  = rect.left + "px";
    hudEl.style.top   = rect.top  + "px";
    header.classList.add("dragging");
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!isDragging) return;
    const newLeft = Math.max(0, Math.min(window.innerWidth  - hudEl.offsetWidth,  e.clientX - dragOffsetX));
    const newTop  = Math.max(0, Math.min(window.innerHeight - hudEl.offsetHeight, e.clientY - dragOffsetY));
    hudEl.style.left = newLeft + "px";
    hudEl.style.top  = newTop  + "px";
    syncLogPosition(newLeft, newTop);
  });

  document.addEventListener("mouseup", () => {
    if (!isDragging) return;
    isDragging = false;
    header.classList.remove("dragging");
    const rect = hudEl.getBoundingClientRect();
    chrome.storage.local.set({ hudPos: { top: rect.top, left: rect.left } });
  });

  function syncLogPosition(hudLeft, hudTop) {
    const gap  = 10;
    const logW = 300;
    let logLeft = hudLeft - logW - gap;
    if (logLeft < 0) logLeft = hudLeft + hudEl.offsetWidth + gap;
    logPanel.style.left  = logLeft + "px";
    logPanel.style.top   = hudTop  + "px";
    logPanel.style.right = "auto";
    syncSourcesPosition(hudLeft, hudTop);
  }

  requestAnimationFrame(() => {
    const r = hudEl.getBoundingClientRect();
    syncLogPosition(r.left, r.top);
    positionToast(r);
  });

  function positionToast(hudRect) {
    const t = shadow.getElementById("ps-toast");
    if (!t) return;
    t.style.top   = (hudRect.bottom + 8) + "px";
    t.style.left  = hudRect.left + "px";
    t.style.right = "auto";
    t.style.bottom = "auto";
  }

  // ── Log filter ───────────────────────────────────────────────────────────────
    // (filter system removed -- log is now paste-only)

  // ── Save Session Log ─────────────────────────────────────────────────────────
  shadow.getElementById("ps-save-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    saveSessionLog();
  });

  shadow.getElementById("ps-log-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    logPanel.classList.toggle("hidden");
    // When opening the log, immediately sync the cursor so it jumps to
    // wherever the user's caret is in Google Docs right now.
    if (!logPanel.classList.contains("hidden")) {
      setTimeout(() => _forceSyncMap(), 50);
    }
  });

  shadow.getElementById("ps-close-log").addEventListener("click", () => {
    logPanel.classList.add("hidden");
  });

  // (filter-existing removed)

  shadow.getElementById("ps-typed-row").addEventListener("click", () => {
    logPanel.classList.remove("hidden");
    if (!logPanel.classList.contains("hidden")) setTimeout(() => _forceSyncMap(), 50);
  });

  shadow.getElementById("ps-pasted-row").addEventListener("click", () => {
    logPanel.classList.remove("hidden");
    logContent.scrollTop = logContent.scrollHeight;
  });
}

// ─── TOGGLE HUD ──────────────────────────────────────────────────────────────
function toggleHUD(forceState) {
  if (!hudEl) return;
  hudVisible = forceState !== undefined ? forceState : !hudVisible;
  hudEl.classList.toggle("ps-hidden", !hudVisible);
  if (!hudVisible && logPanel) logPanel.classList.add("hidden");
  chrome.storage.local.set({ hudVisible });
}

// ─── SHOW TOAST ───────────────────────────────────────────────────────────────
function showToast(chars) {
  if (!shadow || !shadow._toast) return;
  const { toast, toastMsg } = shadow._toast;
  if (hudEl) {
    const r = hudEl.getBoundingClientRect();
    toast.style.top    = (r.bottom + 8) + "px";
    toast.style.left   = r.left + "px";
    toast.style.bottom = "auto";
    toast.style.right  = "auto";
  }
  toastMsg.textContent = `+${chars} char${chars !== 1 ? "s" : ""} pasted`;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 2500);
}

// ─── FORMAT MS ────────────────────────────────────────────────────────────────
function fmtMs(ms) {
  const totalS = Math.floor((ms || 0) / 1000);
  const h = Math.floor(totalS / 3600);
  const m = Math.floor((totalS % 3600) / 60);
  const s = totalS % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}

// ─── UPDATE TIME HUD ─────────────────────────────────────────────────────────
function updateHUDTime(ts, state) {
  if (!hudTimeActive || !ts) return;

  const active = ts.activeMs || 0;
  const idle   = ts.idleMs   || 0;
  const away   = ts.awayMs   || 0;
  const total  = active + idle + away || 1;

  hudTimeActive.textContent = fmtMs(active);
  hudTimeIdle.textContent   = fmtMs(idle);
  hudTimeAway.textContent   = fmtMs(away);

  if (hudTbarActive) hudTbarActive.style.width = Math.round((active / total) * 100) + "%";
  if (hudTbarIdle)   hudTbarIdle.style.width   = Math.round((idle   / total) * 100) + "%";
  if (hudTbarAway)   hudTbarAway.style.width   = Math.round((away   / total) * 100) + "%";

  const stateMap = {
    active:  { label: "Active",  color: "#34d399" },
    idle:    { label: "Idle",    color: "#fbbf24" },
    away:    { label: "Away",    color: "#f87171" },
    paused:  { label: "Paused",  color: "#6366f1" },
    waiting: { label: "Waiting…",color: "#4a6080" },
  };
  const info = stateMap[state] || stateMap.waiting;
  if (hudTrackingDot)   hudTrackingDot.style.background = info.color;
  if (hudTrackingLabel) hudTrackingLabel.textContent     = info.label;
}

// ─── SAVE SESSION LOG ─────────────────────────────────────────────────────────
// Downloads a Google Docs-styled HTML document with:
//   • A summary header (originality %, stats, time tracker)
//   • The full document text with green highlights for typed content and
//     red underline highlights for pasted content — matching the log panel.
// The HTML uses Google Docs default typography (Arial, 11pt, A4 page margins)
// so it looks native when opened in a browser or imported into Google Docs.
// Fully private — no server, no network calls.
function saveSessionLog() {
  chrome.storage.local.get(
    ["charMap", "stats", "timeStats", "lastActivityTime", "pasteEvents", "sessionStartTime"],
    (data) => {
      const charMap        = data.charMap        || [];
      const stats          = data.stats          || { typed: 0, pasted: 0, total: 0, originality: 100, pasteCount: 0 };
      const timeStats      = data.timeStats      || { activeMs: 0, idleMs: 0, awayMs: 0 };
      const pasteEvts      = data.pasteEvents    || [];
      const sessionStart   = data.sessionStartTime
        ? new Date(data.sessionStartTime).toLocaleString() : "—";
      const now            = new Date();
      const dateStr        = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const pct            = stats.originality ?? 100;
      const pctColor       = pct >= 75 ? "#1a9e6e" : pct >= 50 ? "#b45309" : "#b91c1c";

      // Build segments
      const segments = [];
      for (const entry of charMap) {
        const last = segments[segments.length - 1];
        if (last && last.type === entry.type) last.text += entry.char;
        else segments.push({ type: entry.type, text: entry.char });
      }

      // ── Helper: escape HTML ─────────────────────────────────────────────────
      function esc(s) {
        return (s || "")
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;");
      }

      // ── Build color-coded document body ─────────────────────────────────────
      let bodyHtml = "";
      for (const seg of segments) {
        const lines = seg.text.split("\n");
        lines.forEach((line, li) => {
          if (li > 0) bodyHtml += "<br/>\n";
          if (!line) return; // blank line → just the <br/>
          const escaped = esc(line);
          if (seg.type === "typed") {
            // Green text with very subtle green background — matches typed segments in the log
            bodyHtml += `<span style="color:#0d6b47;background:rgba(52,211,153,0.10);border-radius:3px;padding:1px 2px;">${escaped}</span>`;
          } else if (seg.type === "pasted") {
            // Red + underline — matches pasted segments in the log
            bodyHtml += `<span style="color:#b91c1c;background:rgba(248,113,113,0.10);border-radius:3px;padding:1px 2px;text-decoration:underline;text-decoration-color:rgba(248,113,113,0.5);">${escaped}</span>`;
          } else {
            // Existing (pre-loaded) — plain black, like normal Google Docs text
            bodyHtml += `<span style="color:#202124;">${escaped}</span>`;
          }
        });
      }

      // ── Paste source list ────────────────────────────────────────────────────
      let sourcesHtml = "";
      if (pasteEvts.length > 0) {
        sourcesHtml = `
          <table style="width:100%;border-collapse:collapse;font-size:10pt;margin-top:4px;">
            <thead>
              <tr style="background:#f1f3f9;">
                <th style="text-align:left;padding:5px 8px;border:1px solid #dadce0;color:#5f6368;font-weight:600;">#</th>
                <th style="text-align:left;padding:5px 8px;border:1px solid #dadce0;color:#5f6368;font-weight:600;">Time</th>
                <th style="text-align:left;padding:5px 8px;border:1px solid #dadce0;color:#5f6368;font-weight:600;">Source URL</th>
                <th style="text-align:left;padding:5px 8px;border:1px solid #dadce0;color:#5f6368;font-weight:600;">Preview</th>
              </tr>
            </thead>
            <tbody>
              ${pasteEvts.map((ev, i) => `
                <tr style="background:${i % 2 === 0 ? "#fff" : "#f8f9ff"};">
                  <td style="padding:5px 8px;border:1px solid #dadce0;color:#202124;">${i + 1}</td>
                  <td style="padding:5px 8px;border:1px solid #dadce0;color:#5f6368;white-space:nowrap;">${new Date(ev.timestamp).toLocaleTimeString()}</td>
                  <td style="padding:5px 8px;border:1px solid #dadce0;color:#1a73e8;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${ev.sourceUrl ? `<a href="${esc(ev.sourceUrl)}" style="color:#1a73e8;">${esc(ev.sourceUrl.slice(0, 60))}${ev.sourceUrl.length > 60 ? "…" : ""}</a>` : '<span style="color:#9aa0a6;">—</span>'}</td>
                  <td style="padding:5px 8px;border:1px solid #dadce0;color:#5f6368;font-size:9pt;">${esc((ev.text || "").replace(/\n/g, " ").slice(0, 80))}${(ev.text || "").length > 80 ? "…" : ""}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>`;
      } else {
        sourcesHtml = `<p style="color:#9aa0a6;font-style:italic;font-size:10pt;margin:4px 0 0 0;">No paste events recorded in this session.</p>`;
      }

      // ── Full HTML document (Google Docs–styled) ──────────────────────────────
      const docTitle = esc(document.title.replace(/ - Google Docs$/, "") || "Untitled Document");
      const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>PasteScope — ${docTitle}</title>
<style>
  /* Google Docs default print styling */
  body {
    margin: 0; padding: 0;
    background: #f0f2f5;
    font-family: Arial, sans-serif;
    font-size: 11pt;
    color: #202124;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .page {
    width: 794px; /* A4 at 96dpi */
    min-height: 1123px;
    margin: 32px auto;
    padding: 72px 90px;
    background: #ffffff;
    box-shadow: 0 1px 3px rgba(0,0,0,0.12), 0 1px 2px rgba(0,0,0,0.08);
    box-sizing: border-box;
  }
  /* ── PasteScope report header ── */
  .ps-report-header {
    background: #ffffff;
    color: #dce9ff;
    border-radius: 10px;
    padding: 18px 22px 16px;
    margin-bottom: 28px;
    font-family: Arial, sans-serif;
    border: 1px solid #dadce0;
  }
  .ps-report-header h1 {
    font-size: 15pt; font-weight: 700; margin: 0 0 4px 0;
    color: #080d1a; letter-spacing: 0.02em;
  }
  .ps-report-header .subtitle {
    font-size: 8.5pt; color: #8899bb; margin: 0 0 14px 0;
  }
  .ps-stats-grid {
    display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 12px;
  }
  .ps-stat-box {
    background: rgba(8,13,26,0.06);
    border: 1px solid rgba(8,13,26,0.12);
    border-radius: 7px;
    padding: 8px 14px;
    min-width: 90px;
  }
  .ps-stat-box .label {
    font-size: 7.5pt; color: #6a80a8; text-transform: uppercase;
    letter-spacing: 0.08em; margin-bottom: 2px;
  }
  .ps-stat-box .value {
    font-size: 14pt; font-weight: 700; font-family: 'Courier New', monospace;
    color: #080d1a;
  }
  .ps-stat-box .value.green  { color: #1a9e6e; }
  .ps-stat-box .value.yellow { color: #b45309; }
  .ps-stat-box .value.red    { color: #b91c1c; }
  .ps-meta {
    font-size: 8pt; color: #6a80a8; border-top: 1px solid rgba(8,13,26,0.1);
    padding-top: 10px; margin-top: 2px;
    display: flex; flex-wrap: wrap; gap: 14px;
  }
  /* ── Legend ── */
  .ps-legend {
    display: flex; gap: 16px; margin-bottom: 16px; padding: 8px 12px;
    background: #f8f9ff; border: 1px solid #e3e6f3; border-radius: 7px;
    font-size: 9pt;
  }
  .legend-item { display: flex; align-items: center; gap: 6px; color: #5f6368; }
  .legend-dot  { width: 8px; height: 8px; border-radius: 50%; }
  /* ── Document content area ── */
  .doc-body {
    font-family: Arial, sans-serif;
    font-size: 11pt; line-height: 1.6;
    color: #202124;
    white-space: pre-wrap;
    word-wrap: break-word;
    margin-top: 6px;
  }
  /* ── Section headings ── */
  .ps-section {
    font-size: 9pt; font-weight: 700; color: #6366f1;
    text-transform: uppercase; letter-spacing: 0.1em;
    border-bottom: 1px solid #e8eaf6; padding-bottom: 4px;
    margin: 24px 0 10px 0;
  }
  @media print {
    body { background: white; }
    .page { box-shadow: none; margin: 0; }
  }
</style>
</head>
<body>
<div class="page">

  <!-- ── Report Header ── -->
  <div class="ps-report-header">
    <h1>PasteScope · Originality Report</h1>
    <p class="subtitle">Real-Time Originality Monitor — Session Export</p>
    <div class="ps-stats-grid">
      <div class="ps-stat-box">
        <div class="label">Originality</div>
        <div class="value ${pct >= 75 ? "green" : pct >= 50 ? "yellow" : "red"}">${pct}%</div>
      </div>
      <div class="ps-stat-box">
        <div class="label">Typed</div>
        <div class="value green">${(stats.typed ?? 0).toLocaleString()}</div>
      </div>
      <div class="ps-stat-box">
        <div class="label">Pasted</div>
        <div class="value red">${(stats.pasted ?? 0).toLocaleString()}</div>
      </div>
      <div class="ps-stat-box">
        <div class="label">Paste Events</div>
        <div class="value">${stats.pasteCount ?? 0}</div>
      </div>
      <div class="ps-stat-box">
        <div class="label">Active</div>
        <div class="value green">${_fmtMsPlain(timeStats.activeMs)}</div>
      </div>
      <div class="ps-stat-box">
        <div class="label">Idle</div>
        <div class="value yellow">${_fmtMsPlain(timeStats.idleMs)}</div>
      </div>
      <div class="ps-stat-box">
        <div class="label">Away</div>
        <div class="value red">${_fmtMsPlain(timeStats.awayMs)}</div>
      </div>
    </div>
    <div class="ps-meta">
      <span>📄 ${docTitle}</span>
      <span>🕐 Session started: ${sessionStart}</span>
      <span>💾 Exported: ${now.toLocaleString()}</span>
      <span>🔗 ${esc(window.location.href.slice(0, 80))}</span>
    </div>
  </div>

  <!-- ── Color legend ── -->
  <div class="ps-legend">
    <span class="legend-item"><span class="legend-dot" style="background:#34d399;"></span>Typed (original)</span>
    <span class="legend-item"><span class="legend-dot" style="background:#f87171;"></span>Pasted (non-original)</span>
    <span class="legend-item"><span class="legend-dot" style="background:#9ca3af;"></span>Pre-existing document text</span>
  </div>

  <!-- ── Full document text ── -->
  <div class="ps-section">Full Document Text</div>
  <div class="doc-body">${bodyHtml || '<span style="color:#9aa0a6;font-style:italic;">No content recorded in this session.</span>'}</div>

  <!-- ── Paste sources ── -->
  <div class="ps-section">Paste Sources (${pasteEvts.length})</div>
  ${sourcesHtml}

</div>
</body>
</html>`;

      _triggerDownload(
        `pastescope-${dateStr}.html`,
        "text/html;charset=utf-8",
        html
      );
    }
  );
}

function _triggerDownload(filename, mime, content) {
  const blob = new Blob([content], { type: mime });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
}

function _fmtMsPlain(ms) {
  const totalS = Math.floor((ms || 0) / 1000);
  const h = Math.floor(totalS / 3600);
  const m = Math.floor((totalS % 3600) / 60);
  const s = totalS % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// ─── STATUS BADGE ─────────────────────────────────────────────────────────────
function getStatusInfo(pct) {
  if (pct >= 90) return { label: "Excellent",  cls: "ps-badge-green"  };
  if (pct >= 75) return { label: "Good",        cls: "ps-badge-green"  };
  if (pct >= 50) return { label: "Moderate",    cls: "ps-badge-yellow" };
  if (pct >= 25) return { label: "Low",         cls: "ps-badge-red"    };
  return              { label: "Critical",    cls: "ps-badge-red"    };
}

// ─── UPDATE HUD ───────────────────────────────────────────────────────────────
function updateHUD(res) {
  if (!hudScore || !res) return;

  const pct   = res.originality;
  const color = pct >= 75 ? "#34d399" : pct >= 50 ? "#fbbf24" : "#f87171";

  hudScore.textContent  = pct + "%";
  hudScore.style.color  = color;
  hudTyped.textContent  = (res.typed ?? 0).toLocaleString();
  hudPasted.textContent = (res.pasted ?? 0).toLocaleString();

  const typedWords  = shadow.getElementById("ps-typed-words");
  const pastedWords = shadow.getElementById("ps-pasted-words");
  if (typedWords  && res._typedWords  !== undefined) typedWords.textContent  = `·${res._typedWords}w`;
  if (pastedWords && res._pastedWords !== undefined) pastedWords.textContent = `·${res._pastedWords}w`;

  if (hudRingFill) {
    const offset = CIRC - (pct / 100) * CIRC;
    hudRingFill.style.strokeDashoffset = offset;
    hudRingFill.style.stroke           = color;
    hudRingFill.setAttribute("data-pct", pct);
    if (shadow._ring) {
      shadow._ring.ringGlow.style.strokeDashoffset = offset;
      shadow._ring.ringGlow.style.stroke           = color;
    }
  }

  if (shadow._badge) {
    const { badge, badgeText } = shadow._badge;
    const { label, cls } = getStatusInfo(pct);
    badge.className       = `ps-badge-inner ${cls}`;
    badgeText.textContent = label;
  }

  if (shadow._mini) {
    shadow._mini.miniPct.textContent  = pct + "%";
    shadow._mini.miniPct.style.color  = color;
    shadow._mini.miniFill.style.width = pct + "%";
    shadow._mini.miniFill.style.background = color;
  }

  if (res.hudVisible !== undefined) toggleHUD(res.hudVisible);
  // Always refresh log if the panel is open
  if (logPanel && !logPanel.classList.contains("hidden")) renderLog(res.segments || [], res.typed, res.pasted, res.cursorIdx);
  if (res.timeStats)                updateHUDTime(res.timeStats, res.trackingState);
}

// ─── RENDER LOG ───────────────────────────────────────────────────────────────
// Tab 1 (Full Log): Color-coded full document — typed=green, pasted=red, existing=plain.
// Tab 2 (Pastes): Each paste event card with source type badge + URL.
function renderLog(_segments, _typed, _pasted, _cursorIdx) {
  if (!shadow) return;

  const badge     = shadow.getElementById("log-paste-count-badge");
  const pastedCt  = shadow.getElementById("log-pasted-ct");
  const pastedCh  = shadow.getElementById("log-pasted-chars");
  const sourcesCt = shadow.getElementById("log-sources-ct");
  const fullLogEl = shadow.getElementById("ps-fulllog-content");

  function esc(s) {
    return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // ── FULL COLOR-CODED LOG (from _segments passed from updateHUD) ────────────
  if (fullLogEl) {
    if (_segments && _segments.length > 0) {
      let fullHtml = "";
      for (const seg of _segments) {
        if (!seg.text) continue;
        // Split on newlines but keep them so pre-wrap renders correctly
        const escaped = esc(seg.text);
        const cls = seg.type === "typed" ? "fl-seg typed"
                  : seg.type === "pasted" ? "fl-seg pasted"
                  : "fl-seg existing";
        fullHtml += `<span class="${cls}">${escaped}</span>`;
      }
      fullLogEl.innerHTML = fullHtml;
    } else {
      fullLogEl.innerHTML = `<div class="log-empty"><span class="log-empty-icon">⌨</span>Start typing or pasting<br/>to see content here.</div>`;
    }
  }

  // ── PASTE ENTRIES LOG ─────────────────────────────────────────────────────
  if (!logContent) return;

  const events = pasteEvents;

  if (!events || events.length === 0) {
    logContent.innerHTML = `<div class="log-empty">
      <span class="log-empty-icon">📋</span>
      No pasted content yet.<br/>Paste something to see it here.
    </div>`;
    if (badge)     badge.textContent     = "0 pastes";
    if (pastedCt)  pastedCt.textContent  = "0";
    if (pastedCh)  pastedCh.textContent  = "0";
    if (sourcesCt) sourcesCt.textContent = "0";
    return;
  }

  const uniqueSources = new Set(events.map(ev => ev.sourceUrl).filter(Boolean));
  const totalPastedChars = events.reduce((a, ev) => a + (ev.text || "").length, 0);

  if (badge)     badge.textContent     = `${events.length} paste${events.length !== 1 ? "s" : ""}`;
  if (pastedCt)  pastedCt.textContent  = events.length;
  if (pastedCh)  pastedCh.textContent  = totalPastedChars.toLocaleString();
  if (sourcesCt) sourcesCt.textContent = uniqueSources.size;

  let html = "";
  events.forEach((ev, i) => {
    const timeStr   = new Date(ev.timestamp).toLocaleTimeString();
    const charCount = (ev.text || "").length;
    const bodyText  = esc(ev.text || "");

    // Build source type badge
    const srcType = ev.sourceType || "unknown";
    const srcTypeLabels = {
      website:  { label: "Website",   cls: "src-type-website", icon: "🌐" },
      gdoc:     { label: "Google Doc", cls: "src-type-gdoc",   icon: "📄" },
      gdrive:   { label: "Drive",      cls: "src-type-gdoc",   icon: "📁" },
      local:    { label: "Local App",  cls: "src-type-local",  icon: "💻" },
      unknown:  { label: "Unknown",    cls: "src-type-unknown", icon: "❓" },
    };
    const typeInfo = srcTypeLabels[srcType] || srcTypeLabels.unknown;
    const typeBadge = `<span class="src-type-badge ${typeInfo.cls}">${typeInfo.icon} ${typeInfo.label}</span>`;

    let sourceHtml;
    if (ev.sourceUrl) {
      const domain = ev.sourceDomain || ev.sourceUrl.replace(/^https?:\/\/(www\.)?/, "").split("/")[0];
      sourceHtml = `
        <div class="paste-entry-source">
          <div class="paste-entry-domain" style="display:flex;align-items:center;gap:5px;">
            ${typeBadge}
            <a href="${esc(ev.sourceUrl)}" target="_blank" title="${esc(ev.sourceUrl)}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:140px;">🔗 ${esc(domain)}</a>
          </div>
          <div class="paste-entry-url-full" title="${esc(ev.sourceUrl)}">${esc(ev.sourceUrl)}</div>
        </div>`;
    } else {
      sourceHtml = `<div class="paste-entry-unknown" style="display:flex;align-items:center;gap:5px;">${typeBadge} <span>No URL detected</span></div>`;
    }

    html += `
      <div class="paste-entry">
        <div class="paste-entry-header">
          <span class="paste-entry-num">#${i + 1}</span>
          ${sourceHtml}
          <div class="paste-entry-meta">
            <span>${charCount}ch</span>
            <span>${timeStr}</span>
          </div>
        </div>
        <div class="paste-entry-body" id="paste-body-${i}">${bodyText}</div>
        <button class="paste-entry-expand" data-idx="${i}">show more ▾</button>
      </div>`;
  });

  logContent.innerHTML = html;

  logContent.querySelectorAll(".paste-entry-expand").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx  = btn.getAttribute("data-idx");
      const body = logContent.querySelector(`#paste-body-${idx}`);
      if (!body) return;
      const isExpanded = body.classList.toggle("expanded");
      btn.textContent = isExpanded ? "show less ▴" : "show more ▾";
    });
  });

  logContent.scrollTop = logContent.scrollHeight;
}

// ─── MESSAGING ────────────────────────────────────────────────────────────────
function sendEvent(msg) {
  chrome.runtime.sendMessage(msg, (res) => {
    if (chrome.runtime.lastError) return;
    if (_skipNextRender) return; // reset in progress — don't re-draw old data
    if (window.top === window.self) updateHUD(res);
  });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "TOGGLE_HUD") {
    chrome.storage.local.get("hudVisible", (d) => {
      toggleHUD(d.hudVisible === undefined ? false : !d.hudVisible);
      chrome.storage.local.set({ hudVisible });
    });
  }
  if (msg.type === "OPEN_LOG") {
    if (hudEl)    hudEl.classList.remove("ps-hidden");
    if (logPanel) {
      logPanel.classList.remove("hidden");
      if (msg.focus && shadow) {
        const fakeClick = shadow.getElementById(`filter-${msg.focus}`);
        if (fakeClick) fakeClick.click();
      }
    }
    hudVisible = true;
  }
});

document.addEventListener("keydown", (e) => {
  if (e.altKey && e.shiftKey && e.key === "P") sendEvent({ type: "TOGGLE_HUD" });
});

// ─── ATTACH TO GOOGLE DOCS ────────────────────────────────────────────────────
function attachListeners() {
  const docsIframe = document.querySelector(".docs-texteventtarget-iframe");
  const target = docsIframe ? docsIframe.contentDocument : document;
  if (!target) { setTimeout(attachListeners, 500); return; }

  // Store the iframe reference for cursor sync
  _docsIframe = docsIframe;

  console.log("[PasteScope v3.3]", docsIframe ? "Attached to Docs iframe" : "Attached to document");

  let charMap   = [];
  let cursorIdx = 0;

  // ── Undo history stack ────────────────────────────────────────────────────
  // Each entry is a snapshot: { charMap: [...], cursorIdx }
  // We push BEFORE every destructive operation so Ctrl+Z can restore it.
  let undoStack = [];
  const MAX_UNDO = 200;

  function pushUndo() {
    undoStack.push({ charMap: charMap.slice(), cursorIdx });
    if (undoStack.length > MAX_UNDO) undoStack.shift();
  }

  // Expose a reset hook for the HUD reset button (which lives outside this closure)
  _resetLocalCharMap = () => {
    // Keep existing-text entries; strip typed/pasted. cursorIdx → end of existing.
    const existingEntries = existingDocText
      ? Array.from(existingDocText).map(char => ({ char, type: "existing" }))
      : [];
    charMap   = existingEntries;
    cursorIdx = existingEntries.length;
    undoStack = [];
  };

  // Expose hook so the top-level loadExistingContent can inject existing chars
  // into this closure's charMap/cursorIdx once the doc text is fetched.
  _applyExistingToCharMap = (text) => {
    const existingEntries = Array.from(text).map(char => ({ char, type: "existing" }));
    if (charMap.length === 0) {
      charMap   = existingEntries;
      cursorIdx = charMap.length; // default: end of existing
    } else {
      // Late load: user already typed — prepend and shift cursorIdx
      charMap   = existingEntries.concat(charMap);
      cursorIdx = Math.min(charMap.length, cursorIdx + existingEntries.length);
    }
    // Immediately sync cursor from the actual Docs caret position
    // so the blinking cursor in the log starts at the right place.
    setTimeout(() => {
      syncCursorOnClick();
      sendEvent({ type: "SYNC_MAP", charMap, cursorIdx });
    }, 150);
  };

  // Expose hook so buildUI's log-open button can trigger a fresh cursor sync
  // without needing access to this closure's charMap/cursorIdx directly.
  _forceSyncMap = () => {
    syncCursorOnClick();
    sendEvent({ type: "SYNC_MAP", charMap, cursorIdx });
  };

  // ── Cursor sync: maps the Docs caret position → charMap index ───────────────
  //
  // STRATEGY (tried in order, first success wins):
  //
  // 1. CHARACTER-COUNT from paragraph renderers — walk every paragraph node in
  //    the Docs canvas; measure each node's top against the caret's top.
  //    Sum chars in all paragraphs above the caret's line, then add the X-based
  //    char offset within the caret's own line.  This matches the actual charMap
  //    far more accurately than a raw scroll ratio.
  //
  // 2. SELECTION-BASED fallback — if the Docs SVG/canvas exposes a document
  //    selection (it sometimes does in pageless mode), use
  //    window.getSelection() from the iframe's contentWindow.
  //
  // 3. LAST RESORT — do nothing (keep cursorIdx where it was from keyboard
  //    tracking, which is accurate).  Never overwrite with a bad heuristic.
  //
  // ═══════════════════════════════════════════════════════════════════════════
  // syncCursorOnClick — DEFINITIVE v3.5
  //
  // ALL previous approaches failed because they tried to read text from the DOM
  // (para.innerText) and match it to the charMap text (from /export?format=txt).
  // These two ALWAYS have different character counts — different newlines,
  // whitespace normalisation, Unicode normalisation, etc.
  //
  // THE REAL FIX: never read DOM text lengths at all.
  //
  // KEY INSIGHT: Both the DOM and the charMap have the same NUMBER of visual
  // lines (one .kix-lineview per logical line in the document). We can map
  // DOM visual-line-number to charMap line-number purely by counting, with zero
  // text comparison. Then within the target line we use the DOM lineview's
  // real text nodes + Range API to get an exact pixel-to-character offset.
  //
  // ALGORITHM:
  //   1. Collect every .kix-lineview in DOM order.
  //   2. Find which lineview the caret is on (by Y coordinate) = lineNum (0-based).
  //   3. Split charMap on \n to get charMap lines.
  //   4. charMapLine = charMapLines[lineNum].
  //   5. Within that charMap line, use the DOM lineview Range API to find
  //      the exact character offset the caret X maps to.
  //   6. cursorIdx = charMap index of charMapLine start + xOffset.
  //
  // No text comparison. No innerText lengths. No export-vs-DOM mismatch.
  // ═══════════════════════════════════════════════════════════════════════════
  function syncCursorOnClick() {
    try {
      if (!charMap.length) return;

      // ── Determine the correct document to query ─────────────────────────────
      // Google Docs renders its editor inside an iframe (.docs-texteventtarget-iframe).
      // Querying `document` (the top-level page) returns nothing because all
      // .kix-cursor-caret and .kix-lineview elements live in the iframe's DOM.
      // We try the iframe's contentDocument first; fall back to document for
      // pageless / frameless layouts.
      const iframeDoc = (_docsIframe && _docsIframe.contentDocument) || null;
      const queryDoc  = (iframeDoc && iframeDoc.querySelector(".kix-cursor-caret"))
                          ? iframeDoc
                          : document;

      // 1. Find the Docs caret
      const caret = queryDoc.querySelector(".kix-cursor-caret");
      if (!caret) return;

      const caretRect = caret.getBoundingClientRect();
      const caretMidY = caretRect.top + caretRect.height / 2;
      const caretX    = caretRect.left;

      // 2. Collect ALL .kix-lineview elements in DOM order.
      // Each .kix-lineview = exactly one visual/logical line in the document.
      // They appear in document order, matching the charMap line order.
      const allLineViews = Array.from(queryDoc.querySelectorAll(".kix-lineview"));
      if (!allLineViews.length) return;

      // 3. Find which lineview the caret is on, count lines above it
      let caretLineNum = -1;
      let caretLV      = null;

      for (let i = 0; i < allLineViews.length; i++) {
        const lv     = allLineViews[i];
        const lvRect = lv.getBoundingClientRect();
        if (lvRect.height === 0) continue; // skip invisible lineviews

        const onThisLine = caretMidY >= lvRect.top - 6 && caretMidY <= lvRect.bottom + 6;
        if (onThisLine) {
          caretLineNum = i;
          caretLV      = lv;
          break;
        }
        if (lvRect.top > caretMidY + 6) {
          // Caret is above this lineview - it was on the previous one
          caretLineNum = Math.max(0, i - 1);
          caretLV      = allLineViews[caretLineNum];
          break;
        }
      }

      // If not found, caret is past all lineviews = last line
      if (caretLineNum === -1) {
        caretLineNum = allLineViews.length - 1;
        caretLV      = allLineViews[caretLineNum];
      }

      // 4. Build charMap line table (split on \n entries)
      // charMapLines[i] = { startIdx, length }
      const charMapLines = [];
      let lineStart = 0;
      for (let i = 0; i <= charMap.length; i++) {
        if (i === charMap.length || charMap[i].char === "\n") {
          charMapLines.push({ startIdx: lineStart, length: i - lineStart });
          lineStart = i + 1;
        }
      }

      // 5. Map DOM line number to charMap line.
      // PROBLEM: exported text often has different line counts than DOM (blank
      // paragraph lines, heading extra-lines, etc.).  So we use the line-count
      // approach only when the counts are close; otherwise fall back to Y-ratio.
      const domLineCount    = allLineViews.filter(lv => lv.getBoundingClientRect().height > 0).length;
      const charMapLineCount = charMapLines.length;
      const lineCountRatio  = Math.min(domLineCount, charMapLineCount) /
                              Math.max(domLineCount, charMapLineCount, 1);

      let targetLine;
      if (lineCountRatio >= 0.75) {
        // Counts are close enough — trust the direct line mapping
        const targetLineNum = Math.min(caretLineNum, charMapLines.length - 1);
        targetLine = charMapLines[targetLineNum];
      } else {
        // Large mismatch (headings, images, etc.) — use Y-ratio across entire document
        const firstLV  = allLineViews.find(lv => lv.getBoundingClientRect().height > 0);
        const lastLV   = [...allLineViews].reverse().find(lv => lv.getBoundingClientRect().height > 0);
        if (!firstLV || !lastLV) {
          // Absolute fallback: stay put
          return;
        }
        const docTop    = firstLV.getBoundingClientRect().top;
        const docBottom = lastLV.getBoundingClientRect().bottom;
        const docHeight = Math.max(docBottom - docTop, 1);
        const yFrac     = Math.max(0, Math.min(1, (caretMidY - docTop) / docHeight));
        const mappedLine = Math.round(yFrac * (charMapLines.length - 1));
        targetLine = charMapLines[Math.min(mappedLine, charMapLines.length - 1)];
      }

      // 6. Find X offset within the lineview using Range API
      let xOffset = targetLine.length; // default: end of line

      if (caretLV) {
        const lineText = (caretLV.innerText || caretLV.textContent || "").replace(/\n$/, "");
        const rangeOff = _charOffsetInLineview(caretLV, lineText, caretX);
        if (rangeOff !== null) {
          xOffset = Math.min(rangeOff, targetLine.length);
        } else {
          // xFrac fallback
          const lvRect  = caretLV.getBoundingClientRect();
          const lvWidth = Math.max(lvRect.width, 1);
          const xFrac   = Math.max(0, Math.min(1, (caretX - lvRect.left) / lvWidth));
          xOffset = Math.round(xFrac * targetLine.length);
        }
      }

      // 7. Set cursorIdx
      cursorIdx = Math.max(0, Math.min(charMap.length, targetLine.startIdx + xOffset));

    } catch (err) {
      console.debug("[PasteScope] Cursor sync error:", err);
    }
  }

  // Range-based per-character X offset within a .kix-lineview
  // Returns 0-based char index where caretX falls, or null if unmeasurable.
  //
  // FIX v3.3: Always use lv.ownerDocument for TreeWalker and Range creation.
  // The .kix-lineview elements live in the Docs iframe's document, NOT the
  // top-level window.document.  Using the wrong document caused Range.setStart()
  // to silently fail (cross-document node), so getBoundingClientRect() returned
  // zeros and _charOffsetInLineview always fell back to the inaccurate xFrac
  // method — causing the log cursor to consistently land in the wrong position.
  function _charOffsetInLineview(lv, lineText, caretX) {
    try {
      // ← KEY FIX: use the element's own document, not the top-level document
      const ownerDoc = lv.ownerDocument || document;

      const textNodes = [];
      const walker = ownerDoc.createTreeWalker(lv, NodeFilter.SHOW_TEXT, null);
      let nd;
      while ((nd = walker.nextNode())) {
        if (nd.nodeValue && nd.nodeValue.length > 0) textNodes.push(nd);
      }
      if (!textNodes.length) return null;

      const segs = [];
      let pos = 0;
      for (const tn of textNodes) {
        segs.push({ node: tn, start: pos });
        pos += tn.nodeValue.length;
      }

      const total = lineText.length;
      if (total === 0) return 0;

      function xAtChar(idx) {
        let seg = null;
        for (const s of segs) {
          if (idx >= s.start && idx <= s.start + s.node.nodeValue.length) { seg = s; break; }
        }
        if (!seg) return null;
        try {
          // ← KEY FIX: create Range from the same document that owns the nodes
          const range = ownerDoc.createRange();
          const off   = Math.min(idx - seg.start, seg.node.nodeValue.length);
          range.setStart(seg.node, off);
          range.setEnd(  seg.node, off);
          const r = range.getBoundingClientRect();
          if (r.width === 0 && r.height === 0 && r.left === 0) return null;
          return r.left;
        } catch (_) { return null; }
      }

      const x0 = xAtChar(0);
      if (x0 === null) return null;
      if (caretX <= x0) return 0;
      const xN = xAtChar(total);
      if (xN !== null && caretX >= xN) return total;

      // Binary search for closest character boundary to caretX
      let lo = 0, hi = total;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const x = xAtChar(mid);
        if (x === null) { hi = mid; continue; }
        if (x < caretX) lo = mid + 1;
        else            hi = mid;
      }
      const xLo   = xAtChar(lo)     ?? caretX;
      const xPrev = xAtChar(lo - 1) ?? caretX;
      return (lo > 0 && caretX - xPrev < xLo - caretX) ? lo - 1 : lo;

    } catch (err) {
      console.debug("[PasteScope] _charOffsetInLineview:", err);
      return null;
    }
  }

  // ── Paste ─────────────────────────────────────────────────────────────────
  target.addEventListener("paste", (e) => {
    const text = (e.clipboardData || window.clipboardData).getData("text") || "";
    if (!text) return;

    // ── Source URL extraction (7-strategy) ───────────────────
    // Chrome embeds the copy-source page URL in several clipboard HTML locations.
    // We try 7 strategies in priority order and URL-validate the winner.
    let sourceUrl = null;
    let sourceDomain = null;
    try {
      const html = (e.clipboardData || window.clipboardData).getData("text/html") || "";
      if (html) {
        // S1: Chrome plain-text header block "Version:0.9\nStartHTML:...\nURL:https://..."
        const s1 = html.match(/(?:^|\n)URL:[ \t]*(https?:\/\/[^\r\n]+)/m);
        // S2: <base href="..."> injected by Chrome from the source page's <base>
        const s2 = html.match(/<base[^>]+href=["']([^"']+)["']/i);
        // S3: <!--Source|PageURL: ...--> comment Chrome sometimes adds
        const s3 = html.match(/<!--\s*(?:Source|Page)?URL:\s*(https?:\/\/[^\s>-]+)/i);
        // S4: SourceURL: annotation (Notion, Confluence, copy managers)
        const s4 = html.match(/SourceURL:\s*(https?:\/\/[^\s\n<]+)/);
        // S5: <link rel="canonical" href="...">
        const s5 = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)
                || html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i);
        // S6: <meta property="og:url" content="...">
        const s6 = html.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i)
                || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:url["']/i);
        // S7: First absolute <a href> in the copied HTML
        const s7 = html.match(/<a[^>]+href=["'](https?:\/\/[^"'>]+)["']/i);

        const candidate = (s1 && s1[1].trim())
                       || (s2 && s2[1].trim())
                       || (s3 && s3[1].trim())
                       || (s4 && s4[1].trim())
                       || (s5 && s5[1].trim())
                       || (s6 && s6[1].trim())
                       || (s7 && s7[1].trim())
                       || null;

        if (candidate) {
          try {
            const parsed = new URL(candidate);
            const isBad  = ["mailto:", "javascript:", "data:"].some(p => candidate.startsWith(p));
            if (!isBad) {
              sourceUrl    = parsed.origin + parsed.pathname + (parsed.search || "");
              sourceDomain = parsed.hostname.replace(/^www\./, "");
            }
          } catch (_) { /* invalid URL — ignore */ }
        }
      }
    } catch (_) {}

    // ── Source type classification ────────────────────────────────────────────
    // Classify the paste source into one of: website | gdoc | gdrive | local | unknown
    let sourceType = "unknown";
    if (sourceUrl) {
      try {
        const ph = new URL(sourceUrl).hostname;
        if (ph.includes("docs.google.com"))   sourceType = "gdoc";
        else if (ph.includes("drive.google.com")) sourceType = "gdrive";
        else                                   sourceType = "website";
      } catch (_) { sourceType = "website"; }
    } else {
      // No URL found in clipboard HTML.
      // Heuristics for local/native app pastes:
      // – If the HTML was non-empty but had no extractable URL → clipboard manager or local app
      // – If text was pasted with no HTML at all → plain text from any source (terminal, notepad, etc.)
      try {
        const rawHtml = (e.clipboardData || window.clipboardData).getData("text/html") || "";
        if (rawHtml.length > 0) {
          sourceType = "local"; // has HTML structure but no parseable URL → likely native app
        } else {
          sourceType = "unknown"; // plain text only — could be anything
        }
      } catch (_) {}
    }

    // Record this paste event
    const pasteEvent = { text, sourceUrl, sourceDomain, sourceType, timestamp: Date.now() };
    pasteEvents.push(pasteEvent);

    // Persist pasteEvents and sessionStartTime to storage
    try {
  chrome.storage.local.get("pasteEvents", (d) => {
    if (chrome.runtime.lastError) return;

    const stored = d.pasteEvents || [];
    stored.push(pasteEvent);
    chrome.storage.local.set({ pasteEvents: stored });
  });
} catch (e) {
  console.warn("Extension context lost:", e);
}

    // Update source count chip + refresh log if open
    if (shadow) {
      const chip = shadow.getElementById("ps-source-count");
      if (chip) chip.textContent = pasteEvents.length;
      // Immediately refresh the paste log (full color log will update via sendEvent response)
      if (logPanel && !logPanel.classList.contains("hidden")) renderLog(null, null, null, null);
    }

    pushUndo(); // snapshot before paste so Ctrl+Z can undo the whole block
    const markers = text.split("").map(char => ({ char, type: "pasted" }));
    charMap.splice(cursorIdx, 0, ...markers);
    cursorIdx += text.length;
    chrome.runtime.sendMessage({ type: "INCREMENT_PASTE" });
    showToast(text.length);
    sendEvent({ type: "SYNC_MAP", charMap, cursorIdx });
    tmOnInput(); // ensure tracker starts on paste too
  }, true);

  // ── Keydown ───────────────────────────────────────────────────────────────
  target.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === "z") {
      // Restore the previous snapshot from the undo stack.
      // Each snapshot was pushed right before the operation that changed charMap,
      // so popping it reverts exactly one logical operation (typed char, paste block,
      // backspace, delete, enter — whatever Google Docs just undid).
      if (undoStack.length > 0) {
        const prev = undoStack.pop();
        charMap   = prev.charMap;
        cursorIdx = prev.cursorIdx;
        sendEvent({ type: "SYNC_MAP", charMap, cursorIdx });
      }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.shiftKey && e.key === "z"))) return;
    if (e.ctrlKey || e.metaKey) return;

    if (e.key === "Backspace") {
      if (cursorIdx > 0) {
        pushUndo();
        charMap.splice(cursorIdx - 1, 1);
        cursorIdx = Math.max(0, cursorIdx - 1);
        sendEvent({ type: "SYNC_MAP", charMap, cursorIdx });
      }
    } else if (e.key === "Delete") {
      if (cursorIdx < charMap.length) {
        pushUndo();
        charMap.splice(cursorIdx, 1);
        sendEvent({ type: "SYNC_MAP", charMap, cursorIdx });
      }
    } else if (e.key === "ArrowLeft") {
      cursorIdx = Math.max(0, cursorIdx - 1);
      sendEvent({ type: "SYNC_MAP", charMap, cursorIdx });
    } else if (e.key === "ArrowRight") {
      cursorIdx = Math.min(charMap.length, cursorIdx + 1);
      sendEvent({ type: "SYNC_MAP", charMap, cursorIdx });
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      setTimeout(() => {
        syncCursorOnClick();
        sendEvent({ type: "SYNC_MAP", charMap, cursorIdx });
      }, 120);
    } else if (e.key === "Home") {
      cursorIdx = 0;
      sendEvent({ type: "SYNC_MAP", charMap, cursorIdx });
    } else if (e.key === "End") {
      cursorIdx = charMap.length;
      sendEvent({ type: "SYNC_MAP", charMap, cursorIdx });
    } else if (e.key === "Enter") {
      pushUndo();
      charMap.splice(cursorIdx, 0, { char: "\n", type: "typed" });
      cursorIdx++;
      sendEvent({ type: "SYNC_MAP", charMap, cursorIdx });
    } else if (e.key.length === 1) {
      pushUndo();
      charMap.splice(cursorIdx, 0, { char: e.key, type: "typed" });
      cursorIdx++;
      sendEvent({ type: "SYNC_MAP", charMap, cursorIdx });
    }
  }, true);

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "RESET_STATS") {
      const existingEntries = existingDocText
        ? Array.from(existingDocText).map(char => ({ char, type: "existing" }))
        : [];
      charMap   = existingEntries;
      cursorIdx = existingEntries.length;
      undoStack = [];
    }
  });

  function syncAndSend() {
    syncCursorOnClick();
    syncHUDToPageSetup();
    sendEvent({ type: "SYNC_MAP", charMap, cursorIdx });
  }

  // Give Google Docs ~120 ms to actually move its .kix-cursor-caret element
  // before we read its position.  30 ms was too short — the caret DOM update
  // lags behind the mouseup event, causing us to read the OLD caret position.
  target.addEventListener("mouseup",  () => { setTimeout(syncAndSend, 120); }, true);
  document.addEventListener("mouseup", () => { setTimeout(syncAndSend, 120); });

  // ── selectionchange: fires on clicks AND keypresses in Google Docs ───────
  // We only want to re-sync on CLICK-based cursor moves.
  // Keyboard handler already tracks cursorIdx character-by-character accurately.
  // Guard: track whether a key is currently held so we can skip selectionchange
  // events that were caused by keypresses rather than mouse clicks.
  let _keyHeld = false;
  document.addEventListener("keydown", () => { _keyHeld = true;  }, { capture: true, passive: true });
  document.addEventListener("keyup",   () => { _keyHeld = false; }, { capture: true, passive: true });
  target.addEventListener("keydown",   () => { _keyHeld = true;  }, { capture: true, passive: true });
  target.addEventListener("keyup",     () => { _keyHeld = false; }, { capture: true, passive: true });

  document.addEventListener("selectionchange", () => {
    if (_keyHeld) return; // keyboard handler already updated cursorIdx accurately
    setTimeout(() => {
      if (_keyHeld) return; // double-check after the delay
      const prevIdx = cursorIdx;
      syncCursorOnClick();
      if (cursorIdx !== prevIdx) {
        sendEvent({ type: "SYNC_MAP", charMap, cursorIdx });
      }
    }, 120);
  });

  // ── MutationObserver: real-time caret tracking ────────────────────────────
  //
  // Google Docs moves .kix-cursor-caret by mutating its style (left, top).
  // Observing these attribute changes gives us a hook for EVERY cursor move —
  // clicks, Home/End, mouse drags — without polling.
  //
  // We guard with _keyHeld so we don't double-fire on keystrokes: the keydown
  // handler already updates cursorIdx character-by-character (more accurately
  // than xFrac), so we only want the observer to fire on click-based moves.
  //
  // Debounced to 80 ms so rapid arrow-key repeats don't flood sendEvent.
  let _caretObsTimer = null;
  function _startCaretObserver() {
    // Must query from the iframe document — .kix-cursor lives there, not in
    // the top-level document.  Fall back to document for pageless layouts.
    const iframeDoc = (_docsIframe && _docsIframe.contentDocument) || null;
    const queryDoc  = iframeDoc || document;
    const cursorContainer = queryDoc.querySelector(".kix-cursor");
    if (!cursorContainer) {
      // Docs hasn't rendered the cursor yet — retry shortly
      setTimeout(_startCaretObserver, 600);
      return;
    }
    const obs = new MutationObserver(() => {
      clearTimeout(_caretObsTimer);
      _caretObsTimer = setTimeout(() => {
        if (_keyHeld) return; // keyboard handler already tracks position accurately
        const prev = cursorIdx;
        syncCursorOnClick();
        // Always send when log is open so the cursor stays in sync even if
        // the index didn't change (ensures a re-render / scroll to cursor).
        if (cursorIdx !== prev || (logPanel && !logPanel.classList.contains("hidden"))) {
          sendEvent({ type: "SYNC_MAP", charMap, cursorIdx });
        }
      }, 80);
    });
    obs.observe(cursorContainer, {
      attributes:      true,
      subtree:         true,
      attributeFilter: ["style"],
    });
  }
  _startCaretObserver();

  // ── Polling cursor sync ───────────────────────────────────────────────────
  // As a safety-net for any click-based cursor moves that the MutationObserver
  // or selectionchange events might miss (e.g., keyboard Home/End, mouse drag),
  // poll every 800 ms while the log panel is visible.
  setInterval(() => {
    if (!logPanel || logPanel.classList.contains("hidden")) return;
    if (_keyHeld) return; // keyboard handler handles this
    const prev = cursorIdx;
    syncCursorOnClick();
    if (cursorIdx !== prev) {
      sendEvent({ type: "SYNC_MAP", charMap, cursorIdx });
    }
  }, 800);

  // Load pre-existing document content on open (with retries while Docs renders)
  loadExistingContent();
}

// ─── LOAD EXISTING GOOGLE DOCS CONTENT ───────────────────────────────────────
// Uses chrome.scripting (MAIN world) injected via the background worker.
// Running fetch() inside the page's own JavaScript context means it uses
// the page's session cookies automatically — no redirects, no OAuth needed.
function loadExistingContent() {
  if (existingDocText) return;

  const docMatch = window.location.href.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (!docMatch) return;
  const docId = docMatch[1];

  // Get the current tab's ID so background.js knows where to inject
  chrome.runtime.sendMessage({ type: "GET_TAB_ID" }, (res) => {
    if (chrome.runtime.lastError || !res || !res.tabId) {
      retryDOM(0);
      return;
    }
    const tabId = res.tabId;

    // Ask background to inject fetch() into the page's MAIN world
    chrome.runtime.sendMessage({ type: "FETCH_DOC_TEXT", docId, tabId }, (res2) => {
      if (chrome.runtime.lastError) { retryDOM(0); return; }
      const t = (res2 && res2.text || "").trim();
      if (t && !t.startsWith("<!") && !t.startsWith("<html") && t.length > 5) {
        applyExisting(t, "MAIN-world fetch");
      } else {
        console.debug("[PasteScope] MAIN fetch failed:", res2?.error);
        retryDOM(0);
      }
    });
  });

  // Fallback: DOM scan for older/pageless docs
  const DOM_DELAYS = [1000, 2000, 3500, 5500, 8000];
  function retryDOM(attempt) {
    if (existingDocText) return;
    const parts = [];
    document.querySelectorAll(
      ".kix-page .kix-paragraphrenderer, " +
      ".kix-page-compact .kix-paragraphrenderer, " +
      ".kix-paginateddocumentplugin .kix-paragraphrenderer"
    ).forEach((p) => {
      const t = p.innerText || p.textContent || "";
      if (t.trim()) parts.push(t);
    });
    const text = parts.join("\n").trim();
    if (text.length > 5) {
      applyExisting(text, `DOM retry #${attempt}`);
    } else if (attempt < DOM_DELAYS.length) {
      setTimeout(() => retryDOM(attempt + 1), DOM_DELAYS[attempt]);
    } else {
      console.log("[PasteScope] Could not read existing content.");
    }
  }

  function applyExisting(text, source) {
    if (existingDocText) return;
    existingDocText = text;

    // Inject existing chars into attachListeners' charMap via the exposed hook.
    // Direct assignment here would silently fail — charMap lives in a different closure.
    _applyExistingToCharMap(text);

    console.log(`[PasteScope] Loaded ${text.length} existing chars via ${source}.`);
  }
}

// ─── FORCE EXISTING TEXT INTO LOG ────────────────────────────────────────────
// No longer used — existing chars are now pre-loaded into charMap as type:"existing"
// so renderLog handles them automatically via the normal segments rendering path.
function forceExistingTextRender() {
  // no-op — kept so call sites in the startup block don't throw
}

// ─── PAGE SETUP SYNC ─────────────────────────────────────────────────────────
function syncHUDToPageSetup() {
  const docsBackground = document.querySelector(".kix-appview-editor");
  const docsPage = document.querySelector(".kix-page-compact, .kix-page, .kix-canvas-tile-content");

  if (docsBackground && shadow) {
    const bgColor = window.getComputedStyle(docsBackground).backgroundColor;
    shadow.host.style.setProperty("--docs-canvas", bgColor);
  }

  if (docsPage && shadow) {
    const pageStyle = window.getComputedStyle(docsPage);
    shadow.host.style.setProperty("--docs-page", pageStyle.backgroundColor);
    shadow.host.style.setProperty("--docs-text", pageStyle.color);

    const isPageless = !document.querySelector(".kix-page-break");
    const lc = shadow.getElementById("ps-log-content");
    if (lc) {
      lc.style.margin       = isPageless ? "0" : "15px 25px";
      lc.style.borderRadius = isPageless ? "0" : "2px";
      lc.style.boxShadow    = isPageless ? "none" : "0 1px 3px rgba(0,0,0,0.2)";
    }
  }

  // Read the actual font Google Docs is using and apply it to the log so the
  // text log visually matches the document.  We try several selectors —
  // whichever succeeds first wins.
  const FONT_SELECTORS = [
    ".kix-wordhtmlgenerator-word-node",       // rendered word spans (most reliable)
    ".kix-lineview-text-block span[style]",   // styled inline spans
    ".kix-lineview-text-block",               // plain lineview block
  ];
  if (shadow) {
    const lc = shadow.getElementById("ps-log-content");
    if (lc) {
      for (const sel of FONT_SELECTORS) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const cs = window.getComputedStyle(el);
        const ff = cs.fontFamily;
        const fs = cs.fontSize;
        // Sanity-check: skip if we got a monospace or empty family
        if (ff && ff.length > 0 && !ff.toLowerCase().includes("mono")) {
          shadow.host.style.setProperty("--docs-font", ff);
          lc.style.fontFamily = ff;
          if (fs && parseFloat(fs) >= 10) lc.style.fontSize = fs;
          break;
        }
      }
    }
  }
}

window.addEventListener("resize", syncHUDToPageSetup);
document.addEventListener("mouseup", () => setTimeout(syncHUDToPageSetup, 100));
setTimeout(syncHUDToPageSetup, 2000);
setTimeout(attachListeners, 2500);

// ─── IFRAME REFERENCE (set by attachListeners) ────────────────────────────────
let _docsIframe = null;

// ═══════════════════════════════════════════════════════════════════════════════
//  TIME TRACKER  — v3.2 FIXED
//
//  BUG FIX: The old code called tmOnHide() on window "blur". But clicking from
//  the HUD into the Google Docs iframe fires window blur (top-level loses focus
//  to the iframe). This made every Docs click register as "Away".
//
//  FIX STRATEGY:
//    1. Remove the raw window "blur" → tmOnHide() binding.
//    2. Use document.visibilitychange as the only reliable away signal — this
//       fires ONLY when the tab is actually hidden (user switches tabs/windows).
//    3. For the iframe focus loss case: debounce blur with 200ms and check
//       document.hasFocus(). If the top document still has focus (the iframe
//       just stole it within the same tab), do NOT go away.
//    4. Time tracker auto-starts on mousedown inside the Docs editor area too,
//       so opening a file and clicking immediately marks Active.
// ═══════════════════════════════════════════════════════════════════════════════
if (window.top === window.self) {

  const IDLE_TIMEOUT  = 120_000; // 2 min
  const PERSIST_EVERY = 15_000;  // write storage every 15 s

  const TM = {
    activeMs:     0,
    idleMs:       0,
    awayMs:       0,
    currentState: null,   // null | "active" | "idle" | "away" | "paused"
    stateStart:   0,
    lastInput:    0,
    tickId:       null,
    saveId:       null,
    started:      false,
    paused:       false,
    pausedState:  null,   // state we were in before pausing
  };

  function tmSetState(newState) {
    if (TM.paused && newState !== "paused") return; // don't change state while paused
    const now = Date.now();
    if (TM.currentState && TM.currentState !== "paused") {
      const elapsed = now - TM.stateStart;
      TM[TM.currentState + "Ms"] = (TM[TM.currentState + "Ms"] || 0) + elapsed;
    }
    TM.currentState = newState;
    TM.stateStart   = now;
    tmPushHUD();
  }

  function tmPushHUD() {
    if (!TM.currentState) return;
    // Always compute real elapsed — idle ticks up while manually paused
    const elapsed      = Date.now() - TM.stateStart;
    const displayState = TM.paused ? "paused" : TM.currentState;
    updateHUDTime({
      activeMs: TM.activeMs + (TM.currentState === "active" ? elapsed : 0),
      idleMs:   TM.idleMs   + (TM.currentState === "idle"   ? elapsed : 0),
      awayMs:   TM.awayMs   + (TM.currentState === "away"   ? elapsed : 0),
    }, displayState);
  }

  function tmSave() {
    if (!TM.currentState) return;
    // Save even while paused — idle time is still accumulating
    const elapsed = Date.now() - TM.stateStart;
    const snapshot = {
      activeMs: TM.activeMs + (TM.currentState === "active" ? elapsed : 0),
      idleMs:   TM.idleMs   + (TM.currentState === "idle"   ? elapsed : 0),
      awayMs:   TM.awayMs   + (TM.currentState === "away"   ? elapsed : 0),
    };
    chrome.storage.local.set({
      timeStats:        snapshot,
      lastActivityTime: TM.lastInput,
      isTabVisible:     TM.currentState !== "away",
    });
    // Rolling session history (up to 20 entries) — powers the save log export
    chrome.storage.local.get(["stats", "sessionHistory"], (data) => {
      const history = data.sessionHistory || [];
      const entry = {
        savedAt:   new Date().toISOString(),
        pageTitle: document.title,
        pageUrl:   window.location.href,
        stats:     data.stats || {},
        timeStats: snapshot,
      };
      const last = history[history.length - 1];
      const sameMinute = last &&
        Math.abs(new Date(last.savedAt) - new Date(entry.savedAt)) < 60_000;
      if (sameMinute) history[history.length - 1] = entry;
      else history.push(entry);
      if (history.length > 20) history.shift();
      chrome.storage.local.set({ sessionHistory: history });
    });
  }

  function tmLoad() {
    chrome.storage.local.get(["timeStats", "charMap", "cursorIdx", "stats", "pasteEvents", "sessionStartTime"], (data) => {
      // Restore time buckets
      if (data.timeStats) {
        TM.activeMs = data.timeStats.activeMs || 0;
        TM.idleMs   = data.timeStats.idleMs   || 0;
        TM.awayMs   = data.timeStats.awayMs   || 0;
        updateHUDTime(data.timeStats, "waiting");
      }

      // Restore paste events
      if (data.pasteEvents && data.pasteEvents.length > 0) {
        pasteEvents = data.pasteEvents;
        if (shadow) {
          const count = shadow.getElementById("ps-source-count");
          if (count) count.textContent = pasteEvents.length;
        }
      }

      // Restore session start time
      if (data.sessionStartTime) {
        sessionStartTime = data.sessionStartTime;
        if (shadow) {
          const chip = shadow.getElementById("ps-session-start-chip");
          if (chip) chip.textContent = `Started: ${new Date(sessionStartTime).toLocaleTimeString()}`;
        }
      }
      // Restore charMap into the local closure via the exposed reset hook trick:
      // We fire a synthetic SYNC_MAP response so updateHUD re-draws the log.
      if (data.charMap && data.charMap.length > 0) {
        // Rebuild segments and push to HUD without touching background storage
        const charMap  = data.charMap;
        const stats    = data.stats || {};
        const segments = [];
        for (const entry of charMap) {
          const last = segments[segments.length - 1];
          if (last && last.type === entry.type) last.text += entry.char;
          else segments.push({ type: entry.type, text: entry.char });
        }
        updateHUD({
          typed:       stats.typed       || 0,
          pasted:      stats.pasted      || 0,
          total:       stats.total       || 0,
          originality: stats.originality || 100,
          pasteCount:  stats.pasteCount  || 0,
          segments,
          cursorIdx:   data.cursorIdx    || charMap.length,
          hudVisible:  true,
          timeStats:   data.timeStats    || { activeMs: 0, idleMs: 0, awayMs: 0 },
          trackingState: "waiting",
        });
      }
    });
  }

  function tmStart() {
    if (TM.started) return;
    TM.started      = true;
    TM.stateStart   = Date.now();
    TM.lastInput    = Date.now();
    TM.currentState = "active";

    // Record session start time (only on the very first start)
    if (!sessionStartTime) {
      sessionStartTime = Date.now();
      chrome.storage.local.set({ sessionStartTime });
      // Update HUD chip
      if (shadow) {
        const chip = shadow.getElementById("ps-session-start-chip");
        if (chip) chip.textContent = `Started: ${new Date(sessionStartTime).toLocaleTimeString()}`;
      }
    }

    TM.tickId = setInterval(() => {
      if (!TM.currentState) return;
      // While manually paused, only idle time runs — skip the idle-timeout check
      // so the user's pause doesn't get auto-upgraded back to active.
      if (!TM.paused) {
        if (TM.currentState === "active" && Date.now() - TM.lastInput > IDLE_TIMEOUT) {
          tmSetState("idle");
        }
      }
      tmPushHUD();
    }, 1000);

    TM.saveId = setInterval(tmSave, PERSIST_EVERY);
    window.addEventListener("beforeunload", tmSave);
    tmPushHUD();
  }

  // ── Pause / Resume ───────────────────────────────────────────────────────
  function tmTogglePause() {
    if (!hudPauseBtn) return;
    const now = Date.now();

    if (!TM.paused) {
      // ── PAUSE ──────────────────────────────────────────────────────────────
      // 1. Commit whatever time was accrued in the current state (active/idle/away).
      if (TM.currentState) {
        const elapsed = now - TM.stateStart;
        TM[TM.currentState + "Ms"] = (TM[TM.currentState + "Ms"] || 0) + elapsed;
      }
      // 2. Switch tracking state to "idle" so idle time accumulates while paused.
      //    The user is not actively writing, so idle is the correct bucket.
      TM.currentState = "idle";
      TM.stateStart   = now;
      TM.paused       = true;
      TM.pausedState  = "active"; // resume will return to active

      // 3. Write isPaused to storage so background.js returns trackingState:"paused"
      //    on any subsequent message — this keeps the HUD label correct.
      chrome.storage.local.set({ isPaused: true });

      hudPauseBtn.textContent = "▶ Resume Tracking";
      hudPauseBtn.classList.add("paused");
      tmPushHUD(); // immediately refresh HUD with "paused" label + idle ticking

    } else {
      // ── RESUME ─────────────────────────────────────────────────────────────
      // 1. Commit idle time accumulated during the pause period.
      const idleElapsed = now - TM.stateStart;
      TM.idleMs = (TM.idleMs || 0) + idleElapsed;

      // 2. Switch back to active.
      TM.paused       = false;
      TM.currentState = "active";
      TM.stateStart   = now;
      TM.lastInput    = now;

      // 3. Clear isPaused in storage.
      chrome.storage.local.set({ isPaused: false, lastActivityTime: now });

      hudPauseBtn.textContent = "⏸ Pause Tracking";
      hudPauseBtn.classList.remove("paused");
      tmPushHUD();
    }
  }

  // ── Reset time + all storage ─────────────────────────────────────────────
  function tmReset() {
    TM.activeMs     = 0;
    TM.idleMs       = 0;
    TM.awayMs       = 0;
    TM.currentState = null;
    TM.started      = false;
    TM.paused       = false;
    TM.lastInput    = 0;
    TM.stateStart   = 0;
    if (TM.tickId) { clearInterval(TM.tickId); TM.tickId = null; }
    if (TM.saveId) { clearInterval(TM.saveId); TM.saveId = null; }
    if (hudPauseBtn) {
      hudPauseBtn.textContent = "⏸ Pause Tracking";
      hudPauseBtn.classList.remove("paused");
    }

    // Reset paste sources
    pasteEvents = [];
    sessionStartTime = null;
    if (shadow) {
      const chip = shadow.getElementById("ps-session-start-chip");
      if (chip) chip.textContent = "Session: —";
      const count = shadow.getElementById("ps-source-count");
      if (count) count.textContent = "0";
    }

    updateHUDTime({ activeMs: 0, idleMs: 0, awayMs: 0 }, "waiting");
    // Wipe all session data from storage — charMap cleared separately by reset btn
    chrome.storage.local.set({
      timeStats:        { activeMs: 0, idleMs: 0, awayMs: 0 },
      lastActivityTime: Date.now(),
      isTabVisible:     true,
      isPaused:         false,
      charMap:          [],
      cursorIdx:        0,
      pasteEvents:      [],
      sessionStartTime: null,
      stats:            { typed: 0, pasted: 0, total: 0, originality: 100, pasteCount: 0 },
    });
  }

  function tmOnInput() {
    if (TM.paused) return; // ignore input while paused
    TM.lastInput = Date.now();
    if (!TM.started) {
      tmLoad();
      setTimeout(tmStart, 0);
      return;
    }
    if (TM.currentState === "idle") tmSetState("active");
  }

  // ── FIXED: Away detection — visibilitychange ONLY ─────────────────────────
  // window "blur" is NOT used as an away trigger because clicking from the HUD
  // widget into the Docs iframe causes window blur without the user leaving.
  function tmOnHide() {
    if (!TM.started || TM.currentState === "away" || TM.paused) return;
    tmSetState("away");
    tmSave();
    chrome.runtime.sendMessage({ type: "TAB_HIDDEN" }, () => { if (chrome.runtime.lastError) return; });
  }

  function tmOnShow() {
    TM.lastInput = Date.now();
    if (!TM.started) return;
    if (TM.currentState === "away") {
      tmSetState("active");
      tmSave();
    }
    chrome.runtime.sendMessage({ type: "TAB_VISIBLE" }, () => { if (chrome.runtime.lastError) return; });
  }

  // ── Wire up events ────────────────────────────────────────────────────────
  // Keyboard and typing
  ["keydown", "keypress"].forEach((e) =>
    document.addEventListener(e, tmOnInput, { passive: true, capture: true })
  );

  // Mouse/touch — including clicks in the Docs editor area
  // This is critical: without this, opening a blank doc and clicking does
  // not start the timer until the user types.
  ["mousedown", "mousemove", "wheel", "scroll", "touchstart"].forEach((e) =>
    document.addEventListener(e, tmOnInput, { passive: true })
  );

  // AWAY: only on true tab visibility change, NOT window blur
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) tmOnHide(); else tmOnShow();
  });

  // Window focus: when user alt-tabs back
  window.addEventListener("focus", tmOnShow);

  // Window blur with hasFocus() guard:
  // If document.hasFocus() is still true after a short delay, the focus
  // moved to an iframe inside our own tab (like the Docs editor) — NOT away.
  window.addEventListener("blur", () => {
    setTimeout(() => {
      if (!document.hasFocus() && !document.hidden) {
        // Focus truly left the page — mark away
        tmOnHide();
      }
      // If document.hasFocus() is true, focus is inside the page (Docs iframe)
      // Do nothing — user is still actively working.
    }, 200);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.timeStats && !TM.started) {
      updateHUDTime(changes.timeStats.newValue, "waiting");
    }
  });

  tmLoad();
  chrome.runtime.sendMessage({ type: "TAB_VISIBLE" }, () => { if (chrome.runtime.lastError) return; });
}
// popup.js — PasteScope v3.3
// New: Save button downloads PDF report. Session history accordion.

const scoreEl    = document.getElementById("score-value");
const ringFill   = document.getElementById("ring-fill");
const typedEl    = document.getElementById("typed-val");
const pastedEl   = document.getElementById("pasted-val");
const totalEl    = document.getElementById("total-val");
const pasteCtEl  = document.getElementById("paste-count");
const sessionEl  = document.getElementById("session-time");
const statusBadge = document.getElementById("status-badge");
const statusText  = document.getElementById("status-text");
const hudToggle   = document.getElementById("hud-toggle");
const btnLog      = document.getElementById("btn-log");
const btnSave     = document.getElementById("btn-save");

// Time tracker DOM refs
const timeNowBadge = document.getElementById("time-now-badge");
const timeNowText  = document.getElementById("time-now-text");
const tbActive = document.getElementById("tb-active");
const tbIdle   = document.getElementById("tb-idle");
const tbAway   = document.getElementById("tb-away");
const tvActive = document.getElementById("tv-active");
const tvIdle   = document.getElementById("tv-idle");
const tvAway   = document.getElementById("tv-away");

// History DOM refs
const historyToggle  = document.getElementById("history-toggle");
const historyChevron = document.getElementById("history-chevron");
const historyList    = document.getElementById("history-list");
const historyEmpty   = document.getElementById("history-empty");

// ─── Helpers ─────────────────────────────────────────────────────────────────
function fmtMs(ms) {
  const totalS = Math.floor((ms || 0) / 1000);
  const h = Math.floor(totalS / 3600);
  const m = Math.floor((totalS % 3600) / 60);
  const s = totalS % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}

function fmtMsLong(ms) {
  const totalS = Math.floor((ms || 0) / 1000);
  const h = Math.floor(totalS / 3600);
  const m = Math.floor((totalS % 3600) / 60);
  const s = totalS % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function fmtRelTime(isoStr) {
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1)  return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// SVG ring circumference (r=36)
const CIRC = 2 * Math.PI * 36; // ≈ 226.2

// ─── Session timer ─────────────────────────────────────────────────────────────
let sessionStart = Date.now();
chrome.storage.local.get("sessionStart", (d) => {
  if (d.sessionStart) sessionStart = d.sessionStart;
  else chrome.storage.local.set({ sessionStart: Date.now() });
  updateSessionTimer();
});

function updateSessionTimer() {
  const mins = Math.floor((Date.now() - sessionStart) / 60000);
  sessionEl.textContent = mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
  setTimeout(updateSessionTimer, 30000);
}

// ─── Time tracker render ─────────────────────────────────────────────────────
function renderTime(ts, lastActivityTime, isTabVisible) {
  if (!ts) ts = { activeMs: 0, idleMs: 0, awayMs: 0 };
  const active = ts.activeMs || 0;
  const idle   = ts.idleMs   || 0;
  const away   = ts.awayMs   || 0;
  const total  = active + idle + away || 1;

  tvActive.textContent = fmtMs(active);
  tvIdle.textContent   = fmtMs(idle);
  tvAway.textContent   = fmtMs(away);

  tbActive.style.width = Math.round((active / total) * 100) + "%";
  tbIdle.style.width   = Math.round((idle   / total) * 100) + "%";
  tbAway.style.width   = Math.round((away   / total) * 100) + "%";

  const IDLE_THRESHOLD = 120_000;
  const now = Date.now();
  let label, badgeCls;

  if (isTabVisible === false) {
    label    = "Away";
    badgeCls = "tnb-red";
  } else if (!lastActivityTime || now - lastActivityTime > IDLE_THRESHOLD) {
    label    = "Idle";
    badgeCls = "tnb-yellow";
  } else {
    label    = "Active";
    badgeCls = "tnb-green";
  }

  timeNowBadge.className = `time-now-badge ${badgeCls}`;
  timeNowText.textContent = label;
}

// ─── Live tick (every second, reads from snapshot) ───────────────────────────
let _lastTimeSnapshot = null;
let _snapshotAt       = 0;

function refreshTimeDisplay() {
  chrome.storage.local.get(["timeStats", "lastActivityTime", "isTabVisible"], (data) => {
    _lastTimeSnapshot = data.timeStats || { activeMs: 0, idleMs: 0, awayMs: 0 };
    _snapshotAt       = Date.now();
    renderTime(_lastTimeSnapshot, data.lastActivityTime, data.isTabVisible);
  });
}

function tickTimeDisplay() {
  if (!_lastTimeSnapshot || !_snapshotAt) return;
  const elapsed = Date.now() - _snapshotAt;
  const IDLE_T  = 120_000;
  chrome.storage.local.get(["lastActivityTime", "isTabVisible"], (data) => {
    const visible   = data.isTabVisible !== false;
    const lastInput = data.lastActivityTime || 0;
    const isIdle    = visible && (Date.now() - lastInput > IDLE_T);
    const isAway    = !visible;
    const live = {
      activeMs: _lastTimeSnapshot.activeMs + (!isAway && !isIdle ? elapsed : 0),
      idleMs:   _lastTimeSnapshot.idleMs   + (!isAway &&  isIdle ? elapsed : 0),
      awayMs:   _lastTimeSnapshot.awayMs   + ( isAway             ? elapsed : 0),
    };
    renderTime(live, data.lastActivityTime, data.isTabVisible);
  });
}

refreshTimeDisplay();
setInterval(tickTimeDisplay, 1000);
setInterval(refreshTimeDisplay, 5000);

// ─── Status helpers ───────────────────────────────────────────────────────────
function getStatus(pct) {
  if (pct >= 90) return { label: "Excellent", cls: "badge-green"  };
  if (pct >= 75) return { label: "Good",       cls: "badge-green"  };
  if (pct >= 50) return { label: "Moderate",   cls: "badge-yellow" };
  if (pct >= 25) return { label: "Low",         cls: "badge-red"    };
  return              { label: "Critical",    cls: "badge-red"    };
}

// ─── Render stats ─────────────────────────────────────────────────────────────
function renderStats(stats) {
  const typed  = stats?.typed      ?? 0;
  const pasted = stats?.pasted     ?? 0;
  const total  = typed + pasted;
  const pct    = total === 0 ? 100 : Math.round((typed / total) * 100);

  scoreEl.textContent   = pct + "%";
  typedEl.textContent   = typed.toLocaleString();
  pastedEl.textContent  = pasted.toLocaleString();
  totalEl.textContent   = total.toLocaleString();
  pasteCtEl.textContent = stats?.pasteCount ?? 0;

  const offset = CIRC - (pct / 100) * CIRC;
  ringFill.style.strokeDashoffset = offset;

  const color = pct >= 75 ? "#34d399" : pct >= 50 ? "#fbbf24" : "#f87171";
  scoreEl.style.color   = color;
  ringFill.style.stroke = color;

  const { label, cls } = getStatus(pct);
  statusBadge.className  = `status-badge ${cls}`;
  statusText.textContent = label;
}

// ─── Load on open ─────────────────────────────────────────────────────────────
chrome.storage.local.get(
  ["stats", "hudVisible", "timeStats", "lastActivityTime", "isTabVisible"],
  (data) => {
    renderStats(data.stats);
    hudToggle.checked = data.hudVisible !== false;
    renderTime(data.timeStats, data.lastActivityTime, data.isTabVisible);
  }
);

// ─── HUD toggle ───────────────────────────────────────────────────────────────
hudToggle.addEventListener("change", () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    chrome.tabs.sendMessage(tabs[0].id, { type: "TOGGLE_HUD" });
  });
  chrome.runtime.sendMessage({ type: "TOGGLE_HUD" });
});

// ─── SAVE AS PDF ─────────────────────────────────────────────────────────────
btnSave.addEventListener("click", () => {
  chrome.storage.local.get(
    ["charMap", "stats", "timeStats", "sessionStartTime", "pasteEvents"],
    (data) => {
      const charMap        = data.charMap        || [];
      const stats          = data.stats          || { typed: 0, pasted: 0, total: 0, originality: 100, pasteCount: 0 };
      const timeStats      = data.timeStats      || { activeMs: 0, idleMs: 0, awayMs: 0 };
      const pasteEvts      = data.pasteEvents    || [];
      const sessionStart   = data.sessionStartTime
        ? new Date(data.sessionStartTime).toLocaleString() : "N/A";
      const now            = new Date();
      const exportedAt     = now.toLocaleString();
      const dateStr        = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);

      // Build segments for the full text log section
      const segments = [];
      for (const entry of charMap) {
        const last = segments[segments.length - 1];
        if (last && last.type === entry.type) last.text += entry.char;
        else segments.push({ type: entry.type, text: entry.char });
      }

      // ── jsPDF setup ─────────────────────────────────────────────────────────
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ unit: "mm", format: "a4" });
      const pageW  = doc.internal.pageSize.getWidth();
      const pageH  = doc.internal.pageSize.getHeight();
      const margin = 14;
      const maxW   = pageW - margin * 2;
      let y = 20;

      // Color helpers (r,g,b arrays) — Google Docs inspired
      const C = {
        accent:  [26,  115, 232],  // Google Blue
        green:   [24,  128, 56],   // Google Green
        red:     [217, 48,  37],   // Google Red
        blue:    [26,  115, 232],  // Google Blue
        dark:    [32,  33,  36],   // #202124
        mid:     [95,  99,  104],  // #5f6368
        muted:   [154, 160, 166],  // #9aa0a6
        white:   [255, 255, 255],
        bg:      [26,  115, 232],  // Google Blue for header bar
        pageBg:  [240, 242, 245],  // light grey page bg
      };

      function setColor(c) { doc.setTextColor(c[0], c[1], c[2]); }
      function setFill(c)  { doc.setFillColor(c[0], c[1], c[2]); }

      function ensurePage(needed = 8) {
        if (y + needed > pageH - 14) { doc.addPage(); y = 20; }
      }

      function addText(text, size, color, opts = {}) {
        ensurePage(size * 0.6);
        doc.setFontSize(size);
        setColor(color);
        const x = opts.center ? pageW / 2 : (opts.x || margin);
        const align = opts.center ? "center" : "left";
        doc.text(text, x, y, { align });
        y += size * 0.45 + (opts.gap ?? 2);
      }

      function addWrappedText(text, size, color, indent = 0) {
        doc.setFontSize(size);
        setColor(color);
        const lines = doc.splitTextToSize(text, maxW - indent);
        for (const line of lines) {
          ensurePage(size * 0.6);
          doc.text(line, margin + indent, y);
          y += size * 0.42 + 1.5;
        }
      }

      function addRule(color = [220, 225, 235]) {
        doc.setDrawColor(color[0], color[1], color[2]);
        doc.setLineWidth(0.3);
        doc.line(margin, y, pageW - margin, y);
        y += 4;
      }

      function addSectionHeader(title) {
        ensurePage(14);
        y += 3;
        setFill([232, 240, 254]);
        doc.roundedRect(margin, y - 5, maxW, 10, 2, 2, "F");
        doc.setFontSize(11);
        doc.setFont(undefined, "bold");
        setColor(C.accent);
        doc.text(title, margin + 3, y + 1);
        doc.setFont(undefined, "normal");
        y += 9;
      }

      // ── PAGE 1: Header ───────────────────────────────────────────────────────
      // Google blue banner
      setFill(C.bg);
      doc.rect(0, 0, pageW, 40, "F");

      doc.setFontSize(20);
      doc.setFont(undefined, "bold");
      setColor(C.white);
      doc.text("PasteScope", margin, 18);

      doc.setFontSize(9);
      doc.setFont(undefined, "normal");
      setColor([200, 220, 255]);
      doc.text("Real-Time Originality Monitor — Session Report", margin, 25);

      // Originality pill
      const pct   = stats.originality ?? 100;
      const pColor = pct >= 75 ? C.green : pct >= 50 ? [251, 191, 36] : C.red;
      setFill(pColor);
      doc.roundedRect(pageW - margin - 28, 10, 28, 14, 4, 4, "F");
      doc.setFontSize(13);
      doc.setFont(undefined, "bold");
      setColor(C.white);
      doc.text(`${pct}%`, pageW - margin - 14, 19, { align: "center" });
      doc.setFontSize(7);
      setColor(C.white);
      doc.text("ORIGINAL", pageW - margin - 14, 23, { align: "center" });
      doc.setFont(undefined, "normal");

      y = 48;

      // Meta row
      addText(`Exported: ${exportedAt}`, 9, C.muted, { gap: 1 });
      addText(`Session started: ${sessionStart}`, 9, C.muted, { gap: 1 });
      addText(`Document: ${document?.title || "Google Docs"}`, 9, C.muted, { gap: 4 });

      addRule();

      // ── ORIGINALITY SUMMARY ──────────────────────────────────────────────────
      addSectionHeader("📊  Originality Summary");

      // Stat boxes (3 across)
      const boxW = (maxW - 8) / 3;
      const boxes = [
        { label: "TYPED",     val: (stats.typed  ?? 0).toLocaleString(), sub: "characters", color: C.green },
        { label: "PASTED",    val: (stats.pasted ?? 0).toLocaleString(), sub: "characters", color: C.red   },
        { label: "PASTE EVENTS", val: stats.pasteCount ?? 0, sub: "total pastes", color: C.accent },
      ];
      const boxY = y;
      boxes.forEach((b, i) => {
        const bx = margin + i * (boxW + 4);
        setFill([232, 240, 254]);
        doc.roundedRect(bx, boxY, boxW, 22, 2, 2, "F");
        doc.setFontSize(7); doc.setFont(undefined, "bold"); setColor(b.color);
        doc.text(b.label, bx + boxW / 2, boxY + 5.5, { align: "center" });
        doc.setFontSize(14); setColor(C.dark);
        doc.text(String(b.val), bx + boxW / 2, boxY + 13, { align: "center" });
        doc.setFontSize(7); doc.setFont(undefined, "normal"); setColor(C.muted);
        doc.text(b.sub, bx + boxW / 2, boxY + 18, { align: "center" });
      });
      y = boxY + 26;

      // Originality progress bar
      const barH  = 5;
      const barW  = maxW;
      setFill([218, 220, 224]);
      doc.roundedRect(margin, y, barW, barH, 2, 2, "F");
      setFill(pColor);
      doc.roundedRect(margin, y, barW * (pct / 100), barH, 2, 2, "F");
      doc.setFontSize(8); setColor(C.mid);
      doc.text(`${pct}% original content`, margin, y + barH + 5);
      y += barH + 10;

      // ── TIME TRACKER ────────────────────────────────────────────────────────
      addSectionHeader("⏱  Time Tracker");

      const totalMs  = (timeStats.activeMs || 0) + (timeStats.idleMs || 0) + (timeStats.awayMs || 0) || 1;
      const timeBars = [
        { label: "Active", ms: timeStats.activeMs || 0, color: C.green   },
        { label: "Idle",   ms: timeStats.idleMs   || 0, color: [251,191,36] },
        { label: "Away",   ms: timeStats.awayMs   || 0, color: C.red     },
      ];

      for (const tb of timeBars) {
        ensurePage(10);
        const pctW = tb.ms / totalMs;
        // Label + time
        doc.setFontSize(9); setColor(C.dark);
        doc.text(tb.label, margin, y + 3.5);
        doc.setFontSize(9); setColor(C.mid);
        doc.text(fmtMs(tb.ms), margin + 22, y + 3.5);
        // Bar
        setFill([218, 220, 224]);
        doc.roundedRect(margin + 46, y, maxW - 46, 5, 1.5, 1.5, "F");
        setFill(tb.color);
        if (pctW > 0) doc.roundedRect(margin + 46, y, (maxW - 46) * pctW, 5, 1.5, 1.5, "F");
        y += 9;
      }
      y += 2;

      // ── PASTE SOURCES ────────────────────────────────────────────────────────
      addSectionHeader("🔗  Paste Sources");

      if (pasteEvts.length === 0) {
        addText("No paste events recorded in this session.", 9, C.muted, { gap: 4 });
      } else {
        for (let i = 0; i < pasteEvts.length; i++) {
          const ev = pasteEvts[i];
          ensurePage(20);

          // Entry card background
          const cardH = ev.sourceUrl ? 22 : 16;
          setFill([232, 240, 254]);
          doc.roundedRect(margin, y, maxW, cardH, 2, 2, "F");

          doc.setFontSize(8); doc.setFont(undefined, "bold"); setColor(C.accent);
          doc.text(`Paste #${i + 1}`, margin + 3, y + 5);

          doc.setFont(undefined, "normal"); setColor(C.muted);
          doc.text(new Date(ev.timestamp).toLocaleTimeString(), pageW - margin - 3, y + 5, { align: "right" });

          if (ev.sourceUrl) {
            doc.setFontSize(8); setColor(C.blue);
            const urlTrimmed = ev.sourceUrl.length > 85 ? ev.sourceUrl.slice(0, 85) + "…" : ev.sourceUrl;
            doc.text(urlTrimmed, margin + 3, y + 12);
          }

          const previewY = ev.sourceUrl ? y + 18 : y + 11;
          const preview  = (ev.text || "").replace(/\n/g, " ").slice(0, 110) + (ev.text.length > 110 ? "…" : "");
          doc.setFontSize(7.5); setColor(C.mid);
          doc.text(`"${preview}"`, margin + 3, previewY);

          y += cardH + 4;
        }
      }

      // ── FULL TEXT LOG (new page) ─────────────────────────────────────────────
      doc.addPage();
      y = 20;

      setFill(C.bg);
      doc.rect(0, 0, pageW, 14, "F");
      doc.setFontSize(11); doc.setFont(undefined, "bold"); setColor(C.white);
      doc.text("Full Document Log", margin, 9);
      doc.setFont(undefined, "normal");
      y = 20;

      if (segments.length === 0) {
        addText("No content recorded.", 10, C.muted);
      } else {
        for (const seg of segments) {
          if (!seg.text.trim()) continue;
          const label = seg.type === "typed"    ? "[TYPED]"
                      : seg.type === "pasted"   ? "[PASTED]"
                      :                           "[EXISTING]";
          const color = seg.type === "typed"    ? C.green
                      : seg.type === "pasted"   ? C.red
                      :                           C.muted;

          doc.setFontSize(7.5); doc.setFont(undefined, "bold"); setColor(color);
          ensurePage(8);
          doc.text(label, margin, y);
          y += 4;
          doc.setFont(undefined, "normal");
          addWrappedText(seg.text.replace(/\n/g, " ↵ "), 8, C.dark, 4);
          y += 2;
        }
      }

      // Page numbers
      const totalPages = doc.internal.getNumberOfPages();
      for (let p = 1; p <= totalPages; p++) {
        doc.setPage(p);
        doc.setFontSize(8); setColor(C.muted);
        doc.text(`PasteScope Report  •  Page ${p} of ${totalPages}`, pageW / 2, pageH - 8, { align: "center" });
      }

      doc.save(`pastescope-${dateStr}.pdf`);
    }
  );
});


// ─── VIEW LOG ─────────────────────────────────────────────────────────────────
btnLog.addEventListener("click", () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    chrome.tabs.sendMessage(tabs[0].id, { type: "OPEN_LOG" });
  });
  window.close();
});

// ─── STAT CARD CLICKS ─────────────────────────────────────────────────────────
document.getElementById("card-typed").addEventListener("click", () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    chrome.tabs.sendMessage(tabs[0].id, { type: "OPEN_LOG", focus: "typed" });
  });
  window.close();
});
document.getElementById("card-pasted").addEventListener("click", () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    chrome.tabs.sendMessage(tabs[0].id, { type: "OPEN_LOG", focus: "pasted" });
  });
  window.close();
});

// ─── PASTE SOURCES ACCORDION ─────────────────────────────────────────────────
const pasteSourcesToggle  = document.getElementById("paste-sources-toggle");
const pasteSourcesChevron = document.getElementById("paste-sources-chevron");
const pasteSourcesList    = document.getElementById("paste-sources-list");
const pasteSourcesEmpty   = document.getElementById("paste-sources-empty");
const pasteSourcesBadge   = document.getElementById("paste-sources-badge");

let pasteSourcesOpen = false;

// Eagerly load badge count on popup open
chrome.storage.local.get("pasteEvents", (data) => {
  const evts = data.pasteEvents || [];
  updatePasteSourcesBadge(evts.length);
});

function updatePasteSourcesBadge(count) {
  if (!pasteSourcesBadge) return;
  pasteSourcesBadge.textContent = count;
  if (count > 0) {
    pasteSourcesBadge.classList.remove("zero");
  } else {
    pasteSourcesBadge.classList.add("zero");
  }
}

pasteSourcesToggle.addEventListener("click", () => {
  pasteSourcesOpen = !pasteSourcesOpen;
  pasteSourcesList.classList.toggle("open", pasteSourcesOpen);
  pasteSourcesChevron.classList.toggle("open", pasteSourcesOpen);
  if (pasteSourcesOpen) loadPasteSources();
});

function loadPasteSources() {
  chrome.storage.local.get("pasteEvents", (data) => {
    const events = data.pasteEvents || [];
    updatePasteSourcesBadge(events.length);

    // Clear old entries (keep empty placeholder)
    pasteSourcesList.querySelectorAll(".ps-src-entry").forEach(el => el.remove());

    if (events.length === 0) {
      pasteSourcesEmpty.style.display = "block";
      return;
    }
    pasteSourcesEmpty.style.display = "none";

    const srcTypeMap = {
      website: { label: "Website",    icon: "🌐", cls: "stype-website" },
      gdoc:    { label: "Google Doc", icon: "📄", cls: "stype-gdoc"    },
      gdrive:  { label: "Drive",      icon: "📁", cls: "stype-gdrive"  },
      local:   { label: "Local App",  icon: "💻", cls: "stype-local"   },
      unknown: { label: "Unknown",    icon: "❓", cls: "stype-unknown"  },
    };
    function getSrcType(ev) {
      if (ev.urlFoundInText && ev.sourceUrl) return { label: "In Text", icon: "🔍", cls: "stype-local" };
      return srcTypeMap[ev.sourceType || "unknown"] || srcTypeMap.unknown;
    }

    // Newest paste first
    [...events].reverse().forEach((ev, idx) => {
      const num     = events.length - idx;
      const type    = getSrcType(ev);
      const timeStr = new Date(ev.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const preview = (ev.text || "").replace(/\n/g, " ").slice(0, 70) +
                      ((ev.text || "").length > 70 ? "…" : "");

      const el = document.createElement("div");
      el.className = "ps-src-entry";

      let urlHtml;
      if (ev.sourceUrl) {
        let domain = ev.sourceUrl;
        try { domain = new URL(ev.sourceUrl).hostname.replace(/^www\./, ""); } catch (_) {}
        urlHtml = `
          <div class="ps-src-url-row">
            <span class="ps-src-type-badge ${type.cls}">${type.icon} ${type.label}</span>
            <a class="ps-src-url-link" href="${escHtml(ev.sourceUrl)}"
               target="_blank" rel="noopener noreferrer"
               title="${escHtml(ev.sourceUrl)}">🔗 ${escHtml(domain)}</a>
          </div>`;
      } else {
        urlHtml = `
          <div class="ps-src-url-row">
            <span class="ps-src-type-badge ${type.cls}">${type.icon} ${type.label}</span>
            <span class="ps-src-no-url">No URL detected</span>
          </div>`;
      }

      el.innerHTML = `
        <div class="ps-src-entry-top">
          <span class="ps-src-entry-num">Paste #${num}</span>
          <span class="ps-src-entry-time">${timeStr} · ${(ev.text||"").length}ch</span>
        </div>
        ${urlHtml}
        <div class="ps-src-preview">"${escHtml(preview)}"</div>`;

      pasteSourcesList.appendChild(el);
    });
  });
}

function escHtml(s) {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── SESSION HISTORY ACCORDION ────────────────────────────────────────────────
let historyOpen = false;

historyToggle.addEventListener("click", () => {
  historyOpen = !historyOpen;
  historyList.classList.toggle("open", historyOpen);
  historyChevron.classList.toggle("open", historyOpen);
  if (historyOpen) loadHistory();
});

function loadHistory() {
  chrome.storage.local.get("sessionHistory", (data) => {
    const history = data.sessionHistory || [];
    // Clear old entries
    historyList.querySelectorAll(".history-entry").forEach(el => el.remove());

    if (history.length === 0) {
      historyEmpty.style.display = "block";
      return;
    }
    historyEmpty.style.display = "none";

    // Show newest first
    [...history].reverse().forEach(entry => {
      const s = entry.stats || {};
      const t = entry.timeStats || {};
      const orig = s.originality ?? 100;
      const color = orig >= 75 ? "orig" : orig >= 50 ? "" : "pasted";

      const el = document.createElement("div");
      el.className = "history-entry";
      el.innerHTML = `
        <div class="history-entry-top">
          <span class="history-entry-title">${entry.pageTitle || "Untitled Doc"}</span>
          <span class="history-entry-time">${fmtRelTime(entry.savedAt)}</span>
        </div>
        <div class="history-entry-stats">
          <span class="history-stat ${color}">${orig}% original</span>
          <span class="history-stat pasted">${s.pasteCount ?? 0} pastes</span>
          <span class="history-stat time">Active: ${fmtMs(t.activeMs)}</span>
        </div>
      `;
      historyList.appendChild(el);
    });
  });
}

// ─── LIVE UPDATE via storage listener ────────────────────────────────────────
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.pasteEvents) {
    const evts = changes.pasteEvents.newValue || [];
    updatePasteSourcesBadge(evts.length);
    if (pasteSourcesOpen) loadPasteSources();
  }
  if (changes.stats) {
    renderStats(changes.stats.newValue);
  }
  if (changes.hudVisible) {
    hudToggle.checked = changes.hudVisible.newValue !== false;
  }
  if (changes.timeStats || changes.lastActivityTime || changes.isTabVisible) {
    chrome.storage.local.get(["timeStats", "lastActivityTime", "isTabVisible"], (data) => {
      renderTime(data.timeStats, data.lastActivityTime, data.isTabVisible);
      if (data.timeStats) {
        _lastTimeSnapshot = data.timeStats;
        _snapshotAt = Date.now();
      }
    });
  }
});
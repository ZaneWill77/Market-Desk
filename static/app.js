"use strict";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const state = { overview: null, sectorTf: "1m", scan: null, sort: { key: "score", dir: -1 }, ticker: "SPY", period: "1y", conversationId: null, account: null, busy: false };

const fmt = (v, d = 2) => (v == null || Number.isNaN(v) ? "—" : Number(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }));
const pct = (v, d = 2) => (v == null ? "—" : `${v > 0 ? "+" : ""}${fmt(v, d)}%`);
const cls = (v) => (v == null ? "" : v > 0 ? "up" : v < 0 ? "down" : "");
const big = (v) => { if (v == null) return "—"; const a = Math.abs(v); return a >= 1e12 ? fmt(v / 1e12) + "T" : a >= 1e9 ? fmt(v / 1e9) + "B" : a >= 1e6 ? fmt(v / 1e6) + "M" : fmt(v, 0); };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
/* ---------------- File export helpers ---------------- */
function downloadFile(filename, content, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
// RFC 4180 CSV. Text cells that a spreadsheet would treat as a formula (=, +, -, @, tab, CR)
// get a leading apostrophe; real numbers are written as plain numbers.
function csvCell(v) {
  if (v == null || (typeof v === "number" && !Number.isFinite(v))) return "";
  if (typeof v === "number") return String(Math.round(v * 1e6) / 1e6);
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function downloadCSV(name, headers, rows) {
  const lines = [headers, ...rows].map((r) => r.map(csvCell).join(","));
  downloadFile(`${name}.csv`, "﻿" + lines.join("\r\n") + "\r\n", "text/csv;charset=utf-8");
}
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const today = () => new Date().toISOString().slice(0, 10);

const scoreColor = (s) => (s >= 75 ? "var(--up)" : s >= 60 ? "var(--blue)" : s >= 40 ? "var(--muted)" : s >= 25 ? "var(--warn)" : "var(--down)");

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) { let m = r.statusText; try { m = (await r.json()).detail || m; } catch {} throw new Error(m); }
  return r.json();
}

/* ---------------- Meta ---------------- */
async function loadMeta() {
  const m = await api("/api/meta");
  $("#strategy").innerHTML = m.strategies.map((s) => `<option value="${s.key}">${esc(s.name)}</option>`).join("");
  $("#universe").innerHTML = m.universes.map((u) => `<option value="${u.key}">${esc(u.name)}${u.count ? ` · ${u.count}` : ""}</option>`).join("");
  $("#universe").value = "sp100";
  state.strategies = Object.fromEntries(m.strategies.map((s) => [s.key, s]));
  state.alertTypes = Object.fromEntries(m.alert_types.map((t) => [t.key, t]));
  const desc = () => ($("#stratDesc").textContent = state.strategies[$("#strategy").value].description);
  $("#strategy").onchange = desc; desc();
  $("#universe").onchange = () => $("#customWrap").classList.toggle("hidden", $("#universe").value !== "custom");
  setStatus(m.status);
}
function setStatus(s) {
  $("#mktState").textContent = `Market ${s.state}`;
  $("#mktState").classList.toggle("open", s.state === "open");
  $("#mktTime").textContent = s.time_et;
}

/* ---------------- Overview ---------------- */
function spark(data, up) {
  if (!data?.length) return "";
  const min = Math.min(...data), max = Math.max(...data), w = 100, h = 28;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - ((v - min) / (max - min || 1)) * (h - 2) - 1}`).join(" ");
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline fill="none" stroke="${up ? "var(--up)" : "var(--down)"}" stroke-width="1.5" vector-effect="non-scaling-stroke" points="${pts}"/></svg>`;
}

async function loadOverview(refresh = false) {
  $("#indices").innerHTML = `<div class="loading"><span class="spinner"></span> Loading market data…</div>`;
  try {
    const ov = await api(`/api/overview${refresh ? "?refresh=true" : ""}`);
    state.overview = ov;
    setStatus(ov.status);
    $("#indices").innerHTML = ov.indices.map((i) => `
      <div class="idx" data-sym="${esc(i.symbol)}">
        <div class="name">${esc(i.name)}</div>
        <div class="px">${fmt(i.price, i.symbol === "^TNX" || i.symbol === "^VIX" ? 2 : 2)}</div>
        <div class="chg ${cls(i.change_pct)}">${pct(i.change_pct)} <span class="muted">· 1M ${pct(i.ret_1m, 1)}</span></div>
        ${spark(i.spark, (i.ret_1m ?? 0) >= 0)}
      </div>`).join("");
    $$(".idx").forEach((el) => (el.onclick = () => openTicker(el.dataset.sym)));
    const r = ov.regime;
    const rc = r.label.startsWith("Risk-On") ? "on" : r.label.startsWith("Risk-Off") ? "off" : "mixed";
    $("#regime").className = `regime ${rc}`;
    $("#regime").textContent = `Regime: ${r.label}`;
    $("#regimeNotes").innerHTML = r.notes.map((n) => `<li>${esc(n)}</li>`).join("");
    renderSectors();
  } catch (e) {
    $("#indices").innerHTML = `<div class="msg error">Failed to load overview: ${esc(e.message)}</div>`;
  }
}

function renderSectors() {
  const tf = state.sectorTf;
  const rows = [...(state.overview?.sectors || [])].sort((a, b) => (b[tf] ?? -1e9) - (a[tf] ?? -1e9));
  const maxAbs = Math.max(1, ...rows.map((r) => Math.abs(r[tf] ?? 0)));
  $("#sectors").innerHTML = rows.map((r) => {
    const v = r[tf] ?? 0, w = (Math.abs(v) / maxAbs) * 50;
    const left = v >= 0 ? 50 : 50 - w;
    return `<div class="sec" data-sym="${r.symbol}">
      <div>${esc(r.name)} <span class="muted small">${r.symbol}</span></div>
      <div class="bar-track"><div class="zero"></div><div class="bar" style="left:${left}%;width:${w}%;background:${v >= 0 ? "var(--up)" : "var(--down)"};opacity:.75"></div></div>
      <div class="v ${cls(v)}">${pct(r[tf], 1)}</div></div>`;
  }).join("");
  $$(".sec").forEach((el) => (el.onclick = () => openTicker(el.dataset.sym)));
}
$$("#sectorTf button").forEach((b) => (b.onclick = () => {
  $$("#sectorTf button").forEach((x) => x.classList.remove("on")); b.classList.add("on");
  state.sectorTf = b.dataset.tf; renderSectors();
}));

/* ---------------- Bot / Scan ---------------- */
async function runScan() {
  const btn = $("#runBtn");
  btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Scanning…`;
  try {
    const res = await api("/api/scan", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ strategy: $("#strategy").value, universe: $("#universe").value, tickers: $("#customTickers").value }),
    });
    state.scan = res; state.sort = { key: "score", dir: -1 };
    renderScan();
  } catch (e) {
    alert(`Scan failed: ${e.message}`);
  } finally {
    btn.disabled = false; btn.innerHTML = "▶ Run Bot";
  }
}

function renderScan() {
  const s = state.scan, b = s.breadth || {};
  $("#scanOut").classList.remove("hidden");
  const stats = [
    ["Scanned", s.scanned, ""], ["> 50 SMA", b.above_sma50, "%"], ["> 200 SMA", b.above_sma200, "%"],
    ["Advancers", b.advancers, "%"], ["Near 52w Hi", b.near_highs, "%"], ["Avg RSI", b.avg_rsi, ""],
    ["Overbought", b.overbought, "%"], ["Oversold", b.oversold, "%"], ["Avg 1M", b.avg_1m, "%"],
  ];
  $("#breadth").innerHTML = stats.map(([k, v, u]) => `<div class="stat"><div class="k">${k}</div><div class="v">${v ?? "—"}${v != null ? u : ""}</div></div>`).join("");
  $("#narrative").innerHTML = `<strong>${esc(s.strategy.name)} · ${esc(s.universe)}</strong>` + s.narrative.map((p) => `<p>${esc(p)}</p>`).join("") +
    (s.missing?.length ? `<p class="muted small">No data: ${esc(s.missing.join(", "))}</p>` : "");
  renderTable();
}

const COLS = ["#", "symbol", "score", "rating", "price", "change_pct", "ret_1m", "ret_3m", "rsi14", "vol_ratio", "pct_from_high", "reasons"];
function renderTable() {
  const { key, dir } = state.sort;
  const rows = [...state.scan.results].sort((a, b) => {
    const x = a[key], y = b[key];
    if (typeof x === "string") return x.localeCompare(y) * dir;
    return ((x ?? -1e9) - (y ?? -1e9)) * dir;
  });
  $("#results tbody").innerHTML = rows.map((r, i) => `
    <tr data-sym="${esc(r.symbol)}">
      <td class="muted">${i + 1}</td><td>${starBtn(r.symbol)}<strong>${esc(r.symbol)}</strong></td>
      <td><span class="score"><span class="track"><span class="fill" style="display:block;width:${r.score}%;background:${scoreColor(r.score)}"></span></span>${fmt(r.score, 0)}</span></td>
      <td><span class="tag ${r.rating}">${r.rating}</span></td>
      <td class="num">${fmt(r.price)}</td><td class="num ${cls(r.change_pct)}">${pct(r.change_pct)}</td>
      <td class="num ${cls(r.ret_1m)}">${pct(r.ret_1m, 1)}</td><td class="num ${cls(r.ret_3m)}">${pct(r.ret_3m, 1)}</td>
      <td class="num">${fmt(r.rsi14, 0)}</td><td class="num">${fmt(r.vol_ratio, 1)}</td><td class="num">${pct(r.pct_from_high, 1)}</td>
      <td class="why">${esc(r.reasons.join(" · "))}</td>
    </tr>`).join("");
  $$("#results tbody tr").forEach((tr) => (tr.onclick = () => openTicker(tr.dataset.sym)));
}
$$("#results th").forEach((th, i) => (th.onclick = () => {
  const key = COLS[i]; if (key === "#" || key === "reasons") return;
  state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : (key === "symbol" ? 1 : -1) };
  renderTable();
}));
$("#runBtn").onclick = runScan;

$("#askScanBtn").onclick = () => {
  const s = state.scan; if (!s) return;
  const top = s.top.map((r) => `${r.symbol}: score ${r.score} (${r.rating}), px ${fmt(r.price)}, day ${pct(r.change_pct)}, 1M ${pct(r.ret_1m, 1)}, RSI ${fmt(r.rsi14, 0)} — ${r.reasons.join("; ")}`).join("\n");
  const bottom = (s.bottom || []).map((r) => `${r.symbol}: ${r.score}`).join(", ");
  sendChat(`I just ran the market bot with the **${s.strategy.name}** strategy on **${s.universe}** (${s.scanned} tickers).\n\nBreadth: ${JSON.stringify(s.breadth)}\n\nTop results:\n${top}\n\nWeakest: ${bottom}\n\nAnalyze these results in the context of today's market: what is this scan telling me, which 3-5 setups look most compelling and why, what are the risks, and what should I watch? Pull any extra data you need.`);
};

/* ---------------- Ticker ---------------- */
function openTicker(sym) {
  $("#tickerInput").value = sym;
  loadTicker(sym, state.period);
  $("#tickerInput").closest(".card").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function loadTicker(sym, period) {
  sym = sym.trim().toUpperCase(); if (!sym) return;
  state.ticker = sym; state.period = period;
  $("#tickerHeader").innerHTML = `<span class="spinner"></span> <span class="muted">Loading ${esc(sym)}…</span>`;
  try {
    const d = await api(`/api/ticker/${encodeURIComponent(sym)}?period=${period}`);
    renderTicker(d);
  } catch (e) {
    $("#tickerHeader").innerHTML = `<span class="msg error">${esc(e.message)}</span>`;
    return;
  }
  loadTickerEarnings(sym);
  $("#fundamentals").innerHTML = `<span class="muted"><span class="spinner"></span> Loading…</span>`;
  $("#news").innerHTML = "";
  try {
    const info = await api(`/api/ticker/${encodeURIComponent(sym)}/info`);
    if (state.ticker === sym) renderInfo(info);
  } catch { $("#fundamentals").innerHTML = `<span class="muted">Unavailable</span>`; }
}

function renderTicker(d) {
  state.tickerData = d;
  const o = d.ohlcv, ind = d.indicators, a = d.analysis, sn = a?.snapshot || {};
  $("#tickerHeader").innerHTML = `<span class="sym">${esc(d.symbol)}</span><span class="px">${fmt(sn.price)}</span>
    <span class="${cls(sn.change_pct)} mono">${pct(sn.change_pct)}</span>
    <span class="muted small">1M ${pct(sn.ret_1m, 1)} · 3M ${pct(sn.ret_3m, 1)} · 12M ${pct(sn.ret_12m, 1)}</span>
    <span class="ticker-actions">${watchBtn(d.symbol)}<button class="btn ghost sm" type="button" data-alert-for="${esc(d.symbol)}">🔔 Alert</button><button class="btn ghost sm" type="button" data-compare="${esc(d.symbol)}" title="Add to the Compare chart">⇄ Compare</button><button class="btn ghost sm" type="button" id="tickerCsv" title="Download prices and indicators for this period">⬇ CSV</button></span>`;

  const x = o.dates, intraday = d.interval.endsWith("m");
  const traces = [
    { type: "candlestick", x, open: o.open, high: o.high, low: o.low, close: o.close, name: d.symbol,
      increasing: { line: { color: "#22c55e" } }, decreasing: { line: { color: "#ef4444" } }, yaxis: "y" },
    { x, y: ind.bb_upper, name: "BB upper", line: { color: "rgba(136,146,166,.35)", width: 1 }, yaxis: "y", hoverinfo: "skip" },
    { x, y: ind.bb_lower, name: "BB lower", line: { color: "rgba(136,146,166,.35)", width: 1 }, fill: "tonexty", fillcolor: "rgba(136,146,166,.05)", yaxis: "y", hoverinfo: "skip" },
    { x, y: ind.sma20, name: "SMA 20", line: { color: "#60a5fa", width: 1.2 }, yaxis: "y" },
    { x, y: ind.sma50, name: "SMA 50", line: { color: "#f0a37f", width: 1.4 }, yaxis: "y" },
    { x, y: ind.sma200, name: "SMA 200", line: { color: "#c084fc", width: 1.6 }, yaxis: "y" },
    { type: "bar", x, y: o.volume, name: "Volume", yaxis: "y2", marker: { color: o.close.map((c, i) => (c >= o.open[i] ? "rgba(34,197,94,.5)" : "rgba(239,68,68,.5)")) } },
    { x, y: ind.rsi, name: "RSI 14", line: { color: "#eab308", width: 1.3 }, yaxis: "y3" },
    { type: "bar", x, y: ind.macd_hist, name: "MACD hist", yaxis: "y4", marker: { color: ind.macd_hist.map((v) => (v >= 0 ? "rgba(34,197,94,.6)" : "rgba(239,68,68,.6)")) } },
    { x, y: ind.macd, name: "MACD", line: { color: "#60a5fa", width: 1.2 }, yaxis: "y4" },
    { x, y: ind.macd_signal, name: "Signal", line: { color: "#f0a37f", width: 1.2 }, yaxis: "y4" },
  ];
  const grid = "rgba(35,43,59,.8)";
  const ax = (domain, extra = {}) => ({ domain, gridcolor: grid, zeroline: false, side: "right", tickfont: { size: 10 }, ...extra });
  const isCrypto = d.symbol.endsWith("-USD");
  const rangebreaks = isCrypto ? [] : intraday ? [{ bounds: ["sat", "mon"] }, { bounds: [16, 9.5], pattern: "hour" }] : [{ bounds: ["sat", "mon"] }];
  const layout = {
    paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)", font: { color: "#8892a6", family: "Inter" },
    margin: { l: 10, r: 50, t: 40, b: 30 }, showlegend: true, legend: { orientation: "h", x: 0, y: 1.08, font: { size: 11 }, traceorder: "normal" },
    hovermode: "x unified", dragmode: "pan",
    xaxis: { rangeslider: { visible: false }, gridcolor: grid, rangebreaks, type: "date" },
    yaxis: ax([0.46, 1]), yaxis2: ax([0.33, 0.44], { showticklabels: false }),
    yaxis3: ax([0.17, 0.31], { range: [0, 100], tickvals: [30, 50, 70] }), yaxis4: ax([0, 0.15]),
    shapes: [30, 70].map((v) => ({ type: "line", xref: "paper", x0: 0, x1: 1, yref: "y3", y0: v, y1: v, line: { color: "rgba(136,146,166,.4)", dash: "dot", width: 1 } })),
    annotations: [],
  };
  Plotly.react("chart", traces, layout, { displaylogo: false, responsive: true, scrollZoom: true, modeBarButtonsToRemove: ["lasso2d", "select2d"] });

  if (a) {
    $("#scorecard").innerHTML = Object.values(a.strategies).sort((p, q) => q.score - p.score).map((s) => `
      <div class="sc-row"><div>${esc(s.name)}</div>
        <div class="score"><span class="track" style="width:100%"><span class="fill" style="display:block;width:${s.score}%;background:${scoreColor(s.score)}"></span></span></div>
        <div><span class="tag ${s.rating}">${fmt(s.score, 0)} ${s.rating}</span></div>
        <div class="reasons">${esc(s.reasons.join(" · "))}</div></div>`).join("");
    const L = [
      ["Price", fmt(sn.price)], ["ATR(14)", fmt(sn.atr14)], ["SMA 20", fmt(sn.sma20)], ["SMA 50", fmt(sn.sma50)],
      ["SMA 200", fmt(sn.sma200)], ["RSI 14", fmt(sn.rsi14, 1)], ["MACD", fmt(sn.macd)], ["ADX 14", fmt(sn.adx14, 1)],
      ["BB upper", fmt(sn.bb_upper)], ["BB lower", fmt(sn.bb_lower)], ["52w high", fmt(sn.high_52w)], ["52w low", fmt(sn.low_52w)],
      ["From high", pct(sn.pct_from_high, 1)], ["Vol (60d ann.)", pct(sn.vol_60d, 1).replace("+", "")], ["Max DD 1y", pct(sn.max_dd_1y, 1)], ["Volume ×avg", fmt(sn.vol_ratio, 2)],
    ];
    $("#levels").innerHTML = L.map(([k, v]) => `<div><span class="muted">${k}</span><span>${v}</span></div>`).join("");
  }
}

function renderInfo({ fundamentals: f, news }) {
  const rows = [
    ["Name", f.shortName], ["Sector", f.sector], ["Market cap", big(f.marketCap)], ["Trailing P/E", fmt(f.trailingPE, 1)],
    ["Forward P/E", fmt(f.forwardPE, 1)], ["P/B", fmt(f.priceToBook, 1)], ["P/S", fmt(f.priceToSalesTrailing12Months, 1)],
    ["Profit margin", f.profitMargins != null ? pct(f.profitMargins * 100, 1).replace("+", "") : "—"],
    ["Rev growth", f.revenueGrowth != null ? pct(f.revenueGrowth * 100, 1) : "—"], ["ROE", f.returnOnEquity != null ? pct(f.returnOnEquity * 100, 1).replace("+", "") : "—"],
    ["Div yield", f.dividendYield != null ? `${fmt(f.dividendYield, 2)}%` : "—"], ["Beta", fmt(f.beta, 2)],
    ["Analyst target", fmt(f.targetMeanPrice)], ["Consensus", f.recommendationKey ? `${f.recommendationKey} (${f.numberOfAnalystOpinions ?? "?"})` : "—"],
  ].filter(([, v]) => v != null && v !== "—");
  $("#fundamentals").innerHTML = rows.length ? rows.map(([k, v]) => `<div><span class="muted">${k}</span><span>${esc(v)}</span></div>`).join("") : `<span class="muted">No fundamentals (ETF, index or rate-limited)</span>`;
  $("#news").innerHTML = news.length ? news.map((n) => `<li><a href="${esc(n.url || "#")}" target="_blank" rel="noopener">${esc(n.title)}</a>
    <div class="muted small">${esc(n.source || "")}${n.published ? " · " + new Date(n.published).toLocaleString() : ""}</div></li>`).join("") : `<li class="muted">No recent news</li>`;
}

$("#tickerForm").onsubmit = (e) => { e.preventDefault(); loadTicker($("#tickerInput").value, state.period); };
$$("#periodSeg button").forEach((b) => (b.onclick = () => {
  $$("#periodSeg button").forEach((x) => x.classList.remove("on")); b.classList.add("on");
  loadTicker($("#tickerInput").value, b.dataset.p);
}));
$("#askTickerBtn").onclick = () => sendChat(`Give me a complete analysis of ${state.ticker}: trend and technical setup, key support/resistance levels, how each strategy rates it, fundamentals and valuation, recent news and catalysts, and the bull vs. bear case.`);

/* ---------------- Claude chat ---------------- */
const msgs = $("#messages");
const scrollDown = () => (msgs.scrollTop = msgs.scrollHeight);
const md = (t) => DOMPurify.sanitize(marked.parse(t, { breaks: false, gfm: true }));

function addMsg(role, html) {
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  if (html != null) el.innerHTML = html;
  msgs.appendChild(el); scrollDown();
  return el;
}

async function sendChat(text) {
  text = text.trim();
  if (!text || state.busy) return;
  if (!state.account?.signed_in) { openSignIn(); return; }
  state.busy = true; $("#sendBtn").disabled = true;
  addMsg("user").textContent = text;
  const box = addMsg("assistant");
  let seg = null, buf = "", raf = 0;
  const newSeg = () => { seg = document.createElement("div"); seg.className = "typing"; box.appendChild(seg); buf = ""; };
  const flush = () => { raf = 0; if (seg) { seg.innerHTML = md(buf); scrollDown(); } };
  const status = document.createElement("div"); status.className = "tool-line"; status.textContent = "Thinking…"; box.appendChild(status);

  try {
    const resp = await fetch("/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, conversation_id: state.conversationId, model: $("#model").value || null, effort: $("#effort").value || null }),
    });
    if (!resp.ok) {
      let m = resp.statusText; try { m = (await resp.json()).detail || m; } catch {}
      if (resp.status === 401 || resp.status === 403) await loadAccount();
      throw new Error(m);
    }
    const reader = resp.body.getReader(); const dec = new TextDecoder(); let pending = "";
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      pending += dec.decode(value, { stream: true });
      const parts = pending.split("\n\n"); pending = parts.pop();
      for (const p of parts) {
        if (!p.startsWith("data: ")) continue;
        const ev = JSON.parse(p.slice(6));
        if (ev.type === "text") {
          if (status.isConnected) status.remove();
          if (!seg) newSeg();
          buf += ev.text; if (!raf) raf = requestAnimationFrame(flush);
        } else if (ev.type === "tool") {
          if (status.isConnected) status.remove();
          if (seg) { flush(); seg.classList.remove("typing"); seg = null; }
          const t = document.createElement("div"); t.className = "tool-line"; t.textContent = ev.label + "…"; box.appendChild(t); scrollDown();
        } else if (ev.type === "turn") {
          if (seg && buf) { flush(); seg.classList.remove("typing"); seg = null; }
        } else if (ev.type === "conversation") {
          state.conversationId = ev.conversation_id;
        } else if (ev.type === "error") {
          if (status.isConnected) status.remove();
          addMsg("error", `⚠ ${esc(ev.message)}`);
        }
      }
    }
  } catch (e) {
    addMsg("error", `⚠ ${esc(e.message)}`);
  } finally {
    if (raf) cancelAnimationFrame(raf);
    flush(); if (seg) seg.classList.remove("typing");
    if (status.isConnected) status.remove();
    state.busy = false; $("#sendBtn").disabled = false;
  }
}

$("#chatForm").onsubmit = (e) => { e.preventDefault(); const t = $("#chatText").value; $("#chatText").value = ""; sendChat(t); };
$("#chatText").onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#chatForm").requestSubmit(); } };
$$("#chips button").forEach((b) => (b.onclick = () => sendChat(b.textContent)));
const clearChat = () => { state.conversationId = null; $$(".msg:not(.intro)", msgs).forEach((m) => m.remove()); };
$("#newChat").onclick = clearChat;

/* ---------------- Sign in / out ---------------- */
async function loadAccount() {
  const a = await api("/api/auth/me");
  state.account = a;
  $("#signInBtn").classList.toggle("hidden", a.signed_in);
  $("#signedIn").classList.toggle("hidden", !a.signed_in);
  $("#chatSignInHint").classList.toggle("hidden", a.signed_in);
  $("#chatText").disabled = !a.signed_in;
  $("#chatText").placeholder = a.signed_in ? "Ask about the market…  (Enter to send, Shift+Enter for new line)" : "Sign in to chat with Claude";
  const sel = $("#model");
  if (a.signed_in) {
    $("#accountLabel").textContent = a.key_hint ? `API key ${a.key_hint}` : a.provider_name;
    $("#accountLabel").title = a.provider_name;
    const prev = sel.value;
    sel.innerHTML = a.models.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join("");
    if (a.models.some((m) => m.id === prev)) sel.value = prev;
    sel.disabled = false;
  } else {
    sel.innerHTML = `<option>Not signed in</option>`; sel.disabled = true;
  }
}

function openSignIn() {
  const a = state.account || { providers: [] };
  $("#providerChoice").innerHTML = a.providers.map((p, i) =>
    `<label><input type="radio" name="provider" value="${esc(p.id)}" ${i === 0 ? "checked" : ""} /> ${esc(p.name)}</label>`).join("");
  $("#providerChoice").classList.toggle("hidden", a.providers.length < 2);
  const sync = () => {
    const id = $("input[name=provider]:checked")?.value;
    const needsKey = (a.providers.find((p) => p.id === id) || { needs_api_key: true }).needs_api_key;
    $("#apiKeyFields").classList.toggle("hidden", !needsKey);
    $("#noKeyFields").classList.toggle("hidden", needsKey);
  };
  $$("input[name=provider]").forEach((r) => (r.onchange = sync)); sync();
  $("#signInError").classList.add("hidden");
  $("#apiKey").value = "";
  $("#signInDialog").showModal();
}

$("#signInForm").onsubmit = async (e) => {
  e.preventDefault();
  const provider = $("input[name=provider]:checked")?.value || "anthropic";
  const needsKey = (state.account?.providers.find((p) => p.id === provider) || { needs_api_key: true }).needs_api_key;
  const btn = $("#submitSignIn");
  btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Checking…`;
  $("#signInError").classList.add("hidden");
  try {
    await api("/api/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, api_key: needsKey ? $("#apiKey").value : null }),
    });
    $("#apiKey").value = "";
    $("#signInDialog").close();
    clearChat();
    await loadAccount();
  } catch (err) {
    $("#signInError").textContent = err.message;
    $("#signInError").classList.remove("hidden");
  } finally {
    btn.disabled = false; btn.textContent = "Sign in";
  }
};
$("#cancelSignIn").onclick = () => { $("#apiKey").value = ""; $("#signInDialog").close(); };
$("#signInBtn").onclick = openSignIn;
$("#chatSignIn").onclick = (e) => { e.preventDefault(); openSignIn(); };
$("#signOutBtn").onclick = async () => {
  await api("/api/auth/logout", { method: "POST" }).catch(() => {});
  clearChat();
  await loadAccount();
};

$("#refreshBtn").onclick = () => { loadOverview(true); loadTicker(state.ticker, state.period); };

/* ---------------- Backtest ---------------- */
// Series colors: validated categorical slots 1-3 for this dark surface; each line also has
// its own dash style so identity never relies on color alone.
const BT_SERIES = {
  strategy: { color: "#3987e5", dash: "solid", width: 2.2 },
  benchmark: { color: "#d95926", dash: "dash", width: 1.8 },
  universe: { color: "#199e70", dash: "dot", width: 1.8 },
};

function setupBacktestSelectors() {
  $("#btStrategy").innerHTML = $("#strategy").innerHTML;
  $("#btUniverse").innerHTML = $("#universe").innerHTML;
  $("#btStrategy").value = $("#strategy").value; $("#btUniverse").value = $("#universe").value;
  $("#btUniverse").onchange = () => $("#btCustomWrap").classList.toggle("hidden", $("#btUniverse").value !== "custom");
}

async function runBacktest() {
  const btn = $("#btRunBtn");
  btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Backtesting…`;
  try {
    const res = await api("/api/backtest", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        strategy: $("#btStrategy").value, universe: $("#btUniverse").value, tickers: $("#btTickers").value,
        period: $("#btPeriod").value, rebalance: $("#btRebalance").value,
        top_n: +$("#btTopN").value || 10, cost_bps: +$("#btCost").value || 0,
      }),
    });
    state.backtest = res;
    renderBacktest(res);
  } catch (e) {
    alert(`Backtest failed: ${e.message}`);
  } finally {
    btn.disabled = false; btn.innerHTML = "⟲ Run Backtest";
  }
}

const monthYear = (d) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: "short", year: "numeric" });

function renderBacktest(r) {
  $("#btOut").classList.remove("hidden");
  const p = r.params, s = r.stats;
  const names = { strategy: `${p.strategy_name} · top ${p.top_n}`, benchmark: p.benchmark, universe: "Equal-weight universe" };
  const sharpe = (v) => (v == null ? "—" : fmt(v, 2));
  const row = (k) => `<tr class="${k === "strategy" ? "lead" : ""}">
      <td><span class="series"><span class="swatch" style="border-top-color:${BT_SERIES[k].color};border-top-style:${BT_SERIES[k].dash === "solid" ? "solid" : BT_SERIES[k].dash === "dash" ? "dashed" : "dotted"}"></span>${esc(names[k])}</span></td>
      <td class="num ${cls(s[k].total_return)}">${pct(s[k].total_return, 1)}</td>
      <td class="num ${cls(s[k].cagr)}">${pct(s[k].cagr, 1)}</td>
      <td class="num">${fmt(s[k].volatility, 1)}%</td>
      <td class="num">${sharpe(s[k].sharpe)}</td>
      <td class="num down">${fmt(s[k].max_drawdown, 1)}%</td>
      <td class="num">${s[k].win_rate != null ? fmt(s[k].win_rate, 0) + "%" : "—"}</td></tr>`;
  const edge = s.strategy.total_return - s.benchmark.total_return;
  $("#btStats").innerHTML = `
    <div class="bt-kpis">
      <div class="stat"><div class="k">vs ${esc(p.benchmark)}</div><div class="v ${cls(edge)}">${pct(edge, 1)}</div><div class="sub">total return difference</div></div>
      <div class="stat"><div class="k">Beat ${esc(p.benchmark)}</div><div class="v">${fmt(s.strategy.beat_benchmark, 0)}%</div><div class="sub">of rebalance periods</div></div>
      <div class="stat"><div class="k">Avg turnover</div><div class="v">${fmt(s.strategy.avg_turnover, 0)}%</div><div class="sub">of holdings replaced</div></div>
      <div class="stat"><div class="k">Window</div><div class="v" style="font-size:15px">${monthYear(p.start)} → ${monthYear(p.end)}</div><div class="sub">${p.tickers_tested} stocks · ${esc(p.rebalance)}</div></div>
    </div>
    <table><thead><tr><th></th><th class="num">Total</th><th class="num">CAGR</th><th class="num">Volatility</th><th class="num">Sharpe</th><th class="num">Max DD</th><th class="num">Up periods</th></tr></thead>
    <tbody>${["strategy", "benchmark", "universe"].map(row).join("")}</tbody></table>`;

  const grid = "rgba(35,43,59,.8)";
  const base = {
    paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)", font: { color: "#8892a6", family: "Inter" },
    hovermode: "x unified", hoverlabel: { bgcolor: "#171d2a", bordercolor: "#232b3b", font: { color: "#e4e8f0" } },
    xaxis: { gridcolor: grid, type: "date", range: [r.curves.strategy.dates[0], r.curves.strategy.dates.at(-1)] }, showlegend: true,
    legend: { orientation: "h", x: 0, y: 1.12, font: { size: 11, color: "#e4e8f0" } },
  };
  const keys = ["strategy", "benchmark", "universe"];
  const line = (k, y) => ({ x: r.curves[k].dates, y, name: names[k], mode: "lines",
    line: { color: BT_SERIES[k].color, dash: BT_SERIES[k].dash, width: BT_SERIES[k].width },
    hovertemplate: "%{y:.1f}%<extra>" + esc(names[k]) + "</extra>" });
  const cum = (k) => r.curves[k].values.map((v) => (v / r.curves[k].values[0] - 1) * 100);
  const dd = (k) => { let peak = -Infinity; return r.curves[k].values.map((v) => { peak = Math.max(peak, v); return (v / peak - 1) * 100; }); };

  // Direct labels at the line ends (final cumulative return).
  const ends = keys.map((k) => { const y = cum(k); return { k, x: r.curves[k].dates.at(-1), y: y.at(-1) }; })
    .sort((a, b) => b.y - a.y);
  const short = { strategy: "Strategy", benchmark: p.benchmark, universe: "Universe" };
  const allY = keys.flatMap(cum), span = Math.max(...allY) - Math.min(...allY) || 1;
  let prev = null;
  const annotations = ends.map((e) => {
    // Nudge labels apart when their end values are close, so they never overlap.
    let yshift = 0;
    if (prev && prev.y - e.y < span * 0.06) yshift = prev.yshift - 15;
    prev = { y: e.y, yshift };
    return { x: e.x, y: e.y, xanchor: "left", xshift: 6, yshift, showarrow: false,
      text: `${short[e.k]} ${pct(e.y, 1)}`, font: { size: 11, color: "#e4e8f0" } };
  });
  Plotly.react("btEquity", keys.map((k) => line(k, cum(k))), {
    ...base, margin: { l: 50, r: 120, t: 36, b: 30 }, annotations,
    yaxis: { gridcolor: grid, zeroline: true, zerolinecolor: "#3a4458", ticksuffix: "%", title: { text: "Cumulative return", font: { size: 11 } } },
  }, { displaylogo: false, responsive: true, modeBarButtonsToRemove: ["lasso2d", "select2d"] });
  Plotly.react("btDrawdown", keys.map((k) => ({ ...line(k, dd(k)), showlegend: false })), {
    ...base, showlegend: false, margin: { l: 50, r: 120, t: 10, b: 30 },
    yaxis: { gridcolor: grid, ticksuffix: "%", title: { text: "Drawdown", font: { size: 11 } } },
  }, { displaylogo: false, responsive: true, displayModeBar: false });

  $("#btNotes").innerHTML = r.notes.map((n) => `<p>⚠ ${esc(n)}</p>`).join("");
  $("#btPeriods tbody").innerHTML = r.periods.map((x) => `<tr>
      <td>${esc(x.date)}</td><td class="num ${cls(x.return)}">${pct(x.return, 1)}</td>
      <td class="num ${cls(x.benchmark)}">${pct(x.benchmark, 1)}</td><td class="num ${cls(x.excess)}">${pct(x.excess, 1)}</td>
      <td class="num">${fmt(x.turnover, 0)}%</td>
      <td class="holdings">${x.holdings.map((h) => esc(h.symbol)).join(", ")}</td></tr>`).join("");
  $("#btPeriods thead th:nth-child(3)").textContent = p.benchmark;
}

$("#btRunBtn").onclick = runBacktest;
$("#backtestThisBtn").onclick = () => {
  $("#btStrategy").value = $("#strategy").value;
  $("#btUniverse").value = $("#universe").value;
  $("#btTickers").value = $("#customTickers").value;
  $("#btUniverse").onchange();
  $("#backtestCard").classList.remove("collapsed");
  $("#backtestCard").scrollIntoView({ behavior: "smooth", block: "start" });
  runBacktest();
};
$("#askBtBtn").onclick = () => {
  const r = state.backtest; if (!r) return;
  const st = (k) => Object.entries(r.stats[k]).map(([a, b]) => `${a} ${b == null ? "n/a" : fmt(b, 2)}`).join(", ");
  const recent = r.periods.slice(0, 6).map((x) => `${x.date}: ${pct(x.return, 1)} vs ${pct(x.benchmark, 1)} — ${x.holdings.map((h) => h.symbol).join(", ")}`).join("\n");
  sendChat(`I backtested **${r.params.strategy_name}** on **${r.params.universe}** (${r.params.start} to ${r.params.end}, ${r.params.rebalance} rebalance, top ${r.params.top_n}, ${r.params.cost_bps} bps costs).\n\nStrategy: ${st("strategy")}\n${r.params.benchmark}: ${st("benchmark")}\nEqual-weight universe: ${st("universe")}\n\nRecent rebalances:\n${recent}\n\nInterpret this: did the strategy add value over the benchmark and over simply holding the whole universe? Is it risk-adjusted outperformance or just more risk? What market conditions helped or hurt it, how much should I trust this given survivorship bias and the sample size, and what tweaks would be worth testing?`);
};

/* ---------------- Resizable layout ---------------- */
// Sizes and collapsed sections are remembered per browser (localStorage, best-effort).
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(`md.${k}`)); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(`md.${k}`) : localStorage.setItem(`md.${k}`, JSON.stringify(v)); } catch {} },
};
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Generic pointer-drag: onStart() returns the starting size, onMove(start, dx, dy) applies, onEnd() saves.
function makeDraggable(handle, axis, { onStart, onMove, onEnd }) {
  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add("dragging");
    document.body.classList.add("resizing", axis);
    const x0 = e.clientX, y0 = e.clientY, start = onStart();
    const move = (ev) => onMove(start, ev.clientX - x0, ev.clientY - y0);
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      handle.classList.remove("dragging");
      document.body.classList.remove("resizing", axis);
      onEnd();
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  });
}

// 1) Chat panel width: the vertical divider between the dashboard and the chat.
(function setupSplitter() {
  const layout = $(".layout"), sp = $("#splitter"), DEFAULT = 440;
  const maxW = () => Math.max(360, Math.min(1000, window.innerWidth * 0.6));
  const apply = (w) => { w = clamp(Math.round(w), 320, maxW()); layout.style.setProperty("--chat-w", `${w}px`); return w; };
  let width = apply(store.get("chatWidth") ?? DEFAULT);
  makeDraggable(sp, "col", {
    onStart: () => width,
    onMove: (start, dx) => { width = apply(start - dx); },
    onEnd: () => store.set("chatWidth", width),
  });
  sp.addEventListener("dblclick", () => { width = apply(DEFAULT); store.set("chatWidth", null); });
  sp.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 80 : 20;
    if (e.key === "ArrowLeft") width = apply(width + step);
    else if (e.key === "ArrowRight") width = apply(width - step);
    else return;
    e.preventDefault(); store.set("chatWidth", width);
  });
  window.addEventListener("resize", () => { width = apply(width); });
})();

// 2) Height handles under the chart, results table and news ([data-resize] elements).
(function setupHeightHandles() {
  $$("[data-resize]").forEach((el) => {
    const key = `h.${el.dataset.resize}`, min = +el.dataset.min || 120;
    const saved = store.get(key);
    const setH = (px) => { el.style.height = px ? `${px}px` : ""; el.style.maxHeight = px ? "none" : ""; };
    if (saved) setH(saved);
    const handle = document.createElement("div");
    handle.className = "v-handle";
    handle.title = "Drag to resize · double-click to reset";
    el.after(handle);
    let h = 0;
    makeDraggable(handle, "row", {
      onStart: () => el.getBoundingClientRect().height,
      onMove: (start, dx, dy) => { h = clamp(Math.round(start + dy), min, 1800); setH(h); },
      onEnd: () => h && store.set(key, h),
    });
    handle.addEventListener("dblclick", () => { setH(null); store.set(key, null); });
  });
})();

// 3) Collapsible sections: a chevron next to each section title.
(function setupCollapsible() {
  const collapsed = new Set(store.get("collapsed") || []);
  $$(".card").forEach((card) => {
    const h2 = $(".card-head h2", card); if (!h2) return;
    const key = h2.textContent.trim().toLowerCase().replace(/\W+/g, "-");
    const row = document.createElement("div"); row.className = "title-row";
    const btn = document.createElement("button");
    btn.className = "collapse-btn"; btn.type = "button"; btn.textContent = "▾";
    h2.replaceWith(row); row.append(btn, h2);
    const set = (on) => {
      card.classList.toggle("collapsed", on);
      btn.setAttribute("aria-expanded", String(!on));
      btn.title = on ? "Expand section" : "Collapse section";
    };
    set(collapsed.has(key));
    btn.onclick = () => {
      const on = !card.classList.contains("collapsed"); set(on);
      on ? collapsed.add(key) : collapsed.delete(key);
      store.set("collapsed", [...collapsed]);
    };
  });
})();

// Keep Plotly charts sized to their containers (width from the splitter, height from handles).
(function watchCharts() {
  ["#chart", "#btEquity", "#btDrawdown", "#cmpChart", "#pfChart"].forEach((sel) => {
    const el = $(sel); let raf = 0;
    new ResizeObserver(() => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (el.data && el.offsetWidth > 0 && el.offsetHeight > 0) Plotly.Plots.resize(el);
      });
    }).observe(el);
  });
})();

/* ---------------- Watchlists & alerts ---------------- */
// Stored in this browser only (localStorage). Export/Import makes a backup file.
const SYM_RE = /^\^?[A-Z0-9][A-Z0-9.\-=]{0,14}$/;
const normSym = (s) => { s = String(s || "").trim().toUpperCase(); return s.startsWith("^") ? s : s.replace(/\./g, "-"); };
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

function defaultWatch() {
  return { version: 1, lists: { main: { name: "My Watchlist", symbols: ["SPY", "QQQ", "AAPL", "NVDA", "MSFT"] } },
    active: "main", strategy: "composite", alerts: [], log: [], unread: 0 };
}
function validWatch(d) {
  return d && typeof d === "object" && d.lists && typeof d.lists === "object" && Object.keys(d.lists).length &&
    Object.values(d.lists).every((l) => l && typeof l.name === "string" && Array.isArray(l.symbols)) && Array.isArray(d.alerts);
}
function sanitizeWatch(d) {
  const out = { ...defaultWatch(), lists: {}, alerts: [], log: Array.isArray(d.log) ? d.log.slice(0, 100) : [], unread: 0 };
  for (const [id, l] of Object.entries(d.lists)) {
    out.lists[String(id).slice(0, 40)] = { name: String(l.name).slice(0, 60) || "Watchlist",
      symbols: [...new Set(l.symbols.map(normSym).filter((s) => SYM_RE.test(s)))].slice(0, 150) };
  }
  out.active = out.lists[d.active] ? d.active : Object.keys(out.lists)[0];
  out.strategy = typeof d.strategy === "string" ? d.strategy : "composite";
  out.alerts = d.alerts.filter((a) => a && SYM_RE.test(normSym(a.symbol)) && typeof a.type === "string").slice(0, 300)
    .map((a) => ({ id: String(a.id || uid()), symbol: normSym(a.symbol), type: a.type,
      value: a.value == null || a.value === "" ? null : Number(a.value), strategy: a.strategy || null,
      repeat: a.repeat === "always" ? "always" : "once", enabled: a.enabled !== false,
      last_state: null, triggered_at: a.triggered_at || null, created_at: a.created_at || new Date().toISOString() }));
  return out;
}

let wl = (() => { const d = store.get("watch"); try { return validWatch(d) ? sanitizeWatch(d) : defaultWatch(); } catch { return defaultWatch(); } })();
const saveWatch = () => store.set("watch", wl);
const activeList = () => wl.lists[wl.active];
const isWatched = (sym) => activeList().symbols.includes(normSym(sym));

function starBtn(sym) {
  const on = isWatched(sym);
  return `<button class="icon-btn star ${on ? "on" : ""}" type="button" data-star="${esc(sym)}" title="${on ? "Remove from" : "Add to"} watchlist" aria-pressed="${on}">${on ? "★" : "☆"}</button>`;
}
function watchBtn(sym) {
  const on = isWatched(sym);
  return `<button class="btn ghost sm" type="button" data-star="${esc(sym)}" data-star-full="1" aria-pressed="${on}">${on ? "★ Watching" : "☆ Watch"}</button>`;
}
function refreshStars() {
  $$("[data-star]").forEach((b) => {
    const on = isWatched(b.dataset.star);
    b.setAttribute("aria-pressed", on);
    if (b.dataset.starFull) b.textContent = on ? "★ Watching" : "☆ Watch";
    else { b.textContent = on ? "★" : "☆"; b.classList.toggle("on", on); b.title = `${on ? "Remove from" : "Add to"} watchlist`; }
  });
}

function addSymbols(raw) {
  const syms = String(raw).split(/[\s,;]+/).map(normSym).filter(Boolean);
  const bad = syms.filter((s) => !SYM_RE.test(s));
  const list = activeList();
  syms.filter((s) => SYM_RE.test(s) && !list.symbols.includes(s)).forEach((s) => list.symbols.push(s));
  list.symbols = list.symbols.slice(0, 150);
  saveWatch(); refreshStars(); refreshWatch();
  if (bad.length) toast("Skipped invalid tickers", bad.join(", "));
}
function toggleWatch(sym) {
  sym = normSym(sym);
  const list = activeList();
  list.symbols = list.symbols.includes(sym) ? list.symbols.filter((s) => s !== sym) : [...list.symbols, sym];
  saveWatch(); refreshStars(); renderWatch(); refreshWatch();
}

// ---- rendering
function renderListSelect() {
  $("#wlSelect").innerHTML = Object.entries(wl.lists).map(([id, l]) =>
    `<option value="${esc(id)}">${esc(l.name)} (${l.symbols.length})</option>`).join("");
  $("#wlSelect").value = wl.active;
  $("#wlDelete").disabled = Object.keys(wl.lists).length < 2;
}

function renderWatch() {
  renderListSelect();
  const rows = state.watch?.rows || {}, strat = wl.strategy;
  const syms = activeList().symbols;
  $("#wlEmpty").classList.toggle("hidden", syms.length > 0);
  $("#wlTable").classList.toggle("hidden", syms.length === 0);
  const alertCount = (s) => wl.alerts.filter((a) => a.symbol === s && a.enabled).length;
  $("#wlTable tbody").innerHTML = syms.map((s) => {
    const r = rows[s];
    const n = alertCount(s);
    const bell = `<button class="icon-btn ${n ? "on" : ""}" type="button" data-alert-for="${esc(s)}" title="${n ? `${n} active alert${n > 1 ? "s" : ""} · add another` : "Add an alert"}">🔔${n ? ` ${n}` : ""}</button>`;
    const remove = `<button class="icon-btn" type="button" data-remove="${esc(s)}" title="Remove ${esc(s)}" aria-label="Remove ${esc(s)}">✕</button>`;
    if (!r) {
      const missing = state.watch?.missing?.includes(s);
      return `<tr data-sym="${esc(s)}"><td><strong>${esc(s)}</strong></td><td colspan="10" class="muted small">${missing ? "No data found for this ticker" : `<span class="spinner"></span> Loading…`}</td><td class="num">${bell}</td><td>${remove}</td></tr>`;
    }
    const sc = r.scores?.[strat];
    const rating = sc == null ? "" : sc >= 75 ? "Strong" : sc >= 60 ? "Favorable" : sc >= 40 ? "Neutral" : sc >= 25 ? "Weak" : "Avoid";
    return `<tr data-sym="${esc(s)}">
      <td><strong>${esc(s)}</strong></td>
      <td class="num">${fmt(r.price)}</td><td class="num ${cls(r.change_pct)}">${pct(r.change_pct)}</td>
      <td class="num ${cls(r.ret_5d)}">${pct(r.ret_5d, 1)}</td><td class="num ${cls(r.ret_1m)}">${pct(r.ret_1m, 1)}</td>
      <td class="spark-cell">${spark(r.spark, (r.spark?.at(-1) ?? 0) >= (r.spark?.[0] ?? 0))}</td>
      <td class="num">${fmt(r.rsi14, 0)}</td><td class="num">${fmt(r.vol_ratio, 1)}</td><td class="num">${pct(r.pct_from_high, 1)}</td>
      <td>${sc == null ? "—" : `<span class="score"><span class="track"><span class="fill" style="display:block;width:${sc}%;background:${scoreColor(sc)}"></span></span>${fmt(sc, 0)}</span> <span class="tag ${rating}">${rating}</span>`}</td>
      <td>${earningsBadge(s)}</td>
      <td class="num">${bell}</td><td>${remove}</td></tr>`;
  }).join("");
  if (state.watch?.as_of) {
    const t = new Date(state.watch.as_of);
    $("#wlUpdated").textContent = `Updated ${t.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · refreshes every ${pollSeconds() / 60} min`;
  }
  renderAlerts();
}

function alertText(a) {
  const t = state.alertTypes?.[a.type];
  if (!t) return `${a.symbol}: unknown condition`;
  const v = !t.needs_value ? "" : t.unit === "$" ? ` $${fmt(a.value)}` : t.unit === "d" ? ` ${a.value} days` : ` ${a.value}${t.unit === "%" ? "%" : t.unit === "×" ? "×" : ""}`;
  const strat = t.needs_strategy ? ` (${state.strategies?.[a.strategy]?.name || a.strategy})` : "";
  return `${t.label}${strat}${v}`;
}
function fmtCurrent(a) {
  if (a.current == null) return "";
  const t = state.alertTypes?.[a.type];
  if (t?.unit === "$" || ["above_sma50", "below_sma50", "above_sma200", "below_sma200"].includes(a.type)) return `now $${fmt(a.current)}`;
  if (a.type.startsWith("score")) return `now ${fmt(a.current, 0)}`;
  if (t?.unit === "%") return `now ${pct(a.current, 1)}`;
  if (t?.unit === "×") return `now ${fmt(a.current, 1)}×`;
  if (t?.unit === "d") return `reports in ${a.current}d`;
  return `now ${fmt(a.current, 1)}`;
}

function renderAlerts() {
  const list = $("#alertList");
  if (!wl.alerts.length) {
    list.innerHTML = `<p class="muted small">No alerts yet. Alerts are checked every minute while this page is open.</p>`;
  } else {
    list.innerHTML = wl.alerts.map((a) => {
      const dot = !a.enabled ? "" : a.error ? "err" : a.last_state ? "met" : "armed";
      const status = !a.enabled ? (a.triggered_at ? `fired ${timeAgo(a.triggered_at)}` : "paused")
        : a.error ? a.error : a.last_state ? "condition met" : "watching";
      return `<div class="alert-row ${a.enabled ? "" : "off"}" data-id="${esc(a.id)}">
        <span class="dot ${dot}" title="${esc(status)}"></span>
        <span><span class="sym" data-open="${esc(a.symbol)}">${esc(a.symbol)}</span> · ${esc(alertText(a))}
          <span class="muted small">· ${a.repeat === "always" ? "every time" : "once"}</span></span>
        <span class="meta">${esc(a.enabled ? fmtCurrent(a) : "")} ${esc(status)}</span>
        <label class="switch" title="${a.enabled ? "Pause" : "Turn on"} this alert"><input type="checkbox" data-toggle-alert="${esc(a.id)}" ${a.enabled ? "checked" : ""} aria-label="Alert on"><span></span></label>
        <button class="icon-btn" type="button" data-delete-alert="${esc(a.id)}" title="Delete alert" aria-label="Delete alert">✕</button>
      </div>`;
    }).join("");
  }
  $("#alertLog").innerHTML = wl.log.length ? wl.log.map((l) => `<li><span><strong data-open="${esc(l.symbol)}" class="sym">${esc(l.symbol)}</strong> ${esc(l.text)}${l.current ? ` <span class="muted">(${esc(l.current)})</span>` : ""}</span><time>${new Date(l.time).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time></li>`).join("") : `<li class="muted">Nothing has fired yet.</li>`;
  $("#logCount").textContent = wl.log.length ? `(${wl.log.length})` : "";
  $("#alertBadge").textContent = wl.unread;
  $("#alertBadge").classList.toggle("hidden", !wl.unread);
}

function timeAgo(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
}

// ---- alert form
function renderAlertForm() {
  const types = Object.values(state.alertTypes || {});
  $("#alType").innerHTML = types.map((t) => `<option value="${t.key}">${esc(t.label)}</option>`).join("");
  $("#alStrategy").innerHTML = $("#strategy").innerHTML;
  $("#wlStrategy").innerHTML = $("#strategy").innerHTML;
  $("#wlStrategy").value = state.strategies[wl.strategy] ? wl.strategy : "composite";
  syncAlertForm();
  updateNotifyHint();
}
function syncAlertForm() {
  const t = state.alertTypes?.[$("#alType").value]; if (!t) return;
  $("#alValueWrap").classList.toggle("hidden", !t.needs_value);
  $("#alStrategyWrap").classList.toggle("hidden", !t.needs_strategy);
  $("#alUnit").textContent = t.unit === "$" ? "$" : "";
  $("#alValue").placeholder = t.unit === "%" ? "%" : t.unit === "×" ? "×" : t.unit === "d" ? "days" : "";
  const sym = normSym($("#alSymbol").value), row = state.watch?.rows?.[sym];
  if (t.default != null) $("#alValue").value = t.default;
  else if (t.unit === "$" && row?.price) $("#alValue").value = (row.price * (t.key === "price_above" ? 1.05 : 0.95)).toFixed(2);
  else $("#alValue").value = "";
}
$("#alType").onchange = syncAlertForm;
$("#alSymbol").onchange = () => { if (state.alertTypes?.[$("#alType").value]?.unit === "$") syncAlertForm(); };

function prefillAlert(sym) {
  $("#watchCard").classList.remove("collapsed");
  $("#alSymbol").value = sym;
  syncAlertForm();
  $("#alertForm").scrollIntoView({ behavior: "smooth", block: "center" });
  setTimeout(() => $("#alType").focus({ preventScroll: true }), 350);
}

async function updateNotifyHint() {
  const el = $("#notifyHint");
  if (!("Notification" in window)) { el.textContent = "This browser doesn't support desktop notifications; alerts will show on this page."; return; }
  const p = Notification.permission;
  el.innerHTML = p === "granted" ? "🔔 Desktop notifications are on. Alerts are checked every minute while this page is open (it can be in a background tab)."
    : p === "denied" ? "Desktop notifications are blocked for this site, so alerts will only show on this page. You can allow them in your browser's site settings."
    : `Alerts are checked every minute while this page is open. <a href="#" id="enableNotify">Turn on desktop notifications</a>`;
  $("#enableNotify")?.addEventListener("click", async (e) => { e.preventDefault(); await Notification.requestPermission(); updateNotifyHint(); });
}

$("#alertForm").onsubmit = async (e) => {
  e.preventDefault();
  const sym = normSym($("#alSymbol").value), t = state.alertTypes?.[$("#alType").value];
  if (!SYM_RE.test(sym)) { toast("Check the ticker", `"${$("#alSymbol").value}" isn't a valid symbol.`); return; }
  const value = t.needs_value ? parseFloat($("#alValue").value) : null;
  if (t.needs_value && !Number.isFinite(value)) { toast("Add a value", "This condition needs a number."); $("#alValue").focus(); return; }
  wl.alerts.unshift({ id: uid(), symbol: sym, type: t.key, value, strategy: t.needs_strategy ? $("#alStrategy").value : null,
    repeat: $("#alRepeat").value, enabled: true, last_state: null, triggered_at: null, created_at: new Date().toISOString() });
  saveWatch(); renderAlerts();
  if ("Notification" in window && Notification.permission === "default") { await Notification.requestPermission(); updateNotifyHint(); }
  refreshWatch();
};

// ---- polling + firing
function pollSeconds() {
  const st = state.watch?.status?.state || "";
  return st === "open" || st === "pre-market" || st === "after-hours" ? 60 : 300;
}
let watchTimer = 0, watchBusy = false;
async function refreshWatch() {
  clearTimeout(watchTimer);
  if (watchBusy) { watchTimer = setTimeout(refreshWatch, 2000); return; }
  watchBusy = true;
  try {
    const alerts = wl.alerts.filter((a) => a.enabled).map(({ id, symbol, type, value, strategy }) => ({ id, symbol, type, value, strategy }));
    const symbols = activeList().symbols;
    state.watch = (symbols.length || alerts.length)
      ? await api("/api/watch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbols, alerts }) })
      : { rows: {}, alerts: {}, missing: [], status: state.watch?.status };
    processAlerts(state.watch.alerts || {});
    renderWatch();
    loadWatchEarnings();
  } catch (e) {
    $("#wlUpdated").textContent = `Couldn't refresh: ${e.message}`;
  } finally {
    watchBusy = false;
    watchTimer = setTimeout(refreshWatch, pollSeconds() * 1000);
  }
}
document.addEventListener("visibilitychange", () => { if (!document.hidden && state.watch && Date.now() - new Date(state.watch.as_of || 0) > 60000) refreshWatch(); });

function processAlerts(results) {
  let changed = false;
  for (const a of wl.alerts) {
    if (!a.enabled) continue;
    const r = results[a.id];
    if (!r) continue;
    a.error = r.error || null;
    if (r.error) continue;
    a.current = r.current;
    if (r.met && a.last_state !== true) { fireAlert(a); changed = true; }
    if (a.last_state !== r.met) changed = true;
    a.last_state = r.met;
  }
  if (changed) saveWatch();
}

function fireAlert(a) {
  const text = alertText(a), current = fmtCurrent(a);
  a.triggered_at = new Date().toISOString();
  if (a.repeat === "once") a.enabled = false;
  wl.log.unshift({ time: a.triggered_at, symbol: a.symbol, text, current });
  wl.log = wl.log.slice(0, 100);
  wl.unread = (wl.unread || 0) + 1;
  toast(`🔔 ${a.symbol}: ${text}`, current, a.symbol);
  if ("Notification" in window && Notification.permission === "granted") {
    try {
      const n = new Notification(`${a.symbol}: ${text}`, { body: current || "Alert triggered", tag: a.id });
      n.onclick = () => { window.focus(); openTicker(a.symbol); n.close(); };
    } catch {}
  }
}

function toast(title, body = "", sym = null) {
  const el = document.createElement("div");
  el.className = "toast"; el.setAttribute("role", "status");
  el.innerHTML = `<strong>${esc(title)}</strong><button class="icon-btn" type="button" aria-label="Dismiss">✕</button>
    ${body ? `<span class="t-body">${esc(body)}</span>` : ""}${sym ? `<button class="t-open" type="button">Open ${esc(sym)} →</button>` : ""}`;
  $(".icon-btn", el).onclick = () => el.remove();
  if (sym) $(".t-open", el).onclick = () => { openTicker(sym); el.remove(); };
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), 15000);
}

// ---- list management + events
$("#wlSelect").onchange = () => { wl.active = $("#wlSelect").value; saveWatch(); refreshStars(); renderWatch(); refreshWatch(); };
$("#wlNew").onclick = () => {
  const name = prompt("Name for the new watchlist:", "New watchlist"); if (!name?.trim()) return;
  const id = uid(); wl.lists[id] = { name: name.trim().slice(0, 60), symbols: [] }; wl.active = id;
  saveWatch(); refreshStars(); renderWatch(); $("#wlAddInput").focus();
};
$("#wlRename").onclick = () => {
  const name = prompt("Rename watchlist:", activeList().name); if (!name?.trim()) return;
  activeList().name = name.trim().slice(0, 60); saveWatch(); renderListSelect();
};
$("#wlDelete").onclick = () => {
  if (Object.keys(wl.lists).length < 2) return;
  if (!confirm(`Delete the watchlist "${activeList().name}"? Its alerts are kept.`)) return;
  delete wl.lists[wl.active]; wl.active = Object.keys(wl.lists)[0];
  saveWatch(); refreshStars(); renderWatch(); refreshWatch();
};
$("#wlAddForm").onsubmit = (e) => { e.preventDefault(); const v = $("#wlAddInput").value; $("#wlAddInput").value = ""; if (v.trim()) addSymbols(v); };
$("#wlStrategy").onchange = () => { wl.strategy = $("#wlStrategy").value; saveWatch(); renderWatch(); };
$("#clearLog").onclick = () => { wl.log = []; wl.unread = 0; saveWatch(); renderAlerts(); };
$(".alert-log").addEventListener("toggle", (e) => { if (e.target.open && wl.unread) { wl.unread = 0; saveWatch(); renderAlerts(); } });

$("#wlExport").onclick = () => {
  downloadFile(`watchlists-${today()}.json`, JSON.stringify({ ...wl, exported_at: new Date().toISOString() }, null, 2), "application/json");
};
$("#wlImport").onchange = async (e) => {
  const file = e.target.files[0]; e.target.value = ""; if (!file) return;
  try {
    const d = JSON.parse(await file.text());
    if (!validWatch(d)) throw new Error("That file isn't a watchlist backup.");
    if (!confirm(`Replace your current watchlists and alerts with "${file.name}"?`)) return;
    wl = sanitizeWatch(d); saveWatch(); refreshStars(); renderAlertForm(); renderWatch(); refreshWatch();
    toast("Watchlists imported", `${Object.keys(wl.lists).length} lists · ${wl.alerts.length} alerts`);
  } catch (err) { toast("Import failed", err.message); }
};

$("#askWlBtn").onclick = () => {
  const rows = state.watch?.rows || {}, strat = state.strategies[wl.strategy]?.name || wl.strategy;
  const lines = activeList().symbols.map((s) => { const r = rows[s]; return r
    ? `${s}: $${fmt(r.price)}, day ${pct(r.change_pct)}, 1M ${pct(r.ret_1m, 1)}, RSI ${fmt(r.rsi14, 0)}, ${pct(r.pct_from_high, 1)} from 52w high, ${strat} score ${fmt(r.scores?.[wl.strategy], 0)}`
    : s; }).join("\n");
  const al = wl.alerts.filter((a) => a.enabled).map((a) => `${a.symbol}: ${alertText(a)}`).join("; ");
  sendChat(`Here's my watchlist "${activeList().name}":\n${lines}${al ? `\n\nActive alerts: ${al}` : ""}\n\nGive me a quick read on each name, what stands out (strongest and weakest setups, anything near key levels or with unusual moves), relevant news or catalysts, and any alerts you think I should add.`);
};

// One delegated handler for stars, bells, remove buttons, alert toggles and symbol links.
// Capture phase so a star click inside a table row doesn't also open the ticker.
document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-star],[data-alert-for],[data-remove],[data-delete-alert],[data-open]");
  if (!el) return;
  e.stopPropagation();
  if (el.dataset.star) toggleWatch(el.dataset.star);
  else if (el.dataset.alertFor) prefillAlert(el.dataset.alertFor);
  else if (el.dataset.remove) toggleWatch(el.dataset.remove);
  else if (el.dataset.deleteAlert) { wl.alerts = wl.alerts.filter((a) => a.id !== el.dataset.deleteAlert); saveWatch(); renderWatch(); }
  else if (el.dataset.open) openTicker(el.dataset.open);
}, true);
document.addEventListener("change", (e) => {
  const id = e.target.dataset?.toggleAlert; if (!id) return;
  const a = wl.alerts.find((x) => x.id === id); if (!a) return;
  a.enabled = e.target.checked; a.last_state = null; a.error = null;
  saveWatch(); renderAlerts(); if (a.enabled) refreshWatch();
});
$("#wlTable tbody").addEventListener("click", (e) => { const tr = e.target.closest("tr[data-sym]"); if (tr) openTicker(tr.dataset.sym); });

/* ---------------- Compare ---------------- */
// Validated categorical slots (dark surface), assigned in fixed order. A ticker keeps its
// slot while it stays in the comparison, so removing one never repaints the others.
const SERIES_COLORS = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];
const CMP_MAX = 8;
const cmp = (() => {
  const d = store.get("compare") || {};
  const symbols = Array.isArray(d.symbols) ? d.symbols.map(normSym).filter((s) => SYM_RE.test(s)).slice(0, CMP_MAX) : ["AAPL", "MSFT", "NVDA"];
  const slots = {}; symbols.forEach((s, i) => (slots[s] = Number.isInteger(d.slots?.[s]) ? d.slots[s] : i));
  return { symbols, slots, period: d.period || "1y", bench: d.bench || "SPY", mode: d.mode === "relative" ? "relative" : "performance" };
})();
const saveCmp = () => store.set("compare", { symbols: cmp.symbols, slots: cmp.slots, period: cmp.period, bench: cmp.bench, mode: cmp.mode });
const colorOf = (s) => SERIES_COLORS[cmp.slots[s] ?? 0];

function cmpAdd(sym) {
  sym = normSym(sym);
  if (!SYM_RE.test(sym)) { toast("Check the ticker", `"${sym}" isn't a valid symbol.`); return false; }
  if (cmp.symbols.includes(sym)) return false;
  if (cmp.symbols.length >= CMP_MAX) { toast("Compare is full", `Remove a ticker first; up to ${CMP_MAX} at a time.`); return false; }
  const used = new Set(cmp.symbols.map((s) => cmp.slots[s]));
  cmp.slots[sym] = [...Array(CMP_MAX).keys()].find((i) => !used.has(i));
  cmp.symbols.push(sym);
  return true;
}
function cmpRemove(sym) { cmp.symbols = cmp.symbols.filter((s) => s !== sym); delete cmp.slots[sym]; }
function cmpSet(symbols) {
  cmp.symbols = []; cmp.slots = {};
  symbols.slice(0, CMP_MAX).forEach(cmpAdd);
}

function renderChips() {
  const box = $("#cmpChips"), input = $("#cmpInput");
  $$(".chip", box).forEach((c) => c.remove());
  cmp.symbols.forEach((s) => {
    const c = document.createElement("span"); c.className = "chip";
    c.innerHTML = `<span class="swatch-dot" style="background:${colorOf(s)}"></span>${esc(s)}<button type="button" aria-label="Remove ${esc(s)}" data-cmp-remove="${esc(s)}">✕</button>`;
    box.insertBefore(c, input);
  });
  input.placeholder = cmp.symbols.length >= CMP_MAX ? "Max 8 tickers" : cmp.symbols.length ? "Add ticker…" : "Type a ticker and press Enter…";
  $("#cmpBench").value = cmp.bench;
  $$("#cmpPeriod button").forEach((b) => b.classList.toggle("on", b.dataset.p === cmp.period));
  $$("#cmpMode button").forEach((b) => b.classList.toggle("on", b.dataset.mode === cmp.mode));
}

$("#cmpInput").addEventListener("keydown", (e) => {
  const input = e.target;
  if ((e.key === "Enter" || e.key === "," || e.key === " ") && input.value.trim()) {
    e.preventDefault();
    input.value.split(/[\s,;]+/).filter(Boolean).forEach(cmpAdd);
    input.value = ""; saveCmp(); renderChips();
  } else if (e.key === "Enter") {
    e.preventDefault(); runCompare();
  } else if (e.key === "Backspace" && !input.value && cmp.symbols.length) {
    cmpRemove(cmp.symbols.at(-1)); saveCmp(); renderChips();
  }
});
$("#cmpChips").addEventListener("click", (e) => {
  const rm = e.target.closest("[data-cmp-remove]");
  if (rm) { cmpRemove(rm.dataset.cmpRemove); saveCmp(); renderChips(); if (state.compare) runCompare(); }
  else $("#cmpInput").focus();
});
$("#cmpForm").onsubmit = (e) => {
  e.preventDefault();
  const v = $("#cmpInput").value.trim();
  if (v) { v.split(/[\s,;]+/).filter(Boolean).forEach(cmpAdd); $("#cmpInput").value = ""; renderChips(); }
  runCompare();
};
$("#cmpBench").onchange = () => { cmp.bench = $("#cmpBench").value; saveCmp(); if (state.compare) runCompare(); };
$$("#cmpPeriod button").forEach((b) => (b.onclick = () => { cmp.period = b.dataset.p; saveCmp(); renderChips(); runCompare(); }));
$$("#cmpMode button").forEach((b) => (b.onclick = () => { cmp.mode = b.dataset.mode; saveCmp(); renderChips(); if (state.compare) renderCompareChart(state.compare); }));

function openCompare(symbols) {
  if (symbols) cmpSet(symbols);
  saveCmp(); renderChips();
  $("#compareCard").classList.remove("collapsed");
  $("#compareCard").scrollIntoView({ behavior: "smooth", block: "start" });
  runCompare();
}

let cmpSeq = 0;
async function runCompare() {
  if (!cmp.symbols.length) { toast("Nothing to compare", "Add at least one ticker."); return; }
  const seq = ++cmpSeq;
  const btn = $("#cmpForm button[type=submit]");
  btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Comparing…`;
  try {
    const res = await api("/api/compare", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbols: cmp.symbols, period: cmp.period, benchmark: cmp.bench }) });
    if (seq !== cmpSeq) return;  // a newer request superseded this one
    state.compare = res;
    if (res.missing.length) { res.missing.forEach(cmpRemove); saveCmp(); renderChips(); toast("No data for some tickers", res.missing.join(", ")); }
    renderCompare(res);
  } catch (e) {
    if (seq === cmpSeq) toast("Compare failed", e.message);
  } finally {
    if (seq === cmpSeq) { btn.disabled = false; btn.innerHTML = "⇄ Compare"; }
  }
}

// Spread end-of-line labels apart (in data units) so they don't overlap.
function endLabels(items, span, fmtV) {
  const sorted = [...items].sort((a, b) => b.y - a.y);
  let prev = null;
  return sorted.map((e) => {
    let yshift = 0;
    if (prev && prev.y - e.y < span * 0.055) yshift = prev.yshift - 15;
    prev = { y: e.y, yshift };
    return { x: e.x, y: e.y, xanchor: "left", xshift: 6, yshift, showarrow: false,
      text: `<b>${esc(e.label)}</b> ${fmtV(e.y)}`, font: { size: 11, color: "#e4e8f0" } };
  });
}

function renderCompareChart(r) {
  const relative = cmp.mode === "relative";
  const x = r.dates, data = relative ? r.relative : r.performance;
  const benchLabel = r.benchmark === "sector" ? "sector ETF" : r.benchmark;
  const traces = r.symbols.map((s) => ({
    x, y: data[s], name: s, mode: "lines", line: { color: colorOf(s), width: 2 },
    hovertemplate: `%{y:+.1f}%<extra>${esc(s)}</extra>`,
  }));
  const labelItems = r.symbols.map((s) => ({ x: x.at(-1), y: data[s].at(-1), label: s }));
  // Performance mode with one benchmark: show it as a neutral reference line (not a series color).
  const benches = Object.keys(r.benchmark_performance);
  if (!relative && benches.length === 1 && !r.symbols.includes(benches[0])) {
    const b = benches[0];
    traces.push({ x, y: r.benchmark_performance[b], name: `${b} (benchmark)`, mode: "lines",
      line: { color: "#8892a6", width: 1.5, dash: "dash" }, hovertemplate: `%{y:+.1f}%<extra>${esc(b)}</extra>` });
    labelItems.push({ x: x.at(-1), y: r.benchmark_performance[b].at(-1), label: b });
  }
  const allY = traces.flatMap((t) => t.y.filter((v) => v != null));
  const span = (Math.max(...allY) - Math.min(...allY)) || 1;
  const grid = "rgba(35,43,59,.8)";
  Plotly.react("cmpChart", traces, {
    paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)", font: { color: "#8892a6", family: "Inter" },
    margin: { l: 55, r: 110, t: 36, b: 30 }, hovermode: "x unified",
    hoverlabel: { bgcolor: "#171d2a", bordercolor: "#232b3b", font: { color: "#e4e8f0" } },
    legend: { orientation: "h", x: 0, y: 1.12, font: { size: 11, color: "#e4e8f0" } },
    xaxis: { gridcolor: grid, type: "date", range: [x[0], x.at(-1)] },
    yaxis: { gridcolor: grid, ticksuffix: "%", zeroline: true, zerolinecolor: "#5a6478", zerolinewidth: 1.5,
      title: { text: relative ? `Out/under-performance vs ${benchLabel}` : "Return since start", font: { size: 11 } } },
    annotations: endLabels(labelItems, span, (v) => pct(v, 1)),
  }, { displaylogo: false, responsive: true, modeBarButtonsToRemove: ["lasso2d", "select2d"] });
}

// Diverging scale for correlation: red (-1) <- gray (0) -> blue (+1), dark-surface steps.
function divergingColor(v) {
  const mid = [0x38, 0x38, 0x35], pos = [0x39, 0x87, 0xe5], neg = [0xe6, 0x67, 0x67];
  const t = Math.min(1, Math.abs(v)), end = v >= 0 ? pos : neg;
  const c = mid.map((m, i) => Math.round(m + (end[i] - m) * t));
  return `rgb(${c.join(",")})`;
}

function renderCompare(r) {
  $("#cmpOut").classList.remove("hidden");
  renderCompareChart(r);
  $("#cmpNotes").textContent = [
    ...r.notes,
    r.benchmark === "sector" ? "Sector mode: each stock is measured against its own SPDR sector ETF; ETFs, indices and crypto use SPY." : "",
  ].filter(Boolean).join(" ");
  const st = r.stats;
  $("#cmpStats tbody").innerHTML = r.symbols.map((s) => { const v = st[s]; return `<tr>
    <td><span class="series" data-open="${esc(s)}"><span class="swatch" style="border-top-color:${colorOf(s)}"></span>${esc(s)}</span></td>
    <td class="num">${fmt(v.price)}</td><td class="num ${cls(v.total_return)}">${pct(v.total_return, 1)}</td>
    <td class="muted small">${esc(v.benchmark)}</td><td class="num ${cls(v.benchmark_return)}">${pct(v.benchmark_return, 1)}</td>
    <td class="num ${cls(v.excess)}"><strong>${pct(v.excess, 1)}</strong></td>
    <td class="num">${v.volatility == null ? "—" : fmt(v.volatility, 1) + "%"}</td><td class="num down">${fmt(v.max_drawdown, 1)}%</td>
    <td class="num">${fmt(v.beta, 2)}</td><td class="num">${fmt(v.correlation, 2)}</td><td class="num">${fmt(v.rsi14, 0)}</td>
    <td class="num up">${pct(v.best_day, 1)}</td><td class="num down">${pct(v.worst_day, 1)}</td></tr>`; }).join("");

  const c = r.correlation;
  $("#cmpCorrWrap").classList.toggle("hidden", !c);
  if (c) {
    $("#cmpCorr").innerHTML = `<table class="corr"><thead><tr><th></th>${c.symbols.map((s) => `<th>${esc(s)}</th>`).join("")}</tr></thead><tbody>${
      c.matrix.map((row, i) => `<tr><th>${esc(c.symbols[i])}</th>${row.map((v, j) => i === j
        ? `<td class="diag">—</td>`
        : `<td style="background:${divergingColor(v)}" title="${esc(c.symbols[i])} vs ${esc(c.symbols[j])}: ${fmt(v, 2)}">${fmt(v, 2)}</td>`).join("")}</tr>`).join("")
    }</tbody></table>`;
  }
}

$("#cmpCsvStats").onclick = () => {
  const r = state.compare; if (!r) return;
  const head = ["Ticker", "Price", "Return %", "Benchmark", "Benchmark Return %", "Excess %", "Volatility %", "Max Drawdown %", "Beta", "Correlation", "RSI 14", "Best Day %", "Worst Day %", "Period"];
  downloadCSV(`compare-${r.symbols.map(slug).join("-")}-${r.period}-${today()}`, head, r.symbols.map((s) => { const v = r.stats[s];
    return [s, v.price, v.total_return, v.benchmark, v.benchmark_return, v.excess, v.volatility, v.max_drawdown, v.beta, v.correlation, v.rsi14, v.best_day, v.worst_day, r.period]; }));
};
$("#cmpCsvSeries").onclick = () => {
  const r = state.compare; if (!r) return;
  const b = Object.keys(r.benchmark_performance);
  downloadCSV(`compare-${r.symbols.map(slug).join("-")}-${r.period}-daily-${today()}`,
    ["Date", ...r.symbols.map((s) => `${s} Return %`), ...b.map((s) => `${s} (benchmark) Return %`), ...r.symbols.map((s) => `${s} vs Benchmark %`)],
    r.dates.map((d, i) => [d, ...r.symbols.map((s) => r.performance[s][i]), ...b.map((s) => r.benchmark_performance[s][i]), ...r.symbols.map((s) => r.relative[s][i])]));
};
$("#askCmpBtn").onclick = () => {
  const r = state.compare; if (!r) return;
  const lines = r.symbols.map((s) => { const v = r.stats[s]; return `${s}: return ${pct(v.total_return, 1)} vs ${v.benchmark} ${pct(v.benchmark_return, 1)} (excess ${pct(v.excess, 1)}), vol ${fmt(v.volatility, 1)}%, max DD ${fmt(v.max_drawdown, 1)}%, beta ${fmt(v.beta, 2)}, corr ${fmt(v.correlation, 2)}, RSI ${fmt(v.rsi14, 0)}`; }).join("\n");
  const corr = r.correlation ? "\n\nCorrelation matrix (" + r.correlation.symbols.join(", ") + "):\n" + r.correlation.matrix.map((row, i) => `${r.correlation.symbols[i]}: ${row.map((v) => fmt(v, 2)).join(", ")}`).join("\n") : "";
  sendChat(`Compare these over ${r.period.toUpperCase()} (benchmark: ${r.benchmark === "sector" ? "each stock's sector ETF" : r.benchmark}):\n${lines}${corr}\n\nWhich ones are showing real relative strength versus just high beta? What explains the leaders and laggards (pull news or fundamentals if useful)? How diversified is this group based on the correlations, and what are the key risks?`);
};

// Entry points from other sections
$("#wlCompare").onclick = () => {
  const syms = activeList().symbols;
  if (!syms.length) { toast("Watchlist is empty", "Add some tickers first."); return; }
  if (syms.length > CMP_MAX) toast("Comparing the first 8", `This list has ${syms.length} tickers; Compare shows up to ${CMP_MAX}.`);
  openCompare(syms.slice(0, CMP_MAX));
};
$("#scanCompare").onclick = () => { if (state.scan) openCompare(state.scan.top.slice(0, 5).map((r) => r.symbol)); };
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-compare]"); if (!b) return;
  if (!cmp.symbols.includes(normSym(b.dataset.compare)) && !cmpAdd(b.dataset.compare)) return;
  openCompare();
});

/* ---------------- Calendar ---------------- */
const calState = (() => { const d = store.get("calendar") || {};
  return { tab: ["economic", "earnings", "watch"].includes(d.tab) ? d.tab : "economic", days: [7, 14, 30].includes(d.days) ? d.days : 7,
    impact: d.impact || "medium", cap: d.cap || "10", mine: !!d.mine }; })();
const saveCal = () => store.set("calendar", calState);
const SESSION_LABEL = { before_open: "☀ Before open", after_close: "☾ After close", during: "◷ During day", unknown: "· Time TBA" };
const IMPACT_LABEL = { high: "▲▲ High", medium: "▲ Medium", low: "Low" };
let calSeq = 0;

function dayHeader(iso) {
  const d = new Date(`${iso}T12:00:00`), today = new Date(); today.setHours(12, 0, 0, 0);
  const diff = Math.round((d - today) / 86400000);
  const rel = diff === 0 ? "Today" : diff === 1 ? "Tomorrow" : diff === -1 ? "Yesterday" : "";
  return `<div class="cal-day"><span>${d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" })}</span><span class="muted">${rel}</span></div>`;
}
const groupBy = (items, key) => items.reduce((m, x) => ((m[x[key]] ||= []).push(x), m), {});
const capFmt = (v) => (v == null ? "—" : "$" + big(v));
const numOrDash = (v, d = 2) => (v == null ? "—" : fmt(v, d));

function syncCalControls() {
  $$("#calTabs button").forEach((b) => { const on = b.dataset.tab === calState.tab; b.classList.toggle("on", on); b.setAttribute("aria-selected", on); });
  $$("#calRange button").forEach((b) => b.classList.toggle("on", +b.dataset.days === calState.days));
  $$(".cal-opt").forEach((l) => l.classList.toggle("hidden", l.dataset.for !== calState.tab));
  $("#calImpact").value = calState.impact; $("#calCap").value = calState.cap; $("#calMine").checked = calState.mine;
  $("#calRange").classList.toggle("hidden", calState.tab === "watch");
}

async function loadCalendar() {
  syncCalControls();
  const seq = ++calSeq, body = $("#calBody");
  if (calState.tab === "watch") { renderWatchCalendar(); return; }
  if (!state.calendar || state.calendar.days !== calState.days || +state.calendar.min_cap !== +calState.cap) {
    body.innerHTML = `<div class="loading"><span class="spinner"></span> Loading calendar…</div>`;
    try {
      const res = await api(`/api/calendar?days=${calState.days}&min_cap=${calState.cap}`);
      if (seq !== calSeq) return;
      state.calendar = res;
    } catch (e) { if (seq === calSeq) body.innerHTML = `<p class="msg error" style="padding:12px">${esc(e.message)}</p>`; return; }
  }
  renderCalendar();
}

function renderCalendar() {
  const c = state.calendar, body = $("#calBody");
  if (!c) return;
  const errs = c.errors?.length ? `<p class="muted small" style="padding:8px 12px">${esc(c.errors.join(" "))}</p>` : "";
  if (calState.tab === "economic") {
    const levels = { high: ["high"], medium: ["high", "medium"], all: ["high", "medium", "low"] }[calState.impact];
    const items = c.economic.filter((e) => levels.includes(e.impact));
    if (!items.length) { body.innerHTML = errs + `<p class="empty muted small">No ${calState.impact === "all" ? "" : "high-impact "}US economic events in this range.</p>`; return; }
    const head = `<div class="cal-row econ head"><span>Time</span><span>Impact</span><span>Event</span><span>Period</span><span class="num">Actual</span><span class="num">Expected</span><span class="num">Previous</span></div>`;
    body.innerHTML = errs + Object.entries(groupBy(items, "date")).map(([d, rows]) => dayHeader(d) + head + rows.map((e) => `
      <div class="cal-row econ"><span class="time">${esc(e.time_et || "—")}</span><span class="impact ${e.impact}">${IMPACT_LABEL[e.impact]}</span>
        <span>${esc(e.event)}</span><span class="muted small">${esc(e.period || "")}</span>
        <span class="num">${e.actual == null ? "—" : `<strong>${fmt(e.actual, 2)}</strong>`}</span><span class="num">${numOrDash(e.expected)}</span><span class="num muted">${numOrDash(e.previous)}</span></div>`).join("")).join("");
  } else {
    const mine = new Set(Object.values(wl.lists).flatMap((l) => l.symbols));
    const items = c.earnings.filter((e) => !calState.mine || mine.has(e.symbol));
    if (!items.length) { body.innerHTML = errs + `<p class="empty muted small">${calState.mine ? "None of your watchlist stocks report in this range at this company size." : "No earnings reports found in this range."}</p>`; return; }
    const head = `<div class="cal-row earn head"><span>When</span><span>Symbol</span><span>Company</span><span class="num">Mkt cap</span><span class="num">EPS est.</span><span class="num">Reported</span></div>`;
    body.innerHTML = errs + `<p class="muted small" style="padding:6px 12px;margin:0">${items.length} reports · click a row to open the chart · ★ = on your watchlists</p>` +
      Object.entries(groupBy(items, "date")).map(([d, rows]) => dayHeader(d) + head + rows.map((e) => `
      <div class="cal-row earn ${mine.has(e.symbol) ? "mine" : ""}" data-sym="${esc(e.symbol)}">
        <span class="session">${SESSION_LABEL[e.session]}</span>
        <span>${starBtn(e.symbol)}<span class="sym">${esc(e.symbol)}</span></span>
        <span class="co" title="${esc(e.company || "")}">${esc(e.company || "")}</span>
        <span class="num">${capFmt(e.market_cap)}</span><span class="num">${numOrDash(e.eps_estimate)}</span>
        <span class="num">${e.eps_reported == null ? `<span class="muted">—</span>` : `${fmt(e.eps_reported, 2)} <span class="${cls(e.surprise_pct)}">${pct(e.surprise_pct, 1)}</span>`}</span></div>`).join("")).join("");
  }
}

function renderWatchCalendar() {
  const body = $("#calBody"), list = state.watchEarnings;
  if (!list) { body.innerHTML = `<div class="loading"><span class="spinner"></span> Checking report dates…</div>`; loadWatchEarnings(true); return; }
  const syms = new Set(Object.values(wl.lists).flatMap((l) => l.symbols));
  const items = list.filter((e) => syms.has(e.symbol));
  if (!items.length) { body.innerHTML = `<p class="empty muted small">No upcoming earnings found for your watchlist tickers in the next 4 months (ETFs, indices and crypto don't report).</p>`; return; }
  body.innerHTML = `<div class="cal-row watch head"><span>Symbol</span><span>Report date</span><span>When</span><span class="num">EPS est.</span><span class="num">Revenue est.</span></div>` +
    items.map((e) => `<div class="cal-row watch" data-sym="${esc(e.symbol)}"><span class="sym">${esc(e.symbol)}</span>
      <span>${new Date(`${e.date}T12:00:00`).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: "numeric" })}</span>
      <span>${e.days_until <= 7 ? `<span class="soon">in ${e.days_until}d</span>` : `<span class="later">in ${e.days_until} days</span>`}</span>
      <span class="num">${numOrDash(e.eps_estimate)}</span><span class="num">${e.revenue_estimate == null ? "—" : "$" + big(e.revenue_estimate)}</span></div>`).join("");
}

// Watchlist earnings: next report per ticker (all lists), refetched only when the set of symbols changes.
let watchEarnKey = "";
async function loadWatchEarnings(force = false) {
  const syms = [...new Set(Object.values(wl.lists).flatMap((l) => l.symbols))].sort();
  const key = syms.join(",");
  if (!force && key === watchEarnKey) return;
  watchEarnKey = key;
  try {
    const res = await api("/api/calendar/symbols", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbols: syms }) });
    if (key !== watchEarnKey) return;
    state.watchEarnings = res.upcoming;
    renderWatch();
    if (calState.tab === "watch") renderWatchCalendar();
  } catch { watchEarnKey = ""; }
}
function earningsBadge(sym) {
  const e = state.watchEarnings?.find((x) => x.symbol === sym);
  if (!e) return `<span class="muted small">—</span>`;
  const label = new Date(`${e.date}T12:00:00`).toLocaleDateString([], { month: "short", day: "numeric" });
  return e.days_until <= 7 ? `<span class="soon" title="Reports ${esc(e.date)}">${label} · ${e.days_until}d</span>` : `<span class="later" title="Reports ${esc(e.date)}">${label}</span>`;
}

$$("#calTabs button").forEach((b) => (b.onclick = () => { calState.tab = b.dataset.tab; saveCal(); loadCalendar(); }));
$$("#calRange button").forEach((b) => (b.onclick = () => { calState.days = +b.dataset.days; saveCal(); loadCalendar(); }));
$("#calImpact").onchange = () => { calState.impact = $("#calImpact").value; saveCal(); renderCalendar(); };
$("#calCap").onchange = () => { calState.cap = $("#calCap").value; saveCal(); loadCalendar(); };
$("#calMine").onchange = () => { calState.mine = $("#calMine").checked; saveCal(); renderCalendar(); };
$("#calBody").addEventListener("click", (e) => { const r = e.target.closest(".cal-row[data-sym]"); if (r) openTicker(r.dataset.sym); });
$("#askCalBtn").onclick = () => sendChat(`What's on the calendar for the next ${calState.days} days? Walk me through the most important US economic releases (what's expected and why each matters) and the biggest earnings reports, especially any for stocks on my watchlist (${[...new Set(Object.values(wl.lists).flatMap((l) => l.symbols))].join(", ")}). How could these events move the market and which sectors are most exposed?`);

// ---- ticker earnings panel + chart markers
let tickerEarnSeq = 0;
async function loadTickerEarnings(sym) {
  const seq = ++tickerEarnSeq, box = $("#earningsBox");
  box.innerHTML = `<span class="muted"><span class="spinner"></span> Loading…</span>`;
  try {
    const e = await api(`/api/ticker/${encodeURIComponent(sym)}/earnings`);
    if (seq !== tickerEarnSeq) return;
    state.tickerEarnings = e;
    renderTickerEarnings(e);
    markEarningsOnChart(e);
  } catch { if (seq === tickerEarnSeq) box.innerHTML = `<span class="muted">Unavailable</span>`; }
}
function renderTickerEarnings(e) {
  const box = $("#earningsBox");
  if (!e.next && !e.history.length) { box.innerHTML = `<span class="muted">No earnings data (ETFs, indices and crypto don't report).</span>`; return; }
  const n = e.next;
  box.innerHTML = (n ? `<div class="next">Next report <strong>${new Date(`${n.date}T12:00:00`).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: "numeric" })}</strong>
      ${n.days_until <= 7 ? `<span class="soon">in ${n.days_until}d</span>` : `<span class="later">in ${n.days_until} days</span>`}
      <div class="muted small">EPS est. ${numOrDash(n.eps_estimate)} · Revenue est. ${n.revenue_estimate == null ? "—" : "$" + big(n.revenue_estimate)}</div></div>` : "") +
    `<div class="kpis"><span>Beat rate <b>${e.beat_rate == null ? "—" : fmt(e.beat_rate, 0) + "%"}</b></span><span>Avg surprise <b>${pct(e.avg_surprise, 1)}</b></span>
      <span title="Average size of the stock's move the session after a report">Typical move <b>±${e.avg_abs_move == null ? "—" : fmt(e.avg_abs_move, 1)}%</b></span></div>` +
    (e.history.length ? `<table><thead><tr><th>Reported</th><th class="num">Est.</th><th class="num">Actual</th><th class="num">Surprise</th><th class="num">Next-day move</th></tr></thead><tbody>${
      e.history.map((h) => `<tr><td>${esc(h.date)}</td><td class="num">${numOrDash(h.eps_estimate)}</td><td class="num">${numOrDash(h.eps_reported)}</td>
        <td class="num ${cls(h.surprise_pct)}">${pct(h.surprise_pct, 1)}</td><td class="num ${cls(h.reaction_pct)}">${pct(h.reaction_pct, 1)}</td></tr>`).join("")}</tbody></table>` : "");
}
function markEarningsOnChart(e) {
  const el = $("#chart"); if (!el.data || !e.history.length || !state.tickerData) return;
  const dates = state.tickerData.ohlcv.dates, first = dates[0].slice(0, 10), last = dates.at(-1).slice(0, 10);
  const inRange = e.history.filter((h) => h.date >= first && h.date <= last);
  const base = (el.layout.shapes || []).filter((s) => !s.name?.startsWith("earn"));
  Plotly.relayout(el, {
    shapes: [...base, ...inRange.map((h, i) => ({ name: `earn${i}`, type: "line", xref: "x", yref: "paper", x0: h.date, x1: h.date, y0: 0.46, y1: 1,
      line: { color: "rgba(250,178,25,.45)", width: 1, dash: "dot" } }))],
    annotations: inRange.map((h) => ({ x: h.date, xref: "x", yref: "paper", y: 1, yanchor: "bottom", showarrow: false, text: "E",
      font: { size: 10, color: "#fab219" }, hovertext: `Earnings ${h.date}: EPS ${numOrDash(h.eps_reported)} vs ${numOrDash(h.eps_estimate)} est. (${pct(h.surprise_pct, 1)}), next day ${pct(h.reaction_pct, 1)}` })),
  });
}

/* ---------------- Portfolio ---------------- */
// Holdings live only in this browser (localStorage); the server just computes the analysis.
const pf = (() => {
  const d = store.get("portfolio") || {};
  const holdings = Array.isArray(d.holdings) ? d.holdings.filter((h) => h && SYM_RE.test(normSym(h.symbol)) && +h.shares > 0)
    .map((h) => ({ symbol: normSym(h.symbol), shares: +h.shares, cost: h.cost == null || h.cost === "" || !(+h.cost >= 0) ? null : +h.cost })) : [];
  return { holdings, cash: +d.cash > 0 ? +d.cash : 0, period: ["6mo", "1y", "2y", "3y"].includes(d.period) ? d.period : "1y" };
})();
const savePf = () => store.set("portfolio", pf);

function pfMerge(items) {
  for (const it of items) {
    const ex = pf.holdings.find((h) => h.symbol === it.symbol);
    if (!ex) { pf.holdings.push({ ...it }); continue; }
    ex.cost = ex.cost != null && it.cost != null ? (ex.cost * ex.shares + it.cost * it.shares) / (ex.shares + it.shares) : (ex.cost ?? it.cost ?? null);
    ex.shares += it.shares;
  }
}

// ---- text / CSV import
function parseNum(s) {
  if (s == null) return NaN;
  s = String(s).trim();
  const neg = /^\(.*\)$/.test(s) || /^-/.test(s);
  const n = parseFloat(s.replace(/[()$€£,\s+\-]/g, ""));
  return neg ? -n : n;
}
function parseDelimited(text) {
  const firstLine = text.split(/\r?\n/).find((l) => l.trim()) || "";
  const delim = firstLine.includes("\t") ? "\t" : firstLine.includes(",") ? "," : firstLine.includes(";") ? ";" : null;
  if (!delim) return text.split(/\r?\n/).map((l) => l.trim().split(/\s+/)).filter((r) => r[0]);
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { f += '"'; i++; } else if (c === '"') q = false; else f += c; }
    else if (c === '"') q = true; else if (c === delim) { row.push(f.trim()); f = ""; }
    else if (c === "\n") { row.push(f.trim()); rows.push(row); row = []; f = ""; } else if (c !== "\r") f += c;
  }
  if (f.trim() || row.length) { row.push(f.trim()); rows.push(row); }
  return rows.filter((r) => r.some((x) => x));
}
function parseHoldingsText(text) {
  text = text.replace(/^﻿/, "");
  let rows = parseDelimited(text);
  const headerAt = rows.findIndex((r) => r.some((c) => /^(symbol|ticker|instrument|security symbol|symbol\/cusip)$/i.test(c.trim())));
  // Simple pasted lists (no header) may mix "AAPL, 50, 150", "NVDA 120 95" and tabs: split each line on its own.
  if (headerAt < 0) rows = text.split(/\r?\n/).map((l) => l.trim().split(/\s*[,\t;]\s*|\s+/).filter(Boolean)).filter((r) => r.length);
  let col = { sym: 0, shares: 1, cost: 2, total: -1 }, body = rows;
  if (headerAt >= 0) {
    const h = rows[headerAt].map((c) => c.trim().toLowerCase());
    const find = (re) => h.findIndex((c) => re.test(c));
    col = {
      sym: find(/^(symbol|ticker|instrument|security symbol|symbol\/cusip)$/),
      shares: find(/quantity|shares|^qty|units/),
      cost: find(/(avg|average).*(cost|price)|cost.*(per|\/).*(share|unit)|price paid|unit cost/),
      total: find(/cost basis|total cost|book value|cost total/),
    };
    body = rows.slice(headerAt + 1);
  }
  const items = [], skipped = [];
  let cash = null;
  for (const r of body) {
    const raw = (r[col.sym] || "").replace(/\*+$/, "").trim();
    const sym = normSym(raw);
    const shares = parseNum(r[col.shares]);
    if (/^cash$/i.test(raw) && shares >= 0) { cash = shares; continue; }  // our own export's cash row
    if (!raw || /^(cash|total|pending|account total|--)/i.test(raw) || /money market|core position/i.test(r.join(" "))) { if (raw) skipped.push(raw); continue; }
    if (!SYM_RE.test(sym) || !(shares > 0)) { skipped.push(raw); continue; }
    let cost = col.cost >= 0 ? parseNum(r[col.cost]) : NaN;
    if (!(cost >= 0) && col.total >= 0) { const t = parseNum(r[col.total]); if (t >= 0) cost = t / shares; }
    items.push({ symbol: sym, shares, cost: cost >= 0 ? cost : null });
  }
  return { items, skipped, cash };
}
function importHoldings(text, source) {
  const { items, skipped, cash } = parseHoldingsText(text);
  if (cash != null) { pf.cash = cash; $("#pfCash").value = cash || ""; }
  if (!items.length) { toast("Nothing imported", `Couldn't find ticker and share columns${skipped.length ? `; skipped: ${skipped.slice(0, 6).join(", ")}` : ""}.`); return false; }
  if (pf.holdings.length && confirm(`Replace your ${pf.holdings.length} current positions with ${items.length} from ${source}?\n\nOK = replace · Cancel = add them to your current positions`)) pf.holdings = [];
  pfMerge(items); savePf(); renderHoldingsOnly(); runPortfolio();
  toast(`Imported ${items.length} position${items.length > 1 ? "s" : ""}`, skipped.length ? `Skipped: ${skipped.slice(0, 8).join(", ")}${skipped.length > 8 ? "…" : ""}` : "");
  return true;
}

// ---- analysis
let pfSeq = 0, pfTimer = 0;
const pfSoon = () => { clearTimeout(pfTimer); pfTimer = setTimeout(runPortfolio, 700); };
async function runPortfolio() {
  clearTimeout(pfTimer);
  $("#pfEmpty").classList.toggle("hidden", pf.holdings.length > 0);
  if (!pf.holdings.length) { $("#pfOut").classList.add("hidden"); state.portfolio = null; return; }
  const seq = ++pfSeq;
  $("#pfKpis").style.opacity = ".55";
  try {
    const r = await api("/api/portfolio/analyze", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ holdings: pf.holdings, cash: pf.cash, period: pf.period }) });
    if (seq !== pfSeq) return;
    state.portfolio = r;
    renderPortfolio(r);
    if (r.missing.length) toast("No price data", `Couldn't find: ${r.missing.join(", ")}. Check the tickers.`);
  } catch (e) {
    if (seq === pfSeq) toast("Portfolio analysis failed", e.message);
  } finally {
    if (seq === pfSeq) $("#pfKpis").style.opacity = "";
  }
}
const money = (v, d = 0) => (v == null ? "—" : `${v < 0 ? "−" : ""}$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}`);
const signedMoney = (v) => (v == null ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}$${Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}`);

function renderHoldingsOnly() {
  // Before/without analysis results: show the raw holdings so edits feel instant.
  $("#pfEmpty").classList.toggle("hidden", pf.holdings.length > 0);
  if (state.portfolio) renderPortfolio(state.portfolio);
}

function renderPortfolio(r) {
  $("#pfOut").classList.remove("hidden");
  const t = r.totals, k = r.risk, perf = r.performance;
  const kpi = (label, v, sub = "", c = "") => `<div class="stat"><div class="k">${label}</div><div class="v ${c}">${v}</div><div class="sub">${sub}</div></div>`;
  $("#pfKpis").innerHTML = [
    kpi("Total value", money(t.value), `${money(t.invested)} invested · ${money(t.cash)} cash`),
    kpi("Today", signedMoney(t.day_change), pct(t.day_pct), cls(t.day_change)),
    kpi("Unrealized P&L", t.pnl == null ? "—" : signedMoney(t.pnl), t.pnl == null ? "add avg costs to see P&L" : `${pct(t.pnl_pct, 1)} on ${t.pnl_positions} position${t.pnl_positions > 1 ? "s" : ""} with cost`, cls(t.pnl)),
    kpi(`Beta vs ${esc(perf.benchmark)}`, fmt(k.beta, 2), "market sensitivity"),
    kpi("Volatility", k.volatility == null ? "—" : `${fmt(k.volatility, 1)}%`, "annualized"),
    kpi("1-day VaR (95%)", k.var95_1d == null ? "—" : money(k.var95_1d), k.var95_1d_pct == null ? "" : `${fmt(k.var95_1d_pct, 1)}% · a bad day, ~1 in 20`),
    kpi(`${perf.period.toUpperCase()} return*`, pct(perf.total_return, 1), `${esc(perf.benchmark)} ${pct(perf.benchmark_return, 1)}`, cls(perf.total_return - perf.benchmark_return)),
    kpi("Max drawdown*", `${fmt(k.max_drawdown, 1)}%`, `Sharpe ${fmt(k.sharpe, 2)}`, "down"),
  ].join("");

  const byS = Object.fromEntries(r.positions.map((p) => [p.symbol, p]));
  $("#pfTable tbody").innerHTML = pf.holdings.map((h) => {
    const p = byS[h.symbol];
    const edit = (field, v, title) => `<input class="cell" type="number" step="any" min="0" value="${v ?? ""}" data-pf-edit="${field}" data-sym="${esc(h.symbol)}" aria-label="${title} for ${esc(h.symbol)}" placeholder="${field === "cost" ? "—" : ""}" />`;
    const del = `<button class="icon-btn" type="button" data-pf-del="${esc(h.symbol)}" aria-label="Remove ${esc(h.symbol)}" title="Remove position">✕</button>`;
    if (!p) return `<tr><td class="name"><strong>${esc(h.symbol)}</strong></td><td class="num">${edit("shares", h.shares, "Shares")}</td><td class="num">${edit("cost", h.cost, "Average cost")}</td>
      <td colspan="11" class="muted small">${r.missing.includes(h.symbol) ? "No price data for this ticker" : `<span class="spinner"></span> Updating…`}</td><td>${del}</td></tr>`;
    const e = p.next_earnings;
    return `<tr>
      <td class="name"><strong class="sym" data-open="${esc(p.symbol)}" style="cursor:pointer">${esc(p.symbol)}</strong><small title="${esc(p.name || "")}">${esc(p.name || "")}</small></td>
      <td class="num">${edit("shares", h.shares, "Shares")}</td><td class="num">${edit("cost", h.cost, "Average cost")}</td>
      <td class="num">${fmt(p.price)}</td><td class="num">${money(p.value)}</td>
      <td><span class="wbar"><span class="track"><span class="fill" style="display:block;width:${Math.min(100, p.weight * 2.5)}%"></span></span>${fmt(p.weight, 1)}%</span></td>
      <td class="num ${cls(p.day_pct)}">${pct(p.day_pct)}</td>
      <td class="num ${cls(p.pnl)}">${p.pnl == null ? "—" : signedMoney(p.pnl)}</td><td class="num ${cls(p.pnl_pct)}">${pct(p.pnl_pct, 1)}</td>
      <td class="sector" title="${esc(p.sector)}">${esc(p.sector)}</td><td class="num">${fmt(p.beta, 2)}</td>
      <td class="num">${p.risk_contribution == null ? "—" : fmt(p.risk_contribution, 0) + "%"}</td>
      <td><span class="tag ${p.rating}" title="Composite score ${fmt(p.score, 0)}">${p.rating}</span></td>
      <td>${e ? (e.days_until <= 7 ? `<span class="soon">${e.days_until}d</span>` : `<span class="later">${new Date(`${e.date}T12:00:00`).toLocaleDateString([], { month: "short", day: "numeric" })}</span>`) : `<span class="muted small">—</span>`}</td>
      <td>${del}</td></tr>`;
  }).join("");

  const bars = (items) => items.map((a) => `<div class="a-row"><span class="name" title="${esc(a.name)}">${esc(a.name)}</span>
      <span class="a-track"><span class="a-fill" style="display:block;width:${Math.min(100, a.weight)}%"></span></span><span class="a-v">${fmt(a.weight, 1)}%</span></div>`).join("");
  $("#pfSectors").innerHTML = bars(r.allocation.sector);
  $("#pfTypes").innerHTML = bars(r.allocation.asset_type);
  const c = r.concentration;
  $("#pfConc").innerHTML = [
    ["Largest position", `${esc(c.largest_symbol)} · ${fmt(c.largest, 1)}%`], ["Top 5 positions", `${fmt(c.top5, 1)}%`],
    ["Effective # of positions", `${fmt(c.effective_positions, 1)} of ${r.positions.length}`],
    ["Diversification ratio", k.diversification_ratio == null ? "—" : `${fmt(k.diversification_ratio, 2)}×`],
  ].map(([a, b]) => `<div><span class="muted">${a}</span><span>${b}</span></div>`).join("");

  $("#pfObs").innerHTML = r.observations.length ? r.observations.map((o) => `<li class="${o.level}"><span class="ico">${o.level === "warn" ? "⚠" : "ℹ"}</span>${esc(o.text)}</li>`).join("")
    : `<li><span class="ico">✓</span>Nothing stands out: no concentration, sector or risk flags.</li>`;

  // Hypothetical performance chart (validated slots 1-2 + dash for the benchmark).
  const x = perf.dates, span = Math.max(...perf.portfolio, ...perf.benchmark_curve) - Math.min(...perf.portfolio, ...perf.benchmark_curve) || 1;
  const grid = "rgba(35,43,59,.8)";
  Plotly.react("pfChart", [
    { x, y: perf.portfolio, name: "Your portfolio", mode: "lines", line: { color: "#3987e5", width: 2.2 }, hovertemplate: "%{y:+.1f}%<extra>Portfolio</extra>" },
    { x, y: perf.benchmark_curve, name: perf.benchmark, mode: "lines", line: { color: "#d95926", width: 1.8, dash: "dash" }, hovertemplate: `%{y:+.1f}%<extra>${esc(perf.benchmark)}</extra>` },
  ], {
    paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)", font: { color: "#8892a6", family: "Inter" },
    margin: { l: 55, r: 120, t: 36, b: 30 }, hovermode: "x unified",
    hoverlabel: { bgcolor: "#171d2a", bordercolor: "#232b3b", font: { color: "#e4e8f0" } },
    legend: { orientation: "h", x: 0, y: 1.12, font: { size: 11, color: "#e4e8f0" } },
    xaxis: { gridcolor: grid, type: "date", range: [x[0], x.at(-1)] },
    yaxis: { gridcolor: grid, ticksuffix: "%", zeroline: true, zerolinecolor: "#5a6478", title: { text: "Return since start", font: { size: 11 } } },
    annotations: endLabels([{ x: x.at(-1), y: perf.portfolio.at(-1), label: "Portfolio" }, { x: x.at(-1), y: perf.benchmark_curve.at(-1), label: perf.benchmark }], span, (v) => pct(v, 1)),
  }, { displaylogo: false, responsive: true, modeBarButtonsToRemove: ["lasso2d", "select2d"] });

  const corr = r.correlation;
  $("#pfCorrWrap").classList.toggle("hidden", !corr);
  if (corr) $("#pfCorr").innerHTML = `<table class="corr"><thead><tr><th></th>${corr.symbols.map((s) => `<th>${esc(s)}</th>`).join("")}</tr></thead><tbody>${
    corr.matrix.map((row, i) => `<tr><th>${esc(corr.symbols[i])}</th>${row.map((v, j) => i === j ? `<td class="diag">—</td>`
      : `<td style="background:${divergingColor(v)}" title="${esc(corr.symbols[i])} vs ${esc(corr.symbols[j])}: ${fmt(v, 2)}">${fmt(v, 2)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  $("#pfNotes").textContent = "* " + r.notes.join(" ");
}

// ---- events
function initPortfolio() {
  $("#pfCash").value = pf.cash || "";
  $("#pfPeriod").value = pf.period;
  $("#pfEmpty").classList.toggle("hidden", pf.holdings.length > 0);
  if (pf.holdings.length) runPortfolio();
}
$("#pfAddForm").onsubmit = (e) => {
  e.preventDefault();
  const sym = normSym($("#pfSym").value), shares = parseFloat($("#pfShares").value), cost = parseFloat($("#pfCost").value);
  if (!SYM_RE.test(sym)) { toast("Check the ticker", `"${$("#pfSym").value}" isn't a valid symbol.`); return; }
  if (!(shares > 0)) { toast("Add a share count", "Shares must be more than 0."); return; }
  pfMerge([{ symbol: sym, shares, cost: cost >= 0 ? cost : null }]);
  savePf(); $("#pfSym").value = ""; $("#pfShares").value = ""; $("#pfCost").value = ""; $("#pfSym").focus();
  renderHoldingsOnly(); runPortfolio();
};
$("#pfCash").onchange = () => { pf.cash = Math.max(0, parseFloat($("#pfCash").value) || 0); savePf(); if (pf.holdings.length) pfSoon(); };
$("#pfPeriod").onchange = () => { pf.period = $("#pfPeriod").value; savePf(); runPortfolio(); };
$("#pfPasteBtn").onclick = () => { $("#pfPaste").classList.toggle("hidden"); $("#pfPasteText").focus(); };
$("#pfPasteCancel").onclick = () => { $("#pfPaste").classList.add("hidden"); $("#pfPasteText").value = ""; };
$("#pfPasteAdd").onclick = () => { if (importHoldings($("#pfPasteText").value, "the pasted text")) { $("#pfPasteText").value = ""; $("#pfPaste").classList.add("hidden"); } };
$("#pfImport").onchange = async (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) importHoldings(await f.text(), f.name); };
$("#pfExport").onclick = () => {
  if (!pf.holdings.length) { toast("Nothing to export", "Add some positions first."); return; }
  downloadCSV(`portfolio-holdings-${today()}`, ["Symbol", "Shares", "Average Cost"], [...pf.holdings.map((h) => [h.symbol, h.shares, h.cost]), ...(pf.cash ? [["CASH", pf.cash, null]] : [])]);
};
$("#pfClear").onclick = () => {
  if (!pf.holdings.length || !confirm(`Remove all ${pf.holdings.length} positions? (Export first if you want a backup.)`)) return;
  pf.holdings = []; pf.cash = 0; $("#pfCash").value = ""; savePf(); runPortfolio();
};
$("#pfTable tbody").addEventListener("change", (e) => {
  const el = e.target.closest("[data-pf-edit]"); if (!el) return;
  const h = pf.holdings.find((x) => x.symbol === el.dataset.sym); if (!h) return;
  const v = parseFloat(el.value);
  if (el.dataset.pfEdit === "shares") { if (!(v > 0)) { el.value = h.shares; toast("Shares must be more than 0", "Use ✕ to remove a position."); return; } h.shares = v; }
  else h.cost = v >= 0 ? v : null;
  savePf(); pfSoon();
});
$("#pfTable tbody").addEventListener("click", (e) => {
  const b = e.target.closest("[data-pf-del]"); if (!b) return;
  pf.holdings = pf.holdings.filter((h) => h.symbol !== b.dataset.pfDel); savePf(); runPortfolio();
});
$("#pfCsv").onclick = () => {
  const r = state.portfolio; if (!r) return;
  downloadCSV(`portfolio-analysis-${today()}`,
    ["Symbol", "Name", "Shares", "Avg Cost", "Price", "Value", "Weight %", "Day %", "Day $", "P&L $", "P&L %", "1M %", "3M %", "YTD %", "Asset Type", "Sector", "Beta", "Volatility %", "Risk Contribution %", "Composite Score", "Rating", "Next Earnings"],
    r.positions.map((p) => [p.symbol, p.name, p.shares, p.cost, p.price, p.value, p.weight, p.day_pct, p.day_change, p.pnl, p.pnl_pct, p.ret_1m, p.ret_3m, p.ret_ytd,
      p.asset_type, p.sector, p.beta, p.volatility, p.risk_contribution, p.score, p.rating, p.next_earnings?.date]));
};
$("#pfCompare").onclick = () => { const r = state.portfolio; if (r) openCompare(r.positions.slice(0, 8).map((p) => p.symbol)); };
$("#askPfBtn").onclick = () => {
  const r = state.portfolio; if (!r) return;
  const t = r.totals, k = r.risk, p = r.performance;
  const lines = r.positions.map((x) => `${x.symbol} ${fmt(x.weight, 1)}% (${x.sector}; P&L ${x.pnl_pct == null ? "n/a" : pct(x.pnl_pct, 1)}; beta ${fmt(x.beta, 2)}; risk share ${fmt(x.risk_contribution, 0)}%; ${x.rating}${x.next_earnings ? `; earnings in ${x.next_earnings.days_until}d` : ""})`).join("\n");
  sendChat(`Please review my portfolio (total ${money(t.value)}, ${fmt(t.cash_pct, 1)}% cash${t.pnl == null ? "" : `, unrealized P&L ${pct(t.pnl_pct, 1)}`}).\n\nPositions:\n${lines}\n\nSectors: ${r.allocation.sector.map((s) => `${s.name} ${fmt(s.weight, 0)}%`).join(", ")}\nRisk: beta ${fmt(k.beta, 2)}, volatility ${fmt(k.volatility, 1)}%, 1-day 95% VaR ${money(k.var95_1d)}, max drawdown ${fmt(k.max_drawdown, 1)}%, effective positions ${fmt(r.concentration.effective_positions, 1)}.\nHypothetical ${p.period} return ${pct(p.total_return, 1)} vs ${p.benchmark} ${pct(p.benchmark_return, 1)}.\nObservations: ${r.observations.map((o) => o.text).join(" ") || "none"}\n\nWhat are the main risks and blind spots in this portfolio, how diversified is it really, which positions dominate the risk, and what upcoming events matter for it? Use current data and news where useful. I'm looking for analysis to inform my own decisions, not personalized advice.`);
};
document.querySelector("#refreshBtn").addEventListener("click", () => { if (pf.holdings.length) runPortfolio(); });

/* ---------------- CSV exports ---------------- */
$("#scanCsv").onclick = () => {
  const s = state.scan; if (!s) return;
  const { key, dir } = state.sort;  // same order as the table on screen
  const rows = [...s.results].sort((a, b) => typeof a[key] === "string" ? a[key].localeCompare(b[key]) * dir : ((a[key] ?? -1e9) - (b[key] ?? -1e9)) * dir);
  downloadCSV(`scan-${slug(s.strategy.key)}-${slug(s.universe)}-${today()}`,
    ["Rank", "Symbol", "Score", "Rating", "Price", "Day %", "1M %", "3M %", "RSI 14", "Volume x Avg", "From 52w High %", "Reasons", "Strategy", "Universe", "As Of"],
    rows.map((r, i) => [i + 1, r.symbol, r.score, r.rating, r.price, r.change_pct, r.ret_1m, r.ret_3m, r.rsi14, r.vol_ratio, r.pct_from_high,
      r.reasons.join("; "), s.strategy.name, s.universe, s.as_of]));
};

const btName = (r, part) => `backtest-${slug(r.params.strategy)}-${slug(r.params.universe)}-${r.params.period}-${part}-${today()}`;
$("#btCsvSummary").onclick = () => {
  const r = state.backtest; if (!r) return;
  const p = r.params, labels = { strategy: `${p.strategy_name} (top ${p.top_n})`, benchmark: p.benchmark, universe: "Equal-weight universe" };
  downloadCSV(btName(r, "summary"),
    ["Portfolio", "Total Return %", "CAGR %", "Volatility %", "Sharpe", "Max Drawdown %", "Up Periods %", "Beat Benchmark %", "Avg Turnover %",
     "Start", "End", "Universe", "Rebalance", "Cost bps", "Stocks Tested"],
    ["strategy", "benchmark", "universe"].map((k) => { const s = r.stats[k]; return [labels[k], s.total_return, s.cagr, s.volatility, s.sharpe,
      s.max_drawdown, s.win_rate, s.beat_benchmark, s.avg_turnover, p.start, p.end, p.universe, p.rebalance, p.cost_bps, p.tickers_tested]; }));
};
$("#btCsvPeriods").onclick = () => {
  const r = state.backtest; if (!r) return;
  downloadCSV(btName(r, "rebalances"),
    ["Rebalance Date", "Hold Until", "Strategy Return %", `${r.params.benchmark} Return %`, "Excess %", "Turnover %", "Holdings", "Holding Scores"],
    [...r.periods].reverse().map((x) => [x.date, x.end, x.return, x.benchmark, x.excess, x.turnover,
      x.holdings.map((h) => h.symbol).join(" "), x.holdings.map((h) => `${h.symbol}:${h.score}`).join(" ")]));
};
$("#btCsvEquity").onclick = () => {
  const r = state.backtest; if (!r) return;
  const c = r.curves, idx = (k) => Object.fromEntries(c[k].dates.map((d, i) => [d, c[k].values[i]]));
  const b = idx("benchmark"), u = idx("universe"), s0 = c.strategy.values[0];
  downloadCSV(btName(r, "equity"),
    ["Date", "Strategy (growth of $1)", `${r.params.benchmark} (growth of $1)`, "Universe (growth of $1)",
     "Strategy Cumulative %", `${r.params.benchmark} Cumulative %`, "Universe Cumulative %"],
    c.strategy.dates.map((d, i) => { const sv = c.strategy.values[i] / s0, bv = b[d], uv = u[d];
      return [d, sv, bv, uv, (sv - 1) * 100, bv == null ? null : (bv - 1) * 100, uv == null ? null : (uv - 1) * 100]; }));
};

$("#wlCsv").onclick = () => {
  const rows = state.watch?.rows || {}, strat = wl.strategy, sname = state.strategies[strat]?.name || strat;
  downloadCSV(`watchlist-${slug(activeList().name)}-${today()}`,
    ["Symbol", "Price", "Day %", "5D %", "1M %", "3M %", "RSI 14", "Volume x Avg", "From 52w High %", "SMA 50", "SMA 200", `${sname} Score`, "Active Alerts", "As Of"],
    activeList().symbols.map((s) => { const r = rows[s] || {};
      return [s, r.price, r.change_pct, r.ret_5d, r.ret_1m, r.ret_3m, r.rsi14, r.vol_ratio, r.pct_from_high, r.sma50, r.sma200,
        r.scores?.[strat], wl.alerts.filter((a) => a.symbol === s && a.enabled).map(alertText).join("; "), state.watch?.as_of]; }));
};

document.addEventListener("click", (e) => {
  if (e.target.id !== "tickerCsv") return;
  const d = state.tickerData; if (!d) return;
  const o = d.ohlcv, ind = d.indicators, keys = Object.keys(ind);
  downloadCSV(`${slug(d.symbol)}-${d.period}-${d.interval}-${today()}`,
    ["Date", "Open", "High", "Low", "Close", "Volume", ...keys.map((k) => k.toUpperCase().replace(/_/g, " "))],
    o.dates.map((dt, i) => [dt, o.open[i], o.high[i], o.low[i], o.close[i], o.volume[i], ...keys.map((k) => ind[k][i])]));
});

/* ---------------- Boot ---------------- */
loadAccount().catch(() => {});
loadMeta().then(() => {
  setupBacktestSelectors();
  renderAlertForm(); renderWatch(); refreshWatch(); renderChips(); loadCalendar(); initPortfolio();
  return loadOverview();
}).then(() => loadTicker("SPY", "1y"));
setInterval(() => api("/api/meta").then((m) => setStatus(m.status)).catch(() => {}), 60000);

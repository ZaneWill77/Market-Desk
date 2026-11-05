"use strict";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const state = { overview: null, sectorTf: "1m", scan: null, sort: { key: "score", dir: -1 }, ticker: "SPY", period: "1y", conversationId: null, account: null, busy: false };

const fmt = (v, d = 2) => (v == null || Number.isNaN(v) ? "—" : Number(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }));
const pct = (v, d = 2) => (v == null ? "—" : `${v > 0 ? "+" : ""}${fmt(v, d)}%`);
const cls = (v) => (v == null ? "" : v > 0 ? "up" : v < 0 ? "down" : "");
const big = (v) => { if (v == null) return "—"; const a = Math.abs(v); return a >= 1e12 ? fmt(v / 1e12) + "T" : a >= 1e9 ? fmt(v / 1e9) + "B" : a >= 1e6 ? fmt(v / 1e6) + "M" : fmt(v, 0); };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
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
      <td class="muted">${i + 1}</td><td><strong>${esc(r.symbol)}</strong></td>
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
  $("#fundamentals").innerHTML = `<span class="muted"><span class="spinner"></span> Loading…</span>`;
  $("#news").innerHTML = "";
  try {
    const info = await api(`/api/ticker/${encodeURIComponent(sym)}/info`);
    if (state.ticker === sym) renderInfo(info);
  } catch { $("#fundamentals").innerHTML = `<span class="muted">Unavailable</span>`; }
}

function renderTicker(d) {
  const o = d.ohlcv, ind = d.indicators, a = d.analysis, sn = a?.snapshot || {};
  $("#tickerHeader").innerHTML = `<span class="sym">${esc(d.symbol)}</span><span class="px">${fmt(sn.price)}</span>
    <span class="${cls(sn.change_pct)} mono">${pct(sn.change_pct)}</span>
    <span class="muted small">1M ${pct(sn.ret_1m, 1)} · 3M ${pct(sn.ret_3m, 1)} · 12M ${pct(sn.ret_12m, 1)}</span>`;

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

/* ---------------- Boot ---------------- */
loadAccount().catch(() => {});
loadMeta().then(() => loadOverview()).then(() => loadTicker("SPY", "1y"));
setInterval(() => api("/api/meta").then((m) => setStatus(m.status)).catch(() => {}), 60000);

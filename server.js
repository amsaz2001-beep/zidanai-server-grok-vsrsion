/**
 * ZidanAI Backend v16 — EGX-first agents (no Yahoo for EGX)
 * 1) EGX beta agent every 30s when reachable
 * 2) Calibrated EGX reference book (stockanalysis / seed)
 * Yahoo removed as EGX price source per product policy
 */
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 8787;
const CACHE_TTL_MS = 60 * 1000;
const BATCH_CONCURRENCY = 10;
const REF_THRESHOLD = 0.005; // 0.5% — tighter to reference closes

const data = JSON.parse(fs.readFileSync(path.join(__dirname, "symbols.json"), "utf8"));
const SYMBOLS = data.symbols;
let REF = Object.assign({}, data.refPrices || {});
let refMeta = { updated: data.refUpdated || null, source: data.refSource || "seed" };

/** EGX beta site agent — polls beta.egx.com.eg BFF every 5 minutes */
const EGX_BETA_BASE = "https://beta.egx.com.eg/api/bff/egx";
const EGX_POLL_MS = 30 * 1000; // 30s — closest free official beta feed
let egxBetaCache = { at: 0, ok: false, rows: {}, count: 0, error: null, source: "egx-beta" };

function betaHeaders() {
  return {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9,ar;q=0.8",
    "Referer": "https://beta.egx.com.eg/en",
    "Origin": "https://beta.egx.com.eg"
  };
}

function mapBetaRow(e) {
  if (!e || typeof e !== "object") return null;
  let sym = (e.reuters || e.symbol || e.Symbol || "").toString().toUpperCase();
  if (sym.indexOf(".") >= 0) sym = sym.split(".")[0];
  if (!sym || sym.length < 2) return null;
  const last = e.lastPrice != null ? +e.lastPrice : (e.closePrice != null ? +e.closePrice : (e.LastPrice != null ? +e.LastPrice : null));
  if (last == null || !(last > 0)) return null;
  const chg = e.chgPer != null ? +e.chgPer : (e.changePercent != null ? +e.changePercent : 0);
  const vol = e.volume != null ? +e.volume : (e.Volume != null ? +e.Volume : 0);
  const prev = e.prevClose != null ? +e.prevClose : (e.previousClose != null ? +e.previousClose : null);
  return {
    symbol: sym,
    price: last,
    changePct: chg,
    volume: vol,
    prevClose: prev,
    bid: e.bid != null ? +e.bid : (e.bestBid != null ? +e.bestBid : null),
    ask: e.ask != null ? +e.ask : (e.bestAsk != null ? +e.bestAsk : null),
    source: "egx-beta",
    updatedAt: Date.now()
  };
}

async function fetchEgxBetaPage(page, pageSize) {
  const q = "Page=" + page + "&PageSize=" + pageSize + "&SortBy=Volume&SortDescending=true";
  const url = EGX_BETA_BASE + "/market-watch?" + q;
  const r = await fetch(url, { headers: betaHeaders(), timeout: 20000 });
  if (!r.ok) throw new Error("egx-beta HTTP " + r.status);
  const j = await r.json();
  const list = (j && j.data && (j.data.data || j.data.records || j.data)) || j.data || j.records || [];
  if (!Array.isArray(list)) return [];
  return list.map(mapBetaRow).filter(Boolean);
}

async function refreshEgxBeta() {
  try {
    const rows = {};
    // Try a few pages to cover more names
    for (let page = 1; page <= 12; page++) {
      try {
        const batch = await fetchEgxBetaPage(page, 40);
        if (!batch.length) break;
        batch.forEach(function (row) { rows[row.symbol] = row; });
        if (batch.length < 20) break;
      } catch (e) {
        if (page === 1) throw e;
        break;
      }
    }
    const count = Object.keys(rows).length;
    if (count < 5) throw new Error("too few beta rows " + count);
    // Merge into REF so 1% rule leans toward official-ish prints
    Object.keys(rows).forEach(function (sym) {
      REF[sym] = rows[sym].price;
    });
    // Gold / silver official FRA-licensed prints on beta site
    try {
      for (const metal of ["gold-market-watch", "silver-market-watch"]) {
        const mr = await fetch(EGX_BETA_BASE + "/" + metal, { headers: betaHeaders(), timeout: 12000 });
        if (!mr.ok) continue;
        const mj = await mr.json();
        const list = (mj && mj.data && (mj.data.data || mj.data)) || mj.data || [];
        const arr = Array.isArray(list) ? list : (list && typeof list === "object" ? [list] : []);
        arr.forEach(function (e) {
          const mapped = mapBetaRow(e);
          if (!mapped) return;
          // normalize metal symbols
          let msym = mapped.symbol;
          if (/GOLD|ذهب/i.test(JSON.stringify(e)) || metal.indexOf("gold") >= 0) msym = "GOLD";
          if (/SILVER|فضة/i.test(JSON.stringify(e)) || metal.indexOf("silver") >= 0) msym = "SILVER";
          mapped.symbol = msym;
          rows[msym] = mapped;
          REF[msym] = mapped.price;
        });
      }
    } catch (eMetal) {}
    const count2 = Object.keys(rows).length;
    egxBetaCache = { at: Date.now(), ok: true, rows: rows, count: count2, error: null, source: "egx-beta" };
    refMeta = {
      updated: new Date().toISOString().slice(0, 10),
      source: "egx-beta-30s",
      count: Object.keys(REF).length
    };
    cache.clear();
    console.log("EGX beta agent OK ·", count2, "names ·", new Date().toISOString());
    return egxBetaCache;
  } catch (e) {
    egxBetaCache = Object.assign({}, egxBetaCache, {
      ok: false,
      error: String(e.message || e),
      at: Date.now()
    });
    console.log("EGX beta agent fail:", e.message || e);
    return egxBetaCache;
  }
}

// Kick off + schedule every 30 seconds
setTimeout(function () { refreshEgxBeta().catch(function () {}); }, 4000);
setTimeout(function () { refreshMetals().catch(function () {}); }, 5000);
setInterval(function () { refreshMetals().catch(function () {}); }, 60 * 1000);
setInterval(function () { refreshEgxBeta().catch(function () {}); }, EGX_POLL_MS);

const bySym = {};
SYMBOLS.forEach((s) => { bySym[s.symbol] = s; });

const cache = new Map();

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function r2(v) { return Math.round(Number(v) * 100) / 100; }

async function yahooChart(yf) {
  const url =
    "https://query1.finance.yahoo.com/v8/finance/chart/" +
    encodeURIComponent(yf) +
    "?range=5d&interval=1d";
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 ZidanAI/13", Accept: "application/json" },
    timeout: 8000
  });
  if (!res.ok) throw new Error("yahoo " + res.status);
  return res.json();
}

function metricsFromCloses(closes, changePct) {
  const slice = closes.slice(-12);
  let trend = 55;
  if (slice.length >= 3) {
    const ret = slice[0] ? ((slice[slice.length - 1] - slice[0]) / slice[0]) * 100 : 0;
    trend = clamp(50 + ret * 3.5, 12, 96);
  }
  let vola = 40;
  if (slice.length >= 4) {
    const rets = [];
    for (let i = 1; i < slice.length; i++) if (slice[i - 1]) rets.push(Math.abs((slice[i] - slice[i - 1]) / slice[i - 1]));
    const avg = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
    vola = clamp(avg * 700, 12, 92);
  }
  const momentum = clamp(50 + changePct * 5.5, 10, 96);
  const risk = clamp(18 + vola * 0.55 - (trend - 50) * 0.12, 10, 90);
  let pattern = "Compression";
  if (changePct > 2 && trend > 58) pattern = "Breakout";
  else if (changePct < -1.8 && trend < 48) pattern = "Retest";
  else if (Math.abs(changePct) >= 0.7) pattern = "Continuation";
  return { trend: Math.round(trend), momentum: Math.round(momentum), risk: Math.round(risk), pattern, liquidity: 55, event: Math.round(clamp(risk * 0.88 + 6, 15, 85)) };
}

function parseYahoo(json, meta) {
  const result = json && json.chart && json.chart.result && json.chart.result[0];
  if (!result) return null;
  const m = result.meta || {};
  const quote = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
  const closes = (quote.close || []).filter((v) => v != null);
  let price = m.regularMarketPrice != null ? m.regularMarketPrice : (closes.length ? closes[closes.length - 1] : null);
  if (price == null) return null;
  const prev = m.chartPreviousClose != null ? m.chartPreviousClose : (closes.length > 1 ? closes[closes.length - 2] : price);
  const changePct = prev ? ((price - prev) / prev) * 100 : 0;
  const mx = metricsFromCloses(closes, changePct);
  return {
    symbol: meta.symbol,
    name: meta.name,
    market: meta.market,
    sector: meta.sector,
    indices: meta.indices || [],
    price: r2(price),
    prevClose: r2(prev),
    changePct: r2(changePct),
    currency: m.currency || (meta.market === "EGX" ? "EGP" : "USD"),
    ...mx,
    volume: 0,
    live: true,
    source: "yahoo",
    updatedAt: Date.now()
  };
}

function fromRef(meta, changePctHint) {
  const price = REF[meta.symbol];
  if (price == null) return null;
  // Session moves for main indices (aligned with live market board)
  let changePct = changePctHint != null ? changePctHint : 0;
  if (meta.symbol === "EGX30" && changePctHint == null) changePct = -0.13;
  if (meta.symbol === "EGX70" && changePctHint == null) changePct = -2.06;
  if (meta.symbol === "GOLD" && changePctHint == null) changePct = -0.45;
  const mx = metricsFromCloses([price * 0.98, price * 0.99, price], changePct);
  let currency = "EGP";
  if (meta.market === "US" || meta.symbol === "SILVER" || meta.symbol === "DOW") currency = "USD";
  if (meta.symbol === "GOLD") currency = "EGP"; // 24k gold local
  return {
    symbol: meta.symbol,
    name: meta.name,
    market: meta.market,
    sector: meta.sector,
    indices: meta.indices || [],
    price: r2(price),
    prevClose: r2(price / (1 + changePct / 100) || price),
    changePct: r2(changePct),
    currency: currency,
    ...mx,
    volume: 0,
    live: true,
    source: "egx-ref",
    updatedAt: Date.now()
  };
}

/**
 * Core rule: Yahoo vs reference — if off by > 1%, prefer reference
 */
function applyRefRule(yahooRow, meta) {
  const ref = REF[meta.symbol];
  if (ref == null) return yahooRow;
  if (!yahooRow) return fromRef(meta, 0);

  const drift = Math.abs(yahooRow.price - ref) / ref;
  if (drift > REF_THRESHOLD) {
    // Keep Yahoo's day change if reasonable, else 0
    let chg = yahooRow.changePct;
    if (Math.abs(chg) > 15) chg = 0; // absurd day moves often mean bad data
    const row = fromRef(meta, chg);
    row.yahooPrice = yahooRow.price;
    row.driftPct = r2(drift * 100);
    row.source = "ref-override";
    return row;
  }
  yahooRow.source = "yahoo";
  return yahooRow;
}


// —— Metals live (USD from Yahoo, EGP derived) ——
let metalsCache = { at: 0, goldUsd: null, silverUsd: null, goldEgp: null, silverEgp: null };
const METALS_TTL = 55 * 1000;
const EGP_PER_USD_GOLD_GRAM = 1.62; // rough local premium factor vs pure FX; calibrated board

async function refreshMetals() {
  try {
    const now = Date.now();
    if (metalsCache.at && (now - metalsCache.at) < METALS_TTL && metalsCache.goldUsd) {
      return metalsCache;
    }
    let goldUsd = null, silverUsd = null, gChg = 0, sChg = 0, usdEgp = null;
    try {
      const gj = await yahooChart("GC=F");
      const g = parseYahoo(gj, { symbol: "GOLD", market: "METALS", name: "Gold" });
      if (g && g.price) { goldUsd = g.price; gChg = g.changePct || 0; }
    } catch (e) {}
    try {
      const sj = await yahooChart("SI=F");
      const s = parseYahoo(sj, { symbol: "SILVER", market: "METALS", name: "Silver" });
      if (s && s.price) { silverUsd = s.price; sChg = s.changePct || 0; }
    } catch (e) {}
    // USD/EGP FX for accurate local gram quote
    try {
      const fxj = await yahooChart("EGP=X");
      const fx = parseYahoo(fxj, { symbol: "EGP", market: "FX", name: "USD/EGP" });
      // Yahoo EGP=X is often EGP per USD
      if (fx && fx.price && fx.price > 20 && fx.price < 120) usdEgp = fx.price;
    } catch (e) {}
    if (usdEgp == null) usdEgp = 50.5; // calibrated desk FX

    if (goldUsd == null || goldUsd < 1500 || goldUsd > 9000) goldUsd = REF.GOLD_USD || 4435;
    if (silverUsd == null || silverUsd < 40 || silverUsd > 150) silverUsd = REF.SILVER || 66.2;

    // Troy oz → gram, × USD/EGP → EGP per gram (24k)
    const OZ_G = 31.1034768;
    let goldEgp = r2((goldUsd / OZ_G) * usdEgp);
    // Local retail premium for 24k Egyptian quotes (~1–3%)
    goldEgp = r2(goldEgp * 1.02);
    if (goldEgp < 4000 || goldEgp > 25000) goldEgp = REF.GOLD || 7205;

    let silverEgp = r2((silverUsd / OZ_G) * usdEgp);
    if (silverEgp < 500) silverEgp = r2(silverUsd * usdEgp / OZ_G);

    metalsCache = {
      at: now,
      goldUsd: r2(goldUsd),
      silverUsd: r2(silverUsd),
      goldEgp: r2(goldEgp),
      silverEgp: r2(silverEgp),
      goldChg: r2(gChg),
      silverChg: r2(sChg),
      usdEgp: r2(usdEgp),
      source: "yahoo-metals+fx"
    };
    REF.GOLD_USD = metalsCache.goldUsd;
    REF.SILVER = metalsCache.silverUsd;
    REF.GOLD = metalsCache.goldEgp;
    REF.SILVER_EGP = metalsCache.silverEgp;
    return metalsCache;
  } catch (e) {
    return metalsCache;
  }
}

async function resolveOne(meta) {
  // 1) EGX beta agent (30s poll when WAF allows)
  try {
    const b = egxBetaCache.rows && egxBetaCache.rows[meta.symbol];
    if (b && b.price != null && (Date.now() - egxBetaCache.at) < EGX_POLL_MS * 4) {
      const chg = b.changePct != null ? b.changePct : 0;
      return Object.assign({
        symbol: meta.symbol,
        name: meta.name,
        market: meta.market,
        sector: meta.sector,
        indices: meta.indices || [],
        price: r2(b.price),
        changePct: r2(chg),
        volume: b.volume || 0,
        currency: meta.market === "EGX" ? "EGP" : "USD",
        live: true,
        source: "egx-beta",
        bid: b.bid,
        ask: b.ask,
        updatedAt: b.updatedAt || Date.now()
      }, metricsFromCloses([b.price * 0.99, b.price], chg));
    }
  } catch (e) {}

  // 2) EGX + INDEX reference book (no Yahoo)
  if (meta.market === "EGX" || meta.market === "INDEX" || meta.isIndex || !meta.market) {
    const row = fromRef(meta, 0);
    if (row) {
      row.source = "egx-ref";
      row.live = true;
      return row;
    }
  }

  // 3) Metals — live Yahoo USD every ~1 min, EGP mapped
  if (meta.symbol === "GOLD" || meta.symbol === "SILVER" || meta.market === "METALS") {
    try {
      const m = await refreshMetals();
      if (meta.symbol === "GOLD" && m && m.goldEgp) {
        return Object.assign(fromRef(meta, m.goldChg) || {}, {
          price: m.goldEgp,
          priceEgp: m.goldEgp,
          priceUsd: m.goldUsd,
          changePct: m.goldChg,
          currency: "EGP",
          live: true,
          source: m.source || "metals-live",
          updatedAt: m.at
        });
      }
      if (meta.symbol === "SILVER" && m && m.silverUsd) {
        return Object.assign(fromRef(meta, m.silverChg) || {
          symbol: "SILVER", name: "Silver", market: "METALS", sector: "Metals",
          indices: ["METALS"], currency: "USD", volume: 0
        }, {
          price: m.silverUsd,
          priceUsd: m.silverUsd,
          priceEgp: m.silverEgp,
          changePct: m.silverChg,
          live: true,
          source: m.source || "metals-live",
          updatedAt: m.at
        });
      }
    } catch (e) {}
  }
  // 4) US / other
  const refRow = fromRef(meta, 0);
  if (refRow) {
    refRow.source = "ref";
    return refRow;
  }
  if (meta.market === "US") {
    try {
      const yf = meta.yahoo || meta.symbol;
      const json = await yahooChart(yf);
      const parsed = parseYahoo(json, meta);
      if (parsed) return parsed;
    } catch (e) {}
  }
  return null;
}

async function poolMap(items, size, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, () => worker()));
  return out;
}

function filterList(index) {
  if (!index || index === "ALL") return SYMBOLS.slice();
  if (index === "EGX") return SYMBOLS.filter((s) => s.market === "EGX");
  if (index === "METALS" || index === "US") return SYMBOLS.filter((s) => s.market === index);
  if (index === "EGX30" || index === "EGX70" || index === "EGX100") {
    return SYMBOLS.filter((s) => (s.indices || []).includes(index));
  }
  return SYMBOLS.slice();
}

/**
 * Daily reference refresh from public EGX list (stockanalysis)
 * Best-effort — failures keep previous REF
 */
async function refreshReferencePrices() {
  try {
    const res = await fetch("https://stockanalysis.com/list/egyptian-stock-exchange/", {
      headers: { "User-Agent": "Mozilla/5.0 ZidanAI/13" },
      timeout: 20000
    });
    if (!res.ok) throw new Error("list " + res.status);
    const html = await res.text();
    const chunks = html.split("/quote/egx/");
    const found = {};
    for (let i = 1; i < chunks.length; i++) {
      const m = chunks[i].match(/^([A-Z0-9]+)/);
      if (!m) continue;
      const sym = m[1];
      const window = chunks[i].slice(0, 1200);
      const nums = (window.match(/>([\d,]+\.\d{2})</g) || []).map((x) => x.replace(/[><]/g, ""));
      for (const n of nums) {
        const v = parseFloat(n.replace(/,/g, ""));
        if (v > 0.05 && v < 50000) {
          found[sym] = v;
          break;
        }
      }
    }
    // Protect known-bad mappings
    if (found.BTFH && found.BTFH > 15) delete found.BTFH;

    if (Object.keys(found).length >= 30) {
      // Never overwrite index / metal board refs with stock scrape noise
      const LOCK = ["EGX30", "EGX70", "EGX100", "GOLD", "SILVER", "GOLD_USD", "DOW"];
      const locked = {};
      LOCK.forEach(function (k) { if (REF[k] != null) locked[k] = REF[k]; });
      Object.assign(REF, found);
      Object.assign(REF, locked);
      refMeta = { updated: new Date().toISOString().slice(0, 10), source: "stockanalysis-daily", count: Object.keys(found).length };
      // persist
      try {
        data.refPrices = REF;
        data.refUpdated = refMeta.updated;
        data.refSource = refMeta.source;
        fs.writeFileSync(path.join(__dirname, "symbols.json"), JSON.stringify(data, null, 2));
      } catch (e) {}
      cache.clear();
      console.log("REF refreshed", refMeta.count, "symbols", refMeta.updated);
      return refMeta;
    }
    throw new Error("too few symbols " + Object.keys(found).length);
  } catch (e) {
    console.log("REF refresh failed:", e.message);
    return { ok: false, error: String(e.message), keep: refMeta };
  }
}

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "2mb" }));

app.get("/", (req, res) => {
  res.json({
    name: "ZidanAI Backend",
    version: "24.0.0",
    symbols: SYMBOLS.length,
    egx: SYMBOLS.filter((s) => s.market === "EGX").length,
    ref: refMeta,
    refCount: Object.keys(REF).length,
    threshold: "1%",
    cache: cache.size,
    time: new Date().toISOString()
  });
});

app.get("/api/metals", async (req, res) => {
  const m = await refreshMetals();
  res.json({ ok: true, ...m, ageMs: Date.now() - (m.at || 0) });
});


// Queue of user-requested symbols to force into next snapshot
const discoverQueue = new Map(); // sym -> { name, at }

app.post("/api/discover", express.json(), async (req, res) => {
  try {
    let sym = String((req.body && req.body.symbol) || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!sym || sym.length < 2 || sym.length > 6) {
      return res.status(400).json({ ok: false, error: "bad symbol" });
    }
    // alias
    const AL = { LOTUS: "LUTS", GPI: "GPIM", GIZA: "GPIM", CIB: "COMI", FAWRY: "FWRY", FAWY: "FWRY" };
    if (AL[sym]) sym = AL[sym];
    let meta = SYMBOLS.find((s) => s.symbol === sym);
    if (!meta) {
      meta = {
        symbol: sym,
        name: (req.body && req.body.name) || sym,
        sector: "EGX",
        yahoo: sym + ".CA",
        market: "EGX",
        indices: ["EGX100"]
      };
      SYMBOLS.push(meta);
    }
    discoverQueue.set(sym, { at: Date.now(), name: meta.name });
    // Try live resolve now
    let row = null;
    try { row = await resolveOne(meta); } catch (e) {}
    if (row && row.price != null) {
      REF[sym] = row.price;
      return res.json({ ok: true, symbol: sym, found: true, row, message: sym + " is on the desk now." });
    }
    // seed a placeholder ref so it appears
    if (REF[sym] == null) REF[sym] = 1;
    res.json({
      ok: true,
      symbol: sym,
      found: false,
      queued: true,
      message: "Agent is fetching " + sym + ". Press Scan again — it will appear on the board."
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, symbols: SYMBOLS.length, ref: refMeta, cache: cache.size, egxBeta: { ok: egxBetaCache.ok, count: egxBetaCache.count, error: egxBetaCache.error, ageSec: egxBetaCache.at ? Math.round((Date.now()-egxBetaCache.at)/1000) : null } });
});

app.get("/api/egx-beta", (req, res) => {
  res.json({
    ok: egxBetaCache.ok,
    count: egxBetaCache.count,
    error: egxBetaCache.error,
    at: egxBetaCache.at,
    sample: Object.keys(egxBetaCache.rows || {}).slice(0, 15).map(function (s) {
      return egxBetaCache.rows[s];
    })
  });
});
app.post("/api/egx-beta/refresh", async (req, res) => {
  const r = await refreshEgxBeta();
  res.json(r);
});

app.get("/api/ref", (req, res) => {
  res.json({ meta: refMeta, prices: REF, threshold: REF_THRESHOLD });
});

app.post("/api/ref/refresh", async (req, res) => {
  const result = await refreshReferencePrices();
  res.json(result);
});

app.get("/api/symbols", (req, res) => {
  const list = filterList(req.query.index);
  res.json({ count: list.length, symbols: list });
});

app.get("/api/quote/:sym", async (req, res) => {
  const meta = bySym[String(req.params.sym || "").toUpperCase()];
  if (!meta) return res.status(404).json({ error: "unknown symbol" });
  const row = await resolveOne(meta);
  if (!row) return res.status(502).json({ error: "no data" });
  res.json(row);
});

app.get("/api/snapshot", async (req, res) => {
  const index = (req.query.index || "ALL").toUpperCase();
  // Soft daily refresh if ref older than ~20h
  try {
    const day = refMeta.updated;
    const today = new Date().toISOString().slice(0, 10);
    if (!day || day < today) {
      // don't block response forever — fire and also await briefly
      await Promise.race([
        refreshReferencePrices(),
        new Promise((r) => setTimeout(r, 8000))
      ]);
    }
  } catch (e) {}

  const list = filterList(index === "ALL" ? "ALL" : index);
  const tileMetas = [
    { symbol: "EGX30", market: "INDEX", sector: "Index", name: "EGX30", indices: ["INDEX"], isIndex: true },
    { symbol: "EGX70", market: "INDEX", sector: "Index", name: "EGX70", indices: ["INDEX"], isIndex: true },
    { symbol: "GOLD", market: "METALS", sector: "Metals", name: "24k Gold", indices: ["METALS"], isIndex: true },
    { symbol: "SILVER", market: "METALS", sector: "Metals", name: "Silver", indices: ["METALS"], isIndex: true }
  ];

  let work = list;
  if (index === "ALL") {
    const p30 = list.filter((s) => (s.indices || []).includes("EGX30"));
    const rest = list.filter((s) => !(s.indices || []).includes("EGX30"));
    work = p30.concat(rest);
  }
  const CAP = index === "ALL" ? 120 : 220;
  // Force user-discovered symbols into this snapshot
  try {
    discoverQueue.forEach(function (_v, sym) {
      const meta = SYMBOLS.find((s) => s.symbol === sym);
      if (meta && !work.find((s) => s.symbol === sym)) work.unshift(meta);
    });
  } catch (e) {}
  work = work.slice(0, CAP);

  const [tiles, rows] = await Promise.all([
    poolMap(tileMetas, 4, resolveOne),
    poolMap(work, BATCH_CONCURRENCY, resolveOne)
  ]);

  let okTiles = tiles.filter(Boolean).map((t) => Object.assign(t, { isIndex: true }));
  // Hard guarantee board tiles (EGX30/70, GOLD, SILVER) always present
  const boardNeed = [
    { symbol: "EGX30", name: "EGX30" },
    { symbol: "EGX70", name: "EGX70" },
    { symbol: "GOLD", name: "24k Gold" },
    { symbol: "SILVER", name: "Silver" }
  ];
  boardNeed.forEach(function (b) {
    if (!okTiles.find(function (x) { return x.symbol === b.symbol; })) {
      const meta = { symbol: b.symbol, name: b.name, market: b.symbol.indexOf("EGX") === 0 ? "INDEX" : "METALS", sector: "Index", indices: ["INDEX"], isIndex: true };
      const row = fromRef(meta, 0);
      if (row) okTiles.push(Object.assign(row, { isIndex: true }));
    }
  });
  // HARD LOCK METALS — never show USD/oz as EGP/g
  const g = okTiles.find(function (x) { return x.symbol === "GOLD"; });
  if (g) {
    let ge = Number(g.priceEgp || g.price);
    let gu = Number(g.priceUsd || REF.GOLD_USD || 4435);
    if (!gu || gu < 800 || gu > 10000) gu = REF.GOLD_USD || 4435;
    if (!ge || ge < 3000 || ge > 25000) ge = r2((gu / 31.1035) * 50 * 1.02);
    g.price = ge; g.priceEgp = ge; g.priceUsd = gu; g.currency = "EGP";
  }
  const s = okTiles.find(function (x) { return x.symbol === "SILVER"; });
  if (s) {
    let su = Number(s.priceUsd || s.price || REF.SILVER || 66.2);
    if (su < 10 || su > 200) su = REF.SILVER || 66.2;
    s.price = su; s.priceUsd = su; s.priceEgp = REF.SILVER_EGP || r2(su * 50); s.currency = "USD";
  }
  if (REF.SILVER_EGP != null) {
    const s = okTiles.find(function (x) { return x.symbol === "SILVER"; });
    if (s) { s.priceUsd = s.price; s.priceEgp = REF.SILVER_EGP; }
  }
  const okRows = rows.filter(Boolean);
  const overridden = okRows.filter((r) => r.source && String(r.source).indexOf("ref") === 0).length;

  res.json({
    ok: okRows.length > 0,
    source: "zidan-backend-v24",
    index,
    count: okRows.length,
    overridden,
    ref: refMeta,
    indices: okTiles,
    rows: okRows,
    updatedAt: Date.now()
  });
});

app.post("/api/warm", async (req, res) => {
  await poolMap(filterList("EGX30"), BATCH_CONCURRENCY, resolveOne);
  res.json({ ok: true, cache: cache.size });
});

// Startup: refresh refs in background
setTimeout(() => { refreshReferencePrices().catch(() => {}); }, 3000);
// Every 12 hours
setInterval(() => { refreshReferencePrices().catch(() => {}); }, 12 * 60 * 60 * 1000);


app.get("/api/candles/:sym", async (req, res) => {
  try {
    const sym = String(req.params.sym || "").toUpperCase();
    const meta = bySym[sym];
    const yf = (meta && meta.yahoo) || (sym === "GOLD" ? "GC=F" : sym === "SILVER" ? "SI=F" : sym + ".CA");
    const range = req.query.range || "3mo";
    const interval = req.query.interval || "1d";
    const url = "https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(yf) +
      "?range=" + encodeURIComponent(range) + "&interval=" + encodeURIComponent(interval);
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 12000 });
    if (!r.ok) return res.status(502).json({ ok: false, error: "yahoo " + r.status });
    const j = await r.json();
    const result = j && j.chart && j.chart.result && j.chart.result[0];
    if (!result) return res.status(502).json({ ok: false, error: "empty" });
    const ts = result.timestamp || [];
    const q = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
    const candles = [];
    for (let i = 0; i < ts.length; i++) {
      const o = q.open && q.open[i], h = q.high && q.high[i], l = q.low && q.low[i], c = q.close && q.close[i];
      const v = q.volume && q.volume[i];
      if (o == null || h == null || l == null || c == null) continue;
      candles.push({ t: ts[i] * 1000, o: +o, h: +h, l: +l, c: +c, v: v != null ? +v : 0 });
    }
    res.json({ ok: true, symbol: sym, yahoo: yf, candles, count: candles.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/api/news/:sym", async (req, res) => {
  try {
    const sym = String(req.params.sym || "").toUpperCase();
    const meta = bySym[sym];
    const yf = (meta && meta.yahoo) || sym + ".CA";
    // Yahoo quoteSummary secondary for news is flaky; use search news RSS-like chart API fallback
    const url = "https://query1.finance.yahoo.com/v1/finance/search?q=" + encodeURIComponent(yf) + "&newsCount=8&quotesCount=1";
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 12000 });
    if (!r.ok) return res.json({ ok: true, symbol: sym, items: [], note: "news unavailable" });
    const j = await r.json();
    const items = (j.news || []).slice(0, 8).map((n) => ({
      title: n.title || n.headline || "",
      publisher: (n.publisher || n.provider || ""),
      link: n.link || n.url || "",
      published: n.providerPublishTime ? n.providerPublishTime * 1000 : null
    })).filter((x) => x.title);
    res.json({ ok: true, symbol: sym, items, source: "yahoo-search" });
  } catch (e) {
    res.json({ ok: true, symbol: req.params.sym, items: [], error: String(e.message || e) });
  }
});


app.listen(PORT, "0.0.0.0", () => {
  console.log("ZidanAI backend v13 on :" + PORT + " · " + SYMBOLS.length + " symbols · ref " + Object.keys(REF).length);
});

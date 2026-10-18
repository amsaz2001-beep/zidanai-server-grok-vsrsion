/**
 * ZidanAI MCP Agent Bridge v1
 * Model-Context-Protocol style tools for live EGX / metals data.
 *
 * Honest limits:
 * - Thndr (thndr.app) has NO public developer API for market data.
 *   Thndr connection = user screenshot OCR only (client-side).
 * - Official EGX full ticks require broker/licensed feed.
 * - This bridge exposes standardized tools so AI agents always
 *   call the same interface: get_quote, get_snapshot, get_metals, etc.
 *
 * Optional: set env EGX_API_KEY to use https://api.egxapi.com when available.
 */
"use strict";

const TOOLS = [
  {
    name: "get_quote",
    description: "Latest price for one EGX symbol or metal (COMI, SWDY, GOLD, EGX30, …).",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Ticker e.g. COMI or GOLD" }
      },
      required: ["symbol"]
    }
  },
  {
    name: "get_egx_snapshot",
    description: "Full EGX board snapshot used by the app (indices + stocks).",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "get_metals",
    description: "Gold and silver in USD and EGP.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "get_indices",
    description: "EGX30 / EGX70 / EGX100 levels.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "list_sources",
    description: "Which live data sources are active and their health.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "thndr_status",
    description: "Explain how Thndr data can be used (screenshot OCR only — no public API).",
    inputSchema: { type: "object", properties: {} }
  }
];

function createMcpBridge(ctx) {
  // ctx: { REF, resolveOne, SYMBOLS, metalsCache, egxBetaCache, fetch, REF_THRESHOLD }
  async function callTool(name, args) {
    args = args || {};
    const sym = String(args.symbol || "").toUpperCase().replace(/\.CA$/, "");

    if (name === "list_sources") {
      const beta = ctx.egxBetaCache || {};
      return {
        sources: [
          {
            id: "egx-beta",
            status: beta.ok ? "live" : "degraded",
            pollSec: 30,
            count: beta.count || 0,
            error: beta.error || null,
            note: "beta.egx.com.eg BFF — official beta when WAF allows"
          },
          {
            id: "board-ref",
            status: "active",
            updated: ctx.refMeta && ctx.refMeta.updated,
            note: "Calibrated board lock when feed drifts > threshold"
          },
          {
            id: "egxapi",
            status: process.env.EGX_API_KEY ? "configured" : "optional",
            note: "Set EGX_API_KEY env for api.egxapi.com free key"
          },
          {
            id: "thndr",
            status: "screenshot-only",
            note: "No public API — user attaches Thndr depth/chart screenshots for OCR"
          },
          {
            id: "metals",
            status: "active",
            note: "Gold/silver FX path refreshed on interval"
          }
        ]
      };
    }

    if (name === "thndr_status") {
      return {
        publicApi: false,
        reason: "Thndr publishes no developer market-data API (confirmed 2026).",
        howAgentsUseThndr: [
          "User opens Thndr → stock → depth or candle chart",
          "Screenshot → attach in ZidanAI Tools or AEON chat",
          "OCR agent extracts price, bid/ask, volume, levels",
          "Council merges OCR with board snapshot for decision"
        ],
        alternativeLive: ["egx-beta poll", "EGX_API_KEY if you register at egxapi.com", "board REF lock"]
      };
    }

    if (name === "get_metals") {
      const m = ctx.metalsCache || {};
      return {
        goldUsd: m.goldUsd || ctx.REF.GOLD_USD,
        goldEgp: m.goldEgp || ctx.REF.GOLD,
        silverUsd: m.silverUsd || ctx.REF.SILVER,
        silverEgp: m.silverEgp || ctx.REF.SILVER_EGP,
        source: m.source || "ref",
        at: m.at || null
      };
    }

    if (name === "get_indices") {
      return {
        EGX30: { price: ctx.REF.EGX30, source: "board" },
        EGX70: { price: ctx.REF.EGX70, source: "board" },
        EGX100: { price: ctx.REF.EGX100, source: "board" },
        boardDate: ctx.refMeta && ctx.refMeta.updated
      };
    }

    if (name === "get_quote") {
      if (!sym) return { error: "symbol required" };
      // Prefer beta cache
      const beta = (ctx.egxBetaCache && ctx.egxBetaCache.rows && ctx.egxBetaCache.rows[sym]) || null;
      if (beta && beta.price > 0) {
        return { symbol: sym, price: beta.price, changePct: beta.changePct || 0, source: "egx-beta", live: true };
      }
      // Optional EGXAPI
      if (process.env.EGX_API_KEY) {
        try {
          const r = await ctx.fetch("https://api.egxapi.com/v1/quotes/" + encodeURIComponent(sym), {
            headers: { Authorization: "Bearer " + process.env.EGX_API_KEY, Accept: "application/json" },
            timeout: 12000
          });
          if (r.ok) {
            const j = await r.json();
            const price = +(j.price || j.last || j.close || 0);
            if (price > 0) {
              return {
                symbol: sym,
                price,
                changePct: +(j.changePct || j.change_percent || 0),
                source: "egxapi",
                live: true
              };
            }
          }
        } catch (e) { /* fall through */ }
      }
      // resolveOne path
      if (typeof ctx.resolveOne === "function") {
        const meta = (ctx.SYMBOLS || []).find(function (s) {
          return s.symbol === sym || s.symbol === sym + ".CA";
        }) || { symbol: sym, market: "EGX" };
        try {
          const row = await ctx.resolveOne(meta);
          if (row && row.price > 0) {
            return {
              symbol: sym,
              price: row.price,
              changePct: row.changePct || 0,
              source: row.source || "resolve",
              live: !!row.live
            };
          }
        } catch (e2) {}
      }
      const ref = ctx.REF[sym];
      if (ref != null && +ref > 0) {
        return { symbol: sym, price: +ref, changePct: 0, source: "board-ref", live: false };
      }
      return { error: "unknown symbol", symbol: sym };
    }

    if (name === "get_egx_snapshot") {
      // Build lightweight snapshot from REF + beta
      const rows = [];
      const betaRows = (ctx.egxBetaCache && ctx.egxBetaCache.rows) || {};
      const seen = {};
      Object.keys(betaRows).forEach(function (s) {
        seen[s] = 1;
        rows.push({
          symbol: s,
          price: betaRows[s].price,
          changePct: betaRows[s].changePct || 0,
          source: "egx-beta",
          live: true
        });
      });
      Object.keys(ctx.REF || {}).forEach(function (s) {
        if (seen[s]) return;
        if (/_USD|_EGP|SILVER_EGP/.test(s)) return;
        rows.push({ symbol: s, price: ctx.REF[s], changePct: 0, source: "board-ref", live: false });
      });
      return {
        count: rows.length,
        betaOk: !!(ctx.egxBetaCache && ctx.egxBetaCache.ok),
        boardDate: ctx.refMeta && ctx.refMeta.updated,
        rows: rows.slice(0, 400)
      };
    }

    return { error: "unknown tool", name: name };
  }

  function listTools() {
    return { tools: TOOLS, protocol: "zidan-mcp/1.0", thndrPublicApi: false };
  }

  return { listTools: listTools, callTool: callTool, TOOLS: TOOLS };
}

module.exports = { createMcpBridge, TOOLS };

// server/adapters/iddaaResultsAdapter.js
// ============================================================================
//  Türkiye maç sonuçları — SofaScore + Nesine + Bilyoner
//  S8 → S33 TITAN FINAL ADAPTER
//  ZERO DELETE — tüm eski davranış korunur, sadece güçlendirme yapılır.
// ============================================================================

import fetch from "node-fetch";
import * as cheerio from "cheerio";

import {
  loadCheerioS200,
  withTimeout,
  TimeoutError,
  coerceItemsS200,
  normalizeItemS200,
  safeStr,
} from "../core/s200AdapterKit.js";

// ============================================================================
// HELPERS — S33 LEVEL
// ============================================================================
function safe(v) {
  return v == null ? "" : String(v).trim();
}

const normalizeName = (t) => safe(t).replace(/\s+/g, " ").trim();

// TITAN stableId 2.0
function stableId(provider, home, away, extra = "") {
  const seed = `${provider}::${home}::${away}::${extra}`;
  return (
    "iddaa_" +
    Buffer.from(seed)
      .toString("base64")
      .replace(/[^A-Za-z0-9]/g, "")
      .slice(0, 18)
  );
}

// TITAN item builder
function buildTitanItem(raw = {}) {
  const id =
    raw.id || stableId("iddaa", raw.home || "", raw.away || "", raw.score || "");

  return {
    id,
    title: raw.title || "",
    price: null,
    optimizedPrice: null,
    priceConfidence: null,

    rating: null,
    stock: null,

    provider: "iddaa",
    providerFamily: "iddaa",
    providerType: "sports",
    vertical: "sports",

    currency: "TRY",
    region: raw.region || "TR",

    category: "sports",
    categoryAI: "sports",

    url: raw.url || null,
    deeplink: raw.url || null,

    image: null,
    imageOriginal: null,
    imageProxy: null,
    hasProxy: false,

    home: raw.home || null,
    away: raw.away || null,
    score: raw.score || null,
    minute: raw.minute || null,
    competition: raw.competition || null,

    raw,
    qualityScore: computeQualityScore(raw),
  };
}

// S33 sports quality score
function computeQualityScore(raw) {
  let s = 0;
  if (raw.title) s += 0.55;
  if (raw.score) s += 0.25;
  if (raw.competition) s += 0.15;
  s += 0.05; // provider bonus
  return Number(s.toFixed(2));
}

// ============================================================================
// 1) SofaScore — primary source
// ============================================================================
async function fetchFromSofa(query, signal) {
  try {
    const url =
      "https://api.sofascore.com/api/v1/search/multi?query=" +
      encodeURIComponent(query);

    const res = await fetch(url, {
      method: "GET",
      signal,
      headers: {
        "User-Agent": "FindAllEasyBot/TITAN",
        "Accept-Language": "tr-TR,tr;q=0.9",
      },
    });

    if (!res.ok) return [];

    const data = await res.json();
    const events = data?.football?.events || [];

    return events.map((ev) =>
      buildTitanItem({
        id: ev.id,
        title: `${ev.homeTeam?.name} - ${ev.awayTeam?.name}`,
        home: ev.homeTeam?.name,
        away: ev.awayTeam?.name,
        score: ev.status?.description || "",
        minute: ev.statusTime || null,
        competition: ev.tournament?.name,
        url: `https://www.sofascore.com/event/${ev.id}`,
        region: "TR",
      })
    );
  } catch (e) {
    if (e.name === "AbortError") return [];
    return [];
  }
}

// ============================================================================
// 2) Nesine — fallback
// ============================================================================
async function fetchFromNesine(query, signal) {
  try {
    const url =
      "https://www.nesine.com/iddaa?search=" + encodeURIComponent(query);

    const res = await fetch(url, {
      method: "GET",
      signal,
      headers: { "User-Agent": "Mozilla/5.0" },
    });

    if (!res.ok) return [];

    const html = await res.text();
    const $ = loadCheerioS200(html);
    const out = [];

    $("div.search-result-item").each((i, el) => {
      const home = normalizeName($(el).find(".team-home").text());
      const away = normalizeName($(el).find(".team-away").text());
      const score = safe($(el).find(".score").text());
      const league = safe($(el).find(".league-name").text());

      if (!home || !away) return;

      out.push(
        buildTitanItem({
          id: `${home}-${away}-${i}`,
          title: `${home} - ${away}`,
          home,
          away,
          score,
          competition: league,
          region: "TR",
          url: null,
        })
      );
    });

    return out;
  } catch (e) {
    if (e.name === "AbortError") return [];
    return [];
  }
}

// ============================================================================
// 3) Bilyoner — fallback 2
// ============================================================================
async function fetchFromBilyoner(query, signal) {
  try {
    const url =
      "https://www.bilyoner.com/iddaa?search=" + encodeURIComponent(query);

    const res = await fetch(url, {
      method: "GET",
      signal,
      headers: { "User-Agent": "Mozilla/5.0" },
    });

    if (!res.ok) return [];

    const html = await res.text();
    const $ = loadCheerioS200(html);
    const out = [];

    $(".SearchMatchCard").each((i, el) => {
      const home = normalizeName($(el).find(".team-home").text());
      const away = normalizeName($(el).find(".team-away").text());
      const sc = safe($(el).find(".match-score").text());
      const lg = safe($(el).find(".league-info").text());

      if (!home || !away) return;

      out.push(
        buildTitanItem({
          id: `${home}-${away}-${i}`,
          title: `${home} - ${away}`,
          home,
          away,
          score: sc,
          competition: lg,
          region: "TR",
          url: null,
        })
      );
    });

    return out;
  } catch (e) {
    if (e.name === "AbortError") return [];
    return [];
  }
}

// ============================================================================
// 4) UNIVERSAL WRAPPER — S33 TITAN FINAL
// ============================================================================
export async function searchIddaaResultsLegacy(query, regionOrOptions = "TR") {
  let region = "TR";
  let signal;

  if (typeof regionOrOptions === "object") {
    region = regionOrOptions.region || "TR";
    signal = regionOrOptions.signal;
  }

  const q = safe(query);
  if (!q) {
    return {
      ok: true,
      adapterName: "iddaa",
      items: [],
      count: 0,
    };
  }

  try {
    const sofa = await fetchFromSofa(q, signal);
    if (sofa.length > 0)
      return { ok: true, adapterName: "iddaa", items: sofa, count: sofa.length };

    const nes = await fetchFromNesine(q, signal);
    if (nes.length > 0)
      return { ok: true, adapterName: "iddaa", items: nes, count: nes.length };

    const bil = await fetchFromBilyoner(q, signal);
    return { ok: true, adapterName: "iddaa", items: bil, count: bil.length };
  } catch (err) {
    if (err.name === "AbortError") {
      return {
        ok: false,
        adapterName: "iddaa",
        timeout: true,
        items: [],
        count: 0,
      };
    }

    return {
      ok: false,
      adapterName: "iddaa",
      error: err?.message || "unknown",
      items: [],
      count: 0,
    };
  }
}

// ============================================================================
// S200 WRAPPER — iddaa (results, no-query) — KIT-LOCKED
// Output: { ok, items, count, source, _meta }
// ============================================================================
const S200_PROVIDER_KEY = "iddaa";
const S200_PROVIDER_FAMILY = "iddaa";
const S200_TIMEOUT_MS = (() => {
  const n = Number(process.env.IDDAA_TIMEOUT_MS || 5200);
  return Number.isFinite(n) ? Math.max(1500, Math.min(20000, n)) : 5200;
})();

function setS200Ctx(url = "") {
  try {
    globalThis.__S200_ADAPTER_CTX = {
      adapter: S200_PROVIDER_KEY,
      providerKey: S200_PROVIDER_KEY,
      query: "iddaa_results",
      url: safeStr(url, 900),
    };
  } catch {}
}

export async function searchIddaaResults(queryOrOptions = {}, maybeOptions = {}) {
  const opts =
    (typeof queryOrOptions === "object" && queryOrOptions && !Array.isArray(queryOrOptions))
      ? queryOrOptions
      : (typeof maybeOptions === "object" ? (maybeOptions || {}) : {});
  const region = (opts.region || "TR").toString();
  const signal = opts.signal;

  setS200Ctx("");

  try {
    const raw = await withTimeout(
      Promise.resolve().then(() => searchIddaaResultsLegacy({ ...opts, region, signal })),
      S200_TIMEOUT_MS,
      S200_PROVIDER_KEY
    );

    if (raw && typeof raw === "object" && raw.ok === false) {
      return {
        ok: false,
        items: [],
        count: 0,
        source: S200_PROVIDER_KEY,
        _meta: {
          providerKey: S200_PROVIDER_KEY,
          region,
          timeout: !!raw.timeout,
          error: raw.error || raw.message || "legacy_fail",
        },
      };
    }

    const rawItems = coerceItemsS200(raw);
    let dropped = 0;
    const items = [];

    for (const it of rawItems) {
      if (!it) { dropped++; continue; }
      const clean = { ...it };
      delete clean.id;
      delete clean.listingId;

      // Results do not have prices
      clean.price = null;
      clean.finalPrice = null;
      clean.optimizedPrice = null;

      const norm = normalizeItemS200(
        {
          ...clean,
          providerKey: S200_PROVIDER_KEY,
          providerFamily: S200_PROVIDER_FAMILY,
          vertical: "sports",
          category: "sports",
          region,
          currency: null,
        },
        S200_PROVIDER_KEY,
        {
          vertical: "sports",
          category: "sports",
          providerFamily: S200_PROVIDER_FAMILY,
          region,
          currency: null,
          titleFallback: "İddaa sonucu",
          requireRealUrlCandidate: true,
        }
      );

      if (!norm) { dropped++; continue; }
      norm.price = null;
      norm.finalPrice = null;
      norm.optimizedPrice = null;

      items.push(norm);
    }

    return {
      ok: true,
      items,
      count: items.length,
      source: S200_PROVIDER_KEY,
      _meta: {
        providerKey: S200_PROVIDER_KEY,
        region,
        rawCount: rawItems.length,
        dropped,
      },
    };
  } catch (e) {
    const timeout = e instanceof TimeoutError || e?.name === "AbortError" || signal?.aborted;
    return {
      ok: false,
      items: [],
      count: 0,
      source: S200_PROVIDER_KEY,
      _meta: {
        providerKey: S200_PROVIDER_KEY,
        region,
        timeout,
        error: e?.message || String(e),
      },
    };
  }
}


export default { searchIddaaResults };

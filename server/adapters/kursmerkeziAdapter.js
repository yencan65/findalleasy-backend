// server/adapters/kursmerkeziAdapter.js
// ============================================================================
//  KursMerkezi Adapter — S5 → S22 ULTRA TITAN
// ----------------------------------------------------------------------------
//  ZERO DELETE — Fonksiyon isimleri korunur
//  ✔ proxyFetchHTML + axios fallback + anti-bot cleaner
//  ✔ deterministic stableId (Titan Merge uyumlu)
//  ✔ ImageVariants S22
//  ✔ provider meta + categoryAI
//  ✔ qualityScore
//  ✔ normalize-friendly S22 output
// ============================================================================

import axios from "axios";
import * as cheerio from "cheerio";

import { proxyFetchHTML } from "../core/proxyEngine.js";
import { buildImageVariants } from "../utils/imageFixer.js";

import { coerceItemsS200, fixKey, loadCheerioS200, normalizeItemS200, withTimeout } from "../core/s200AdapterKit.js";

// ---------------------------------------------------------------------------
// STUB POLICY (HARD)
// - PROD: stubs/mocks/fallback listings are BLOCKED (NO FAKE RESULTS)
// - DEV: allow via FINDALLEASY_ALLOW_STUBS=1
// ---------------------------------------------------------------------------
const FINDALLEASY_ALLOW_STUBS = String(process.env.FINDALLEASY_ALLOW_STUBS || "") === "1";


// ------------------------------------------------------------
// HELPERS
// ------------------------------------------------------------
function clean(v) {
  return String(v || "").trim();
}

function detectCategory() {
  return "education";
}

function cleanBotTraps(html) {
  return String(html || "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
}

function stableId(provider, title, href) {
  const seed = `${provider}::${title}::${href}`;
  return "kurs_" + Buffer.from(seed).toString("base64").slice(0, 14);
}

function computeQualityScore(item) {
  let s = 0;
  if (item.title) s += 0.45;
  if (item.provider) s += 0.2;
  if (item.image) s += 0.2;
  if (item.region) s += 0.15;
  return Number(s.toFixed(2));
}

// S22 Image extractor
function extractImageStrong($, el) {
  const direct =
    clean($(el).find("img").attr("data-src")) ||
    clean($(el).find("img").attr("src")) ||
    clean($(el).find("picture img").attr("src"));

  return direct || null;
}

// ------------------------------------------------------------
// FETCH WRAPPER — proxy → axios fallback
// ------------------------------------------------------------
async function fetchHTML(url, signal) {
  try {
    return await proxyFetchHTML(url);
  } catch {
    try {
      const cfg = {
        timeout: 15000,
        headers: { "User-Agent": "Mozilla/5.0" },
      };
      if (signal) cfg.signal = signal;

      const { data } = await axios.get(url, cfg);
      return data;
    } catch {
      return null;
    }
  }
}

// ======================================================
// PAGE SCRAPER — S22 TITAN
// ======================================================
async function scrapeKursMerkeziPage(query, signal = null) {
  try {
    const q = encodeURIComponent(query);
    const url = `https://kursmerkezi.com/arama?query=${q}`;

    const html = await fetchHTML(url, signal);
    if (!html) return [];

    const $ = loadCheerioS200(cleanBotTraps(html));
    const items = [];

    const selectors = [
      ".course-card",
      ".course-item",
      ".listing-card",
      "div[data-course-id]",
      ".card-course",
      "li.course-card",
      ".course-box",
    ];

    $(selectors.join(", ")).each((i, el) => {
      const title =
        clean($(el).find(".course-title").text()) ||
        clean($(el).find(".title").text()) ||
        clean($(el).find("h3").text()) ||
        clean($(el).attr("data-title"));

      if (!title) return;

      let href =
        clean($(el).find("a").attr("href")) ||
        clean($(el).find(".course-link").attr("href"));

      if (!href) return;
      if (!href.startsWith("http"))
        href = "https://kursmerkezi.com" + href;

      const imgRaw = extractImageStrong($, el);
      const image = buildImageVariants(imgRaw);

      const id = stableId("kursmerkezi", title, href);

      const base = {
        id,
        title,
        price: null,
        rating: null,

        provider: "kursmerkezi",
        providerType: "education",
        providerFamily: "kursmerkezi",
        vertical: "education",

        currency: "TRY",
        region: "TR",

        url: href,
        deeplink: href,

        image: image.image,
        imageOriginal: image.imageOriginal,
        imageProxy: image.imageProxy,
        hasProxy: image.hasProxy,

        category: detectCategory(title),
        categoryAI: "course",

        fallback: false,

        raw: { title, href, imgRaw },
      };

      items.push({
        ...base,
        qualityScore: computeQualityScore(base),
        optimizedPrice: null, // Kurs fiyatları çoğunlukla gösterilmiyor
      });
    });

    return items;
  } catch (err) {
    if (err.name === "AbortError") {
      console.warn("⛔ KursMerkezi → Abort edildi (signal)");
      return [];
    }
    console.warn("KursMerkezi scrape hata:", err.message);
    return [];
  }
}

// ======================================================
// MAIN ADAPTER — S22 UYUMLU
// ======================================================
async function searchKursMerkeziLegacy(query, { region = "TR", signal } = {}) {
  try {
    const q = clean(query);
    if (!q) {
      return {
        ok: false,
        adapterName: "kursmerkezi",
        items: [],
        count: 0,
      };
    }

    const items = await scrapeKursMerkeziPage(q, signal);

    return {
      ok: true,
      adapterName: "kursmerkezi",
      items,
      count: items.length,
      region,
    };
  } catch (err) {
    if (err.name === "AbortError") {
      return {
        ok: false,
        adapterName: "kursmerkezi",
        timeout: true,
        items: [],
        count: 0,
      };
    }

    console.warn("searchKursMerkezi hata:", err.message);

    return {
      ok: false,
      adapterName: "kursmerkezi",
      error: err?.message || "unknown",
      items: [],
      count: 0,
    };
  }
}

// Backward compatibility

// ============================================================================
// S200 WRAPPER — FINAL (KIT-LOCKED, DRIFT-SAFE)
// Output: { ok, items, count, source, _meta }
// ============================================================================

function _s200ResolveRegionSignal(regionOrOptions, fallbackRegion = "TR") {
  let region = fallbackRegion;
  let signal = null;

  if (typeof regionOrOptions === "string") {
    region = regionOrOptions || fallbackRegion;
  } else if (regionOrOptions && typeof regionOrOptions === "object") {
    region = regionOrOptions.region || regionOrOptions.locale || fallbackRegion;
    signal = regionOrOptions.signal || null;
  }

  return { region: String(region || fallbackRegion).toUpperCase(), signal };
}

function _s200IsTimeout(e) {
  const n = String(e?.name || "").toLowerCase();
  const m = String(e?.message || "").toLowerCase();
  return n.includes("timeout") || m.includes("timed out");
}

function _s200IsFake(it) {
  if (!it || typeof it !== "object") return false;
  if (it.fallback === true || it.mock === true) return true;

  const u = String(it.affiliateUrl || it.deeplink || it.finalUrl || it.originUrl || it.url || "");
  if (!u) return false;

  if (u.includes("findalleasy.com/mock")) return true;
  return false;
}

// --------------------------------------------------------------------------------
// S200 WRAPPER — NO FAKE / NO CRASH / NO DRIFT
// --------------------------------------------------------------------------------
export async function searchKursMerkeziAdapter(q, opts = {}) {
  const startedAt = Date.now();
  const query = String(q ?? "").trim();
  const region = String(opts?.region ?? "TR");

  // empty/too-short query: return empty-state (NOT an error)
  if (!query || query.length < 2) {
    return {
      ok: true,
      items: [],
      count: 0,
      source: "kursmerkezi",
      _meta: { emptyQuery: true, providerKey: "kursmerkezi", region, tookMs: Date.now() - startedAt }
    };
  }

  try {
    // global context (some scrapers look at this; harmless otherwise)
    globalThis.__S200_ADAPTER_CTX = {
      adapter: "kursmerkezi",
      providerKey: "kursmerkezi",
      source: "kursmerkezi",
      region,
    };

    const raw = await withTimeout(
      () => searchKursMerkezi(query, opts),
      Number(opts?.timeoutMs ?? 6500),
      "kursmerkezi"
    );

    const arr = coerceItemsS200(raw);
    const items = [];
    for (const it of arr) {
      const norm = normalizeItemS200(it, { providerKey: "kursmerkezi", region });
      if (!norm?.title || !norm?.url) continue;

      if (!norm.id) norm.id = stableId("kursmerkezi", norm.url, norm.title);
      norm.providerKey = fixKey(norm.providerKey || "kursmerkezi");

      items.push(norm);
    }

    return {
      ok: true,
      items,
      count: items.length,
      source: "kursmerkezi",
      _meta: {
        providerKey: "kursmerkezi",
        region,
        tookMs: Date.now() - startedAt
      }
    };
  } catch (e) {
    const msg = String(e?.message || e || "Unknown error");
    const timeout = e?.name === "TimeoutError" || /timeout/i.test(msg);

    return {
      ok: false,
      items: [],
      count: 0,
      source: "kursmerkezi",
      _meta: {
        providerKey: "kursmerkezi",
        region,
        timeout,
        error: msg,
        name: e?.name,
        tookMs: Date.now() - startedAt
      }
    };
  }
}


export const searchKursMerkezi = searchKursMerkeziAdapter;
export const searchKursMerkeziScrape = searchKursMerkeziAdapter;

export default {
  searchKursMerkezi,
  searchKursMerkeziScrape,
  searchKursMerkeziAdapter,
  searchKursMerkeziLegacy
};

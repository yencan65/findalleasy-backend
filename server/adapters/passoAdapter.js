// server/adapters/passoAdapter.js
// ============================================================================
// PASSO — S200 HARDENED (v20251218_025640)
// ZERO DELETE: export isimleri korunur.
// S200 Standard:
// - Output: { ok, items, count, source, _meta } (legacy: Array return + props)
// - NO FAKE RESULTS (PROD): mock/stub KAPALI
// - Observable fail: not implemented / fetch fail / timeout => ok:false + items:[]
// - NO RANDOM ID: stableIdS200
// - Discovery/serp/osm değil → fiyat varsa normalizeItemS200 halleder (<=0 => null)
// ============================================================================

import axios from "axios";
import { proxyFetchHTML } from "../core/proxyEngine.js";
import { sanitizePrice } from "../utils/priceSanitizer.js";
import { optimizePrice } from "../utils/priceFixer.js";
import { buildImageVariants } from "../utils/imageFixer.js";

import {
  withTimeout,
  coerceItemsS200,
  normalizeItemS200,
  stableIdS200,
  loadCheerioS200,
} from "../core/s200AdapterKit.js";

// -----------------------------------------
// HELPERS
// -----------------------------------------
const safe = (v) => String(v ?? "").trim();

function asS200ArrayResult(items, { ok, source, _meta } = {}) {
  const arr = Array.isArray(items) ? items.filter(Boolean) : [];
  const out = arr.slice();            // return array
  out.ok = !!ok;
  out.items = arr.slice();            // non-circular
  out.count = out.items.length;
  out.source = source || "passo";
  out._meta = _meta || {};
  return out;
}

function stableId(provider, urlOrKey) {
  // ZERO DELETE: isim korunur ama NO RANDOM.
  return stableIdS200(String(provider || "passo"), String(urlOrKey || ""), String(urlOrKey || ""));
}

function parsePriceS22(text) {
  const n = sanitizePrice(text, { provider: "passo" });
  return Number.isFinite(n) ? n : null;
}

// -----------------------------------------
// AI CATEGORY (Event subtypes)
// -----------------------------------------
function detectEventCategory(title) {
  const t = (title || "").toLowerCase();
  if (/konser|concert/.test(t)) return "event_concert";
  if (/stand.?up|comedy/.test(t)) return "event_standup";
  if (/tiyatro|theatre/.test(t)) return "event_theatre";
  if (/festival/.test(t)) return "event_festival";
  if (/spor|match|maç/.test(t)) return "event_sport";
  return "event";
}

// -----------------------------------------
// MOCK (S7 davranışı korunur) — AMA PROD'da YASAK
// -----------------------------------------
function buildMockItems(query) {
  const term = query.toLowerCase();

  const mockEvents = [
    {
      keyword: "tarkan",
      item: {
        id: stableId("passo", "tarkan"),
        title: "Tarkan Konseri (Mock)",
        price: 450,
        currency: "TRY",
        provider: "event",
        providerKey: "passo",
        category: "event_concert",
        rating: 4.8,
        image: "https://www.passo.com.tr/mock/tarkan.jpg",
        url: "https://www.passo.com.tr/mock-event-url/tarkan",
        eventDate: new Date(Date.now() + 86400000 * 30).toISOString(),
        venue: "İstanbul",
      },
    },
    {
      keyword: "manga",
      item: {
        id: stableId("passo", "manga"),
        title: "maNga Canlı Performans (Mock)",
        price: 290,
        currency: "TRY",
        provider: "event",
        providerKey: "passo",
        category: "event_concert",
        rating: 4.6,
        image: "https://www.passo.com.tr/mock/manga.jpg",
        url: "https://www.passo.com.tr/mock-event-url/manga",
        eventDate: new Date(Date.now() + 86400000 * 40).toISOString(),
        venue: "Volkswagen Arena",
      },
    },
  ];

  const found = mockEvents.find((x) => term.includes(x.keyword));
  if (!found) return [];

  // S200 normalize
  const img = buildImageVariants(found.item.image);
  const n = normalizeItemS200(
    {
      ...found.item,
      image: img.image,
      imageOriginal: img.imageOriginal,
      imageProxy: img.imageProxy,
      raw: { stub: true, reason: "mock_item" },
    },
    "passo",
    { vertical: "event", category: found.item.category, providerFamily: "event" }
  );

  return n ? [n] : [];
}

// -----------------------------------------
// SCRAPE ATTEMPT (şu an skeleton)
// -----------------------------------------
async function tryScrapePassoS22(query, options = {}) {
  const url = "https://www.passo.com.tr/search?q=" + encodeURIComponent(query);
  const timeoutMs = Number(options.timeoutMs || process.env.S200_PROVIDER_TIMEOUT_MS || 6500);

  // global ctx (kit logları)
  try {
    globalThis.__S200_ADAPTER_CTX = {
      adapter: "passo",
      providerKey: "passo",
      url,
      query,
    };
  } catch {}

  let html = "";
  try {
    html = await withTimeout(proxyFetchHTML(url), timeoutMs, "passo:proxyFetchHTML");
  } catch (e1) {
    try {
      const res = await withTimeout(
        axios.get(url, {
          timeout: timeoutMs,
          headers: {
            "User-Agent": "Mozilla/5.0 (FindAllEasy-S200)",
            "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.7",
          },
        }),
        timeoutMs,
        "passo:axios.get"
      );
      html = res?.data || "";
    } catch (e2) {
      const msg = (e2?.message || e1?.message || "fetch_failed");
      return {
        ok: false,
        items: [],
        _meta: { error: msg, stage: "fetch", url },
      };
    }
  }

  if (!html || typeof html !== "string") {
    return {
      ok: false,
      items: [],
      _meta: { error: "html_not_string", stage: "fetch", url },
    };
  }

  // NOTE: Bu adapterin gerçek DOM selector'ları henüz yazılmadı.
  // S200: "not implemented" olarak gözükmeli (observable fail).
  return {
    ok: false,
    items: [],
    _meta: { notImplemented: true, stage: "parse", url },
  };
}

// ============================================================================
// MAIN
// ============================================================================
export async function searchPasso(query, options = {}) {
  const safeQuery = safe(query);
  if (!safeQuery) return asS200ArrayResult([], {
    ok: true,
    source: "passo",
    _meta: { emptyQuery: true },
  });

  const isProd = String(process.env.NODE_ENV || "").toLowerCase() === "production";
  const allowStubs =
    !isProd &&
    (String(process.env.FINDALLEASY_ALLOW_STUBS || "") === "1" || options.allowStubs === true);

  try {
    // 1) MOCK (DEV only)
    if (allowStubs) {
      const mock = buildMockItems(safeQuery);
      if (mock.length > 0) {
        const items = coerceItemsS200(mock);
        return asS200ArrayResult(items, {
          ok: true,
          source: "passo",
          _meta: { stub: true, reason: "mock", allowStubs: true },
        });
      }
    }

    // 2) SCRAPE (currently not implemented)
    const scraped = await tryScrapePassoS22(safeQuery, options);
    if (Array.isArray(scraped?.items) && scraped.items.length) {
      const items = coerceItemsS200(scraped.items);
      return asS200ArrayResult(items, {
        ok: true,
        source: "passo",
        _meta: { ...scraped._meta, fetched: true },
      });
    }

    // Not implemented / empty
    const meta = scraped?._meta || {};
    const ok = false; // until real scraper exists, empty == not implemented
    return asS200ArrayResult([], {
      ok,
      source: "passo",
      _meta: { ...meta, empty: true, allowStubs },
    });
  } catch (err) {
    const msg = err?.message || String(err);
    const isTimeout = /timed out|timeout/i.test(msg);
    return asS200ArrayResult([], {
      ok: false,
      source: "passo",
      _meta: {
        error: msg,
        timeout: isTimeout || undefined,
        stage: "unknown",
      },
    });
  }
}

export const searchPassoScrape = searchPasso;
export const searchPassoAdapter = searchPasso;

export default {
  searchPasso,
  searchPassoScrape,
  searchPassoAdapter,
};

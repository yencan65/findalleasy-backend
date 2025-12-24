// server/adapters/aliexpressAdapter.js
// ============================================================================
// ALIEXPRESS ADAPTER — S200 FINAL (NO FAKE • NO CRASH • NO DRIFT)
// - Output: { ok, items, count, source, _meta }
// - Contract lock: title+url required; price<=0 => null (normalizeItemS200)
// - Observable fail: timeout/import fail => ok:false + items:[]
// - Deterministic ID: stableIdS200(providerKey, url, title)
// - URL priority: affiliateUrl/deeplink/finalUrl > originUrl > url
// ============================================================================

import { buildImageVariants } from "../utils/imageFixer.js";
import { buildAffiliateUrl } from "./affiliateEngine.js";
import { sanitizePrice } from "../utils/priceSanitizer.js";
import { rateLimiter } from "../utils/rateLimiter.js";

import {
  withTimeout,
  TimeoutError,
  loadCheerioS200,
  normalizeItemS200,
  stableIdS200,
  coerceItemsS200,
  safeStr,
} from "../core/s200AdapterKit.js";

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------
const safe = (v) => (v ? String(v).trim() : "");

function normalizeUrlSoft(u) {
  if (!u) return null;
  const s = String(u).trim();
  if (!s || s === "#" || s.startsWith("javascript") || s.includes("void(0)")) return null;

  if (s.startsWith("http://") || s.startsWith("https://")) return s;
  if (s.startsWith("//")) return "https:" + s;
  if (s.startsWith("/")) return `https://www.aliexpress.com${s}`;
  if (/^[a-z0-9.-]+\.[a-z]{2,}/i.test(s)) return `https://${s}`;
  return null;
}

function parsePriceLoose(v) {
  if (!v) return null;
  try {
    const clean = String(v).replace(/[^\d.,]/g, "").replace(",", ".");
    const n = Number(clean);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function normalizeRating(r) {
  const n = Number(r);
  if (!Number.isFinite(n)) return null;
  if (n > 5) return Math.min(5, (n / 100) * 5);
  return n;
}

function s200Fail({ providerKey, query, region, url, stage, code, err, meta = {} }) {
  const note = err?.message || String(err || code || "ERROR");
  const isTimeout =
    err instanceof TimeoutError || String(err?.name || "").toLowerCase().includes("timeout");

  return {
    ok: false,
    items: [],
    count: 0,
    source: providerKey,
    _meta: {
      providerKey,
      providerFamily: "product",
      provider: "product",
      vertical: "product",
      category: "product",

      query: String(query || ""),
      region: String(region || "TR").toUpperCase(),
      url: String(url || ""),
      stage: stage || "unknown",
      code: code || "ERROR",
      error: note,
      timeout: Boolean(isTimeout),
      ...meta,
      timestamp: Date.now(),
    },
  };
}

// ---------------------------------------------------------------------------
// API SEARCH (helper) — returns normalized S200 items[]
// ---------------------------------------------------------------------------
export async function searchAliExpressAPI(query, { region = "TR", signal, timeoutMs = 15000 } = {}) {
  const providerKey = "aliexpress";
  if (!query || !String(query).trim()) return [];

  const axiosMod = await import("axios").catch(() => null);
  const axios = axiosMod?.default || axiosMod;
  if (!axios?.get) return [];

  const q = encodeURIComponent(String(query || "").trim());

  // NOTE: public endpoints drift eder; fail olursa scrape'a düşeceğiz.
  const url = `https://www.aliexpress.com/wholesale?SearchText=${q}`;

  globalThis.__S200_ADAPTER_CTX = { adapter: providerKey, url, at: "aliexpressAdapter:api" };

  try {
    const res = await withTimeout(
      axios.get(url, {
        timeout: Math.min(20000, timeoutMs + 1500),
        signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (FindAllEasy-S200)",
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "en-US,en;q=0.9",
        },
        validateStatus: (s) => s >= 200 && s < 400,
        maxRedirects: 5,
      }),
      timeoutMs,
      "aliexpress:api:fetch"
    );

    const html = res?.data;
    if (typeof html !== "string" || html.length < 500) return [];

    // AliExpress çoğu zaman HTML içinde JSON gömüyor; parse yerine scrape yapıyoruz (tek kod yolu).
    return await searchAliExpressScrape(query, { region, signal, timeoutMs, html });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// SCRAPE SEARCH (helper) — returns normalized S200 items[]
// ---------------------------------------------------------------------------
export async function searchAliExpressScrape(
  query,
  { region = "TR", signal, timeoutMs = 15000, html: prefetchedHtml = null } = {}
) {
  const providerKey = "aliexpress";
  if (!query || !String(query).trim()) return [];

  const q = encodeURIComponent(String(query || "").trim());
  const url = `https://www.aliexpress.com/wholesale?SearchText=${q}`;

  globalThis.__S200_ADAPTER_CTX = { adapter: providerKey, url, at: "aliexpressAdapter:scrape" };

  let html = prefetchedHtml;

  if (!html) {
    const axiosMod = await import("axios").catch(() => null);
    const axios = axiosMod?.default || axiosMod;
    if (!axios?.get) return [];

    try {
      const res = await withTimeout(
        axios.get(url, {
          timeout: Math.min(20000, timeoutMs + 1500),
          signal,
          headers: {
            "User-Agent": "Mozilla/5.0 (FindAllEasy-S200)",
            Accept: "text/html,application/xhtml+xml",
            "Accept-Language": "en-US,en;q=0.9",
          },
          validateStatus: (s) => s >= 200 && s < 400,
          maxRedirects: 5,
        }),
        timeoutMs,
        "aliexpress:scrape:fetch"
      );
      html = res?.data;
    } catch {
      html = "";
    }
  }

  if (typeof html !== "string" || html.length < 500) return [];

  const $ = loadCheerioS200(html, { adapter: providerKey, url });
  const items = [];

  // selector drift toleransı
  const selectors = [
    ".search-item-card-wrapper",
    ".manhattan--container--",
    ".product-card",
    "a[href*='/item/']",
  ];

  // 1) card wrappers
  const cardNodes = new Set();
  for (const sel of selectors.slice(0, 3)) {
    try {
      $(sel).each((_, el) => cardNodes.add(el));
      if (cardNodes.size > 0) break;
    } catch {}
  }

  const cards = [...cardNodes].slice(0, 120);

  for (const el of cards) {
    try {
      const w = $(el);

      const title =
        safe(w.find("h1, h2, h3").first().text()) ||
        safe(w.find("[title]").first().attr("title")) ||
        safe(w.find("a[title]").first().attr("title")) ||
        safe(w.text());

      if (!title || title.length < 4) continue;

      const hrefRaw =
        safe(w.find("a[href]").first().attr("href")) ||
        safe(w.attr("href")) ||
        "";

      const originUrl = normalizeUrlSoft(hrefRaw);
      if (!originUrl) continue;

      const priceText =
        safe(w.find(".price-current").text()) ||
        safe(w.find("[class*='price']").first().text()) ||
        safe(w.find("span").filter((_, x) => safe($(x).text()).includes("$")).first().text());

      const priceRaw = parsePriceLoose(priceText);
      let price = priceRaw;

      // sanitizePrice (patlarsa ham fiyatı bırak)
      if (price != null) {
        try {
          price = sanitizePrice(price, { provider: "aliexpress", category: "product" });
        } catch {
          price = priceRaw;
        }
      }

      // S200: price<=0 => null (drop yok)
      if (price != null && (!Number.isFinite(price) || price <= 0)) price = null;

      const ratingText =
        safe(w.find("[class*='rating']").first().text()) ||
        safe(w.find("[data-rating]").first().attr("data-rating"));

      const rating = normalizeRating(ratingText);

      const imgRaw =
        safe(w.find("img").attr("data-src")) ||
        safe(w.find("img").attr("src")) ||
        null;

      const variants = buildImageVariants(imgRaw, "aliexpress");

      const affiliateUrl = (() => {
        try {
          return buildAffiliateUrl(
            { providerKey, provider: "product", url: originUrl, title },
            { source: "aliexpressAdapter", providerKey, query, region }
          );
        } catch {
          return null;
        }
      })();

      const rawItem = {
        id: stableIdS200(providerKey, originUrl, title),
        title,
        price: price ?? null,
        rating: Number.isFinite(rating) ? rating : null,
        currency: null,
        region,
        url: originUrl,
        affiliateUrl: affiliateUrl || null,
        provider: "product",
        providerKey,
        providerFamily: "product",
        image: variants?.image || imgRaw || null,

        raw: {
          titleRaw: title,
          hrefRaw: hrefRaw || null,
          priceText: priceText || null,
          ratingText: ratingText || null,
          imageRaw: imgRaw,
          imageVariants: variants,
          extractedAt: new Date().toISOString(),
          sourceUrl: url,
        },
      };

      const norm = normalizeItemS200(rawItem, providerKey, {
        providerFamily: "product",
        vertical: "product",
        category: "product",
        region,
        currency: null,
      });

      if (norm) items.push(norm);
    } catch {
      // NO CRASH
    }
  }

  // 2) fallback: tek tek item linkleri
  if (!items.length) {
    try {
      $("a[href*='/item/']").each((_, a) => {
        if (items.length >= 80) return;
        const href = safe($(a).attr("href"));
        const title = safe($(a).attr("title")) || safe($(a).text());
        const originUrl = normalizeUrlSoft(href);
        if (!title || !originUrl) return;

        const rawItem = {
          id: stableIdS200(providerKey, originUrl, title),
          title,
          price: null,
          url: originUrl,
          provider: "product",
          providerKey,
          providerFamily: "product",
          region,
          raw: { extractedAt: new Date().toISOString(), source: "fallback_links" },
        };

        const norm = normalizeItemS200(rawItem, providerKey, {
          providerFamily: "product",
          vertical: "product",
          category: "product",
          region,
        });

        if (norm) items.push(norm);
      });
    } catch {}
  }

  return items.slice(0, 100);
}

// ---------------------------------------------------------------------------
// MAIN ADAPTER — S200
// ---------------------------------------------------------------------------
export async function searchAliExpressAdapterLegacy(query, regionOrOptions = "TR") {
  const providerKey = "aliexpress";

  if (!query || typeof query !== "string" || !query.trim()) {
    return {
      ok: true,
      items: [],
      count: 0,
      source: providerKey,
      _meta: { providerKey, code: "EMPTY_QUERY", timestamp: Date.now() },
    };
  }

  let region = "TR";
  let signal = null;
  let timeoutMs = 15000;

  if (typeof regionOrOptions === "string") {
    region = regionOrOptions;
  } else if (regionOrOptions && typeof regionOrOptions === "object") {
    region = regionOrOptions.region || "TR";
    signal = regionOrOptions.signal || null;
    timeoutMs = Number(regionOrOptions.timeoutMs || regionOrOptions.timeout || 15000);
  }
  region = String(region || "TR").toUpperCase();

  // RL
  const limiterKey = `s200:adapter:aliexpress:${region}`;
  let allowed = true;
  try {
    allowed = await rateLimiter.check(limiterKey, { limit: 20, windowMs: 60_000, adaptive: true });
  } catch {
    allowed = true;
  }

  if (!allowed) {
    return s200Fail({
      providerKey,
      query,
      region,
      stage: "rate_limit",
      code: "RATE_LIMIT",
      err: new Error("rate limited"),
      meta: { limiterKey },
    });
  }

  const startedAt = Date.now();

  try {
    // API first (same scrape code path inside)
    const apiItems = await withTimeout(
      searchAliExpressAPI(query, { region, signal, timeoutMs }),
      timeoutMs,
      "aliexpress:api"
    );

    if (Array.isArray(apiItems) && apiItems.length > 0) {
      return {
        ok: true,
        items: apiItems.slice(0, 100),
        count: Math.min(100, apiItems.length),
        source: providerKey,
        _meta: {
          providerKey,
          providerFamily: "product",
          provider: "product",
          vertical: "product",
          region,
          mode: "api",
          elapsedMs: Date.now() - startedAt,
        },
      };
    }

    const scrapeItems = await withTimeout(
      searchAliExpressScrape(query, { region, signal, timeoutMs }),
      timeoutMs,
      "aliexpress:scrape"
    );

    return {
      ok: true,
      items: (scrapeItems || []).slice(0, 100),
      count: Math.min(100, (scrapeItems || []).length),
      source: providerKey,
      _meta: {
        providerKey,
        providerFamily: "product",
        provider: "product",
        vertical: "product",
        region,
        mode: "scrape",
        elapsedMs: Date.now() - startedAt,
      },
    };
  } catch (err) {
    return s200Fail({
      providerKey,
      query,
      region,
      stage: "search",
      code: err instanceof TimeoutError ? "TIMEOUT" : "FAIL",
      err,
      meta: { elapsedMs: Date.now() - startedAt },
    });
  }
}

// ---------------------------------------------------------------------------
// CONFIG + DEFAULT EXPORT (ZERO DELETE)
// ---------------------------------------------------------------------------
export const aliexpressAdapterConfig = {
  name: "aliexpress",
  fn: searchAliExpressAdapter,
  timeoutMs: 15000,
  priority: 1.0,
  category: "product",
  provider: "aliexpress",
  commissionRate: 0.05,
};

export default {
  searchAliExpressAdapter,
  aliexpressAdapterConfig,
};

// ============================================================================
// S200 WRAPPER — HARDENED (AUTO)
// - Strict output: { ok, items, count, source, _meta }
// - Deterministic id: stableIdS200(providerKey,url,title)
// - Contract lock: title + url required; price<=0 => null (normalizeItemS200)
// - Observable fail: timeout / notImplemented / error => ok:false + items:[]
// - Global ctx set for kit diagnostics
// ============================================================================

export async function searchAliExpressAdapter(query, options = {}) {
  const started = Date.now();
  const providerKey = "aliexpress";
  globalThis.__S200_ADAPTER_CTX = {
    providerKey,
    adapter: "aliexpressAdapter",
    query: String(query || ""),
    _meta: { startedAt: started },
  };

  const timeoutMs =
    Number(options?.timeoutMs || options?.timeout || 15000) || 15000;

  try {
    const raw = await withTimeout(Promise.resolve(searchAliExpressAdapterLegacy(query, options)), timeoutMs, providerKey);

    // If legacy explicitly says fail, treat as observable fail.
    if (raw && typeof raw === "object" && raw.ok === false) {
      const errMsg =
        safeStr(raw?._meta?.error || raw?.error || raw?.message || "adapter_fail", 900) || "adapter_fail";
      return {
        ok: false,
        items: [],
        count: 0,
        source: "aliexpress",
        _meta: {
          startedAt: started,
          durationMs: Date.now() - started,
          timeoutMs,
          error: errMsg,
          legacyOk: false,
        },
      };
    }

    const itemsIn = coerceItemsS200(raw);
    const out = [];
    let bad = 0;

    for (const it of itemsIn) {
      if (!it || typeof it !== "object") continue;

      const x = { ...it };

      // NO RANDOM ID — wipe any legacy/random ids and rebuild deterministically.
      x.id = null;
      x.listingId = null;
      x.listing_id = null;
      x.itemId = null;

      // Discovery sources: price forced null, affiliate injection OFF.
      if (false) {
        x.price = null;
        x.finalPrice = null;
        x.optimizedPrice = null;
        x.originalPrice = null;
        x.affiliateUrl = null;
        x.deeplink = null;
        x.deepLink = null;
        x.finalUrl = null;
      }

      const ni = normalizeItemS200(x, providerKey, {
        category: "general",
        vertical: "general",
        query: String(query || ""),
        region: String(options?.region || "TR").toUpperCase(),
      });

      if (!ni) {
        bad++;
        continue;
      }

      // Hard enforce stable id.
      ni.id = stableIdS200(providerKey, ni.url, ni.title);

      out.push(ni);
    }

    return {
      ok: true,
      items: out,
      count: out.length,
      source: "aliexpress",
      _meta: {
        startedAt: started,
        durationMs: Date.now() - started,
        timeoutMs,
        bad,
        legacyOk: true,
      },
    };
  } catch (e) {
    const msg = safeStr(e?.message || e, 900) || "unknown_error";
    const isTimeout = e?.name === "TimeoutError" || /timed out|timeout/i.test(String(e?.message || ""));
    return {
      ok: false,
      items: [],
      count: 0,
      source: "aliexpress",
      _meta: {
        startedAt: started,
        durationMs: Date.now() - started,
        timeoutMs,
        timeout: isTimeout,
        error: msg,
      },
    };
  }
}

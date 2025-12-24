// server/adapters/amazonTRAdapter.js
// AMAZON TR — S8 → S10 → S200 ULTRA-NORMALIZED (FINAL)
// ZERO DELETE – ZERO DRIFT — %100 RAW S200 OUTPUT
// ============================================================

import axios from "axios";
import * as cheerio from "cheerio";
import { buildImageVariants } from "../utils/imageFixer.js";
import { buildAffiliateUrl } from "./affiliateEngine.js";
import { rateLimiter } from "../utils/rateLimiter.js";

import {
  loadCheerioS200,
  coerceItemsS200,
  normalizeItemS200,
  stableIdS200,
  withTimeout,
  safeStr,
} from "../core/s200AdapterKit.js";
// --------------------------- S200 STRICT OUTPUT ---------------------------
const S200_SOURCE = "amazon_tr";
const S200_PROVIDER_FAMILY = "product";
const S200_AT = "server/adapters/amazonTRAdapter.js";

function _s200Ok(items, meta = {}) {
  const arr = Array.isArray(items) ? items : [];
  return { ok: true, items: arr, count: arr.length, source: S200_SOURCE, _meta: meta || {} };
}

function _s200Fail(err, meta = {}) {
  const msg = safeStr(err?.message || err, 900) || "unknown_error";
  return { ok: false, items: [], count: 0, source: S200_SOURCE, _meta: { ...(meta || {}), error: msg } };
}

function _isTimeoutErr(e) {
  const msg = String(e?.message || "");
  return e?.name === "TimeoutError" || /timed out/i.test(msg) || /timeout/i.test(msg);
}

// --------------------------- HELPERS ---------------------------
const safe = (v) => (v ? String(v).trim() : "");

function parsePrice(txt) {
  if (!txt) return null;
  const cleaned = txt
    .replace(/[^\d.,]/g, "")
    .replace(/\.(?=\d{3})/g, "")
    .replace(",", ".");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function parseReviewCount(txt) {
  if (!txt) return null;
  const n = Number(txt.replace(/[^\d]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function normalizeUrl(u) {
  if (!u) return null;
  if (u.startsWith("http")) return u;
  return "https://www.amazon.com.tr" + u;
}

function axiosConfig(signal) {
  return {
    signal,
    timeout: 15000,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125",
      "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.8",
      Referer: "https://www.amazon.com.tr/",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
    },
  };
}

// ---------------------- S200 NORMALIZER -----------------------
function normalizeS200(raw, region = "TR") {
  const asin = safeStr(raw?.asin, 80);
  const title = safeStr(raw?.title, 340);
  const href = safeStr(raw?.href, 1200);
  const url = normalizeUrl(href);

  if (!title || !url) return null;

  const imageRaw = safeStr(raw?.imageRaw, 1200);
  const variants = buildImageVariants(imageRaw, "amazon");

  const affiliateUrl = buildAffiliateUrl(
    { url, provider: "amazon_tr" },
    { source: "adapter" }
  );

  return {
    // ✅ deterministic (NO RANDOM ID)
    id: asin || stableIdS200(S200_SOURCE, url, title),

    title,
    url,
    originUrl: url,

    // URL priority: affiliateUrl > originUrl > url
    affiliateUrl: affiliateUrl || null,

    price: raw?.price ?? null,
    finalPrice: raw?.price ?? null,
    optimizedPrice: raw?.price ?? null,
    currency: "TRY",

    rating: raw?.rating ?? null,
    reviewCount: raw?.reviewCount ?? null,

    region: String(region || "TR").toUpperCase(),
    category: "product",

    image: (Array.isArray(variants) && variants[0]) ? variants[0] : (imageRaw || null),
    images: Array.isArray(variants) ? variants : (imageRaw ? [imageRaw] : []),

    raw: {
      ...raw,
      asin,
      href,
      imageRaw,
      variants,
      affiliateHint: affiliateUrl || null,
    },
  };
}


// ----------------------------- SCRAPER -----------------------------
async function scrapePage(query, page = 1, options = {}) {
  const { signal, region = "TR" } = options;

  // ⭐ SAYFA BAZLI RATE LIMIT ⭐
  const limiterKey = `s200:adapter:amazontr:page:${page}:${region}`;
  const allowed = await rateLimiter.check(limiterKey, {
    limit: 10,
    windowMs: 60_000,
    burst: false,
    adaptive: true,
  });
  if (!allowed) return [];

  const q = encodeURIComponent(query);
  const url =
    page === 1
      ? `https://www.amazon.com.tr/s?k=${q}`
      : `https://www.amazon.com.tr/s?k=${q}&page=${page}`;

  try {
    const { data: html } = await axios.get(url, axiosConfig(signal));
    const $ = loadCheerioS200(html);

    const out = [];

    $("div.s-result-item[data-asin]").each((i, el) => {
      const node = $(el);
      const asin = safe(node.attr("data-asin"));
      if (!asin) return;

      const title =
        safe(node.find("h2 span.a-text-normal").text()) ||
        safe(node.find("span.a-size-base-plus").text());
      if (!title) return;

      const priceText =
        safe(node.find("span.a-price > span.a-offscreen").first().text()) ||
        safe(node.find("span.a-price-whole").text());
      const price = parsePrice(priceText);

      let href =
        safe(node.find("a.a-link-normal.a-text-normal").attr("href")) ||
        safe(node.find("a.a-link-normal.s-no-outline").attr("href"));
      if (!href) return;

      const imageRaw =
        safe(node.find("img.s-image").attr("src")) ||
        safe(node.find("img").attr("data-src"));

      const ratingTxt =
        safe(node.find(".a-icon-alt").text()) ||
        safe(node.find("[data-avg-rating]").attr("data-avg-rating"));

      let rating = null;
      const m = ratingTxt.match(/([\d.,]+)/);
      if (m) {
        const r = Number(m[1].replace(",", "."));
        if (Number.isFinite(r)) rating = Math.min(5, Math.max(0, r));
      }

      const reviewTxt = safe(
        node.find("span.a-size-base.s-underline-text").text()
      );
      const reviewCount = parseReviewCount(reviewTxt);

      out.push(
        normalizeS200(
          {
            asin,
            title,
            price,
            priceText,
            rating,
            reviewCount,
            href,
            imageRaw,
          },
          region
        )
      );
    });

    return out;
  } catch (err) {
    console.warn("Amazon TR scraper hata:", err.message);
    return [];
  }
}

// ----------------------------- MULTIPAGE -----------------------------
export async function searchAmazonTRScrape(query, regionOrOptions = "TR") {
  const q = safeStr(query, 220);
  if (!q) return _s200Ok([], { emptyQuery: true });

  try {
    globalThis.__S200_ADAPTER_CTX = { adapter: S200_SOURCE, providerKey: S200_SOURCE, at: S200_AT };
  } catch {}

  const startTime = Date.now();
  let region = "TR";
  let options = {};

  if (typeof regionOrOptions === "string") region = regionOrOptions;
  else {
    region = regionOrOptions?.region || "TR";
    options = regionOrOptions || {};
  }

  // ⭐ UNIFIED QUERY THROTTLE ⭐
  const limiterKey = `s200:adapter:amazontr:query:${region}`;
  const allowed = await rateLimiter.check(limiterKey, {
    limit: 18,
    windowMs: 60_000,
    burst: true,
    adaptive: true,
  });
  if (!allowed) return _s200Fail("RATE_LIMITED", { rateLimited: true, region });

  const outerTimeoutMs = Number(options?.timeoutMs || 11000);

  const errors = [];
  let hadTimeout = false;

  let all = [];
  for (let p = 1; p <= 3; p++) {
    try {
      const part = await withTimeout(scrapePage(q, p, { ...options, region }), outerTimeoutMs, `amazontr_page_${p}`);
      const arr = coerceItemsS200(part).filter(Boolean);
      if (!arr.length) break;
      all = all.concat(arr);
      if (all.length >= 120) break;
    } catch (err) {
      const msg = safeStr(err?.message || err, 500);
      errors.push({ page: p, error: msg });
      if (_isTimeoutErr(err)) hadTimeout = true;
      // ilk sayfa patlarsa daha fazla zorlamanın manası yok
      if (p === 1) break;
    }
  }

  const seen = new Set();
  const normalized = [];
  for (const it of all) {
    const n = normalizeItemS200(it, S200_SOURCE, {
      providerFamily: S200_PROVIDER_FAMILY,
      vertical: "product",
      category: "product",
      region,
      requireRealUrlCandidate: true,
    });
    if (!n || !n.id) continue;
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    normalized.push(n);
  }

  const duration = Date.now() - startTime;

  if (!normalized.length && errors.length) {
    // observable fail (timeout/error) + no items
    return _s200Fail(hadTimeout ? "TIMEOUT" : "SCRAPE_FAILED", {
      region,
      tookMs: duration,
      timeout: !!hadTimeout,
      errors,
    });
  }

  return _s200Ok(normalized, {
    region,
    tookMs: duration,
    rawCount: all.length,
    partial: errors.length > 0,
    errors,
  });
}


// ----------------------------- UNIFIED ADAPTER -----------------------------
export async function searchAmazonTRAdapterLegacy(query, regionOrOptions = "TR") {
  try {
    // already returns { ok, items, count, source, _meta }
    return await searchAmazonTRScrape(query, regionOrOptions);
  } catch (err) {
    return _s200Fail(err, { crash: true });
  }
}


// EXPORTS
export const searchAmazonTR = searchAmazonTRAdapter;

export default {
  searchAmazonTR,
  searchAmazonTRScrape,
  searchAmazonTRAdapter,
};

// ============================================================================
// S200 WRAPPER — HARDENED (AUTO)
// - Strict output: { ok, items, count, source, _meta }
// - Deterministic id: stableIdS200(providerKey,url,title)
// - Contract lock: title + url required; price<=0 => null (normalizeItemS200)
// - Observable fail: timeout / notImplemented / error => ok:false + items:[]
// - Global ctx set for kit diagnostics
// ============================================================================

export async function searchAmazonTRAdapter(query, options = {}) {
  const started = Date.now();
  const providerKey = "amazon_tr";
  globalThis.__S200_ADAPTER_CTX = {
    providerKey,
    adapter: "amazonTRAdapter",
    query: String(query || ""),
    _meta: { startedAt: started },
  };

  const timeoutMs =
    Number(options?.timeoutMs || options?.timeout || 9000) || 9000;

  try {
    const raw = await withTimeout(Promise.resolve(searchAmazonTRAdapterLegacy(query, options)), timeoutMs, providerKey);

    // If legacy explicitly says fail, treat as observable fail.
    if (raw && typeof raw === "object" && raw.ok === false) {
      const errMsg =
        safeStr(raw?._meta?.error || raw?.error || raw?.message || "adapter_fail", 900) || "adapter_fail";
      return {
        ok: false,
        items: [],
        count: 0,
        source: "amazon_tr",
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
        category: "product",
        vertical: "product",
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
      source: "amazon_tr",
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
      source: "amazon_tr",
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

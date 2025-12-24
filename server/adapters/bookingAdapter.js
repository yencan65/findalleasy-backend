// server/adapters/bookingAdapter.js
// =======================================================================
// BOOKING.COM — S33 TITAN+ FINAL MAX EDITION
// ZERO DELETE — S8→S10 akışı korunur, TITAN çekirdeği eklendi
// • stableId (slug + priceHash + urlHash)
// • sanitizePrice + optimizePrice
// • imageVariants + fallback
// • anti-ban proxyFallback
// • categoryAI (hotels / travel vertical AI)
// • stock detection
// • rating normalize
// • qualityScore (hotel-weighted)
// • affiliate S10 → TITAN uyumlu
// • providerFamily + vertical: “travel_hotel”
// • tam normalize S33
// =======================================================================

import fetch from "node-fetch";
import axios from "axios";
import * as cheerio from "cheerio";
import crypto from "crypto";

import { proxyFetchHTML } from "../core/proxyEngine.js";
import { buildImageVariants } from "../utils/imageFixer.js";
import { sanitizePrice } from "../utils/priceSanitizer.js";
import { optimizePrice } from "../utils/priceFixer.js";
import { buildAffiliateUrl } from "./affiliateEngine.js";
import { rateLimiter } from "../utils/rateLimiter.js";
import {
  loadCheerioS200,
  withTimeout,
  coerceItemsS200,
  normalizeItemS200,
  stableIdS200,
  safeStr,
} from "../core/s200AdapterKit.js";

// ------------------------------------------------------------
// ENV
// ------------------------------------------------------------
const BOOKING_API_KEY = process.env.BOOKING_API_KEY || "";
const BOOKING_AFFILIATE_ID = process.env.BOOKING_AFFILIATE_ID || "";
const TIMEOUT_MS = 9000;

// ------------------------------------------------------------
// HELPERS — TITAN LEVEL
// ------------------------------------------------------------
const safe = (v) => (v == null ? "" : String(v).trim());

function parsePriceStrong(txt) {
  if (!txt) return null;
  const n = Number(
    txt
      .replace(/[^\d.,]/g, "")
      .replace(/\.(?=\d{3})/g, "")
      .replace(",", ".")
  );
  return Number.isFinite(n) ? n : null;
}

function slugify(t) {
  return safe(t).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 50);
}

function stableId(provider, title, url, price) {
  const slug = slugify(title);
  const pHash = crypto.createHash("md5").update(String(price ?? "")).digest("hex").slice(0, 6);
  const uHash = crypto.createHash("md5").update(url || "").digest("hex").slice(0, 6);
  return `${provider}_${slug}_${pHash}_${uHash}`;
}

function fallbackImage(title) {
  const q = encodeURIComponent(title || "hotel");
  return `https://source.unsplash.com/featured/?hotel,travel,${q}`;
}

function inferCategoryAI(title) {
  const t = safe(title).toLowerCase();
  if (t.includes("resort")) return "resort";
  if (t.includes("otel") || t.includes("hotel")) return "hotel";
  if (t.includes("villa")) return "villa";
  if (t.includes("apart")) return "aparthotel";
  return "hotel";
}

function detectStock(root) {
  const txt = root?.text?.().toLowerCase() || "";
  if (txt.includes("tükendi") || txt.includes("kapalı") || txt.includes("yok"))
    return "out";
  return "available";
}

function computeQualityScore(base) {
  let s = 0;
  if (base.title) s += 0.22;
  if (base.price != null) s += 0.22;
  if (base.rating != null) s += 0.18;
  if (base.image) s += 0.20;
  if (base.stock !== "out") s += 0.10;
  s += 0.08;
  return Number(s.toFixed(2));
}

// ------------------------------------------------------------
// NORMALIZE S33
// ------------------------------------------------------------
function normalizeS33(raw, region = "TR") {
  const priceSan = sanitizePrice(raw.price);
  const optimized =
    priceSan != null
      ? optimizePrice({ price: priceSan, provider: "booking" }, { provider: "booking", region })
      : null;

  const img = raw.image || fallbackImage(raw.title);
  const variants = buildImageVariants(img, "booking");

  const affiliateUrl = buildAffiliateUrl(
    { url: raw.url, provider: "booking" },
    { source: "adapter" }
  );

  const categoryAI = inferCategoryAI(raw.title);
  const stock = detectStock({ text: () => raw.title }); // Booking stok göstermiyor → dummy

  const id = stableId("booking", raw.title, raw.url, priceSan);

  const base = {
    id,
    provider: "booking",
    providerFamily: "booking",
    vertical: "travel_hotel",

    title: raw.title,
    price: priceSan,
    finalPrice: priceSan,
    optimizedPrice: optimized,
    priceText: priceSan ? `${priceSan} ${raw.currency || "TRY"}` : null,

    currency: raw.currency || "TRY",
    region,

    url: raw.url,
    deeplink: affiliateUrl,

    image: variants.image,
    imageOriginal: variants.imageOriginal,
    imageProxy: variants.imageProxy,
    hasProxy: variants.hasProxy,

    rating: raw.rating || null,
    reviewCount: raw.reviewCount || null,
    stock,

    category: "hotel",
    categoryAI,

    raw,
  };

  return {
    ...base,
    qualityScore: computeQualityScore(base),
  };
}

// ------------------------------------------------------------
// 1) BOOKING OFFICIAL API
// ------------------------------------------------------------
async function bookingOfficialAPI(query, region, signal) {
  if (!BOOKING_API_KEY) return [];

  try {
    const auth = Buffer.from(`${BOOKING_API_KEY}:`).toString("base64");
    const url =
      "https://distribution-xml.booking.com/json/bookings.getHotels?rows=20&offset=0&city_ids=-553173";

    const res = await fetch(url, {
      signal,
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json",
        "User-Agent": "FindAllEasy/BookingTitan",
      },
    });

    if (!res.ok) return [];

    const data = await res.json();
    const list = data?.result || [];

    return list
      .map((h) =>
        normalizeS33(
          {
            title: safe(h.hotel_name),
            price: Number(h.min_total_price) || null,
            image: h.photo_url,
            url: h.url ? `${h.url}?aid=${BOOKING_AFFILIATE_ID}` : null,
            rating: Number(h.review_score) || null,
            currency: h.currency_code || "EUR",
            region,
            raw: h,
          },
          region
        )
      )
      .filter((x) => x.title);
  } catch (err) {
    console.warn("Booking API hata:", err.message);
    return [];
  }
}

// ------------------------------------------------------------
// 2) GOOGLE HOTELS FALLBACK
// ------------------------------------------------------------
async function scrapeGoogleHotels(query, region, signal) {
  try {
    const q = encodeURIComponent(query);
    const url = `https://www.google.com/travel/hotels?q=${q}`;

    const html = await proxyFetchHTML(url, {
      timeout: TIMEOUT_MS,
      signal,
      headers: { "User-Agent": "Mozilla/5.0 Chrome/124" },
    });

    const $ = loadCheerioS200(html);
    const out = [];

    $("a[jscontroller][href*='booking']").each((i, el) => {
      const w = $(el);

      const title = safe(w.find("[role='heading']").text());
      if (!title) return;

      const priceTxt =
        safe(w.find("[aria-label*='₺']").text()) ||
        safe(w.find(".NprGfe").text());
      const price = parsePriceStrong(priceTxt);

      const img =
        w.find("img").attr("data-src") ||
        w.find("img").attr("src") ||
        null;

      const href = w.attr("href");
      const urlFull = href.startsWith("http")
        ? href
        : "https://www.google.com" + href;

      out.push(
        normalizeS33(
          {
            title,
            price,
            finalPrice: price,
            image: img,
            url: urlFull,
            currency: "TRY",
            region,
            raw: {},
          },
          region
        )
      );
    });

    return out.slice(0, 25);
  } catch (err) {
    console.warn("Google Hotels hata:", err.message);
    return [];
  }
}

// ------------------------------------------------------------
// 3) BOOKING HTML SCRAPE (S33 fallback)
// ------------------------------------------------------------
async function scrapeBookingHtml(query, region, signal) {
  const q = encodeURIComponent(query);
  const url = `https://www.booking.com/searchresults.html?ss=${q}`;

  let html = null;

  try {
    html = await proxyFetchHTML(url, {
      timeout: TIMEOUT_MS,
      signal,
      headers: { "User-Agent": "Mozilla/5.0 Chrome/125" },
    });
  } catch {}

  if (!html) {
    try {
      const { data } = await axios.get(url, {
        timeout: TIMEOUT_MS,
        signal,
        headers: { "User-Agent": "Mozilla/5.0 Chrome/125" },
      });
      html = data;
    } catch (err) {
      console.warn("Booking HTML hata:", err.message);
      return [];
    }
  }

  const $ = loadCheerioS200(html);
  const out = [];

  $(".d4924c9e74, .fde444d7ef, .c90d3bf728").each((i, el) => {
    const w = $(el);

    const title = safe(w.find("div[data-testid='title']").text());
    if (!title) return;

    const priceTxt =
      safe(
        w.find("span[data-testid='price-and-discounted-price']").text()
      ) || safe(w.find(".bui-price-display__value").text());
    const price = parsePriceStrong(priceTxt);

    const href =
      w.find("a[data-testid='item-link']").attr("href") ||
      w.find("a").attr("href");
    if (!href) return;

    const urlFull = href.startsWith("http")
      ? href
      : `https://www.booking.com${href}`;

    const img =
      w.find("img").attr("data-src") ||
      w.find("img").attr("src") ||
      null;

    out.push(
      normalizeS33(
        {
          title,
          price,
          image: img,
          url: urlFull,
          currency: "TRY",
          region,
          raw: {},
        },
        region
      )
    );
  });

  return out.slice(0, 25);
}

// ------------------------------------------------------------
// UNIFIED ADAPTER — S33
// ------------------------------------------------------------
export async function searchBookingLegacy(query = "", regionOrOptions = "TR") {
  let region = "TR";
  let signal = null;

  if (typeof regionOrOptions === "object") {
    region = regionOrOptions.region || "TR";
    signal = regionOrOptions.signal || null;
  }

  if (!query) return [];

  // ==========================
  // S33 RATE LIMITER BLOĞU
  // ==========================
  const limiterKey = `s33:adapter:booking:${region}`;

  const allowed = await rateLimiter.check(limiterKey, {
    limit: 10,         // Booking için güvenli RPM
    windowMs: 60_000,  // 1 dakika
    burst: true,
    adaptive: true
  });

  if (!allowed) {
    return [{
      ok: false,
      items: [],
      count: 0,
      error: "S33_RATE_LIMIT_EXCEEDED",
      adapterName: "booking_s33",
      _meta: {
        limiterKey,
        timestamp: Date.now()
      }
    }];
  }
  // ==========================

  console.log("🟣 BookingAdapter (S33) çalıştı:", query);

  const api = await bookingOfficialAPI(query, region, signal);

  if (api.length > 0) return api;

  const gh = await scrapeGoogleHotels(query, region, signal);
  if (gh.length > 0) return gh;

  return await scrapeBookingHtml(query, region, signal);
}

export const searchBookingAdapter = searchBooking;

export default {
  searchBooking,
  searchBookingAdapter,
  searchBookingAPI: bookingOfficialAPI,
  searchBookingScrape: scrapeBookingHtml,
};

// ============================================================================
// S200 WRAPPER — HARDENED (AUTO)
// - Strict output: { ok, items, count, source, _meta }
// - Deterministic id: stableIdS200(providerKey,url,title)
// - Contract lock: title + url required; price<=0 => null (normalizeItemS200)
// - Observable fail: timeout / notImplemented / error => ok:false + items:[]
// - Global ctx set for kit diagnostics
// ============================================================================

export async function searchBooking(query, options = {}) {
  const started = Date.now();
  const providerKey = "booking";
  globalThis.__S200_ADAPTER_CTX = {
    providerKey,
    adapter: "bookingAdapter",
    query: String(query || ""),
    _meta: { startedAt: started },
  };

  const timeoutMs =
    Number(options?.timeoutMs || options?.timeout || 9000) || 9000;

  try {
    const raw = await withTimeout(Promise.resolve(searchBookingLegacy(query, options)), timeoutMs, providerKey);

    // If legacy explicitly says fail, treat as observable fail.
    if (raw && typeof raw === "object" && raw.ok === false) {
      const errMsg =
        safeStr(raw?._meta?.error || raw?.error || raw?.message || "adapter_fail", 900) || "adapter_fail";
      return {
        ok: false,
        items: [],
        count: 0,
        source: "booking",
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
      source: "booking",
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
      source: "booking",
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

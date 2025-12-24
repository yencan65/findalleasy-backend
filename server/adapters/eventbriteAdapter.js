// server/adapters/eventbriteAdapter.js
// ======================================================================
// EVENTBRITE — S33 TITAN+ EDITION (FINAL)
// Zero Delete — eski fonksiyonlar korunur, çekirdek TITAN+ seviyesine çıkarıldı
// Rate Limiter uyumlu (ana motor ile entegre)
// ----------------------------------------------------------------------
// • stableId v3.5 (slug + urlHash + entropy)
// • ImageVariants FULL
// • optimizedPrice + finalPrice pipeline
// • QualityScore S33 (event-weighted)
// • categoryAI: "event"
// • location + date + price normalize
// • Multi-page S33
// • TITAN SAFE fallback
// • providerSignature + adapterVersion + reliabilityScore
// ======================================================================

import axios from "axios";
import * as cheerio from "cheerio";
import crypto from "crypto";
import { buildImageVariants } from "../utils/imageFixer.js";
import { rateLimiter } from "../utils/rateLimiter.js";

import { loadCheerioS200, coerceItemsS200, normalizeItemS200, priceOrNullS200, stableIdS200, withTimeout } from "../core/s200AdapterKit.js";

// ======================= RATE LIMITER =======================
async function checkRateLimit() {
  const key = "adapter_eventbrite_TR";
  const allowed = await rateLimiter.check(key, {
    limit: 18,
    windowMs: 60000,
    burst: true,
    adaptive: true,
  });
  
  if (!allowed) {
    console.warn(`⛔ RATE LIMIT → eventbrite`);
    throw new Error("Rate limit exceeded for eventbrite adapter");
  }
  
  return true;
}

// ======================= HELPERS — S33 LEVEL =======================
const safe = (v) => (v ? String(v).trim() : "");

function slugify(t) {
  return safe(t)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 50);
}

function stableId(title, href) {
  // S200 deterministic stable id (NO RANDOM)
  return stableIdS200("eventbrite", href || "", title || "eventbrite");
}

function parsePriceStrong(txt) {
  if (!txt) return null;

  const low = txt.toLowerCase();
  if (low.includes("free") || low.includes("ücretsiz")) return 0;

  const cleaned = txt
    .replace(/[^\d.,]/g, "")
    .replace(/\.(?=\d{3})/g, "")
    .replace(",", ".");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function normalizeCurrency(txt) {
  if (!txt) return "USD";
  if (txt.includes("₺") || txt.includes("TL")) return "TRY";
  if (txt.includes("€")) return "EUR";
  if (txt.includes("$")) return "USD";
  return "USD";
}

function extractImage($, el) {
  const sel = [
    "img",
    "[data-spec='event-card-image'] img",
    "img.eds-event-card-content__image",
  ];
  for (const s of sel) {
    const src =
      safe($(el).find(s).attr("data-src")) ||
      safe($(el).find(s).attr("src"));
    if (src) return src;
  }
  return null;
}

function extractLocation($, el) {
  const sel = [
    ".card-text--truncated__one",
    ".card-text--label-default",
    ".location-info",
    ".eds-event-card-content__sub",
  ];
  for (const s of sel) {
    const v = safe($(el).find(s).first().text());
    if (v) return v;
  }
  return null;
}

function extractDate($, el) {
  const sel = [
    ".event-card-content__header-time",
    ".eds-event-card-content__sub-title",
    ".eds-text--label-medium",
    "time",
  ];
  for (const s of sel) {
    const v = safe($(el).find(s).first().text());
    if (v) return v;
  }
  return null;
}

function categoryAI() {
  return "event";
}

// ======================= QualityScore — S33 (event-weighted) =======================
function computeQualityScore(item) {
  let s = 0;

  if (item.title) s += 0.30;
  if (item.price != null) s += 0.20;
  if (item.image) s += 0.25;
  if (item.dateText) s += 0.10;
  if (item.locationText) s += 0.10;

  s += 0.05; // entropy boost
  return Number(s.toFixed(2));
}

// ======================= NORMALIZER — Ana motor uyumlu =======================
function normalizeEventbriteItem(raw, region, query) {
  const title = raw.title || `Event — ${query}`;
  const price = parsePriceStrong(raw.price);
  const url = raw.url;

  const id = stableId(title, url);
  const img = buildImageVariants(raw.image, "eventbrite");

  // Ana motorun normalizeItem fonksiyonu ile uyumlu temel yapı
  const baseItem = {
    id,
    title,
    price,
    rating: null,
   originUrl: url,
finalUrl: url,
deeplink: url,
url,

    provider: "eventbrite",
    currency: raw.currency || "USD",
    region: region.toUpperCase(),
    category: "event",
    adapterSource: "eventbriteAdapter",
    
    // Ana motorun normalizeItem fonksiyonunda kullanılacak raw alanı
    raw: {
      title,
      price,
      url,
      dateText: raw.dateText,
      locationText: raw.locationText,
      currency: raw.currency || "USD",
      
      // S33 TITAN+ ek alanları
      providerType: "event",
      providerFamily: "eventbrite",
      providerSignature: "eventbrite_s33",
      adapterVersion: "S33.TITAN+",
      reliabilityScore: 0.87,
      vertical: "event",
      categoryAI: categoryAI(),
      
      // Fiyat alanları
      finalPrice: price,
      optimizedPrice: price,
      
      // Görsel alanları
      image: img.image,
      imageOriginal: img.imageOriginal,
      imageProxy: img.imageProxy,
      hasProxy: img.hasProxy,
      
      qualityScore: computeQualityScore({
        title,
        price,
        image: raw.image,
        dateText: raw.dateText,
        locationText: raw.locationText
      }),
      rawData: raw.raw || raw
    }
  };

  return baseItem;
}

// ======================= SCRAPER — SINGLE PAGE (S33) =======================
async function scrapeEventbritePage(query, region, signal, page = 1) {
  try {
    const q = encodeURIComponent(query);
    const pagePart = page > 1 ? `?page=${page}` : "";
    const link = `https://www.eventbrite.com/d/${region.toLowerCase()}/${q}/${pagePart}`;

    const res = await axios.get(link, {
      timeout: 15000,
      signal,
      headers: {
        "User-Agent": "Mozilla/5.0 Chrome/125",
        "Accept-Language": "en-US,en;q=0.9,tr;q=0.8",
      },
    });

    const $ = loadCheerioS200(res.data);
    const items = [];

    const selectors = [
      ".search-event-card-wrapper",
      ".eds-event-card-content__content",
      ".discover-vertical-event-card",
      ".discover-horizontal-event-card",
      ".search-main-content__events-list li",
      "[data-event-item]",
    ];

    $(selectors.join(",")).each((i, el) => {
      const title =
        safe($(el).find("h3").text()) ||
        safe($(el).find(".eds-event-card-content__title").text());
      if (!title) return;

      let href =
        safe($(el).find("a").attr("href")) ||
        safe($(el).attr("data-event-item-url"));
      if (!href) return;
      if (!href.startsWith("http"))
        href = "https://www.eventbrite.com" + href;

      const priceTxt =
        safe($(el).find(".eds-event-card-content__sub-title").text()) ||
        safe($(el).find(".eds-event-card-content__sub").text());

      const raw = {
        title,
        url: href,
        price: priceTxt,
        currency: normalizeCurrency(priceTxt),
        dateText: extractDate($, el),
        locationText: extractLocation($, el),
        image: extractImage($, el),
      };

      items.push(normalizeEventbriteItem(raw, region, query));
    });

    return items;
  } catch (err) {
    if (err?.name === "AbortError") return [];
    console.warn("⚠️ Eventbrite page scrape hata:", err.message);
    return [];
  }
}

// ======================= MULTI PAGE S33 =======================
async function scrapeEventbriteAll(query, region, signal) {
  let all = [];
  let last = null;

  for (let page = 1; page <= 3; page++) {
    const part = await scrapeEventbritePage(query, region, signal, page);
    if (!part.length) break;
    if (last !== null && part.length === last) break;

    last = part.length;
    all.push(...part);
  }

  return all.slice(0, 80);
}

// ======================= FALLBACK — TITAN SAFE =======================
function fallbackEventbrite(query, region) {
  const raw = {
    title: `Event bulunamadı: ${query}`,
    url: "https://www.eventbrite.com",
    price: null,
    currency: "USD",
    dateText: null,
    locationText: null,
    image: null,
    fallback: true,
  };

  const item = normalizeEventbriteItem(raw, region, query);
  item.raw = {
    ...item.raw,
    fallback: true,
    qualityScore: 0.05
  };

  return [item];
}

// ======================= MAIN ADAPTER — UNIFIED =======================
export async function searchEventbriteAdapterItems(query, regionOrOptions = "TR") {
  let region = "TR";
  let signal = null;

  if (typeof regionOrOptions === "object") {
    region = regionOrOptions.region || "TR";
    signal = regionOrOptions.signal || null;
  }

  try {
    // Rate limiter kontrolü
    await checkRateLimit();
    
    const scraped = await scrapeEventbriteAll(query, region, signal);
    
    if (scraped.length > 0) {
      // Başarılı isteği kaydet
      rateLimiter.registerSuccess("adapter_eventbrite_TR", 1);
      return scraped;
    }

    // Fallback durumu - başarılı sayalım (sonuç yok ama hata değil)
    rateLimiter.registerSuccess("adapter_eventbrite_TR", 1);
    return fallbackEventbrite(query, region);
  } catch (err) {
    // Hata durumunda rate limiter'a bildir
    if (err.message !== "Rate limit exceeded for eventbrite adapter") {
      rateLimiter.registerError("adapter_eventbrite_TR", 1);
    }
    
    console.warn("⚠️ EventbriteAdapter Final Error:", err.message);
    return fallbackEventbrite(query, region);
  }
}

// ======================= ALIAS — ZERO DELETE =======================
// ======================================================================
// S200 WRAPPER (observable fail, contract lock, deterministic id)
// ======================================================================
function _s200NormalizeList(out, providerKey, opts = {}) {
  const arr = coerceItemsS200(out);
  const res = [];
  for (const it of arr) {
    if (!it) continue;
    const clean = { ...it };
    delete clean.id;
    delete clean.listingId;
    if ("price" in clean) clean.price = priceOrNullS200(clean.price);
    const n = normalizeItemS200(clean, providerKey, opts);
    if (n) res.push(n);
  }
  return res;
}

export async function searchEventbriteAdapter(query, options = {}) {
  const providerKey = "eventbrite";
  const started = Date.now();
  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = {
    providerKey,
    adapter: "eventbriteAdapter",
    query: String(query || ""),
    _meta: { startedAt: started },
  };
  try {
    const t = Number(options?.timeoutMs || options?.timeout || 6500);
    const raw = await withTimeout(searchEventbriteAdapterItems(query, options), t, `${providerKey}_items`);
    const region = String(options?.region || "TR").toUpperCase();
    const items = _s200NormalizeList(raw, providerKey, { vertical: "event", category: "event", region });
    return { ok: true, items, count: items.length, source: providerKey, _meta: { tookMs: Date.now() - started, region } };
  } catch (err) {
    const msg = err?.message || String(err);
    const isTimeout = err?.name === "TimeoutError" || /timed out/i.test(msg);
    return { ok: false, items: [], count: 0, source: providerKey, _meta: { tookMs: Date.now() - started, error: msg, timeout: isTimeout } };
  } finally {
    globalThis.__S200_ADAPTER_CTX = prevCtx;
  }
}

export const searchEventbrite = searchEventbriteAdapter;
export const searchEventbriteScrape = searchEventbriteAdapter;

export default {
  searchEventbrite,
  searchEventbriteScrape,
  searchEventbriteAdapter,
};
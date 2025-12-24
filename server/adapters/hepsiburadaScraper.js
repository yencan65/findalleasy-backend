// server/adapters/hepsiburadaScraper.js
// ============================================================================
//  Hepsiburada — S33 TITAN → S200 FINAL
//  ZERO DELETE: Eski tüm S33 mantığı korunur; çıkış normalizeS200 formatına çevrilir.
// ============================================================================

import axios from "axios";
import * as cheerio from "cheerio";

import { sanitizePrice } from "../utils/priceSanitizer.js";
import { optimizePrice } from "../utils/priceFixer.js";
import { buildImageVariants } from "../utils/imageFixer.js";

import {
  loadCheerioS200,
  normalizeItemS200,
  coerceItemsS200,
  withTimeout,
  TimeoutError,
  safeStr,
} from "../core/s200AdapterKit.js";

// ============================================================================
// S200 HARDENING HELPERS (KIT-LOCKED)
// ============================================================================
const FINDALLEASY_ALLOW_STUBS = String(process.env.FINDALLEASY_ALLOW_STUBS || "0") === "1";

function _errStr(e) {
  return safeStr(e?.message || e || "error", 500);
}
function _isTimeout(e) {
  return e instanceof TimeoutError || /timed?\s*out/i.test(String(e?.message || e || ""));
}
function _mkRes(source, ok, items, meta = {}) {
  const arr = Array.isArray(items) ? items : [];
  return { ok: !!ok, items: arr, count: arr.length, source, _meta: { ...meta } };
}
function _normalizeMany(rawItems, providerKey, normOpts = {}) {
  const out = [];
  for (const it of coerceItemsS200(rawItems)) {
    const x = it && typeof it === "object" ? { ...it } : it;
    if (x && typeof x === "object") {
      // NO RANDOM/DRIFT ID: force kit stableId
      delete x.id;
      delete x.listingId;
    }
    const n = normalizeItemS200(x, providerKey, normOpts);
    if (n) out.push(n);
  }
  // dedupe by id
  const seen = new Set();
  const deduped = [];
  for (const it of out) {
    const id = String(it?.id || "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push(it);
  }
  return deduped;
}


// ============================================================================
// ⭐️ S200 NORMALIZER — tüm adapterları TEK FORMA sokan blender
// ============================================================================
function normalizeS200(item) {
  if (!item) return null;

  const link = item.deeplink || item.url || null;

  return {
    id: item.id,

    provider: "hepsiburada",
    source: "hepsiburada_scraper",

    title: item.title || "",
    price: item.price ?? null,
    priceText: item.priceText ?? null,

    finalPrice: item.optimizedPrice ?? item.price ?? null,
    optimizedPrice: item.optimizedPrice ?? item.price ?? null,

    rating: item.rating ?? null,
    reviewCount: item.reviewCount ?? null,

    url: link,
    deeplink: link,
    affiliateUrl: link,

    image: item.image || null,
    imageOriginal: item.imageOriginal || null,
    imageProxy: item.imageProxy || null,
    hasProxy: item.hasProxy ?? false,

    currency: item.currency || "TRY",
    region: String(item.region || "TR").toUpperCase(),

    category: "product",
    categoryAI: "product",

    stockStatus: "in_stock",
    availability: "in_stock",

    providerType: "retailer",
    providerFamily: "hepsiburada",
    vertical: "product",

    qualityScore: item.qualityScore ?? 0,

    raw: item.raw || { legacy: item },
  };
}

// ============================================================================
// HELPERS — S33
// ============================================================================
function safe(v) {
  return v == null ? "" : String(v).trim();
}

function clean(v) {
  return String(v || "").replace(/\s+/g, " ").trim();
}

function parsePriceStrong(text) {
  if (!text) return null;
  try {
    let cleaned = text
      .replace(/[^\d.,]/g, "")
      .replace(/\.(?=\d{3})/g, "")
      .replace(",", ".");
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function stableId(provider, title, url) {
  const seed = `${provider}::${title}::${url}`;
  return (
    "hb_" +
    Buffer.from(seed)
      .toString("base64")
      .replace(/[^A-Za-z0-9]/g, "")
      .slice(0, 14)
  );
}

function computeQualityScore(item) {
  let s = 0;
  if (item.title) s += 0.45;
  if (item.price != null) s += 0.35;
  if (item.image) s += 0.15;
  s += 0.05;
  return Number(s.toFixed(2));
}

const BASE = "https://www.hepsiburada.com";
const wait = (ms) => new Promise((res) => setTimeout(res, ms));

// ============================================================================
// 1) REAL SCRAPER — TITAN LEVEL → S200 OUTPUT
// ============================================================================
export async function searchHepsiScrape(query = "", region = "TR", signal = null) {
  try {
    const q = encodeURIComponent(query);
    const url = `${BASE}/ara?q=${q}`;

    await wait(120); // anti-bot

    const { data: html } = await axios.get(url, {
      timeout: 15000,
      signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (FindAllEasyBot S33)",
        "Accept-Language": "tr-TR,tr;q=0.9",
      },
    });

    const $ = loadCheerioS200(html);
    const rawItems = [];

    const selectors = [
      ".search-item",
      ".productBox",
      ".box",
      ".search-item-wrapper",
      ".product-list-item",
      "[data-testid='product-card']",
      ".product-card",
    ];

    $(selectors.join(", ")).each((i, el) => {
      const root = $(el);

      const title =
        clean(
          root
            .find(
              "h3.title, h3.product-title, a.title, a.product-title, .product-title"
            )
            .first()
            .text()
        ) || null;

      const priceText =
        clean(
          root
            .find(
              ".price, .price-value, .product-price, span.price, .price-new, [data-testid='price-current']"
            )
            .first()
            .text()
        ) || null;

      const rawParsed = parsePriceStrong(priceText);
      const sanitized = sanitizePrice(rawParsed);

      let href =
        root.find("a").attr("href") ||
        root.find("a.product-link").attr("href") ||
        null;

      if (!href) return;
      if (!href.startsWith("http")) href = BASE + href;

      const imgRaw =
        root.find("img").attr("data-src") ||
        root.find("img").attr("src") ||
        null;

      const image = buildImageVariants(imgRaw);

      if (!title) return;

      const id = stableId("hepsiburada", title, href);

      const item = {
        id,
        title,
        price: sanitized,
        priceText,

        optimizedPrice:
          sanitized != null
            ? optimizePrice({ price: sanitized }, { provider: "hepsiburada" })
            : null,

        provider: "hepsiburada",
        providerType: "retailer",
        providerFamily: "hepsiburada",
        vertical: "product",

        region,
        currency: "TRY",

        url: href,
        deeplink: href,

        image: image.image,
        imageOriginal: image.imageOriginal,
        imageProxy: image.imageProxy,
        hasProxy: image.hasProxy,

        category: "product",
        categoryAI: "product",

        raw: { priceText, href, imgRaw },
      };

      rawItems.push({
        ...item,
        qualityScore: computeQualityScore(item),
      });
    });

    // ⭐️ SON ÇIKIŞ: normalizeS200 → TEK STANDART
    return rawItems.slice(0, 30).map((x) => normalizeS200(x));
  } catch (err) {
    if (err?.name === "AbortError") return [];
    console.warn("⚠️ Hepsiburada scrape hata:", err.message);
    return [];
  }
}

// ============================================================================
// 2) API MOCK — Şimdilik boş (S200 uyumlu)
// ============================================================================
export async function searchHepsiburada(query = "", region = "TR") {
  return [];
}

// ============================================================================
// 3) UNIVERSAL ADAPTER — S200 FINAL
// ============================================================================
export async function searchHepsiburadaAdapterLegacy(query, region = "TR") {
  try {
    const scraped = await searchHepsiScrape(query, region);
    return scraped;
  } catch {
    return [];
  }
}


export async function searchHepsiburadaAdapter(query, region = "TR") {
  const timeoutMs = Number(process.env.S200_PROVIDER_TIMEOUT_MS || 6500);

  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = { adapter: "hepsiburadaScraper", providerKey: "hepsiburada", url: "" };

  try {
    const raw = await withTimeout(searchHepsiburadaAdapterLegacy(query, region), timeoutMs, "hepsiburada.scraper");
    const items = _normalizeMany(raw, "hepsiburada", { providerFamily: "hepsiburada", vertical: "product", category: "product", currency: "TRY", region, baseUrl: "https://www.hepsiburada.com" });
    return _mkRes("hepsiburada_scraper", true, items, { code: items.length ? "OK" : "OK_EMPTY", region, timeoutMs });
  } catch (err) {
    return _mkRes("hepsiburada_scraper", false, [], { code: _isTimeout(err) ? "TIMEOUT" : "ERROR", error: _errStr(err), region, timeoutMs });
  } finally {
    globalThis.__S200_ADAPTER_CTX = prevCtx;
  }
}

export const searchHepsiScrapeAdapter = searchHepsiburadaAdapter;
export const searchHepsiburadaSearch = searchHepsiburadaAdapter;

export default {
  searchHepsiburada,
  searchHepsiScrape,
  searchHepsiburadaAdapter,
  searchHepsiburadaSearch,
};

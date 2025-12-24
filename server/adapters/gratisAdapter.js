// server/adapters/gratisAdapter.js
// ============================================================================
// GRATIS — S33 TITAN FINAL ADAPTER
// ZERO DELETE — tüm fonksiyon imzaları korunur
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


// ------------------------------------------------------------
// SAFE HELPERS
// ------------------------------------------------------------
function safe(v) {
  return v == null ? "" : String(v).trim();
}

function parsePriceStrong(txt) {
  if (!txt) return null;
  let clean = String(txt)
    .replace(/[^\d.,]/g, "")
    .replace(/\.(?=\d{3})/g, "")
    .replace(",", ".");
  const n = Number(clean);
  return Number.isFinite(n) ? n : null;
}

// stableId — TITAN merge engine için zorunlu
function stableId(provider, title, href) {
  const seed = `${provider}::${title}::${href}`;
  return (
    "gratis_" +
    Buffer.from(seed)
      .toString("base64")
      .replace(/[^A-Za-z0-9]/g, "")
      .slice(0, 16)
  );
}

// BEST kart sıralaması için kalite skoru
function computeQualityScore(base) {
  let s = 0;
  if (base.title) s += 0.45;
  if (base.price != null) s += 0.35;
  if (base.image) s += 0.15;
  s += 0.05;
  return Number(s.toFixed(2));
}

const MAX_PAGES = 3;

// ------------------------------------------------------------
// TEK SAYFA SCRAPER — S33 TITAN
// ------------------------------------------------------------
async function scrapeGratisPage(query, page = 1, signal = null) {
  try {
    const q = encodeURIComponent(query);
    const url = `https://www.gratis.com/search?q=${q}&page=${page}`;

    const { data: html } = await axios.get(url, {
      timeout: 15000,
      signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/124",
        "Accept-Language": "tr-TR,tr;q=0.9",
        Referer: "https://www.gratis.com",
      },
    });

    const $ = loadCheerioS200(html);
    const out = [];
    const qLower = query.toLowerCase();

    const selectors = [
      ".prd-list-item",
      ".product-card",
      ".fl-product-card",
      ".product-item",
      ".prd-item",
      ".product",
      ".col-6",
      ".col-md-4",
    ];

    $(selectors.join(",")).each((i, el) => {
      const wrap = $(el);

      // -----------------------------------------
      // TITLE
      // -----------------------------------------
      const title =
        safe(wrap.find(".prd-list-item-name").text()) ||
        safe(wrap.find(".product-title").text()) ||
        safe(wrap.find(".item-name").text()) ||
        safe(wrap.find(".fl-product-card__title").text()) ||
        safe(wrap.find("h3").text());

      if (!title) return;

      // Fuzzy match
      const tNorm = title.toLowerCase().replace(/\s+/g, "");
      const qNorm = qLower.replace(/\s+/g, "");

      if (!tNorm.includes(qNorm)) return;

      // -----------------------------------------
      // PRICE
      // -----------------------------------------
      const priceTxt =
        safe(wrap.find(".prd-list-item-price").text()) ||
        safe(wrap.find(".price").text()) ||
        safe(wrap.find(".product-price").text()) ||
        safe(wrap.find(".fl-product-card__price").text());

      const strong = parsePriceStrong(priceTxt);
      const price = sanitizePrice(strong);

      // -----------------------------------------
      // URL
      // -----------------------------------------
      let href =
        safe(wrap.find("a.prd-list-item-link").attr("href")) ||
        safe(wrap.find("a").attr("href"));

      if (!href) return;
      if (!href.startsWith("http")) href = "https://www.gratis.com" + href;

      // -----------------------------------------
      // IMAGE + VARIANTS
      // -----------------------------------------
      const imgRaw =
        safe(wrap.find("img").attr("data-src")) ||
        safe(wrap.find("img").attr("data-original")) ||
        safe(wrap.find("img").attr("src")) ||
        null;

      const imageData = buildImageVariants(imgRaw, "gratis");

      // -----------------------------------------
      // ID
      // -----------------------------------------
      const id = stableId("gratis", title, href);

      const base = {
        id,
        title,
        price,
        priceText: priceTxt,
        rating: null,

        provider: "gratis",
        providerType: "retailer",
        providerFamily: "gratis",
        vertical: "cosmetics",
        category: "cosmetics",
        categoryAI: "beauty_product",

        currency: "TRY",
        region: "TR",

        url: href,
        deepLink: href,

        image: imageData.image,
        imageOriginal: imageData.imageOriginal,
        imageProxy: imageData.imageProxy,
        hasProxy: imageData.hasProxy,

        raw: { title, priceTxt, href, imgRaw },
      };

      out.push({
        ...base,
        finalPrice: base.price,
        optimizedPrice:
          base.price != null
            ? optimizePrice({ price: base.price }, { provider: "gratis" })
            : null,
        qualityScore: computeQualityScore(base),
        stock: "var",
      });
    });

    return out;
  } catch (err) {
    if (err?.name === "CanceledError" || err?.name === "AbortError") {
      console.warn("⏳ Gratis scrape abort.");
      return [];
    }
    console.warn("⚠️ Gratis S33 hata:", err.message);
    return [];
  }
}

// ------------------------------------------------------------
// ANA ADAPTER — ZERO DELETE GUARANTEE
// ------------------------------------------------------------
export async function searchGratisLegacy(query, regionOrOptions = "TR") {
  let region = "TR";
  let signal = null;

  if (typeof regionOrOptions === "string") {
    region = regionOrOptions;
  } else if (typeof regionOrOptions === "object") {
    region = regionOrOptions.region || "TR";
    signal = regionOrOptions.signal || null;
  }

  try {
    const q = safe(query);
    if (!q) return [];

    let all = [];

    for (let p = 1; p <= MAX_PAGES; p++) {
      const part = await scrapeGratisPage(q, p, signal);
      if (!part.length) break;
      all = all.concat(part);
    }

    return all.slice(0, 60); // Titan optimum
  } catch (err) {
    console.warn("searchGratis hata:", err.message);
    return [];
  }
}

// ------------------------------------------------------------
// ALIASES — SILINMEDI
// ------------------------------------------------------------
export const searchGratisScrape = searchGratis;
export const searchGratisAdapter = searchGratis;


export async function searchGratis(query, regionOrOptions = "TR", signal = null) {
  let region = "TR";
  let options = {};
  if (typeof regionOrOptions === "string") {
    region = regionOrOptions || "TR";
  } else if (regionOrOptions && typeof regionOrOptions === "object") {
    region = regionOrOptions.region || "TR";
    options = regionOrOptions;
  }
  const timeoutMs = Number(options.timeoutMs || process.env.S200_PROVIDER_TIMEOUT_MS || 6500);

  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = { adapter: "searchGratis", providerKey: "gratis", url: "" };

  try {
    const raw = await withTimeout(searchGratisLegacy(query, regionOrOptions, signal), timeoutMs, "gratis.legacy");
    // If legacy returned fallback placeholders, block in PROD
    const hasFallback = Array.isArray(raw) && raw.some((x) => x && typeof x === "object" && (x.fallback === true || x.isFallback === true));
    if (hasFallback && !FINDALLEASY_ALLOW_STUBS) {
      return _mkRes("gratis", false, [], { code: "STUB_BLOCKED", region, timeoutMs });
    }
    const items = _normalizeMany(raw, "gratis", { providerFamily: "gratis", vertical: "cosmetics", category: "beauty_product", currency: "TRY", region, baseUrl: "https://www.gratis.com" });
    return _mkRes("gratis", true, items, { code: items.length ? "OK" : "OK_EMPTY", region, timeoutMs });
  } catch (err) {
    return _mkRes("gratis", false, [], { code: _isTimeout(err) ? "TIMEOUT" : "ERROR", error: _errStr(err), region, timeoutMs });
  } finally {
    globalThis.__S200_ADAPTER_CTX = prevCtx;
  }
}

export async function searchGratisArray(query, regionOrOptions = "TR", signal = null) {
  // legacy raw array (ZERO DELETE)
  return await searchGratisLegacy(query, regionOrOptions, signal);
}

export default { searchGratis };

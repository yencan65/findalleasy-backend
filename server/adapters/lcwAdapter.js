// server/adapters/lcwAdapter.js
// ============================================================================
//  LC Waikiki Ürün Arama Adapterı — S5 → S22 ULTRA TITAN
// ----------------------------------------------------------------------------
//  ZERO DELETE — Eski S5 fonksiyonları korunur, üstüne Titan katmanları eklendi
// ----------------------------------------------------------------------------
//  ✔ S5 output format: { ok, adapterName, items, count }
//  ✔ signal tam uyumlu (AbortController)
//  ✔ multi-page + early break
//  ✔ normalizeItem ile %100 uyumlu alanlar
//  ✔ proxyFetchHTML + anti-bot script cleaner
//  ✔ strongPriceParser + sanitizePrice + optimizePrice
//  ✔ ImageVariants S22 (image, imageOriginal, imageProxy, hasProxy)
//  ✔ stableId (Titan Merge Engine uyumlu)
//  ✔ provider meta + categoryAI + qualityScore
// ============================================================================

import axios from "axios";
import * as cheerio from "cheerio";

import { proxyFetchHTML } from "../core/proxyEngine.js";
import { sanitizePrice } from "../utils/priceSanitizer.js";
import { optimizePrice } from "../utils/priceFixer.js";
import { buildImageVariants } from "../utils/imageFixer.js";

import { coerceItemsS200, fixKey, loadCheerioS200, normalizeItemS200, withTimeout } from "../core/s200AdapterKit.js";

// ---------------------------------------------------------------------------
// STUB POLICY (HARD)
// - PROD: stubs/mocks/fallback listings are BLOCKED (NO FAKE RESULTS)
// - DEV: allow via FINDALLEASY_ALLOW_STUBS=1
// ---------------------------------------------------------------------------
const FINDALLEASY_ALLOW_STUBS = String(process.env.FINDALLEASY_ALLOW_STUBS || "") === "1";


// ------------------------------------------------------------
// SAFE HELPERS (ESKİLER KORUNDU)
// ------------------------------------------------------------
function safe(v) {
  return v == null ? "" : String(v).trim();
}

// Eski basit fiyat parser — ZERO DELETE için korunuyor
function parsePrice(txt) {
  if (!txt) return null;
  const cleaned = txt
    .replace(/[^\d.,]/g, "")
    .replace(/\./g, "")
    .replace(",", ".");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// Yeni güçlü fiyat parser (S22 Titan)
function parsePriceStrong(txt) {
  if (!txt) return null;
  try {
    let clean = String(txt)
      .replace(/TL|tl|₺|TRY|try|’den|den|başlayan|baslayan/gi, "")
      .replace(/[^\d.,\-]/g, "")
      .trim();

    // Aralık ise ilk değeri al
    if (clean.includes("-")) {
      clean = clean.split("-")[0].trim();
    }

    clean = clean
      .replace(/\.(?=\d{3})/g, "") // 1.299,99 → 1299,99
      .replace(",", ".");

    const n = Number(clean);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// Anti-bot / trap script temizleyici
function cleanBotTraps(html) {
  if (!html) return "";
  return String(html)
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
}

// stableId — Titan Merge Engine uyumlu
function stableId(provider, url, i = 0) {
  const seed = `${provider}::${url}::${i}`;
  return (
    "lcw_" + Buffer.from(seed).toString("base64").slice(0, 14)
  );
}

// Görsel çıkarma (eski fonksiyon korunuyor, yeni ile destekleniyor)
function extractImage($, el) {
  return (
    $(el).find("img").attr("data-src") ||
    $(el).find("img").attr("data-original") ||
    $(el).find("img").attr("data-image") ||
    $(el).find("img").attr("src") ||
    $(el).find("picture img").attr("src") ||
    null
  );
}

// Yeni: srcset/data-srcset destekli image extractor
function extractImageStrong($, el) {
  const $img = $(el).find("img").first();
  if (!$img || !$img.length) {
    return extractImage($, el);
  }

  const direct =
    $img.attr("src") ||
    $img.attr("data-src") ||
    $img.attr("data-original") ||
    $img.attr("data-image");

  let srcset = $img.attr("srcset") || $img.attr("data-srcset") || "";
  if (srcset) {
    const parts = srcset.split(",").map((p) => p.trim());
    const last = parts[parts.length - 1] || "";
    const url = last.split(" ")[0];
    if (url) return url;
  }

  return direct || extractImage($, el) || null;
}

// QualityScore — başlık + fiyat + görsel
function computeQualityScore(item) {
  let s = 0;
  if (item.title && item.title.length > 5) s += 0.35;
  if (item.price != null) s += 0.35;
  if (item.image) s += 0.30;
  return Number(s.toFixed(2));
}

// ------------------------------------------------------------
// LCW DOM SELECTORS — eski + yeni fallback’lar
// ------------------------------------------------------------
const SELECTORS = [
  ".product-card",
  ".product-item",
  ".product",
  ".product-grid-container .product-card",
  ".row .product-card",
  ".product-list-item",
  ".col-6.product-card",
  "[data-product-id]",
  "li.product-card",
  "[itemtype='http://schema.org/Product']",
];

const MAX_PAGES = 3;

// ========================================================
// TEK SAYFA SCRAPER (SİNYAL DESTEKLİ) — S22 TITAN
// ========================================================
async function scrapeLCWPage(query, page = 1, signal) {
  try {
    const q = encodeURIComponent(query);
    const url = `https://www.lcwaikiki.com/tr-TR/TR/arama?q=${q}&page=${page}`;

    let html = null;

    // 1) proxyFetchHTML → anti-bot bypass
    try {
      html = await proxyFetchHTML(url);
    } catch {
      // 2) Proxy çökerse axios fallback
      try {
        const axiosConfig = {
          timeout: 17000,
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120",
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.8",
          },
        };
        if (signal) axiosConfig.signal = signal;

        const { data } = await axios.get(url, axiosConfig);
        html = data;
      } catch (innerErr) {
        if (innerErr.name === "AbortError") {
          console.warn("⛔ LCW abort (axios fallback)");
          return [];
        }
        console.warn("LCW axios fallback hata:", innerErr.message);
        return [];
      }
    }

    if (!html) return [];

    // 3) Anti-bot/trap temizliği
    const cleaned = cleanBotTraps(html);
    const $ = loadCheerioS200(cleaned);
    const items = [];

    $(SELECTORS.join(",")).each((i, el) => {
      const $el = $(el);

      const title =
        safe($el.find(".product-card__title").text()) ||
        safe($el.find(".product-title").text()) ||
        safe($el.find(".name").text()) ||
        safe($el.find("h3").text()) ||
        safe($el.find("h2").text()) ||
        safe($el.attr("data-product-name"));

      if (!title) return;

      const priceTxt =
        safe($el.find(".product-card__price--new").text()) ||
        safe($el.find(".product-card__price").text()) ||
        safe($el.find(".product-price").text()) ||
        safe($el.find(".price").text()) ||
        safe($el.find(".new-price").text()) ||
        safe($el.find("[itemprop='price']").text());

      // Yeni strong parser + eski parser fallback + sanitizePrice
      const strongParsed = parsePriceStrong(priceTxt);
      const legacyParsed = parsePrice(priceTxt);

      const priceSanitized = sanitizePrice(
        strongParsed != null ? strongParsed : legacyParsed
      );

      const price =
        priceSanitized != null
          ? priceSanitized
          : strongParsed != null
          ? strongParsed
          : legacyParsed;

      // URL
      let href =
        safe($el.find("a").attr("href")) ||
        safe($el.find(".product-link").attr("href")) ||
        safe($el.attr("data-product-url"));

      if (!href) return;
      if (!href.startsWith("http")) {
        href = "https://www.lcwaikiki.com" + href;
      }

      // Görsel
      const imgRaw = extractImageStrong($, el);
      const imageVariants = buildImageVariants(imgRaw);

      const id = stableId("lcwaikiki", href, i);

      const baseItem = {
        id,
        title,
        price,
        rating: null,

        provider: "lcwaikiki",
        providerType: "retailer",
        providerFamily: "lcwaikiki",
        vertical: "fashion",

        currency: "TRY",
        region: "TR",

        url: href,
        deeplink: href,

        image: imageVariants.image,
        imageOriginal: imageVariants.imageOriginal,
        imageProxy: imageVariants.imageProxy,
        hasProxy: imageVariants.hasProxy,

        category: "product",
        categoryAI: "fashion",

        fallback: false,

        raw: { title, priceTxt, href, imgRaw },
      };

      const qualityScore = computeQualityScore({
        title: baseItem.title,
        price: baseItem.price,
        image: baseItem.image,
      });

      // Titan PriceEngine ile optimize fiyat
      const optimizedPrice =
        price != null
          ? optimizePrice({ price }, { provider: "lcwaikiki" })
          : null;

      items.push({
        ...baseItem,
        optimizedPrice,
        qualityScore,
      });
    });

    return items;
  } catch (err) {
    if (err.name === "AbortError") {
      console.warn("⛔ LCW abort edildi");
      return [];
    }
    console.warn("LCW scrape hata:", err.message);
    return [];
  }
}

// ========================================================
// ANA ADAPTER (S5 UYUM + S22 TITAN GÜÇLENDİRME)
// ========================================================
async function searchLCWLegacy(
  query,
  { region = "TR", signal } = {}
) {
  try {
    const q = safe(query);
    if (!q) {
      return {
        ok: false,
        adapterName: "lcwaikiki",
        items: [],
        count: 0,
      };
    }

    let all = [];

    for (let page = 1; page <= MAX_PAGES; page++) {
      const part = await scrapeLCWPage(q, page, signal);

      // Titan guard: hem bot-trap hem gerçek boş sayfa burada yakalanır
      if (!part || part.length === 0) {
        break; // erken kırma
      }

      all = all.concat(part);
    }

    return {
      ok: true,
      adapterName: "lcwaikiki",
      items: all,
      count: all.length,
      region: region || "TR",
    };
  } catch (err) {
    if (err.name === "AbortError") {
      return {
        ok: false,
        adapterName: "lcwaikiki",
        timeout: true,
        items: [],
        count: 0,
      };
    }

    console.warn("searchLCW hata:", err.message);

    return {
      ok: false,
      adapterName: "lcwaikiki",
      error: err?.message || "unknown error",
      items: [],
      count: 0,
    };
  }
}

// Alias (backward compatibility)

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

export async function searchLCWAdapter(query, regionOrOptions = "TR") {
  const t0 = Date.now();
  const { region, signal } = _s200ResolveRegionSignal(regionOrOptions, "TR");

  globalThis.__S200_ADAPTER_CTX = {
adapter: "lcwaikiki",
    providerKey: "lcwaikiki",
    source: "lcwaikiki",  region,
  };
  try {
    const legacyOut = await withTimeout(
      searchLCWLegacy(query, typeof regionOrOptions === "object" ? { region, signal } : { region }),
      6500,
      "lcwaikiki"
    );

    const rawItems = coerceItemsS200(legacyOut);
    const rawCount = Array.isArray(rawItems) ? rawItems.length : 0;

    const blocked = !FINDALLEASY_ALLOW_STUBS && rawItems.some(_s200IsFake);
    const filtered = blocked ? [] : rawItems;

    const normalized = filtered
      .map((it) => {
        if (!it || typeof it !== "object") return null;

        const copy = { ...it };
        delete copy.id;
        delete copy.listingId;

        const pk = "lcwaikiki";

        return normalizeItemS200(copy, pk, {
          providerFamily: "fashion",
          vertical: "fashion",
          category: "fashion",
          region,
        });
      })
      .filter(Boolean);

    const meta = {
      adapter: "lcwaikiki",
      providerKey: "lcwaikiki",
      source: "lcwaikiki",
      region,
      ms: Date.now() - t0,
      allowStubs: FINDALLEASY_ALLOW_STUBS,
      legacyOk: legacyOut && typeof legacyOut === "object" ? legacyOut.ok : undefined,
      rawCount,
      normalizedCount: normalized.length,
      stubBlocked: blocked,
    };
    if (blocked) {
      return { ok: false, items: [], count: 0, source: "lcwaikiki", _meta: { ...meta, error: "stub_blocked" } };
    }

    if (legacyOut && typeof legacyOut === "object" && legacyOut.ok === false) {
      return {
        ok: false,
        items: [],
        count: 0,
        source: "lcwaikiki",
        _meta: {
          ...meta,
          timeout: !!legacyOut.timeout,
          error: legacyOut.error || legacyOut.errorMessage || "legacy_fail",
        }
      };
    }

    return { ok: true, items: normalized, count: normalized.length, source: "lcwaikiki", _meta: meta };
  } catch (e) {
    return {
      ok: false,
      items: [],
      count: 0,
      source: "lcwaikiki",
      _meta: {
        adapter: "lcwaikiki",
        providerKey: "lcwaikiki",
        source: "lcwaikiki",
        region,
        ms: Date.now() - t0,
        allowStubs: FINDALLEASY_ALLOW_STUBS,
        timeout: _s200IsTimeout(e),
        error: e?.message || String(e),
      }
    };
  }
}

export const searchLCW = searchLCWAdapter;
export const searchLCWScrape = searchLCWAdapter;

export default {
  searchLCW,
  searchLCWScrape,
  searchLCWAdapter,
  searchLCWLegacy
};

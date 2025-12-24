// server/adapters/endeksaAdapter.js
// ======================================================================
// ENDEKSA — S33 TITAN+ EMlAK ANALİZ ADAPTERİ (FINAL)
// Zero Delete · StableId v3.5 · QualityScore(estate) · CategoryAI
// ImageVariants → Yok ama boş variantlar eklenir (router uyumu)
// Rate Limiter uyumlu (ana motor ile entegre)
// ======================================================================

import axios from "axios";
import * as cheerio from "cheerio";
import crypto from "crypto";
import { buildImageVariants } from "../utils/imageFixer.js";
import { rateLimiter } from "../utils/rateLimiter.js";

import { loadCheerioS200 } from "../core/s200AdapterKit.js";

// ======================= RATE LIMITER =======================
async function checkRateLimit() {
  const key = "adapter_endeksa_TR";
  const allowed = await rateLimiter.check(key, {
    limit: 12,
    windowMs: 60000,
    burst: true,
    adaptive: true,
  });
  
  if (!allowed) {
    console.warn(`⛔ RATE LIMIT → endeksa`);
    throw new Error("Rate limit exceeded for endeksa adapter");
  }
  
  return true;
}

// ======================= HELPERS =======================
const safe = (v) => (v ? String(v).trim() : "");

function parsePrice(t) {
  if (!t) return null;
  const cleaned = t.replace(/[^\d.,]/g, "").replace(/\./g, "").replace(",", ".");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// ----------------------------------------------------------------------
// S33 StableID (slug + city + district + md5hash)
// ----------------------------------------------------------------------
function stableId(name, city, district, href) {
  const slug = safe(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 40);

  const hash = crypto
    .createHash("md5")
    .update((href || "") + (city || "") + (district || ""))
    .digest("hex")
    .slice(0, 8);

  return `endeksa_${slug}_${hash}`;
}

// ----------------------------------------------------------------------
// S33 Estate Quality Score (basitleştirilmiş ama çok etkili)
// ----------------------------------------------------------------------
function computeEstateScore(item) {
  let s = 0;

  if (item.title) s += 0.25;
  if (item.city) s += 0.20;
  if (item.district) s += 0.20;

  if (item.price) s += 0.15;
  if (item.priceMin && item.priceMax) s += 0.10;

  s += 0.10; // entropy / stabilisation

  return Number(s.toFixed(2));
}

// ----------------------------------------------------------------------
// NORMALIZER — Ana motor ile uyumlu format
// ----------------------------------------------------------------------
function normalizeEndeksa(raw, region, query) {
  const img = buildImageVariants(null, "endeksa"); // Endeksa görsel vermiyor → boş variant seti

  // Ana motorun normalizeItem fonksiyonu ile uyumlu temel yapı
 const baseItem = {
    id: stableId(raw.name, raw.city, raw.district, raw.href),
    title: raw.name,

    // 🔥 S200 URL STANDARDI
    originUrl: raw.href,
    finalUrl: raw.href,
    deeplink: raw.href,
    url: raw.href,

    // 🔥 S200 PRICE PIPELINE
    price: raw.avgPrice ?? null,
    finalPrice: raw.avgPrice ?? null,
    optimizedPrice: raw.avgPrice ?? null,

    rating: null,
    provider: "endeksa",
    currency: "TRY",
    region: region.toUpperCase(),
    category: "estate",
    adapterSource: "endeksaAdapter",

    
    // Ana motorun normalizeItem fonksiyonunda kullanılacak raw alanı
    raw: {
      title: raw.name,
      city: raw.city || null,
      district: raw.district || null,
      price: raw.avgPrice ?? null,
      priceMin: raw.priceMin ?? null,
      priceMax: raw.priceMax ?? null,
      url: raw.href,
      
      // S33 TITAN+ ek alanları
      providerFamily: "estate",
      providerType: "estimate",
      providerSignature: "endeksa_s33",
      adapterVersion: "S33.TITAN+",
      reliabilityScore: 0.93,
      categoryAI: "estate",
      vertical: "estate",
      
      // Görsel alanları (boş)
      image: img.image,
      imageOriginal: img.imageOriginal,
      imageProxy: img.imageProxy,
      hasProxy: img.hasProxy,
      
      qualityScore: computeEstateScore({
        title: raw.name,
        city: raw.city,
        district: raw.district,
        price: raw.avgPrice,
        priceMin: raw.priceMin,
        priceMax: raw.priceMax
      }),
      rawData: raw
    }
  };

  return baseItem;
}

// ----------------------------------------------------------------------
// SCRAPE PAGE — S33 Ultra Selector Pool
// ----------------------------------------------------------------------
async function scrapePage(query, page, signal, region) {
  try {
    const q = encodeURIComponent(query);
    const url =
      page === 1
        ? `https://www.endeksa.com/tr/analiz?q=${q}`
        : `https://www.endeksa.com/tr/analiz?q=${q}&page=${page}`;

    const { data: html } = await axios.get(url, {
      timeout: 20000,
      signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (FindAllEasy-S33)",
        "Accept-Language": "tr-TR,tr;q=0.9",
        Referer: "https://www.endeksa.com/",
      },
    });

    const $ = loadCheerioS200(html);
    const out = [];

    const selectors = [
      ".district-box",
      ".analysis-card",
      ".location-card",
      ".analysis-item",
      ".result-card",
      ".location-box",
      ".location-card-component",
    ];

    $(selectors.join(",")).each((_, el) => {
      const wrap = $(el);

      const name =
        safe(wrap.find(".district-name").text()) ||
        safe(wrap.find(".title").text()) ||
        safe(wrap.find("h3").text()) ||
        safe(wrap.find(".name").text());
      if (!name) return;

      const city =
        safe(wrap.find(".city-name").text()) ||
        safe(wrap.find(".location-city").text()) ||
        safe(wrap.find(".sehir").text()) ||
        null;

      const district =
        safe(wrap.find(".district").text()) ||
        safe(wrap.find(".ilce").text()) ||
        safe(wrap.find(".location-district").text()) ||
        null;

      const avgPrice = parsePrice(
        safe(wrap.find(".price-value").text()) ||
          safe(wrap.find(".avg-price").text()) ||
          safe(wrap.find(".value").text()) ||
          safe(wrap.find(".analysis-avg-value").text())
      );

      const priceMin = parsePrice(
        safe(wrap.find(".price-min").text()) ||
          safe(wrap.find(".min-price").text())
      );

      const priceMax = parsePrice(
        safe(wrap.find(".price-max").text()) ||
          safe(wrap.find(".max-price").text())
      );

      let href =
        safe(wrap.find("a").attr("href")) ||
        safe(wrap.find(".card-link").attr("href")) ||
        "";

      if (href && !href.startsWith("http")) {
        href = "https://www.endeksa.com" + href;
      }
      if (!href) href = "https://www.endeksa.com/tr/analiz";

      out.push(
        normalizeEndeksa(
          {
            name,
            city,
            district,
            avgPrice,
            priceMin,
            priceMax,
            href,
          },
          region,
          query
        )
      );
    });

    return out;
  } catch (err) {
    console.warn("⚠️ Endeksa S33 scrape hata:", err.message);
    return [];
  }
}

// ----------------------------------------------------------------------
// MAIN ADAPTER — Multi-Page S33 TITAN (Rate Limiter uyumlu)
// ----------------------------------------------------------------------
export async function searchEndeksa(query, regionOrOptions = "TR", opts = {}) {
  let region = "TR";
  let signal = null;

  if (typeof regionOrOptions === "string") {
    region = regionOrOptions;
  } else if (regionOrOptions && typeof regionOrOptions === "object") {
    region = regionOrOptions.region || "TR";
    signal = regionOrOptions.signal || null;
  }

  const q = safe(query);
  if (!q) return [];

  try {
    // Rate limiter kontrolü
    await checkRateLimit();
    
    let all = [];

    for (let p = 1; p <= 3; p++) {
      const part = await scrapePage(q, p, signal, region);
      if (part.length === 0) break;

      all.push(...part);
      if (all.length > 150) break;
    }

    // Başarılı isteği kaydet
    rateLimiter.registerSuccess("adapter_endeksa_TR", 1);
    
    return all;
  } catch (err) {
    if (opts && opts.throwOnError) throw err;

    // Hata durumunda rate limiter'a bildir
    if (err.message !== "Rate limit exceeded for endeksa adapter") {
      rateLimiter.registerError("adapter_endeksa_TR", 1);
    }
    
    console.warn("⚠️ Endeksa adapter global hata:", err.message);
    return [];
  }
}

export const searchEndeksaScrape = searchEndeksa;
export const searchEndeksaAdapterLegacy = searchEndeksa;

export default { searchEndeksa };

// ============================================================================
// S200 WRAPPER HELPERS (AUTO-GENERATED)
// - ZERO DELETE: legacy funcs preserved as *Legacy
// - Output: { ok, items, count, source, _meta }
// - Observable fail: ok:false + items:[]
// - Deterministic IDs: normalizeItemS200 will enforce stableIdS200(providerKey,url,title)
// ============================================================================

function __s200_now() { return Date.now(); }

function __s200_result(providerKey, ok, items, meta) {
  const safeItems = Array.isArray(items) ? items : [];
  return {
    ok: !!ok,
    items: safeItems,
    count: safeItems.length,
    source: providerKey,
    _meta: meta || {},
  };
}

function __s200_errMeta(providerKey, started, err, extra) {
  const msg = (err && (err.message || err.toString())) || "unknown";
  const name = (err && err.name) || "Error";
  return {
    providerKey,
    startedAt: started,
    tookMs: Math.max(0, __s200_now() - started),
    error: { name, message: msg },
    ...(extra || {}),
  };
}


// ============================================================================
// S200 WRAPPED EXPORT (STRICT OUTPUT)
// ============================================================================
export async function searchEndeksaAdapter(query, options = {}, signal = null) {
  const providerKey = "endeksa";
  const started = __s200_now();
  try {
    globalThis.__S200_ADAPTER_CTX = {
      providerKey,
      adapter: "endeksaAdapter",
      query: String(query || ""),
      _meta: { startedAt: started },
    };

    const timeoutMs =
      Number(options?.timeoutMs) ||
      Number(process.env[`${providerKey.toUpperCase()}_TIMEOUT_MS`]) ||
      6500;

    // Call legacy (array) — force observable fail via throwOnError
    const raw = await withTimeout(
      () => searchEndeksa(query, options?.region || "TR", signal, { throwOnError: true }),
      timeoutMs,
      providerKey
    );

    const arr = coerceItemsS200(raw);
    const norm = [];
    for (const it of arr) {
      const cleaned = (it && typeof it === "object") ? { ...it, id: null, listingId: null } : it;
      const ni = normalizeItemS200(cleaned, providerKey);
      if (!ni) continue;
      norm.push(ni);
    }

    return __s200_result(providerKey, true, norm, {
      startedAt: started,
      tookMs: __s200_now() - started,
      timeoutMs,
      okFrom: "legacy_array",
    });
  } catch (err) {
    return __s200_result(providerKey, false, [], __s200_errMeta(providerKey, started, err, {
      timeoutMs: Number(options?.timeoutMs) || 6500,
      okFrom: "exception",
    }));
  }
}

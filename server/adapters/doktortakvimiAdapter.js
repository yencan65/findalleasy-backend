// server/adapters/doktortakvimiAdapter.js
// ============================================================
// DoktorTakvimi – S33 TITAN+ Sağlık/Uzman Adapter (FINAL)
// ------------------------------------------------------------
// ✔ stableId v3.5 (title + url hash)
// ✔ ImageVariants (proxy-ready)
// ✔ Health-weighted qualityScore
// ✔ providerSignature / providerFamily / adapterVersion
// ✔ categoryAI = "health", subCategory = "doctor", vertical = "health"
// ✔ multi-selector + anti-ban headers + signal-safe
// ✔ Rate Limiter uyumlu (ana motor ile entegre)
// ============================================================

import axios from "axios";
import * as cheerio from "cheerio";
import crypto from "crypto";
import { buildImageVariants } from "../utils/imageFixer.js";
import { rateLimiter } from "../utils/rateLimiter.js";

import { loadCheerioS200 } from "../core/s200AdapterKit.js";

// ======================= RATE LIMITER =======================
async function checkRateLimit() {
  const key = "adapter_doktortakvimi_TR";
  const allowed = await rateLimiter.check(key, {
    limit: 10,
    windowMs: 60000,
    burst: true,
    adaptive: true,
  });
  
  if (!allowed) {
    console.warn(`⛔ RATE LIMIT → doktortakvimi`);
    throw new Error("Rate limit exceeded for doktortakvimi adapter");
  }
  
  return true;
}

// ======================= HELPERS =======================
const safe = (v) => (v ? String(v).trim() : "");

function pick(...vals) {
  for (const v of vals) {
    if (v && String(v).trim().length > 1) return String(v).trim();
  }
  return "";
}

function normalizeUrl(h) {
  if (!h) return null;
  if (h.startsWith("http")) return h.split("?")[0];
  return "https://www.doktortakvimi.com" + h.split("?")[0];
}

// stableId v3.5 — title + urlHash
function stableId(title, href) {
  const slug = safe(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 60);

  const hash = crypto
    .createHash("md5")
    .update(href || "")
    .digest("hex")
    .slice(0, 8);

  return `doktortakvimi_${slug}_${hash}`;
}

// health-weighted quality score
function computeHealthScore(item) {
  let s = 0;

  if (item.title) s += 0.25;
  if (item.specialty) s += 0.20;
  if (item.location) s += 0.20;
  if (item.rating != null) s += 0.20;
  if (item.image) s += 0.10;
  s += 0.05; // entropy

  return Number(s.toFixed(2));
}

// Normalize → Ana motor ile uyumlu format
function normalizeDoctor(raw, region = "TR") {
  const img = buildImageVariants(raw.image || null, "doktortakvimi");

  // Ana motorun normalizeItem fonksiyonu ile uyumlu temel yapı
 const baseItem = {
    id: stableId(raw.title, raw.url),
    title: raw.title,

    // S200 URL Standardı
    originUrl: raw.url,
    finalUrl: raw.url,
    deeplink: raw.url,
    url: raw.url,

    price: null,

    // S200 Price Pipeline
    finalPrice: null,
    optimizedPrice: null,

    rating: raw.rating ?? null,

    provider: "doktortakvimi",
    currency: "TRY",

    region: (region || "TR").toUpperCase(),
    category: "health",
    adapterSource: "doktortakvimiAdapter",
    
    // Ana motorun normalizeItem fonksiyonunda kullanılacak raw alanı
    raw: {
      title: raw.title,
      specialty: raw.specialty || null,
      location: raw.location || null,
      rating: raw.rating ?? null,
      url: raw.url,
      image: img.image,
      imageOriginal: img.imageOriginal,
      imageProxy: img.imageProxy,
      hasProxy: img.hasProxy,
      
      // S33 TITAN+ ek alanları
      providerFamily: "health",
      providerType: "doctor",
      providerSignature: "doktortakvimi_s33",
      adapterVersion: "S33.TITAN+",
      reliabilityScore: 0.93,
      categoryAI: "health",
      vertical: "health",
      subCategory: "doctor",
      qualityScore: computeHealthScore({
        title: raw.title,
        specialty: raw.specialty,
        location: raw.location,
        rating: raw.rating,
        image: raw.image
      }),
      rawData: raw.raw || raw
    }
  };

  return baseItem;
}

const BASE = "https://www.doktortakvimi.com";

// ============================================================
// MAIN ADAPTER (S33 TITAN+) - Rate Limiter uyumlu
// ============================================================
export async function searchDoktorTakvimi(query, regionOrOptions = "TR", opts = {}) {
  let region = "TR";
  let signal = null;

  if (typeof regionOrOptions === "string") {
    region = regionOrOptions;
  } else if (regionOrOptions) {
    region = regionOrOptions.region || "TR";
    signal = regionOrOptions.signal || null;
  }

  try {
    // Rate limiter kontrolü
    await checkRateLimit();
    
    const q = encodeURIComponent(query);
    const url = `${BASE}/ara?q=${q}`;

    const { data: html } = await axios.get(url, {
      timeout: 15000,
      signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36",
        Accept: "text/html",
        "Accept-Language": "tr-TR,tr;q=0.9",
        Referer: "https://www.google.com/",
        Pragma: "no-cache",
        "Cache-Control": "no-cache",
      },
    });

    const $ = loadCheerioS200(html);
    const out = [];

    const selectors = [
      "div.c-doctor-card",
      "div.doctor-card",
      "li[data-professional-id]",
      ".professional-card",
      ".search-result-card",
      ".doctor-card-wrapper",
      "article",
      ".result-card",
    ];

    $(selectors.join(",")).each((i, el) => {
      const w = $(el);

      const title = pick(
        safe(w.find(".c-doctor-card__name").text()),
        safe(w.find(".doctor-name").text()),
        safe(w.find("h2").text()),
        safe(w.find("h3").text()),
        safe(w.find(".name").text())
      );
      if (!title) return;

      const href =
        normalizeUrl(
          safe(w.find("a").attr("href")) ||
          safe(w.find("a.c-doctor-card__link").attr("href"))
        );
      if (!href) return;

      const specialty = pick(
        safe(w.find(".c-doctor-card__specialty").text()),
        safe(w.find(".doctor-specialty").text()),
        safe(w.find(".specialty").text())
      );

      const location = pick(
        safe(w.find(".location").text()),
        safe(w.find(".clinic-name").text()),
        safe(w.find(".address").text())
      );

      const ratingTxt = pick(
        safe(w.find(".c-doctor-card__rating").text()),
        safe(w.find(".rating").text()),
        safe(w.find(".stars").text())
      );

      const rating =
        Number(ratingTxt.replace(",", ".").replace(/[^\d.]/g, "")) || null;

      const image =
        safe(w.find("img").attr("data-src")) ||
        safe(w.find("img").attr("src")) ||
        null;

      const raw = {
        title,
        specialty,
        location,
        ratingTxt,
        image,
        url: href,
      };

      out.push(
        normalizeDoctor(
          {
            title,
            specialty,
            location,
            rating,
            image,
            url: href,
            raw,
          },
          region
        )
      );
    });

    // Başarılı isteği kaydet
    rateLimiter.registerSuccess("adapter_doktortakvimi_TR", 1);
    
    return out;
  } catch (err) {
    if (opts && opts.throwOnError) throw err;

    // Hata durumunda rate limiter'a bildir
    if (err.message !== "Rate limit exceeded for doktortakvimi adapter") {
      rateLimiter.registerError("adapter_doktortakvimi_TR", 1);
    }
    
    console.warn("⚠️ DoktorTakvimi adapter hata:", err.message);
    return [];
  }
}

export const searchDoktorTakvimiScrape = searchDoktorTakvimi;
export const searchDoktorTakvimiAdapterLegacy = searchDoktorTakvimi;

export default { searchDoktorTakvimi };

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
export async function searchDoktorTakvimiAdapter(query, options = {}, signal = null) {
  const providerKey = "doktortakvimi";
  const started = __s200_now();
  try {
    globalThis.__S200_ADAPTER_CTX = {
      providerKey,
      adapter: "doktortakvimiAdapter",
      query: String(query || ""),
      _meta: { startedAt: started },
    };

    const timeoutMs =
      Number(options?.timeoutMs) ||
      Number(process.env[`${providerKey.toUpperCase()}_TIMEOUT_MS`]) ||
      7500;

    // Call legacy (array) — force observable fail via throwOnError
    const raw = await withTimeout(
      () => searchDoktorTakvimi(query, options?.region || "TR", signal, { throwOnError: true }),
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
      timeoutMs: Number(options?.timeoutMs) || 7500,
      okFrom: "exception",
    }));
  }
}

// server/adapters/dgymAdapter.js
// ============================================================
// D-GYM Spor Salonları — S33 TITAN+ Adapter (FINAL)
// ------------------------------------------------------------
// ✔ stableId v3.5 (title + url hash)
// ✔ ImageVariants (proxy-ready)
// ✔ Fitness-weighted qualityScore
// ✔ providerFamily / providerSignature / adapterVersion
// ✔ categoryAI = "gym", vertical = "fitness"
// ✔ multi-selector + anti-ban + signal-safe
// ✔ Rate Limiter uyumlu (ana motor ile entegre)
// ============================================================

import axios from "axios";
import * as cheerio from "cheerio";
import crypto from "crypto";
import { buildImageVariants } from "../utils/imageFixer.js";
import { rateLimiter } from "../utils/rateLimiter.js";

import { loadCheerioS200 } from "../core/s200AdapterKit.js";

const safe = (v) => (v ? String(v).trim() : "");

// Rate Limiter kontrolü
async function checkRateLimit() {
  const key = "adapter_dgym_TR";
  const allowed = await rateLimiter.check(key, {
    limit: 12,
    windowMs: 60000,
    burst: true,
    adaptive: true,
  });
  
  if (!allowed) {
    console.warn(`⛔ RATE LIMIT → dgym`);
    throw new Error("Rate limit exceeded for dgym adapter");
  }
  
  return true;
}

// URL sabitleyici
function normalizeUrl(h) {
  if (!h) return null;
  if (h.startsWith("http")) return h.split("?")[0];
  return ("https://www.dgym.com.tr" + h).split("?")[0];
}

// stableId v3.5 → title + urlHash
function stableId(title, url) {
  const slug = safe(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 50);

  const hash = crypto
    .createHash("md5")
    .update(url || "")
    .digest("hex")
    .slice(0, 8);

  return `dgym_${slug}_${hash}`;
}

// Fitness-weighted kalite puanı
function computeFitnessScore(item) {
  let score = 0;

  if (item.title) score += 0.35;
  if (item.address) score += 0.20;
  if (item.image) score += 0.20;
  score += 0.10; // provider reliability
  score += 0.05; // entropy

  return Number(score.toFixed(2));
}

// Normalizer → S33 TITAN unified output
function normalizeGym(raw, region = "TR") {
  const img = buildImageVariants(raw.image || null, "dgym");

  const out = {
    id: stableId(raw.title, raw.url),
    title: raw.title,
    originUrl: raw.url,
finalUrl: raw.url,
deeplink: raw.url,
url: raw.url, // backward compatibility


    provider: "dgym",
    providerFamily: "fitness",
    providerType: "gym",
    providerSignature: "dgym_s33",
    adapterVersion: "S33.TITAN+",
    reliabilityScore: 0.92,

       price: null,

    // S200/TITAN Price Pipeline uyumluluğu
    finalPrice: null,
    optimizedPrice: null,

    rating: raw.rating ?? null,


    currency: "TRY",
    region: (region || "TR").toUpperCase(),
    category: "fitness",
    categoryAI: "gym",
    vertical: "fitness",

    address: raw.address || null,

    image: img.image,
    imageOriginal: img.imageOriginal,
    imageProxy: img.imageProxy,
    hasProxy: img.hasProxy,

    qualityScore: 0,
    raw: raw.raw || raw,
  };

  out.qualityScore = computeFitnessScore(out);
  return out;
}

// ============================================================
// MAIN SCRAPER — S33 TITAN+ (Rate Limiter uyumlu)
// ============================================================
export async function searchDGym(query = "", regionOrOptions = "TR", opts = {}) {
  let region = "TR";
  let signal;

  if (typeof regionOrOptions === "string") {
    region = regionOrOptions;
  } else if (regionOrOptions) {
    region = regionOrOptions.region || "TR";
    signal = regionOrOptions.signal || null;
  }

  try {
    // Rate limiter kontrolü
    await checkRateLimit();
    
    const url = "https://www.dgym.com.tr/spor-salonu";

    const { data: html } = await axios.get(url, {
      timeout: 15000,
      signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36",
        Accept: "text/html",
        "Accept-Language": "tr-TR,tr;q=0.9",
        Referer: "https://www.google.com/",
      },
    });

    const $ = loadCheerioS200(html);
    const items = [];

    const selectors = [
      ".gym-location",
      ".gym-item",
      ".location-card",
      ".gym-card",
      ".branch-card",
      ".location-item",
      ".col-md-4",
      "article",
    ];

    $(selectors.join(",")).each((i, el) => {
      const wrap = $(el);

      const title =
        safe(wrap.find(".name").text()) ||
        safe(wrap.find(".gym-name").text()) ||
        safe(wrap.find(".branch-name").text()) ||
        safe(wrap.find("h3").text());

      if (!title) return;

      const address =
        safe(wrap.find(".address").text()) ||
        safe(wrap.find(".location").text()) ||
        safe(wrap.find(".branch-location").text()) ||
        null;

      const href =
        safe(wrap.find("a").attr("href")) ||
        safe(wrap.attr("data-url")) ||
        null;

      const finalUrl = normalizeUrl(href);

      const image =
        safe(wrap.find("img").attr("data-src")) ||
        safe(wrap.find("img").attr("src")) ||
        null;

      const raw = {
        title,
        address,
        url: finalUrl,
        image,
        rating: null,
      };

      items.push(normalizeGym(raw, region));
    });

    // Başarılı isteği kaydet
    rateLimiter.registerSuccess("adapter_dgym_TR", 1);
    
    return items;
  } catch (err) {
    if (opts && opts.throwOnError) throw err;

    // Hata durumunda rate limiter'a bildir
    if (err.message !== "Rate limit exceeded for dgym adapter") {
      rateLimiter.registerError("adapter_dgym_TR", 1);
    }
    
    console.warn("⚠️ DGYM adapter hata:", err.message);
    return [];
  }
}

export const searchDGymScrape = searchDGym;
export const searchDGymAdapterLegacy = searchDGym;

export default { searchDGym };

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
export async function searchDGymAdapter(query, options = {}, signal = null) {
  const providerKey = "dgym";
  const started = __s200_now();
  try {
    globalThis.__S200_ADAPTER_CTX = {
      providerKey,
      adapter: "dgymAdapter",
      query: String(query || ""),
      _meta: { startedAt: started },
    };

    const timeoutMs =
      Number(options?.timeoutMs) ||
      Number(process.env[`${providerKey.toUpperCase()}_TIMEOUT_MS`]) ||
      6500;

    // Call legacy (array) — force observable fail via throwOnError
    const raw = await withTimeout(
      () => searchDGym(query, options?.region || "TR", signal, { throwOnError: true }),
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

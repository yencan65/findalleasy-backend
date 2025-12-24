// server/adapters/googleShopping.js
// =======================================================================
//  GOOGLE SHOPPING — S33 TITAN FINAL → S200 HARDENED (PATCHED)
// -----------------------------------------------------------------------
//  ZERO DELETE — tüm fonksiyon imzaları korunur
//  FIX:
//   - SERP key drift: SERP_API_KEY + SERPAPI_KEY + SERPAPI_API_KEY fallback
//   - region/options drift: region object gelirse normalize et (no [object Object])
//   - stableId: gerçek hash (crypto sha1) + fallback (fnv+base64)
//   - url safety: javascript:/data: blok
//   - buildImageVariants crash-proof
//   - fetch timeout always cleared
// =======================================================================

import "dotenv/config";
import fetch from "node-fetch";
import crypto from "crypto";
import { sanitizePrice } from "../utils/priceSanitizer.js";
import { optimizePrice } from "../utils/priceFixer.js";
import { buildImageVariants } from "../utils/imageFixer.js";
import { rateLimiter } from "../utils/rateLimiter.js";
import { normalizeItemS200, coerceItemsS200, stableIdS200, withTimeout, TimeoutError } from "../core/s200AdapterKit.js";

// =======================================================================
// S200 FAIL-ARRAY HELPERS (keeps array signature, makes failure observable)
// =======================================================================
const FINDALLEASY_ALLOW_STUBS = String(process.env.FINDALLEASY_ALLOW_STUBS || "") === "1";

function _s200FailArray(source, query, opt = {}, code = "ADAPTER_FAIL", err = "") {
  const arr = [];
  try {
    Object.defineProperty(arr, "ok", { value: false, enumerable: false });
    Object.defineProperty(arr, "_meta", {
      value: {
        source,
        query: typeof query === "string" ? query : "",
        code,
        error: String(err || ""),
        stubAllowed: FINDALLEASY_ALLOW_STUBS,
        opt,
      },
      enumerable: false,
    });
  } catch {}
  return arr;
}

function _s200MarkOkArray(arr, source, meta = {}) {
  if (!Array.isArray(arr)) return arr;
  try {
    Object.defineProperty(arr, "ok", { value: true, enumerable: false });
    Object.defineProperty(arr, "_meta", { value: { source, ...meta }, enumerable: false });
  } catch {}
  return arr;
}


// ENV drift-safe
const SERP_API_KEY =
  process.env.SERP_API_KEY ||
  process.env.SERPAPI_KEY ||
  process.env.SERPAPI_API_KEY ||
  "";

// =======================================================================
// SERPAPI GLOBAL CACHE/GATE (prevents double-calls + reduces 429)
// =======================================================================
function _getSerpCache() {
  const k = "__FINDALLEASY_SERPAPI_CACHE";
  if (!globalThis[k]) globalThis[k] = new Map();
  return globalThis[k];
}

function _serpCacheGet(key, maxAgeMs = 25_000) {
  try {
    const cache = _getSerpCache();
    const hit = cache.get(key);
    if (!hit) return null;
    const age = Date.now() - (hit.ts || 0);
    if (age > maxAgeMs) return null;
    return hit.json || null;
  } catch {
    return null;
  }
}

function _serpCacheSet(key, json) {
  try {
    const cache = _getSerpCache();
    cache.set(key, { ts: Date.now(), json });
  } catch {}
}

// =======================================================================
// SAFE HELPERS
// =======================================================================
function safeStr(v, fb = "") {
  if (v == null) return fb;
  const s = String(v).trim();
  return s ? s : fb;
}

function safeNum(v, fb = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
}

// region normalize (drift-safe)
function normalizeRegionInput(regionLike, fb = "TR") {
  try {
    if (regionLike && typeof regionLike === "object" && !Array.isArray(regionLike)) {
      regionLike =
        regionLike.region ||
        regionLike.country ||
        regionLike.countryCode ||
        regionLike.code ||
        regionLike.locale ||
        regionLike.lang ||
        "";
    }
    const s = safeStr(regionLike, "");
    if (!s) return fb;
    return s.toUpperCase();
  } catch {
    return fb;
  }
}

// timeout fetch json (zero-crash)

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function getGlobalGate(name) {
  const key = `__FINDALLEASY_GATE_${name}`;
  if (!globalThis[key]) globalThis[key] = { p: Promise.resolve(), lastStart: 0 };
  return globalThis[key];
}

async function withGlobalGate(name, minIntervalMs, fn) {
  const gate = getGlobalGate(name);
  const job = gate.p.then(async () => {
    const now = Date.now();
    const wait = gate.lastStart + minIntervalMs - now;
    if (wait > 0) await sleep(wait);
    gate.lastStart = Date.now();
    return fn();
  });
  // Prevent unhandled rejections from poisoning the queue
  gate.p = job.catch(() => {});
  return job;
}

async function fetchJsonWithTimeout(url, timeoutMs = 4500, opts = {}) {
  const retries = Number.isFinite(opts?.retries) ? Math.max(0, opts.retries) : 1;
  const start = Date.now();

  const cacheKey = typeof opts?.cacheKey === "string" ? opts.cacheKey : "";
  const cacheMaxAgeMs = Number.isFinite(Number(opts?.cacheMaxAgeMs)) ? Number(opts.cacheMaxAgeMs) : 25_000;
  if (cacheKey) {
    const hit = _serpCacheGet(cacheKey, cacheMaxAgeMs);
    if (hit) return hit;
  }

  const doFetchOnce = async (timeLeftMs) => {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), Math.max(250, timeLeftMs));
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { accept: "application/json" },
      });

      if (!res.ok) {
        let body = "";
        try {
          body = await res.text();
        } catch {}
        const err = new Error(`HTTP ${res.status}`);
        err.status = res.status;
        err.body = body ? String(body).slice(0, 300) : "";
        throw err;
      }

      return await res.json();
    } finally {
      clearTimeout(t);
    }
  };

  let attempt = 0;
  let backoffMs = 550;

  while (true) {
    attempt += 1;
    const elapsed = Date.now() - start;
    const timeLeft = timeoutMs - elapsed;
    if (timeLeft <= 250) throw new Error(`timeout ${timeoutMs}ms`);

    try {
      const runner = () => doFetchOnce(timeLeft);

      // SerpAPI is rate-limited per second; gate it globally to avoid burst-429.
      
let json = null;

// SerpAPI is rate-limited per second; gate it globally to avoid burst-429.
if (String(url).includes("serpapi.com")) {
  json = await withGlobalGate("serpapi", Math.max(250, Number(opts?.gateMinIntervalMs || 1200)), runner);
} else {
  json = await runner();
}

if (cacheKey && json) _serpCacheSet(cacheKey, json);
return json;
    } catch (e) {
      const status = Number(e?.status || 0);
      const msg = String(e?.message || "");

      const retryable =
        status === 429 ||
        (status >= 500 && status <= 599) ||
        msg.includes("ECONNRESET") ||
        msg.includes("ETIMEDOUT") ||
        msg.includes("timeout") ||
        msg.includes("aborted");

      const hasRetryLeft = attempt <= (retries + 1);

      if (!retryable || !hasRetryLeft) throw e;

      const elapsed2 = Date.now() - start;
      const remaining = timeoutMs - elapsed2 - 250;
      if (remaining <= 0) throw e;

      const wait = Math.min(backoffMs, remaining);
      await sleep(wait);

      backoffMs = Math.min(Math.floor(backoffMs * 1.8), 1600);
      continue;
    }
  }
}

// TITAN ID (hardened: sha1 + url-safe; fallback fnv+base64)
function stableId(provider, title, link) {
  return stableIdS200(provider || "unknown", link || "", title || "");
}

// sync hash helper (ZERO DELETE: adı korunur, güçlendi)
function awaitHash(seed) {
  // 1) crypto sha1 (kısa + deterministik)
  try {
    const hex = crypto.createHash("sha1").update(seed).digest("hex");
    // 18 hex yeterince kısa + çakışma riski düşük
    return hex.slice(0, 18);
  } catch {
    // 2) FNV-1a + base64 salt fallback (deterministik)
    let h1 = 0x811c9dc5; // FNV-1a
    for (let i = 0; i < seed.length; i++) {
      h1 ^= seed.charCodeAt(i);
      h1 = (h1 * 0x01000193) >>> 0;
    }
    return (
      h1.toString(16).padStart(8, "0") +
      Buffer.from(seed)
        .toString("base64")
        .replace(/[^A-Za-z0-9]/g, "")
        .slice(0, 10)
    );
  }
}

function isBadUrl(u) {
  const s = safeStr(u, "").toLowerCase();
  return (
    !s ||
    s.startsWith("javascript:") ||
    s.startsWith("data:") ||
    s.startsWith("file:") ||
    s.startsWith("blob:")
  );
}

function sanitizeUrl(u) {
  if (!u) return "";
  try {
    const s = String(u).trim();
    if (!s) return "";
    if (isBadUrl(s)) return "";

    if (s.startsWith("http://") || s.startsWith("https://")) return s;
    // bazı linkler "//" ile geliyor olabilir
    if (s.startsWith("//")) return "https:" + s;

    // çıplak domain gibi gelirse https ekle
    return `https://${s}`;
  } catch {
    return "";
  }
}

// price parse (₺ 1.299,90 / 1,299.90 / 1299,90 / 1299.90)
function parsePriceLoose(v) {
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;

  const s = safeStr(v, "");
  if (!s) return null;

  const cleaned = s.replace(/\s+/g, " ").replace(/[^\d.,]/g, "").trim();
  if (!cleaned) return null;

  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");

  let normalized = cleaned;

  if (lastComma > -1 && lastDot > -1) {
    if (lastComma > lastDot) normalized = cleaned.replace(/\./g, "").replace(",", ".");
    else normalized = cleaned.replace(/,/g, "");
  } else if (lastComma > -1) {
    normalized = cleaned.replace(/\./g, "").replace(",", ".");
  } else {
    const parts = cleaned.split(".");
    if (parts.length > 2) {
      const dec = parts.pop();
      normalized = parts.join("") + "." + dec;
    }
  }

  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function inferCurrency(priceText, region = "TR") {
  const t = safeStr(priceText, "").toLowerCase();
  if (t.includes("₺") || t.includes("try") || t.includes("tl")) return "TRY";
  if (t.includes("€") || t.includes("eur")) return "EUR";
  if (t.includes("$") || t.includes("usd")) return "USD";
  if (t.includes("£") || t.includes("gbp")) return "GBP";
  if (String(region).toUpperCase() === "TR") return "TRY";
  return "USD";
}

// S33 QualityScore (S200’de de kullanıyoruz)
function computeQualityScore(base) {
  let s = 0;
  if (base.title) s += 0.45;
  if (base.price != null) s += 0.30;
  if (base.url) s += 0.12;
  if (base.image) s += 0.10;
  if (base.rating != null) s += 0.02;
  if (base.reviewCount != null) s += 0.01;
  return Number(s.toFixed(2));
}

function safeSanitizePrice(anyPrice, meta = {}) {
  try {
    const n = parsePriceLoose(anyPrice);
    if (n == null) return null;
    return sanitizePrice(n, meta);
  } catch {
    return null;
  }
}

function safeOptimizePrice(item, meta = {}) {
  try {
    const out = optimizePrice(item, meta);
    if (out && typeof out === "object") return out;
    return item;
  } catch {
    return item;
  }
}

function safeBuildImageVariants(imgRaw, tag) {
  try {
    return buildImageVariants(imgRaw, tag);
  } catch {
    return {
      image: imgRaw || null,
      imageOriginal: imgRaw || null,
      imageProxy: null,
      hasProxy: false,
    };
  }
}

// =======================================================================
// NORMALIZE — S200 HARDENED
// =======================================================================
function normalizeGoogleShoppingItem(raw = {}, query = "", region = "TR", idx = 0) {
  const reg = normalizeRegionInput(region, "TR");

  const title =
    safeStr(raw.title) ||
    safeStr(raw.product_title) ||
    safeStr(raw.name) ||
    safeStr(query, "Unknown Product");

  const priceText =
    safeStr(raw.price) ||
    safeStr(raw.unit_price) ||
    safeStr(raw.price_string) ||
    (raw.extracted_price != null ? String(raw.extracted_price) : "") ||
    null;

  const extracted =
    raw.extracted_price ??
    raw.price ??
    raw.unit_price ??
    raw.price_string ??
    null;

  const price = safeSanitizePrice(extracted, {
    provider: "google_shopping",
    category: "product",
    region: reg,
  });

  const currency = safeStr(raw.currency) || inferCurrency(priceText, reg);

  // Görsel → Titan variant
  const imgRaw =
    safeStr(raw.thumbnail) ||
    safeStr(raw.image) ||
    safeStr(raw.thumbnail_url) ||
    "";

  const imageData = safeBuildImageVariants(imgRaw, "google-shopping");

  const url = sanitizeUrl(raw.link || raw.product_link || raw.url || "");
  if (!url) return null;

  // Optimizasyon (crash-proof)
  let optimizedPrice = null;
  let finalPrice = price;

  if (price != null) {
    const tmp = safeOptimizePrice(
      {
        price,
        finalPrice: price,
        provider: "google_shopping",
        region: reg,
        category: "product",
        currency,
      },
      { provider: "google_shopping", region: reg, category: "product", currency }
    );

    finalPrice = tmp.finalPrice ?? tmp.price ?? price;
    optimizedPrice = tmp.optimizedPrice ?? tmp.finalPrice ?? finalPrice;
  }

  const base = {
    id: stableId("google_shopping", title, url),
    title,

    provider: "google_shopping",
    source: "google_shopping",

    providerType: "aggregator",
    providerFamily: "google",
    vertical: "product",

    category: "product",
    categoryAI: "product",

    price,
    priceText: priceText || null,
    finalPrice,
    optimizedPrice,

    rating: safeNum(raw.rating, null),
    reviewCount: safeNum(raw.reviews ?? raw.review_count, null),

    currency,
    region: reg,

    url,
    deeplink: url,
    affiliateUrl: null,

    image: imageData.image,
    imageOriginal: imageData.imageOriginal,
    imageProxy: imageData.imageProxy,
    hasProxy: imageData.hasProxy,

    availability: finalPrice != null ? "in_stock" : "unknown",
    stockStatus: finalPrice != null ? "available" : "unknown",

    raw: {
      ...raw,
      _meta: {
        idx,
        query,
        region: reg,
        extractedAt: new Date().toISOString(),
      },
    },
  };

  return {
    ...base,
    qualityScore: computeQualityScore(base),
  };
}

// =======================================================================
// MAIN SEARCH — S200 FINAL
// =======================================================================
export async function searchGoogleShopping(query, region = "TR") {
  // --- ARG NORMALIZATION (DRIFT-SAFE) ---
  // allow: searchGoogleShopping({ query, region })
  // allow: searchGoogleShopping("x", { region:"TR" })
  let qLike = query;
  let rLike = region;

  if (qLike && typeof qLike === "object" && !Array.isArray(qLike)) {
    const o = qLike;
    qLike = o.query ?? o.q ?? o.term ?? o.text ?? "";
    rLike = o.region ?? o.country ?? o.countryCode ?? o.code ?? rLike;
  }
  if (rLike && typeof rLike === "object" && !Array.isArray(rLike)) {
    const o = rLike;
    rLike = o.region ?? o.country ?? o.countryCode ?? o.code ?? "TR";
  }

  const q = safeStr(qLike, "");
  if (!q) return [];

  // Key guard
  if (!SERP_API_KEY) {
    console.log("⚠️ GoogleShopping: SERP key yok → devre dışı.");
    return _s200FailArray("google_shopping", q, { kind: "serpapi" }, "MISSING_SERPAPI_KEY", "SERPAPI_KEY missing");
  }

  const reg = normalizeRegionInput(rLike, "TR");

  // Rate limit (SerpApi kota koruması)
  try {
    const key = `s200:adapter:google_shopping:${reg}`;
    const allowed = await rateLimiter.check(key, {
      limit: 25,
      windowMs: 60_000,
      burst: true,
      adaptive: true,
    });
    if (!allowed) return [];
  } catch {
    // rateLimiter yoksa bile devam (crash yok)
  }

  try {
    const gl = reg.toLowerCase();
    const hl = reg === "TR" ? "tr" : "en";

    const url = `https://serpapi.com/search.json?engine=google_shopping&q=${encodeURIComponent(
      q
    )}&gl=${gl}&hl=${hl}&api_key=${SERP_API_KEY}`;

    const cacheKey = `serpapi:google_shopping:${gl}:${hl}:${q.toLowerCase()}`;

    const json = await fetchJsonWithTimeout(url, 16000, { retries: 2, gateMinIntervalMs: 1200, cacheKey, cacheMaxAgeMs: 30_000 });

    const arr = Array.isArray(json?.shopping_results) ? json.shopping_results : [];

    // Normalize + dedupe
    const out = [];
    const seen = new Set();

    for (let i = 0; i < Math.min(arr.length, 30); i++) {
      const it = normalizeGoogleShoppingItem(arr[i], q, reg, i);
      if (!it) continue;

      const k = `${it.url}::${it.title}`.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);

      if (!it.title || !it.url) continue;

      out.push(it);
      if (out.length >= 24) break;
    }

    console.log(`🛍️ GoogleShopping S200 → ${out.length} ürün`);
    return out;
  } catch (e) {
    const msg = safeStr(e?.message, "unknown");
    const st = Number(e?.status || 0);
    const body = e?.body ? String(e.body) : "";
    console.warn("GoogleShopping adapter hata:", msg, st ? `(HTTP ${st})` : "", body ? `body=${body}` : "");
    return [];
  }
}

// =======================================================================
// DEFAULT EXPORT
// =======================================================================
export default {
  searchGoogleShopping,
};

// =======================================================================
// S200 WRAPPED EXPORT — standard output { ok, items, count, source, _meta }
// =======================================================================
function _s200StripIds(x) {
  if (!x || typeof x !== "object") return x;
  const y = { ...x };
  delete y.id;
  delete y.listingId;
  return y;
}

function _s200NormalizeItems(arr, providerKey) {
  const out = [];
  const items = coerceItemsS200(arr);
  for (const it of items) {
    const clean = _s200StripIds(it);
    if (!clean) continue;
    if (true) {
      clean.price = null;
      clean.finalPrice = null;
      clean.optimizedPrice = null;
    }
    const norm = normalizeItemS200(clean, providerKey, { vertical: "discovery", providerFamily: "discovery" });
    if (norm) out.push(norm);
  }
  return out;
}

export async function searchGoogleShoppingS200(query, options = {}) {
  const startedAt = Date.now();
  const providerKey = "google_shopping";
  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = { providerKey, adapter: "google_shopping", query: typeof query === "string" ? query : "" };
  try {
    const raw = await withTimeout((searchGoogleShopping(query, options)), 6500, providerKey);
    const items = _s200NormalizeItems(raw, providerKey);
    return {
      ok: true,
      items,
      count: items.length,
      source: providerKey,
      _meta: { tookMs: Date.now() - startedAt, stub: false },
    };
  } catch (e) {
    const msg = (e && e.message) ? String(e.message) : String(e || "unknown");
    const isTimeout = (e && e.name === "TimeoutError") || /timed out|timeout/i.test(msg);
    if (FINDALLEASY_ALLOW_STUBS) {
      return {
        ok: true,
        items: [],
        count: 0,
        source: providerKey,
        _meta: { tookMs: Date.now() - startedAt, stub: true, error: msg, timeout: isTimeout },
      };
    }
    return {
      ok: false,
      items: [],
      count: 0,
      source: providerKey,
      _meta: { tookMs: Date.now() - startedAt, error: msg, timeout: isTimeout },
    };
  } finally {
    globalThis.__S200_ADAPTER_CTX = prevCtx;
  }
}

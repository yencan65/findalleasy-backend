// server/adapters/serpApi.js
// ============================================================================
// SerpAPI Adapter — S200 HARDENED (DISCOVERY-SAFE, ZERO-CRASH, NO-FAKE)
// Output: { ok, items, count, source, _meta }   (+ iterable/length compat)
// Contract lock: title+url required; price<=0 => null
// DISCOVERY SOURCE RULE: serpapi price forced null + affiliate injection OFF
// Observable fail: config/fetch/timeout/parse => ok:false + items:[]
// NO RANDOM ID: stableIdS200(providerKey,url,title)
// URL priority handled by normalizeItemS200
// withTimeout everywhere + global ctx set (kit logları "unknown" demesin)
// ZERO DELETE: named + default export korunur (searchWithSerpApi)
// ============================================================================
import "dotenv/config";

import axios from "axios";
import crypto from "crypto"; // ZERO DELETE (legacy)
import { rateLimiter } from "../utils/rateLimiter.js";

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
  gate.p = job.catch(() => {});
  return job;
}

// ----------------------------------------------------------------------------
// Shared global cache (cross-adapter) to prevent duplicate SerpAPI calls
// ----------------------------------------------------------------------------
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
    return hit.data || null;
  } catch {
    return null;
  }
}

function _serpCacheSet(key, data) {
  try {
    const cache = _getSerpCache();
    cache.set(key, { ts: Date.now(), data });
  } catch {}
}

function clampNum(n, lo, hi) {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  return Math.max(lo, Math.min(hi, Math.floor(x)));
}

import {
  normalizeItemS200,
  coerceItemsS200,
  stableIdS200,
  withTimeout,
  TimeoutError,
  safeStr,
} from "../core/s200AdapterKit.js";

const PROVIDER_KEY = "serpapi";
const ADAPTER_KEY = "serpapi_discovery";
const PROVIDER_FAMILY = "serpapi";
const DEFAULT_TIMEOUT_MS = 12000;

const SERPAPI_KEY =
  process.env.SERPAPI_KEY ||
  process.env.SERPAPI_API_KEY ||
  process.env.SERP_API_KEY ||
  process.env.SERP_API_KEY ||
  "";

function safe(v, max = 400) {
  return safeStr(v, max);
}

function normalizeRegionArg(regionLike) {
  try {
    if (typeof regionLike === "string" && regionLike.trim())
      return regionLike.trim().toUpperCase();
    if (regionLike && typeof regionLike === "object") {
      const pick =
        safe(regionLike.region) ||
        safe(regionLike.gl) ||
        safe(regionLike.country) ||
        safe(regionLike.cc) ||
        safe(regionLike.locale);
      if (pick) return pick.trim().toUpperCase();
    }
  } catch {}
  return "TR";
}

function normalizeHl(regionUpper, opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const hl = safe(o.hl) || safe(o.language);
  if (hl) return hl.toLowerCase();
  return regionUpper === "TR" ? "tr" : "en";
}

function normalizeGl(regionUpper, opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const gl = safe(o.gl) || safe(o.country) || "";
  if (gl) return gl.toLowerCase();
  return regionUpper.toLowerCase() === "tr" ? "tr" : regionUpper.toLowerCase();
}

function sanitizeUrl(u) {
  const s = safe(u, 2000);
  if (!s) return "";
  if (s.startsWith("http://") || s.startsWith("https://")) return s;
  if (s.startsWith("//")) return "https:" + s;
  return "";
}

function tokenize(q) {
  const s = safe(q, 600).toLowerCase();
  const raw = s.split(/[^a-z0-9ğüşöçıİĞÜŞÖÇ]+/gi).filter(Boolean);

  const stop = new Set([
    "en",
    "ucuz",
    "fiyat",
    "fiyatı",
    "kampanya",
    "indirim",
    "satın",
    "al",
    "alınır",
    "tr",
    "tl",
    "try",
    "ve",
    "ile",
    "için",
    "orjinal",
    "orijinal",
    "sıfır",
    "ikinci",
    "el",
  ]);

  const tokens = raw
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
    .filter((t) => !stop.has(t));

  return Array.from(new Set(tokens));
}

// ======================================================================
// BARCODE QUERY DETECTOR (kritik fix)
//  - Barcode aramalarında title içinde barkod geçmeyebilir.
//  - Eski relevance filtresi her şeyi çöpe atıyordu => kredi yanıp items:[].
// ======================================================================
function isBarcodeQuery(q) {
  const s = safe(q, 300).toLowerCase();
  if (!s) return false;

  const hasCode = /\b\d{8,18}\b/.test(s);
  if (!hasCode) return false;

  // anahtar kelime varsa direkt barcode
  if (/\b(ean|gtin|upc|barcode|barkod|ean13|ean-13|ean_13)\b/.test(s)) return true;

  // hepsi neredeyse rakamsa barcode kabul et
  const digits = (s.match(/\d/g) || []).length;
  const alpha = (s.match(/[a-zğüşöçı]/gi) || []).length;
  return digits >= 8 && alpha <= 3;
}

function relevanceScore(query, title) {
  // ✅ BARCODE MODE: relevance filtresi yüzünden item kaybetme
  if (isBarcodeQuery(query)) return 1;

  const qt = tokenize(query);
  const tt = tokenize(title);
  if (!qt.length || !tt.length) return 0;

  const setT = new Set(tt);
  let hit = 0;
  for (const tok of qt) if (setT.has(tok)) hit++;

  const ratio = hit / qt.length;

  const nums = qt.filter((x) => /^\d+$/.test(x));
  if (nums.length) {
    const numHit = nums.filter((n) => setT.has(n)).length;
    if (numHit === 0) return 0;
  }

  return ratio;
}

function isProbablyProduct(query, opts = {}) {
  const intentType = safe(opts?.intent?.type || opts?.intent?.category);
  if (intentType === "product") return true;

  const cat = safe(opts?.category || opts?.group || opts?.vertical || "");
  if (cat && /^(product|tech|electronics|device|gadget|appliance|market|fashion|food|grocery|supermarket)$/i.test(cat))
    return true;

  const q = safe(query, 300).toLowerCase();
  if (/\biphone\b|\bsamsung\b|\bgalaxy\b|\bps5\b|\bplaystation\b|\bdyson\b|\bmacbook\b/.test(q)) return true;

  const t = tokenize(q);
  const hasNum = t.some((x) => /^\d+$/.test(x));
  const hasWord = t.some((x) => /[a-zğüşöçı]/i.test(x));
  return hasNum && hasWord;
}

function _mkRes(ok, items, meta = {}) {
  const arr = Array.isArray(items) ? items : [];
  const res = { ok: !!ok, items: arr, count: arr.length, source: PROVIDER_KEY, _meta: { ...meta } };
  // Back-compat: allow legacy code to treat response like an array
  try {
    Object.defineProperty(res, "length", { value: arr.length, enumerable: false });
    Object.defineProperty(res, Symbol.iterator, {
      enumerable: false,
      value: function* () {
        yield* arr;
      },
    });
  } catch {}
  return res;
}

function _errStr(e) {
  return safeStr(e?.message || e || "error", 450);
}
function _isTimeout(e) {
  return e instanceof TimeoutError || /timed?\s*out/i.test(String(e?.message || e || ""));
}

// ======================================================================
// MAIN — S200
// ======================================================================
export async function searchWithSerpApi(query, opts = {}) {
  const t0 = Date.now();
  const q = safe(query, 260);
  const regionUpper = normalizeRegionArg(opts?.region || "TR");
  const hl = normalizeHl(regionUpper, opts);
  const gl = normalizeGl(regionUpper, opts);

  const timeoutMs = Number.isFinite(Number(opts?.timeoutMs))
    ? Math.max(1200, Math.min(25000, Number(opts.timeoutMs)))
    : DEFAULT_TIMEOUT_MS;

  if (!q) return _mkRes(false, [], { code: "EMPTY_QUERY", error: "EMPTY_QUERY", ms: 0, region: regionUpper });

  if (!SERPAPI_KEY) {
    return _mkRes(false, [], {
      code: "NOT_CONFIGURED",
      notImplemented: true,
      error: "SERPAPI_KEY missing",
      ms: Date.now() - t0,
      region: regionUpper,
    });
  }

  // ✅ BARCODE MODE (kritik): filtreleri kapatır
  const barcodeMode = opts?.barcode === true || isBarcodeQuery(q);

  const productMode =
    opts?.mode === "shopping" ||
    opts?.forceShopping === true ||
    isProbablyProduct(q, opts);

  const engine = productMode ? "google_shopping" : "google";
  const url = "https://serpapi.com/search.json";

  // ctx for kit logs
  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = { adapter: ADAPTER_KEY, providerKey: PROVIDER_KEY, url, engine, region: regionUpper };

  // RateLimit (kota koruması) — crash yok
  try {
    const key = `s200:adapter:serpapi:${engine}:${regionUpper}`;
    const allowed = await rateLimiter.check(key, {
      limit: 30,
      windowMs: 60_000,
      burst: true,
      adaptive: true,
    });
    if (!allowed) {
      return _mkRes(false, [], {
        code: "RATE_LIMIT",
        error: "RATE_LIMIT",
        ms: Date.now() - t0,
        region: regionUpper,
        engine,
        barcodeMode,
      });
    }
  } catch {
    // ignore
  }

  try {
    const httpTimeout = Math.max(1000, Math.min(30000, timeoutMs - 150));

    // cacheKey barcodeMode ile de ayrışsın
    const cacheKey = `serpapi:${engine}:${gl}:${hl}:${barcodeMode ? "B" : "N"}:${q.toLowerCase()}`;
    const cached = _serpCacheGet(cacheKey, 30_000);

    const fetchOnce = async () => {
      const req = async () => {
        const res = await axios.get(url, {
          timeout: httpTimeout,
          params: {
            engine,
            q,
            api_key: SERPAPI_KEY,
            hl,
            gl,
            num: clampNum(opts?.num, 1, 20) ?? (productMode ? 20 : 10),
          },
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
            Accept: "application/json",
          },
          validateStatus: () => true,
        });

        const status = Number(res?.status || 0);
        if (!status) throw new Error("SERPAPI_NO_STATUS");

        if (status >= 400) {
          const err = new Error(`HTTP ${status}`);
          err.status = status;
          err.data = res?.data;
          throw err;
        }

        return res?.data;
      };

      // SerpAPI bursts trigger 429; gate globally to avoid spike.
      return await withGlobalGate("serpapi", Math.max(250, Number(opts?.gateMinIntervalMs || 1200)), req);
    };

    let data = cached;
    if (!data) {
      try {
        data = await withTimeout(fetchOnce(), timeoutMs, `${ADAPTER_KEY}.fetch`);
      } catch (e) {
        const status = Number(e?.status || e?.response?.status || 0);

        // One retry on 429/5xx — best effort within remaining time.
        if (status === 429 || (status >= 500 && status <= 599)) {
          const elapsed = Date.now() - t0;
          const remaining = timeoutMs - elapsed - 300;
          if (remaining > 0) {
            await sleep(Math.min(700, remaining));
            data = await withTimeout(fetchOnce(), timeoutMs, `${ADAPTER_KEY}.fetch_retry`);
          } else {
            throw e;
          }
        } else {
          throw e;
        }
      }
    }

    if (data) _serpCacheSet(cacheKey, data);

    if (data?.error) throw new Error(`SERPAPI_ERROR: ${String(data.error)}`);
    const metaStatus = String(data?.search_metadata?.status || "");
    if (metaStatus && metaStatus.toLowerCase() !== "success") throw new Error(`SERPAPI_STATUS: ${metaStatus}`);

    // Build candidates
    let candidates = [];

    if (productMode) {
      const list =
        data?.shopping_results ||
        data?.inline_shopping_results ||
        data?.shopping_results_inline ||
        [];

      candidates = (Array.isArray(list) ? list : [])
        .map((r) => {
          const title = safe(r?.title || r?.name, 280);
          const link = sanitizeUrl(r?.link || r?.product_link || r?.product_url || r?.url);
          const thumb = safe(r?.thumbnail || r?.image || r?.thumbnail_url, 2000);
          if (!title || !link) return null;

          const rel = relevanceScore(q, title);

          return {
            id: stableIdS200(PROVIDER_KEY, link, title),
            title,
            provider: PROVIDER_KEY,
            providerKey: PROVIDER_KEY,
            providerType: "aggregator",
            providerFamily: PROVIDER_FAMILY,
            vertical: "discovery",
            category: "product",
            region: regionUpper,
            url: link,
            originUrl: link,
            image: thumb || null,

            // DISCOVERY SOURCE RULE: price forced null
            price: null,
            finalPrice: null,
            optimizedPrice: null,

            rating: null,
            trustScore: 0.7,
            qualityScore: 0.75,

            __relevance: rel,
            priceHint: safe(r?.price || r?.price_raw || "", 120) || null,
            raw: opts?.includeRaw ? r : undefined,
          };
        })
        .filter(Boolean);

      // ✅ BARCODE MODE: relevance filtrelerini kapat
      if (!barcodeMode) {
        const qTokens = tokenize(q);
        const minRel = qTokens.length >= 3 ? 0.5 : 0.34;
        candidates = candidates.filter((it) => (it.__relevance ?? 0) >= minRel);
        candidates.sort((a, b) => (b.__relevance ?? 0) - (a.__relevance ?? 0));
      }
    } else {
      const locals = Array.isArray(data?.local_results) ? data.local_results : [];
      const organic = Array.isArray(data?.organic_results) ? data.organic_results : [];
      const mix = [...locals, ...organic].slice(0, 20);

      candidates = mix
        .map((r) => {
          const title = safe(r?.title || r?.name, 280);
          const link = sanitizeUrl(r?.link || r?.website || r?.url);
          const thumb = safe(r?.thumbnail || r?.image, 2000);
          if (!title || !link) return null;

          const rel = relevanceScore(q, title);

          return {
            id: stableIdS200(PROVIDER_KEY, link, title),
            title,
            provider: PROVIDER_KEY,
            providerKey: PROVIDER_KEY,
            providerType: "search",
            providerFamily: PROVIDER_FAMILY,
            vertical: "discovery",
            category: "service",
            region: regionUpper,
            url: link,
            originUrl: link,
            image: thumb || null,

            // DISCOVERY SOURCE RULE: price forced null
            price: null,
            finalPrice: null,
            optimizedPrice: null,

            rating: typeof r?.rating === "number" ? r.rating : null,
            trustScore: 0.65,
            qualityScore: 0.7,

            __relevance: rel,
            raw: opts?.includeRaw ? r : undefined,
          };
        })
        .filter(Boolean);

      if (!barcodeMode) {
        candidates = candidates.filter((it) => (it.__relevance ?? 0) >= 0.25);
        candidates.sort((a, b) => (b.__relevance ?? 0) - (a.__relevance ?? 0));
      }
    }

    // Normalize via kit
    const normalized = [];
    for (const it of coerceItemsS200(candidates)) {
      const n = normalizeItemS200(it, PROVIDER_KEY, {
        providerFamily: PROVIDER_FAMILY,
        vertical: "discovery",
        category: it?.category || "discovery",
        region: regionUpper,
        currency: "TRY",
        discovery: true,
      });
      if (n) normalized.push(n);
    }

    // Dedupe
    const seen = new Set();
    const items = [];
    for (const it of normalized) {
      const id = String(it?.id || "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      items.push(it);
    }

    return _mkRes(true, items.slice(0, 40), {
      code: items.length ? "OK" : "OK_EMPTY",
      engine,
      productMode,
      barcodeMode,
      region: regionUpper,
      hl,
      gl,
      ms: Date.now() - t0,
      timeoutMs,
    });
  } catch (e) {
    return _mkRes(false, [], {
      code: _isTimeout(e) ? "TIMEOUT" : "ERROR",
      error: _errStr(e),
      engine,
      region: regionUpper,
      ms: Date.now() - t0,
      timeoutMs,
      barcodeMode: opts?.barcode === true || isBarcodeQuery(query),
    });
  } finally {
    globalThis.__S200_ADAPTER_CTX = prevCtx;
  }
}

export default searchWithSerpApi;

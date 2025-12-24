// server/adapters/floAdapter.js
// ============================================================================
// FLO — S200 HARDENED (SERPAPI FALLBACK, NO-CRASH, NO-FAKE)
// Why:
// - Direct scraping frequently breaks (404/403/cloudflare/WAF).
// - For stability, we use SerpApi Google Shopping and filter FLO links.
// Output: { ok, items, count, source, _meta } ✅
// ============================================================================

import crypto from "node:crypto";

import { sanitizePrice } from "../utils/priceSanitizer.js";
import { optimizePrice } from "../utils/priceFixer.js";
import { buildImageVariants } from "../utils/imageFixer.js";

import {
  withTimeout,
  TimeoutError,
  coerceItemsS200,
  normalizeItemS200,
  stableIdS200,
  normalizeUrlS200,
  safeStr,
} from "../core/s200AdapterKit.js";

const SOURCE = "flo";

function getSerpKey() {
  return (
    process.env.SERPAPI_KEY ||
    process.env.SERP_API_KEY ||
    process.env.SERPAPI_API_KEY ||
    process.env.SERPAPI ||
    ""
  );
}

const _cache = new Map(); // key -> { exp, items }
let _cooldownUntil = 0;

function now() {
  return Date.now();
}

function cacheGet(key) {
  const v = _cache.get(key);
  if (!v) return null;
  if (v.exp <= now()) {
    _cache.delete(key);
    return null;
  }
  return v.items;
}

function cacheSet(key, items, ttlMs) {
  _cache.set(key, { exp: now() + ttlMs, items });
}

async function fetchJson(url, timeoutMs = 6500) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), Math.max(250, timeoutMs));
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { "accept": "application/json" } });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { ok: res.ok, status: res.status, json, text };
  } finally {
    clearTimeout(t);
  }
}

function buildSerpUrl(q, opts = {}) {
  const key = getSerpKey();
  const hl = safeStr(opts.hl || opts.lang || "tr") || "tr";
  const gl = safeStr(opts.gl || opts.region || "tr") || "tr";
  const num = Math.max(1, Math.min(30, Number(opts.num || opts.limit || 18)));

  const u = new URL("https://serpapi.com/search.json");
  u.searchParams.set("engine", "google_shopping");
  // We'll ask for FLO explicitly and then filter by domain.
  u.searchParams.set("q", `flo ${safeStr(q)}`);
  u.searchParams.set("hl", hl);
  u.searchParams.set("gl", gl);
  u.searchParams.set("num", String(num));
  u.searchParams.set("api_key", key);
  return u.toString();
}

function isFloUrl(url = "") {
  const s = safeStr(url);
  if (!s) return false;
  return /(^|\.)flo\.com\.tr\b/i.test(s) || /(^|\.)flo\.com\b/i.test(s);
}

function normalizeShoppingResult(r, providerKey = SOURCE) {
  const title = safeStr(r?.title || r?.name || "");
  const url = normalizeUrlS200(r?.link || r?.product_link || r?.url || "");
  if (!title || !url || !isFloUrl(url)) return null;

  const rawPrice = r?.extracted_price ?? r?.price ?? r?.price_raw ?? r?.price_str;
  const price = sanitizePrice(rawPrice);
  const optimizedPrice = optimizePrice(price);
  const finalPrice = optimizedPrice ?? price ?? null;

  const img = safeStr(r?.thumbnail || r?.thumbnail_url || r?.image || "");
  const images = img ? buildImageVariants(img) : null;

  const idBase = `${providerKey}|${title}|${url}`;
  const id = stableIdS200 ? stableIdS200(providerKey, idBase) : crypto.createHash("sha1").update(idBase).digest("hex");

  return {
    id,
    title,
    url,
    originUrl: url,
    finalUrl: url,

    price: finalPrice ?? null,
    finalPrice: finalPrice ?? null,
    optimizedPrice: optimizedPrice ?? null,
    currency: "TRY",

    image: img || null,
    images: images || null,

    provider: providerKey,
    providerKey,

    raw: { providerKey, via: "serpapi_google_shopping", serp: r },
  };
}

export async function searchFlo(q, opts = {}) {
  const key = getSerpKey();
  if (!key) {
    const err = new Error("SERPAPI_KEY missing (FLO adapter uses SerpApi)");
    err.code = "MISSING_SERPAPI_KEY";
    throw err;
  }

  const query = safeStr(q);
  if (!query) return [];

  if (now() < _cooldownUntil) {
    const err = new Error("FLO cooldown (429 previously)");
    err.code = "COOLDOWN_429";
    throw err;
  }

  const cacheKey = `${SOURCE}|${query}|${safeStr(opts.hl || "tr")}|${safeStr(opts.gl || "tr")}|${Number(opts.limit || 18)}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const ttlMs = Math.max(10_000, Math.min(5 * 60_000, Number(opts.cacheTtlMs || 90_000)));
  const url = buildSerpUrl(query, opts);

  const { ok, status, json, text } = await fetchJson(url, Math.max(1500, Number(opts.httpTimeoutMs || 6500)));
  if (!ok) {
    const err = new Error(`FLO SerpApi HTTP: ${status}`);
    err.code = "HTTP_NON_2XX";
    err.status = status;

    if (status === 429) {
      _cooldownUntil = now() + Math.max(15_000, Math.min(5 * 60_000, Number(opts.cooldownMs || 60_000)));
    }
    err._meta = { status, snippet: String(text || "").slice(0, 500) };
    throw err;
  }

  const raw = Array.isArray(json?.shopping_results) ? json.shopping_results : [];
  const items = raw.map((r) => normalizeShoppingResult(r, SOURCE)).filter(Boolean);

  cacheSet(cacheKey, items, ttlMs);
  return items;
}

// Aliases (some groups import FLO in different casing)
export const searchFLO = async (q, opts = {}) => searchFlo(q, opts);
export const searchFloScrape = async (q, opts = {}) => searchFlo(q, opts);
export const searchFLOScrape = async (q, opts = {}) => searchFlo(q, opts);

export async function searchFloAdapter(q, opts = {}) {
  const started = now();
  const providerKey = SOURCE;
  try {
    const rawItems = await withTimeout(searchFlo(q, opts), Number(opts.timeoutMs || 6500));
    const items = coerceItemsS200(rawItems, providerKey).map((it) => normalizeItemS200(it, providerKey, { strict: true }));
    return { ok: true, items, count: items.length, source: providerKey, _meta: { ms: now() - started, via: "serpapi_google_shopping" } };
  } catch (e) {
    const isTimeout = e instanceof TimeoutError || e?.name === "TimeoutError";
    const meta = { ms: now() - started, timeout: !!isTimeout, code: e?.code, status: e?.status, error: { name: e?.name, message: e?.message } };
    if (e?._meta) meta.upstream = e._meta;
    return { ok: false, items: [], count: 0, source: providerKey, _meta: meta };
  }
}

export const searchFLOAdapter = async (q, opts = {}) => searchFloAdapter(q, opts);

export default {
  searchFloAdapter,
  searchFLOAdapter,
  searchFlo,
  searchFLO,
  searchFloScrape,
  searchFLOScrape,
};

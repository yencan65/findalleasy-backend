// server/adapters/getirYemekAdapter.js
// ============================================================================
// GETİR YEMEK — S200 HARDENED
// Scraping food delivery platforms reliably is a losing fight without partner APIs.
// STRICT: disabled (ok:false, empty, observable).
// DEV: optional SerpApi discovery (price null).
// ============================================================================

import crypto from "node:crypto";

import {
  withTimeout,
  TimeoutError,
  coerceItemsS200,
  normalizeItemS200,
  stableIdS200,
  normalizeUrlS200,
  safeStr,
} from "../core/s200AdapterKit.js";

const SOURCE = "getir_yemek";
const FINDALLEASY_ALLOW_STUBS = String(process.env.FINDALLEASY_ALLOW_STUBS || "0") === "1";

function getSerpKey() {
  return (
    process.env.SERPAPI_KEY ||
    process.env.SERP_API_KEY ||
    process.env.SERPAPI_API_KEY ||
    process.env.SERPAPI ||
    ""
  );
}

function now() {
  return Date.now();
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

function serpUrlGoogle(q, opts = {}) {
  const key = getSerpKey();
  const hl = safeStr(opts.hl || opts.lang || "tr") || "tr";
  const gl = safeStr(opts.gl || opts.region || "tr") || "tr";
  const num = Math.max(1, Math.min(20, Number(opts.num || opts.limit || 10)));

  const u = new URL("https://serpapi.com/search.json");
  u.searchParams.set("engine", "google");
  u.searchParams.set("q", `site:getir.com yemek ${safeStr(q)}`);
  u.searchParams.set("hl", hl);
  u.searchParams.set("gl", gl);
  u.searchParams.set("num", String(num));
  u.searchParams.set("api_key", key);
  return u.toString();
}

function normalizeOrganic(r, providerKey = SOURCE) {
  const title = safeStr(r?.title);
  const url = normalizeUrlS200(r?.link || r?.redirect_link || "");
  if (!title || !url) return null;

  const idBase = `${providerKey}|${title}|${url}`;
  const id = stableIdS200 ? stableIdS200(providerKey, idBase) : crypto.createHash("sha1").update(idBase).digest("hex");

  return {
    id,
    title,
    url,
    originUrl: url,
    finalUrl: url,

    price: null,
    finalPrice: null,
    optimizedPrice: null,
    currency: null,

    provider: providerKey,
    providerKey,

    raw: { providerKey, discovery: true, serp: r },
  };
}

export async function scrapeGetirYemek(q, opts = {}) {
  const err = new Error("Getir Yemek scrape disabled (needs official/partner API)");
  err.code = "DISABLED_SCRAPE";
  throw err;
}

export const scrapeGetirYemekFallback = async (q, opts = {}) => scrapeGetirYemek(q, opts);

async function discoveryGetirYemek(q, opts = {}) {
  const key = getSerpKey();
  if (!key) {
    const err = new Error("SERPAPI_KEY missing for discovery");
    err.code = "MISSING_SERPAPI_KEY";
    throw err;
  }
  const { ok, status, json, text } = await fetchJson(serpUrlGoogle(q, opts), Math.max(1500, Number(opts.httpTimeoutMs || 6500)));
  if (!ok) {
    const err = new Error(`GetirYemek discovery HTTP: ${status}`);
    err.code = "HTTP_NON_2XX";
    err.status = status;
    err._meta = { status, snippet: String(text || "").slice(0, 400) };
    throw err;
  }
  const organic = Array.isArray(json?.organic_results) ? json.organic_results : [];
  return organic.map((r) => normalizeOrganic(r, SOURCE)).filter(Boolean);
}

export async function searchGetirYemek(q, opts = {}) {
  if (!FINDALLEASY_ALLOW_STUBS) {
    const err = new Error("Getir Yemek disabled in STRICT mode (scrape blocked)");
    err.code = "STRICT_DISABLED";
    throw err;
  }
  return discoveryGetirYemek(q, opts);
}

export const searchGetirYemekScrape = async (q, opts = {}) => searchGetirYemek(q, opts);

export async function searchGetirYemekAdapter(q, opts = {}) {
  const started = now();
  const providerKey = SOURCE;

  try {
    const rawItems = await withTimeout(searchGetirYemek(q, opts), Number(opts.timeoutMs || 6500));
    const items = coerceItemsS200(rawItems, providerKey).map((it) => normalizeItemS200(it, providerKey, { strict: true }));
    return { ok: true, items, count: items.length, source: providerKey, _meta: { ms: now() - started, discovery: true } };
  } catch (e) {
    const isTimeout = e instanceof TimeoutError || e?.name === "TimeoutError";
    const meta = {
      ms: now() - started,
      timeout: !!isTimeout,
      code: e?.code,
      status: e?.status,
      disabled: true,
      error: { name: e?.name, message: e?.message },
    };
    if (e?._meta) meta.upstream = e._meta;
    return { ok: false, items: [], count: 0, source: providerKey, _meta: meta };
  }
}

export default {
  searchGetirYemekAdapter,
  searchGetirYemek,
  searchGetirYemekScrape,
};

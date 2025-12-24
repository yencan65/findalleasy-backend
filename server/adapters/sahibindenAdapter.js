// server/adapters/sahibindenAdapter.js
// ============================================================================
// SAHIBINDEN — S200 TITAN HARDENED (NO FAKE / NO CRASH / NO DRIFT)
// Marketplace / Listings (cars, real estate, services)
//
// - Wrapper output: { ok, items, count, source, _meta }
// - Contract lock: title + url required; price<=0 => null
// - NO RANDOM ID: deterministic stableIdS200(providerKey, url, title)
// - Observable fail: timeout / fetch fail => ok:false + items:[] (+ _meta)
// ZERO DELETE: legacy exports kept (searchSahibinden, ...)
// ============================================================================

import axios from "axios";
import * as cheerio from "cheerio";

import { proxyFetchHTML } from "../core/proxyEngine.js";
import { sanitizePrice } from "../utils/priceSanitizer.js";

import {
  withTimeout,
  TimeoutError,
  coerceItemsS200,
  normalizeItemS200,
  stableIdS200,
  fixKey,
} from "../core/s200AdapterKit.js";

const PROVIDER_KEY = "sahibinden";
const BASE = "https://www.sahibinden.com";

function safe(v) {
  return v == null ? "" : String(v).trim();
}

function clampInt(v, min, max, d) {
  const n = Number(v);
  const x = Number.isFinite(n) ? Math.trunc(n) : d;
  return Math.max(min, Math.min(max, x));
}

function _failArray(code, note, extra = {}) {
  const a = [];
  a.ok = false;
  a.error = code;
  a.note = note;
  a._meta = extra;
  return a;
}

async function fetchHTML(url, timeoutMs) {
  // 1) Prefer proxy engine (better odds against 403/anti-bot)
  try {
    const html = await withTimeout(proxyFetchHTML(url), timeoutMs, `${PROVIDER_KEY}:proxyFetchHTML`);
    if (html && String(html).length > 50) return String(html);
  } catch (_) {
    // fallthrough
  }

  // 2) Fallback direct axios
  const r = await axios.get(url, {
    timeout: timeoutMs,
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "tr-TR,tr;q=0.9,en;q=0.8",
    },
    validateStatus: () => true,
  });

  if (!r || typeof r.status !== "number") throw new Error("HTTP_NO_STATUS");
  if (r.status >= 400) throw new Error(`HTTP_${r.status}`);
  return String(r.data ?? "");
}

async function _searchSahibindenArray(q, opts = {}) {
  const query = safe(q);
  if (!query) return _failArray("bad_query", "Empty query");

  const limit = clampInt(opts?.limit, 1, 100, 50);
  const timeoutMs = clampInt(opts?.timeoutMs, 2000, 25000, 12000);

  const searchUrl = `${BASE}/arama?query_text=${encodeURIComponent(query)}`;
  const html = await fetchHTML(searchUrl, timeoutMs);
  const $ = cheerio.load(html);

  const items = [];

  $("li.searchResultsItem").each((_, el) => {
    if (items.length >= limit) return;

    const a = $(el).find("a.classifiedTitle").first();
    const href = safe(a.attr("href"));
    const title = safe(a.text());

    if (!title || !href) return;

    const url = href.startsWith("http")
      ? href
      : href.startsWith("//")
        ? `https:${href}`
        : `${BASE}${href.startsWith("/") ? "" : "/"}${href}`;

    const priceText = safe($(el).find(".searchResultsPriceValue").first().text());
    let price = sanitizePrice(priceText);
    if (typeof price === "number" && !(price > 0)) price = null;
    if (!Number.isFinite(price)) price = null;

    const imgEl = $(el).find("img").first();
    const imgRaw = safe(imgEl.attr("data-src") || imgEl.attr("src"));
    const image = !imgRaw
      ? null
      : imgRaw.startsWith("http")
        ? imgRaw
        : imgRaw.startsWith("//")
          ? `https:${imgRaw}`
          : `${BASE}${imgRaw.startsWith("/") ? "" : "/"}${imgRaw}`;

    const raw = {
      providerKey: PROVIDER_KEY,
      href,
      priceText,
      query,
    };

    const it = normalizeItemS200(
      {
        id: stableIdS200(PROVIDER_KEY, url, title),
        title,
        url,
        originUrl: url,
        price,
        image,
        raw,
      },
      PROVIDER_KEY
    );

    if (it?.title && (it?.url || it?.originUrl)) items.push(it);
  });

  return items;
}

async function _wrapS200(providerKey, fn, q, opts = {}) {
  const t0 = Date.now();
  const timeoutMs = clampInt(opts?.timeoutMs, 2000, 25000, 12000);

  try {
    const out = await withTimeout(Promise.resolve(fn(q, { ...opts, timeoutMs })), timeoutMs, `${providerKey}:search`);
    const ok = out?.ok ?? true;
    const items = coerceItemsS200(out);

    return {
      ok: !!ok,
      items,
      count: items.length,
      source: providerKey,
      _meta: {
        providerKey,
        ms: Date.now() - t0,
        timedOut: false,
      },
    };
  } catch (e) {
    const timedOut = e instanceof TimeoutError || String(e?.name || "").toLowerCase().includes("timeout");
    return {
      ok: false,
      items: [],
      count: 0,
      source: providerKey,
      _meta: {
        providerKey,
        ms: Date.now() - t0,
        timedOut,
        error: fixKey(e?.name || "error"),
        note: safe(e?.message || "fetch failed"),
      },
    };
  }
}

// ============================================================================
// Exports (ZERO DELETE)
// ============================================================================

// S200 wrapper exports (preferred)
export const searchSahibindenScrape = async (q, opts = {}) => _wrapS200(PROVIDER_KEY, _searchSahibindenArray, q, opts);
export const searchSahibindenAdapter = async (q, opts = {}) => searchSahibindenScrape(q, opts);

// Legacy array export (kept): returns items[]
export const searchSahibinden = async (q, opts = {}) => {
  const r = await searchSahibindenScrape(q, opts);
  return r?.items || [];
};

// Default adapter contract used by group loaders
export default {
  key: PROVIDER_KEY,
  search: searchSahibindenAdapter,
};

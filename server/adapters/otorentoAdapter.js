// server/adapters/otorentoAdapter.js
// ============================================================================
// OTORONTO — S200 HARDENED (DRIFT-SAFE, ZERO-CRASH, NO-FAKE)
// Output: { ok, items, count, source, _meta }
// Contract lock: title + url required; price<=0 => null
// Observable fail: fetch/timeout/parse => ok:false + items:[]
// NO RANDOM ID: stableIdS200(providerKey,url,title) (Math.random banned)
// URL priority: affiliateUrl/deeplink/finalUrl > originUrl > url (kit)
// withTimeout everywhere + global ctx set
// ZERO DELETE: S7 API + SCRAPE korunur, üzerine S200 layer oturtulur
// ============================================================================

import axios from "axios";
import * as cheerio from "cheerio"; // ZERO DELETE

import { proxyFetchHTML } from "../core/proxyEngine.js";
import { sanitizePrice } from "../utils/priceSanitizer.js";
import { optimizePrice } from "../utils/priceFixer.js";
import { buildImageVariants } from "../utils/imageFixer.js";

import {
  loadCheerioS200,
  normalizeItemS200,
  coerceItemsS200,
  stableIdS200,
  withTimeout,
  TimeoutError,
  safeStr,
} from "../core/s200AdapterKit.js";

const PROVIDER_KEY = "otorento";
const ADAPTER_KEY = "otorento_car_rental";
const PROVIDER_FAMILY = "car_rental";
const BASE = "https://otorento.com";
const DEFAULT_TIMEOUT_MS = Number(process.env.OTORENTO_TIMEOUT_MS || 9000);

const safe = (v, max = 1200) => safeStr(v, max).trim();

function parsePrice(txt) {
  const n = sanitizePrice(txt, { provider: PROVIDER_KEY });
  return Number.isFinite(n) ? n : null;
}

function parseRegion(regionOrOptions = "TR") {
  let region = "TR";
  let signal = null;
  let timeoutMs = DEFAULT_TIMEOUT_MS;

  if (typeof regionOrOptions === "string") {
    region = regionOrOptions;
  } else if (regionOrOptions && typeof regionOrOptions === "object") {
    region = regionOrOptions.region || "TR";
    signal = regionOrOptions.signal || null;
    if (Number.isFinite(Number(regionOrOptions.timeoutMs))) {
      timeoutMs = Math.max(1200, Math.min(20000, Number(regionOrOptions.timeoutMs)));
    }
  }

  return { region: String(region || "TR").toUpperCase(), signal, timeoutMs };
}

function detectVehicleClass(title) {
  const t = String(title || "").toLowerCase();
  if (/suv|jeep/.test(t)) return "car_suv";
  if (/pickup|kamyonet/.test(t)) return "car_pickup";
  if (/bmw|audi|mercedes|volvo/.test(t)) return "car_premium";
  if (/fiat|renault|hyundai|ford|opel/.test(t)) return "car_standard";
  return "car_rental";
}

function extractVehicleDetails(title) {
  const t = String(title || "").toLowerCase();
  const year = (t.match(/\b(20\d{2}|19\d{2})\b/) || [null])[0];
  const engine = (t.match(/\b(\d\.\d|\d,\d)\b/) || [null])[0];
  const brand =
    (t.match(/\b(bmw|mercedes|audi|volkswagen|volvo|toyota|renault|fiat|hyundai|kia|ford|opel)\b/) || [null])[0];
  return { year, engine, brand };
}

function _errStr(e) {
  return safeStr(e?.message || e || "error", 450);
}
function _isTimeout(e) {
  return e instanceof TimeoutError || /timed?\s*out/i.test(String(e?.message || e || ""));
}
function _mkRes(ok, items, meta = {}) {
  const arr = Array.isArray(items) ? items : [];
  const res = { ok: !!ok, items: arr, count: arr.length, source: PROVIDER_KEY, _meta: { ...meta } };
  try {
    Object.defineProperty(res, "length", { value: arr.length, enumerable: false });
    Object.defineProperty(res, Symbol.iterator, { enumerable: false, value: function* () { yield* arr; } });
  } catch {}
  return res;
}

function _abs(url) {
  const u = safe(url, 2000);
  if (!u) return "";
  if (u.startsWith("http")) return u;
  if (u.startsWith("//")) return `https:${u}`;
  if (u.startsWith("/")) return BASE + u;
  return BASE + "/" + u;
}

// ============================================================================
// 1) API — ZERO DELETE (korunur) → S200 normalize + stableId
// ============================================================================
async function apiOtorento(query, signal, timeoutMs) {
  const url = `${BASE}/api/search?q=${encodeURIComponent(query)}`;
  try {
    const { data } = await withTimeout(
      axios.get(url, {
        timeout: Math.max(2500, Math.min(25000, timeoutMs + 7000)),
        signal,
        headers: {
          "User-Agent": "Mozilla/5.0 FindAllEasy-S200",
          Accept: "application/json",
        },
      }),
      timeoutMs,
      `${ADAPTER_KEY}.api`
    );

    if (!Array.isArray(data?.cars)) return [];

    const out = [];
    for (const c of data.cars) {
      const title = safe(c?.name || c?.model || query, 260);
      const link = _abs(c?.url || c?.link || c?.href || "");
      if (!title || !link) continue;

      const price = parsePrice(c?.dailyPrice);

      const img = buildImageVariants(c?.image || c?.photo || null);

      const details = extractVehicleDetails(title);
      const category = detectVehicleClass(title);

      let item = {
        id: stableIdS200(PROVIDER_KEY, link, title),
        title,
        price,
        rating: null,

        provider: PROVIDER_FAMILY,
        providerFamily: PROVIDER_FAMILY,
        providerKey: PROVIDER_KEY,
        providerType: "provider",

        vertical: PROVIDER_FAMILY,
        category,

        currency: "TRY",
        region: "TR",

        url: link,
        originUrl: link,
        deeplink: link,

        image: img.image,
        imageOriginal: img.imageOriginal,
        imageProxy: img.imageProxy,
        hasProxy: img.hasProxy,

        vehicle: details,

        raw: c,
      };

      item = optimizePrice(item, { provider: PROVIDER_KEY });
      out.push(item);
    }

    return out;
  } catch (e) {
    const ex = new Error("API_FAIL");
    ex.code = _isTimeout(e) ? "TIMEOUT" : "API_FAIL";
    ex.cause = _errStr(e);
    ex.url = url;
    throw ex;
  }
}

// ============================================================================
// 2) SCRAPER — S7 korunur → S200 normalize + stableId
// ============================================================================
async function scrapeOtorento(query, region, signal, timeoutMs) {
  const q = encodeURIComponent(query);
  const url = `${BASE}/arac-kiralama?search=${q}`;

  let html = "";
  try {
    html = await withTimeout(proxyFetchHTML(url), timeoutMs, `${ADAPTER_KEY}.proxyFetch`);
    html = String(html || "");
  } catch (e) {
    const res = await withTimeout(
      axios.get(url, {
        timeout: Math.max(2500, Math.min(25000, timeoutMs + 7000)),
        signal,
        headers: { "User-Agent": "Mozilla/5.0 FindAllEasy-S200" },
      }),
      timeoutMs,
      `${ADAPTER_KEY}.axiosFetch`
    );
    html = String(res?.data || "");
  }

  if (!html) {
    const ex = new Error("FETCH_FAIL");
    ex.code = "FETCH_FAIL";
    ex.url = url;
    throw ex;
  }

  const $ = loadCheerioS200(html, { adapter: ADAPTER_KEY, providerKey: PROVIDER_KEY, url });
  const out = [];

  const selectors = [
    ".car-card",
    ".vehicle-card",
    ".search-item",
    ".result-card",
    ".car-item",
    ".carListing",
    ".car-box",
  ];

  $(selectors.join(",")).each((i, el) => {
    const wrap = $(el);

    const title =
      safe(wrap.find(".car-title").text()) ||
      safe(wrap.find("h3").text()) ||
      safe(wrap.find(".title").text());
    if (!title) return;

    const priceTxt =
      safe(wrap.find(".price").text()) ||
      safe(wrap.find(".daily-price").text()) ||
      safe(wrap.find(".amount").text());
    const price = parsePrice(priceTxt);

    let href = safe(wrap.find("a").attr("href"), 2000);
    if (!href) return;
    href = _abs(href);

    const img = buildImageVariants(
      safe(wrap.find("img").attr("data-src"), 2000) || safe(wrap.find("img").attr("src"), 2000) || null
    );

    const category = detectVehicleClass(title);
    const details = extractVehicleDetails(title);

    let item = {
      id: stableIdS200(PROVIDER_KEY, href, title),
      title,
      price,
      rating: null,

      provider: PROVIDER_FAMILY,
      providerFamily: PROVIDER_FAMILY,
      providerKey: PROVIDER_KEY,
      providerType: "provider",

      vertical: PROVIDER_FAMILY,
      category,

      currency: "TRY",
      region,

      url: href,
      originUrl: href,
      deeplink: href,

      image: img.image,
      imageOriginal: img.imageOriginal,
      imageProxy: img.imageProxy,
      hasProxy: img.hasProxy,

      vehicle: details,

      raw: {
        title,
        priceTxt,
        href,
        image: img,
        details,
      },
    };

    item = optimizePrice(item, { provider: PROVIDER_KEY });
    out.push(item);
  });

  return out;
}

// ============================================================================
// 3) PUBLIC UNIFIED ADAPTER — S200 OUTPUT (ZERO DELETE export isimleri)
// ============================================================================
export async function searchOtorento(query, regionOrOptions = "TR") {
  const t0 = Date.now();
  const q = safe(query, 240);
  const { region, signal, timeoutMs } = parseRegion(regionOrOptions);

  if (!q) {
    return _mkRes(true, [], {
      code: "OK_EMPTY",
      region,
      ms: Date.now() - t0,
      timeoutMs,
    });
  }

  const ctxUrl = `${BASE}/arac-kiralama?search=${encodeURIComponent(q)}`;
  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = { adapter: ADAPTER_KEY, providerKey: PROVIDER_KEY, url: ctxUrl };

  let apiError = null;

  try {
    let rawItems = [];
    let mode = "scrape";

    try {
      rawItems = await apiOtorento(q, signal, Math.min(3500, timeoutMs));
      mode = rawItems.length ? "api" : "scrape";
    } catch (e) {
      apiError = { code: e?.code || "API_FAIL", error: _errStr(e?.cause || e), url: e?.url || "" };
      rawItems = [];
    }

    if (!rawItems.length) {
      rawItems = await scrapeOtorento(q, region, signal, timeoutMs);
      mode = "scrape";
    }

    const normalized = [];
    for (const it of coerceItemsS200(rawItems)) {
      const n = normalizeItemS200(it, PROVIDER_KEY, {
        providerFamily: PROVIDER_FAMILY,
        vertical: PROVIDER_FAMILY,
        category: it?.category || "car_rental",
        region,
        currency: "TRY",
        baseUrl: BASE,
      });
      if (n) normalized.push(n);
    }

    const seen = new Set();
    const items = [];
    for (const it of normalized) {
      const id = String(it?.id || "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      items.push(it);
    }

    const ok = items.length > 0 || !apiError; // scrape succeeded OR api had no error
    return _mkRes(ok, items, {
      code: ok ? (items.length ? "OK" : "OK_EMPTY") : (apiError?.code || "ERROR"),
      mode,
      region,
      apiError: apiError || undefined,
      ms: Date.now() - t0,
      timeoutMs,
    });
  } catch (err) {
    return _mkRes(false, [], {
      code: _isTimeout(err) ? "TIMEOUT" : (err?.code || "ERROR"),
      error: _errStr(err?.cause || err),
      region,
      ms: Date.now() - t0,
      timeoutMs,
    });
  } finally {
    globalThis.__S200_ADAPTER_CTX = prevCtx;
  }
}

export const searchOtorentoScrape = searchOtorento;
export const searchOtorentoAdapter = searchOtorento;

export default { searchOtorento };

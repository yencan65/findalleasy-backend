// server/adapters/otoshopsAdapter.js
// ============================================================================
// OTOSHOPS — S200 HARDENED (DRIFT-SAFE, ZERO-CRASH, NO-FAKE)
// Output: { ok, items, count, source, _meta }
// Contract lock: title + url required; price<=0 => null
// Observable fail: fetch/timeout/parse => ok:false + items:[]
// NO RANDOM ID: stableIdS200(providerKey,url,title) (Math.random banned)
// URL priority: affiliateUrl/deeplink/finalUrl > originUrl > url (kit)
// withTimeout everywhere + global ctx set
// ZERO DELETE: export isimleri korunur
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

const PROVIDER_KEY = "otoshops";
const ADAPTER_KEY = "otoshops_vehicle_sale";
const PROVIDER_FAMILY = "vehicle_sale";
const BASE = "https://www.otoshops.com";
const DEFAULT_TIMEOUT_MS = Number(process.env.OTOSHOPS_TIMEOUT_MS || 9000);

const safe = (v, max = 1200) => safeStr(v, max).trim();

function parsePrice(text) {
  const n = sanitizePrice(text, { provider: PROVIDER_KEY });
  return Number.isFinite(n) ? n : null;
}

function detectVehicleCategory(title) {
  const t = String(title || "").toLowerCase();
  if (/bmw|mercedes|audi|volvo/.test(t)) return "car_premium";
  if (/renault|fiat|hyundai|opel|ford/.test(t)) return "car_standard";
  if (/range rover|land rover/.test(t)) return "car_luxury";
  if (/suv|jeep/.test(t)) return "car_suv";
  if (/pickup|kamyonet/.test(t)) return "car_pickup";
  return "car_sale";
}

function extractVehicleDetails(title) {
  const t = String(title || "").toLowerCase();
  const year = (t.match(/\b(20\d{2}|19\d{2})\b/) || [null])[0];
  const engine = (t.match(/\b(\d\.\d|\d,\d)\b/) || [null])[0];
  const brand =
    (t.match(/\b(bmw|mercedes|audi|volkswagen|renault|fiat|honda|ford|hyundai|kia)\b/) || [null])[0];
  return { year, engine, brand };
}

function parseRegionOptions(regionOrOptions = "TR") {
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

function extractImage($, el) {
  const raw =
    safe($(el).find("img").attr("data-src"), 2000) ||
    safe($(el).find("img").attr("src"), 2000) ||
    "";
  return buildImageVariants(raw || null);
}

async function scrapeOtoShopsInternal(query, region, signal, timeoutMs) {
  const q = encodeURIComponent(query);
  const url = `${BASE}/arama?text=${q}`;

  let html = "";
  try {
    html = await withTimeout(proxyFetchHTML(url), timeoutMs, `${ADAPTER_KEY}.proxyFetch`);
    html = String(html || "");
  } catch (e) {
    const res = await withTimeout(
      axios.get(url, {
        timeout: Math.max(2500, Math.min(25000, timeoutMs + 7000)),
        signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (FindAllEasy-S200)",
          Accept: "text/html",
        },
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

  const selectors = [
    ".car-box",
    ".result-card",
    ".car-item",
    ".vehicle-card",
    ".carListing",
    ".list-item",
    ".product",
  ];

  const out = [];

  $(selectors.join(",")).each((i, el) => {
    const wrap = $(el);

    const title =
      safe(wrap.find(".car-title").text()) ||
      safe(wrap.find(".title").text()) ||
      safe(wrap.find("h3").text());
    if (!title) return;

    const priceTxt =
      safe(wrap.find(".price").text()) ||
      safe(wrap.find(".car-price").text()) ||
      safe(wrap.find(".amount").text());
    const price = parsePrice(priceTxt);

    let href =
      safe(wrap.find("a").attr("href"), 2000) ||
      safe(wrap.find(".link").attr("href"), 2000);
    if (!href) return;
    if (!href.startsWith("http")) href = BASE + href;

    const img = extractImage($, el);

    const category = detectVehicleCategory(title);
    const details = extractVehicleDetails(title);

    let item = {
      id: stableIdS200(PROVIDER_KEY, href, title),
      title,
      price,
      provider: PROVIDER_FAMILY,
      providerFamily: PROVIDER_FAMILY,
      providerKey: PROVIDER_KEY,
      providerType: "provider",

      vertical: PROVIDER_FAMILY,
      category,

      url: href,
      originUrl: href,
      deeplink: href,

      rating: null,
      currency: "TRY",
      region,

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

// PUBLIC SCRAPE — ZERO DELETE
export async function searchOtoShopsScrape(query, regionOrOptions = "TR") {
  const t0 = Date.now();
  const q = safe(query, 240);
  const { region, signal, timeoutMs } = parseRegionOptions(regionOrOptions);

  if (!q) {
    return _mkRes(true, [], {
      code: "OK_EMPTY",
      region,
      ms: Date.now() - t0,
      timeoutMs,
    });
  }

  const ctxUrl = `${BASE}/arama?text=${encodeURIComponent(q)}`;
  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = { adapter: ADAPTER_KEY, providerKey: PROVIDER_KEY, url: ctxUrl };

  try {
    const raw = await scrapeOtoShopsInternal(q, region, signal, timeoutMs);

    const normalized = [];
    for (const it of coerceItemsS200(raw)) {
      const n = normalizeItemS200(it, PROVIDER_KEY, {
        providerFamily: PROVIDER_FAMILY,
        vertical: PROVIDER_FAMILY,
        category: it?.category || "car_sale",
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

    return _mkRes(true, items, {
      code: items.length ? "OK" : "OK_EMPTY",
      region,
      ms: Date.now() - t0,
      timeoutMs,
    });
  } catch (e) {
    return _mkRes(false, [], {
      code: _isTimeout(e) ? "TIMEOUT" : (e?.code || "ERROR"),
      error: _errStr(e?.cause || e),
      region,
      ms: Date.now() - t0,
      timeoutMs,
    });
  } finally {
    globalThis.__S200_ADAPTER_CTX = prevCtx;
  }
}

// UNIFIED ADAPTER — S200 OUTPUT (ZERO DELETE)
export async function searchOtoShops(query, regionOrOptions = "TR") {
  // same behavior as scrape, but keep name for compatibility
  return await searchOtoShopsScrape(query, regionOrOptions);
}

export const searchOtoShopsAdapter = searchOtoShops;

export default {
  searchOtoShops,
  searchOtoShopsScrape,
  searchOtoShopsAdapter,
};

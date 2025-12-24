// server/adapters/searchGroupama.js
// ============================================================================
// GROUPAMA ADAPTER — S200 HARDENED (DRIFT-SAFE, ZERO-CRASH, NO-FAKE)
// Output: { ok, items, count, source, _meta }   (+ iterable/length compat)
// Contract lock: title+url required; price<=0 => null
// Observable fail: fetch/timeout/parse => ok:false + items:[]
// NO RANDOM ID: stableIdS200(providerKey,url,title) (Math.random banned)
// URL priority: affiliateUrl/deeplink/finalUrl > originUrl > url (kit)
// withTimeout everywhere + global ctx set
// ZERO DELETE: existing exports preserved (searchGroupama + aliases)
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

const PROVIDER_KEY = "groupama";
const ADAPTER_KEY = "groupama_insurance";
const PROVIDER_FAMILY = "insurance";
const BASE = "https://www.groupama.com.tr";
const LIST_URL = "https://www.groupama.com.tr/urunler";
const DEFAULT_TIMEOUT_MS = 6500;

function safe(v, max = 400) {
  return safeStr(v, max);
}
function clean(v) {
  return safe(v, 1200).trim();
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
  // Back-compat: allow treating response like array
  try {
    Object.defineProperty(res, "length", { value: arr.length, enumerable: false });
    Object.defineProperty(res, Symbol.iterator, { enumerable: false, value: function* () { yield* arr; } });
  } catch {}
  return res;
}

function detectCategory(title = "", desc = "") {
  const t = (String(title) + " " + String(desc)).toLowerCase();

  if (/tamamlayıcı|supplement/.test(t)) return "supplementary_health";
  if (/sağlık|health|medikal/.test(t)) return "health_insurance";
  if (/kasko|trafik|oto|araç|arac|otomobil/.test(t)) return "car_insurance";
  if (/konut|ev|dask/.test(t)) return "home_insurance";
  if (/seyahat|travel/.test(t)) return "travel_insurance";

  return "insurance";
}

function stableId(url, title) {
  return stableIdS200(PROVIDER_KEY, safe(url, 2000), safe(title, 260));
}

async function fetchHTML(url, signal, timeoutMs) {
  // Proxy-first (Cloudflare safe), fallback direct
  try {
    const h = await proxyFetchHTML(url);
    return String(h || "");
  } catch {
    try {
      const r = await axios.get(url, {
        timeout: Math.max(2500, Math.min(25000, timeoutMs + 7000)),
        headers: { "User-Agent": "Mozilla/5.0 (FindAllEasy-S200)" },
        ...(signal ? { signal } : {}),
      });
      return String(r?.data || "");
    } catch {
      return "";
    }
  }
}

function _normalizeCandidates(rawItems, region) {
  const out = [];
  for (const it of coerceItemsS200(rawItems)) {
    const category = safe(it?.category || "insurance", 80);
    const n = normalizeItemS200(it, PROVIDER_KEY, {
      providerFamily: PROVIDER_FAMILY,
      vertical: "insurance",
      category,
      region,
      currency: "TRY",
      baseUrl: BASE,
    });
    if (n) out.push(n);
  }
  // Dedupe by id
  const seen = new Set();
  const items = [];
  for (const it of out) {
    const id = String(it?.id || "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    items.push(it);
  }
  return items;
}

// ============================================================================
// MAIN ADAPTER — S200
// ============================================================================
export async function searchGroupama(query, regionOrOptions = "TR") {
  const t0 = Date.now();

  let region = "TR";
  let options = {};

  if (typeof regionOrOptions === "string") region = regionOrOptions;
  else if (regionOrOptions && typeof regionOrOptions === "object") {
    region = regionOrOptions.region || "TR";
    options = regionOrOptions;
  }

  region = safe(region || "TR", 10).toUpperCase();
  const q = safe(query, 180);
  const qLower = q ? q.toLowerCase() : "";

  const timeoutMs = Number.isFinite(Number(options?.timeoutMs))
    ? Math.max(1200, Math.min(20000, Number(options.timeoutMs)))
    : DEFAULT_TIMEOUT_MS;

  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = { adapter: ADAPTER_KEY, providerKey: PROVIDER_KEY, url: LIST_URL };

  try {
    const html = await withTimeout(fetchHTML(LIST_URL, options.signal, timeoutMs), timeoutMs, `${ADAPTER_KEY}.fetch`);
    if (!html) {
      return _mkRes(false, [], {
        code: "FETCH_FAIL",
        error: "FETCH_FAIL",
        url: LIST_URL,
        region,
        ms: Date.now() - t0,
        timeoutMs,
      });
    }

    const $ = loadCheerioS200(html, { adapter: ADAPTER_KEY, providerKey: PROVIDER_KEY, url: LIST_URL });
    const out = [];

    const selectors = [
      ".product-card",
      ".product-item",
      ".insurance-card",
      ".card-product",
      ".product-list-item",
      ".card",
      ".col-md-4",
      ".col-sm-6",
    ];

    $(selectors.join(",")).each((i, el) => {
      const title =
        clean($(el).find(".product-title").text()) ||
        clean($(el).find(".title").text()) ||
        clean($(el).find("h3").text());

      if (!title) return;

      const desc =
        clean($(el).find(".product-description").text()) ||
        clean($(el).find(".description").text()) ||
        clean($(el).find(".desc").text()) ||
        clean($(el).find(".text").text()) ||
        "";

      // Query filter (soft)
      if (qLower) {
        const t = title.toLowerCase();
        const d = desc.toLowerCase();
        if (!t.includes(qLower) && !d.includes(qLower)) return;
      }

      let href =
        clean($(el).find("a").attr("href")) ||
        clean($(el).find(".card-link").attr("href"));

      if (!href) return;
      if (!href.startsWith("http")) href = BASE + href;

      const category = detectCategory(title, desc);

      // Image
      const img =
        clean($(el).find("img").attr("data-src")) ||
        clean($(el).find("img").attr("src")) ||
        "";
      const variants = img ? buildImageVariants(img, "insurance") : {};

      // Insurance pages generally don't list price → forced null (valid)
      const price = sanitizePrice(null, { provider: PROVIDER_KEY, category });

      let item = {
        id: stableId(href, title),

        provider: PROVIDER_FAMILY,
        providerKey: PROVIDER_KEY,
        providerFamily: PROVIDER_FAMILY,
        providerType: "provider",
        vertical: "insurance",

        title,
        description: desc,
        category,

        region,
        currency: "TRY",

        url: href,
        originUrl: href,
        deeplink: href,

        price,
        rating: null,

        image: variants.image || null,
        imageOriginal: variants.imageOriginal || null,
        imageProxy: variants.imageProxy || null,
        hasProxy: variants.hasProxy || false,

        raw: { title, desc, href, img },
      };

      item = optimizePrice(item, { provider: PROVIDER_KEY, category });
      out.push(item);
    });

    const items = _normalizeCandidates(out, region);

    return _mkRes(true, items, {
      code: items.length ? "OK" : "OK_EMPTY",
      url: LIST_URL,
      region,
      ms: Date.now() - t0,
      timeoutMs,
    });
  } catch (e) {
    return _mkRes(false, [], {
      code: _isTimeout(e) ? "TIMEOUT" : "ERROR",
      error: _errStr(e),
      url: LIST_URL,
      region,
      ms: Date.now() - t0,
      timeoutMs,
    });
  } finally {
    globalThis.__S200_ADAPTER_CTX = prevCtx;
  }
}

// Aliases — zero delete
export const searchGroupamaScrape = searchGroupama;
export const searchGroupamaAdapter = searchGroupama;

export default { searchGroupama };

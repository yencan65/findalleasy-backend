// server/adapters/otoNetAdapter.js
// ============================================================================
// OTONET — S200 HARDENED (DRIFT-SAFE, ZERO-CRASH, NO-FAKE)
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

const PROVIDER_KEY = "otonet";
const ADAPTER_KEY = "otonet_vehicle_sale";
const PROVIDER_FAMILY = "vehicle_sale";
const BASE = "https://www.oto.net";
const DEFAULT_TIMEOUT_MS = Number(process.env.OTONET_TIMEOUT_MS || 9000);

function safe(v, max = 1000) {
  return safeStr(v, max).trim();
}

function safeNumber(txt) {
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
  if (/fiat|renault|hyundai|opel|ford|kia/.test(t)) return "car_standard";
  return "car_sale";
}

function extractVehicleDetails(title) {
  const t = String(title || "").toLowerCase();
  const year = (t.match(/\b(20\d{2}|19\d{2})\b/) || [null])[0];
  const engine = (t.match(/\b(\d\.\d|\d,\d)\b/) || [null])[0];
  const brand =
    (t.match(/\b(bmw|mercedes|audi|volkswagen|volvo|toyota|renault|fiat|hyundai|kia|ford|opel)\b/) || [null])[0];
  return { year, engine, brand };
}

function extractImage($, el) {
  const raw = safe($(el).find("img").attr("data-src"), 2000) || safe($(el).find("img").attr("src"), 2000) || "";
  return buildImageVariants(raw || null);
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

const SELECTORS = [
  ".arac-card",
  ".vehicle-card",
  ".listing-card",
  ".result-card",
  ".car-item",
  ".ilan-card",
];

export async function searchOtoNetAdapter(query, regionOrOptions = "TR") {
  const t0 = Date.now();
  const qStr = safe(query, 200);
  const { region, signal, timeoutMs } = parseRegion(regionOrOptions);

  if (!qStr) {
    return _mkRes(true, [], {
      code: "OK_EMPTY",
      region,
      ms: Date.now() - t0,
      timeoutMs,
    });
  }

  const q = encodeURIComponent(qStr);
  const url = `${BASE}/arama?searchText=${q}`;

  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = { adapter: ADAPTER_KEY, providerKey: PROVIDER_KEY, url };

  try {
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
      return _mkRes(false, [], {
        code: "FETCH_FAIL",
        error: "FETCH_FAIL",
        url,
        region,
        ms: Date.now() - t0,
        timeoutMs,
      });
    }

    const $ = loadCheerioS200(html, { adapter: ADAPTER_KEY, providerKey: PROVIDER_KEY, url });
    const candidates = [];

    for (const sel of SELECTORS) {
      $(sel).each((i, el) => {
        const wrap = $(el);

        const title =
          safe(wrap.find(".title").text()) ||
          safe(wrap.find(".car-title").text()) ||
          safe(wrap.find("h3").text());
        if (!title) return;

        const priceTxt =
          safe(wrap.find(".price").text()) ||
          safe(wrap.find(".amount").text()) ||
          safe(wrap.find(".car-price").text());

        const price = safeNumber(priceTxt);

        let link =
          safe(wrap.find("a").attr("href"), 2000) ||
          safe(wrap.find(".vehicle-link").attr("href"), 2000);
        if (!link) return;
        if (!link.startsWith("http")) link = BASE + link;

        const img = extractImage($, el);
        const category = detectVehicleClass(title);
        const details = extractVehicleDetails(title);

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
          region,

          url: link,
          originUrl: link,
          deeplink: link,

          image: img.image,
          imageOriginal: img.imageOriginal,
          imageProxy: img.imageProxy,
          hasProxy: img.hasProxy,

          vehicle: details,

          raw: {
            title,
            priceTxt,
            link,
            imageRaw: img,
            details,
          },
        };

        item = optimizePrice(item, { provider: PROVIDER_KEY });
        candidates.push(item);
      });
    }

    const normalized = [];
    for (const it of coerceItemsS200(candidates)) {
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
      url,
      region,
      ms: Date.now() - t0,
      timeoutMs,
    });
  } catch (err) {
    if (err?.name === "CanceledError" || err?.name === "AbortError") {
      return _mkRes(false, [], {
        code: "ABORTED",
        error: "ABORTED",
        url,
        region,
        ms: Date.now() - t0,
        timeoutMs,
      });
    }
    return _mkRes(false, [], {
      code: _isTimeout(err) ? "TIMEOUT" : "ERROR",
      error: _errStr(err),
      url,
      region,
      ms: Date.now() - t0,
      timeoutMs,
    });
  } finally {
    globalThis.__S200_ADAPTER_CTX = prevCtx;
  }
}

export default { searchOtoNetAdapter };

// server/adapters/spaBiletinoAdapter.js
// ============================================================================
// Biletino (Etkinlik) — S200 HARDENED (DRIFT-SAFE, ZERO-CRASH, NO-FAKE)
// Output: { ok, items, count, source, _meta } (+ iterable/length compat)
// Contract lock: title+url required; price<=0 => null
// Observable fail: API/scrape fetch/timeout/parse => ok:false + items:[]
// NO RANDOM ID: stableIdS200(providerKey,url,title) via normalizeItemS200
// URL priority: affiliateUrl/deeplink/finalUrl > originUrl > url
// withTimeout everywhere + global ctx set
// ZERO DELETE: mevcut export isimleri korunur
// ============================================================================

import axios from "axios";
import * as cheerio from "cheerio"; // ZERO DELETE

import { proxyFetchHTML } from "../core/proxyEngine.js";
import { buildImageVariants } from "../utils/imageFixer.js";
import { sanitizePrice } from "../utils/priceSanitizer.js";
import { optimizePrice } from "../utils/priceFixer.js";
import { buildAffiliateUrlS9 as buildAffiliateUrlS10 } from "./affiliateEngine.js";

import {
  loadCheerioS200,
  normalizeItemS200,
  coerceItemsS200,
  stableIdS200,
  withTimeout,
  TimeoutError,
  safeStr,
} from "../core/s200AdapterKit.js";

const PROVIDER_KEY = "biletino";
const ADAPTER_KEY = "biletino_event";
const PROVIDER_FAMILY = "event";
const BASE = "https://www.biletino.com";
const DEFAULT_TIMEOUT_MS = 6500;

const safe = (v, max = 400) => safeStr(v, max);

function _now() {
  return Date.now();
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

// ZERO DELETE: legacy stableId function name preserved
function stableId(url, title) {
  return stableIdS200(PROVIDER_KEY, url || "", title || "");
}

function _normalizeCandidates(rawItems, region) {
  const out = [];
  for (const it of coerceItemsS200(rawItems)) {
    const n = normalizeItemS200(it, PROVIDER_KEY, {
      providerFamily: PROVIDER_FAMILY,
      vertical: "event",
      category: "event",
      region,
      currency: "TRY",
      baseUrl: BASE,
    });
    if (n) out.push(n);
  }
  const seen = new Set();
  const deduped = [];
  for (const it of out) {
    const id = String(it?.id || "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push(it);
  }
  return deduped;
}

// ===================================================================================
//  PRIMARY API FETCH (Biletino resmi API) — S200
// ===================================================================================
async function fetchBiletinoAPI(query, region, signal, timeoutMs) {
  const url = `${BASE}/api/search?q=${encodeURIComponent(query)}`;
  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = { adapter: ADAPTER_KEY, providerKey: PROVIDER_KEY, url, mode: "api" };

  try {
    const data = await withTimeout(
      axios
        .get(url, { timeout: Math.max(2500, Math.min(25000, timeoutMs + 5000)), signal })
        .then((r) => r?.data),
      timeoutMs,
      `${ADAPTER_KEY}.api`
    );

    const results = Array.isArray(data?.results) ? data.results : [];

    const candidates = results.map((ev) => {
      const eventUrl = `${BASE}/${ev.slug}`;
      const affiliateUrl = buildAffiliateUrlS10({ provider: PROVIDER_KEY, url: eventUrl });

      const price = sanitizePrice(ev.price ?? ev.minPrice ?? null, { provider: PROVIDER_KEY, category: "event" });

      let item = {
        id: stableIdS200(PROVIDER_KEY, affiliateUrl || eventUrl, ev.title || "Event"),
        title: ev.title,
        providerKey: PROVIDER_KEY,
        provider: PROVIDER_FAMILY,
        category: "event",
        vertical: "event",
        currency: "TRY",
        region,

        url: eventUrl,
        originUrl: eventUrl,
        affiliateUrl,

        rating: null,
        price,

        dateText: ev.date || ev.startDate || null,
        locationText: ev.locationName || ev.city || null,

        ...buildImageVariants(ev.image || ev.coverImage || null, "event"),
        raw: ev,
      };

      item = optimizePrice(item, { provider: PROVIDER_KEY, category: "event" });
      return item;
    });

    const items = _normalizeCandidates(candidates, region);

    return _mkRes(true, items, { code: items.length ? "OK" : "OK_EMPTY", mode: "api", url, region });
  } catch (e) {
    return _mkRes(false, [], { code: _isTimeout(e) ? "TIMEOUT" : "API_FAIL", mode: "api", url, region, error: _errStr(e) });
  } finally {
    globalThis.__S200_ADAPTER_CTX = prevCtx;
  }
}

// ===================================================================================
//  SCRAPER (Proxy destekli + Multi-selector) — S200
// ===================================================================================
async function fetchBiletinoScrape(query, region, signal, timeoutMs) {
  const url = `${BASE}/search/?q=${encodeURIComponent(query)}`;

  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = { adapter: ADAPTER_KEY, providerKey: PROVIDER_KEY, url, mode: "scrape" };

  try {
    let html = "";
    try {
      html = await withTimeout(
        axios
          .get(url, {
            timeout: Math.max(2500, Math.min(25000, timeoutMs + 5000)),
            signal,
            headers: { "User-Agent": "Mozilla/5.0 (FindAllEasy-S200)" },
          })
          .then((r) => r?.data),
        timeoutMs,
        `${ADAPTER_KEY}.direct`
      );
      html = String(html || "");
    } catch {
      try {
        const p = await withTimeout(proxyFetchHTML(url), timeoutMs, `${ADAPTER_KEY}.proxy`);
        html = String(p || "");
      } catch {
        html = "";
      }
    }

    if (!html) return _mkRes(false, [], { code: "FETCH_FAIL", mode: "scrape", url, region, error: "FETCH_FAIL" });

    const $ = loadCheerioS200(html, { adapter: ADAPTER_KEY, providerKey: PROVIDER_KEY, url });
    const out = [];

    const selectors = [".event-card", ".evt-card", ".event", ".eventItem", ".b-event-card"];
    const qLower = safe(query, 120).toLowerCase();

    $(selectors.join(",")).each((i, el) => {
      const title =
        safe($(el).find(".event-title").text()) ||
        safe($(el).find("h3").text()) ||
        safe($(el).find(".title").text());

      if (!title) return;

      let href =
        $(el).find("a").attr("href") ||
        $(el).find(".event-link").attr("href");

      href = safe(href, 2000);
      if (!href) return;

      const absUrl = href.startsWith("http") ? href : `${BASE}${href}`;
      const affiliateUrl = buildAffiliateUrlS10({ provider: PROVIDER_KEY, url: absUrl });

      const price = sanitizePrice(safe($(el).find(".event-price").text()), { provider: PROVIDER_KEY, category: "event" });

      const img =
        safe($(el).find("img").attr("data-src"), 2000) ||
        safe($(el).find("img").attr("src"), 2000) ||
        null;

      const dateText =
        safe($(el).find(".event-date").text()) ||
        safe($(el).find("[data-event-date]").text()) ||
        null;

      const locationText =
        safe($(el).find(".location").text()) ||
        safe($(el).find(".event-location").text()) ||
        null;

      // QueryProof
      const bigText = safe($(el).text(), 1200).toLowerCase();
      if (qLower && !title.toLowerCase().includes(qLower) && !bigText.includes(qLower)) return;

      let item = {
        id: stableIdS200(PROVIDER_KEY, affiliateUrl || absUrl, title),
        title,
        providerKey: PROVIDER_KEY,
        provider: PROVIDER_FAMILY,
        category: "event",
        vertical: "event",
        currency: "TRY",
        region,

        url: absUrl,
        originUrl: absUrl,
        affiliateUrl,

        rating: null,
        price,
        dateText,
        locationText,

        ...buildImageVariants(img, "event"),
        raw: { title, img, absUrl },
      };

      item = optimizePrice(item, { provider: PROVIDER_KEY, category: "event" });
      out.push(item);
    });

    const items = _normalizeCandidates(out, region).slice(0, 80);
    return _mkRes(true, items, { code: items.length ? "OK" : "OK_EMPTY", mode: "scrape", url, region });
  } catch (e) {
    return _mkRes(false, [], { code: _isTimeout(e) ? "TIMEOUT" : "ERROR", mode: "scrape", url, region, error: _errStr(e) });
  } finally {
    globalThis.__S200_ADAPTER_CTX = prevCtx;
  }
}

// ===================================================================================
//  UNIFIED ADAPTER — API → SCRAPER fallback — S200
// ===================================================================================
export async function searchSpaBiletinoAdapter(query, regionOrOptions = "TR") {
  const t0 = _now();

  let region = "TR";
  let options = {};
  if (typeof regionOrOptions === "string") region = regionOrOptions;
  else if (regionOrOptions) {
    region = regionOrOptions.region || "TR";
    options = regionOrOptions;
  }

  region = safe(region || "TR", 10).toUpperCase();
  const q = safe(query, 160);

  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(1200, Math.min(20000, Number(options.timeoutMs)))
    : DEFAULT_TIMEOUT_MS;

  if (!q) return _mkRes(false, [], { code: "EMPTY_QUERY", error: "EMPTY_QUERY", ms: 0, region });

  const api = await fetchBiletinoAPI(q, region, options.signal, timeoutMs);
  api._meta = { ...(api._meta || {}), ms: _now() - t0, timeoutMs };

  if (api.ok && api.items?.length) return api;

  const scrape = await fetchBiletinoScrape(q, region, options.signal, timeoutMs);
  scrape._meta = { ...(scrape._meta || {}), ms: _now() - t0, timeoutMs };
  return scrape;
}

export const searchSpaBiletino = searchSpaBiletinoAdapter;

// Keep legacy export name (ZERO DELETE): previously pointed to raw scrape function.
// Now it returns S200 too, but still usable.
export const searchSpaBiletinoScrape = async (q, o = "TR") => searchSpaBiletinoAdapter(q, o);

export default {
  searchSpaBiletino,
  searchSpaBiletinoScrape,
  searchSpaBiletinoAdapter,
};

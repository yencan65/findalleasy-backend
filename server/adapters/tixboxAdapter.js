// server/adapters/tixboxAdapter.js
// ======================================================================
// T I X B O X — S200 FINAL (KIT-LOCKED, DRIFT-SAFE, OBSERVABLE)
// - Output: { ok, items, count, source, _meta } ✅
// - Contract lock: title + url required; price<=0 => null ✅
// - Observable fail: fetch/timeout/parse => ok:false + items:[] ✅
// - NO RANDOM ID: stableIdS200(providerKey,url,title) ✅
// - URL priority: affiliateUrl/deeplink/finalUrl > originUrl > url ✅
// - withTimeout wrapped ✅
// ZERO DELETE: Fonksiyon isimleri korunur.
// ======================================================================

import axios from "axios";
import * as cheerio from "cheerio"; // ZERO DELETE

import { proxyFetchHTML } from "../core/proxyEngine.js";
import { sanitizePrice } from "../utils/priceSanitizer.js";
import { optimizePrice } from "../utils/priceFixer.js";
import { buildImageVariants } from "../utils/imageFixer.js";
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

const PROVIDER_KEY = "tixbox";
const PROVIDER_FAMILY = "tixbox";
const BASE = "https://www.tixbox.com";
const DEFAULT_TIMEOUT_MS = Number(process.env.TIXBOX_TIMEOUT_MS || 9000);

// ------------------------------------------------------------
// HELPERS (legacy kept)
// ------------------------------------------------------------
function safe(v) { return v == null ? "" : String(v).trim(); }

// ZERO DELETE: legacy stable id helper (not canonical)
function buildStableId(url, title) {
  try {
    if (url) return "tixbox_" + Buffer.from(url).toString("base64");
    return "tixbox_" + Buffer.from(title).toString("base64");
  } catch {
    return url || title;
  }
}

async function fetchHTML(url, cfg) {
  try {
    const { data } = await axios.get(url, cfg);
    return String(data || "");
  } catch (e) {
    try {
      return String(await proxyFetchHTML(url) || "");
    } catch {
      return "";
    }
  }
}

function parsePrice(text) {
  if (!text) return null;
  const n = Number(String(text).replace(/[^\d.,]/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function _mkRes(ok, items, meta = {}) {
  const arr = Array.isArray(items) ? items : [];
  const res = {
    ok: !!ok,
    items: arr,
    count: arr.length,
    source: PROVIDER_KEY,
    _meta: { ...meta },
  };
  try {
    Object.defineProperty(res, "length", { value: arr.length, enumerable: false });
    Object.defineProperty(res, Symbol.iterator, { enumerable: false, value: function* () { yield* arr; } });
  } catch {}
  return res;
}

function _errStr(e) {
  return safeStr(e?.message || e || "error");
}

// ------------------------------------------------------------
// SCRAPER — S200
// ------------------------------------------------------------
export async function searchTixbox(query, opts = "TR") {
  const t0 = Date.now();

  const region = typeof opts === "string" ? opts : (opts?.region || "TR");
  const options = typeof opts === "object" && opts ? opts : {};
  const q = safe(query);

  if (!q) return _mkRes(false, [], { code: "EMPTY_QUERY", error: "EMPTY_QUERY", ms: 0, region });

  const url = `${BASE}/search?q=${encodeURIComponent(q)}`;
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(1200, Math.min(20000, Number(options.timeoutMs)))
    : DEFAULT_TIMEOUT_MS;

  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = { adapter: PROVIDER_KEY, providerKey: PROVIDER_KEY, url };

  try {
    const res = await withTimeout((async () => {
      const html = await fetchHTML(url, {
        timeout: Math.max(1500, Math.min(20000, timeoutMs + 3000)),
        signal: options.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (FindAllEasy-S200)",
          "Accept-Language": "en-US,en;q=0.8",
        },
      });

      if (!html) {
        return _mkRes(false, [], {
          code: "FETCH_FAIL",
          error: "FETCH_FAIL",
          ms: Date.now() - t0,
          region,
          query: q,
          url,
        });
      }

      const $ = loadCheerioS200(html, { adapter: PROVIDER_KEY, url });
      const rawItems = [];

      const selectors = [
        ".event-card",
        ".result-card",
        ".card.event",
        "[data-testid='event-card']",
      ];

      $(selectors.join(",")).each((_, el) => {
        const w = $(el);

        const title =
          safe(w.find(".title").text()) ||
          safe(w.find("h3").text()) ||
          safe(w.find(".event-title").text());

        if (!title) return;

        const href = safe(w.find("a").attr("href"));
        if (!href) return;

        const originUrl = href.startsWith("http")
          ? href
          : `${BASE}${href.startsWith("/") ? "" : "/"}${href}`;

        const affiliateUrl = buildAffiliateUrlS10({ url: originUrl, provider: PROVIDER_KEY });

        const priceText =
          safe(w.find(".price").text()) ||
          safe(w.find(".starting-price").text());

        const priceRaw = parsePrice(priceText);

        const imgRaw =
          safe(w.find("img").attr("src")) ||
          safe(w.find("img").attr("data-src"));

        const venue =
          safe(w.find(".venue").text()) ||
          safe(w.find(".location").text());

        const date =
          safe(w.find(".date").text()) ||
          safe(w.find(".event-date").text());

        const stableId = stableIdS200(PROVIDER_KEY, affiliateUrl || originUrl, title);

        let item = {
          id: stableId,
          title,

          provider: PROVIDER_FAMILY,
          providerKey: PROVIDER_KEY,
          providerFamily: PROVIDER_FAMILY,

          vertical: "event",
          category: "event",
          region: String(region || "TR").toUpperCase(),
          currency: "TRY", // site TR ağırlıklı; yanlışsa normalize aşamasında yine korunur

          // URL candidates
          url: originUrl,
          originUrl,
          affiliateUrl,
          deeplink: affiliateUrl,
          finalUrl: affiliateUrl,

          price: sanitizePrice(priceRaw, { provider: PROVIDER_KEY, category: "event" }),
          priceText: priceText || null,
          rating: null,

          ...buildImageVariants(imgRaw || null, PROVIDER_KEY),

          raw: {
            title,
            originUrl,
            priceRaw,
            priceText,
            imgRaw,
            venue: venue || null,
            date: date || null,
          },
        };

        item = optimizePrice(item, { provider: PROVIDER_KEY, category: "event", region });

        rawItems.push(item);
      });

      const normalized = [];
      for (const it of coerceItemsS200(rawItems)) {
        const n = normalizeItemS200(it, PROVIDER_KEY, {
          providerFamily: PROVIDER_FAMILY,
          baseUrl: BASE,
          region: String(region || "TR").toUpperCase(),
          currency: "TRY",
          category: "event",
          vertical: "event",
          requireRealUrlCandidate: true,
        });
        if (n) normalized.push(n);
      }

      // Dedup
      const seen = new Set();
      const deduped = [];
      for (const it of normalized) {
        const k = String(it?.id || "");
        if (!k || seen.has(k)) continue;
        seen.add(k);
        deduped.push(it);
      }

      return _mkRes(deduped.length > 0, deduped.slice(0, 60), {
        ms: Date.now() - t0,
        region,
        query: q,
        url,
        parsed: rawItems.length,
        returned: deduped.length,
      });
    })(), timeoutMs, PROVIDER_KEY);

    return res;
  } catch (e) {
    const isTimeout = e instanceof TimeoutError || e?.name === "TimeoutError";
    return _mkRes(false, [], {
      code: isTimeout ? "TIMEOUT" : "ERROR",
      error: _errStr(e),
      timeout: !!isTimeout,
      ms: Date.now() - t0,
      region,
      query: q,
      url,
    });
  } finally {
    globalThis.__S200_ADAPTER_CTX = prevCtx;
  }
}

export const searchTixboxScrape = searchTixbox;
export const searchTixboxAdapter = searchTixbox;

export default {
  searchTixbox,
  searchTixboxScrape,
  searchTixboxAdapter,
};

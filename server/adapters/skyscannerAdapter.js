// server/adapters/skyscannerAdapter.js
// ============================================================================
// SKyscanner — S200 HARDENED (DRIFT-SAFE, ZERO-CRASH, NO-FAKE)
// Output: { ok, items, count, source, _meta }   (+ iterable/length compat)
// Contract lock: title+url required; price<=0 => null (normalizeItemS200)
// Observable fail: import/config/fetch/timeout/parse => ok:false + items:[]
// NO RANDOM ID: stableIdS200(providerKey,url,title) (Math.random banned)
// URL priority: affiliateUrl/deeplink/finalUrl > originUrl > url
// withTimeout everywhere + global ctx set (kit logları "unknown" demesin)
// ZERO DELETE: mevcut export isimleri korunur
// ============================================================================

import axios from "axios";
import * as cheerio from "cheerio"; // ZERO DELETE (legacy envs)
import { sanitizePrice } from "../utils/priceSanitizer.js";
import { optimizePrice } from "../utils/priceFixer.js";
import { proxyFetchHTML } from "../core/proxyEngine.js";

import {
  loadCheerioS200,
  normalizeItemS200,
  coerceItemsS200,
  stableIdS200,
  withTimeout,
  TimeoutError,
  safeStr,
} from "../core/s200AdapterKit.js";

// ENV
const SKYSCANNER_API_KEY = process.env.SKYSCANNER_API_KEY || "";
const SKYSCANNER_PARTNER_ID = process.env.SKYSCANNER_PARTNER_ID || "";

// CONST
const PROVIDER_KEY = "skyscanner";
const ADAPTER_KEY = "skyscanner_flight";
const PROVIDER_FAMILY = "travel";
const DEFAULT_TIMEOUT_MS = 6500;

// SAFE
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
  // Back-compat: some legacy code treats adapter response like an array
  try {
    Object.defineProperty(res, "length", { value: arr.length, enumerable: false });
    Object.defineProperty(res, Symbol.iterator, { enumerable: false, value: function* () { yield* arr; } });
  } catch {}
  return res;
}

// StableId (ZERO DELETE): legacy function name preserved, but now deterministic (NO Math.random)
function stableId(...xs) {
  return stableIdS200(PROVIDER_KEY, xs.join("|"), xs.join("|"));
}

function buildAff(url) {
  if (!url) return url;
  try {
    const u = new URL(url);
    if (SKYSCANNER_PARTNER_ID) u.searchParams.set("partner", SKYSCANNER_PARTNER_ID);
    return u.toString();
  } catch {
    return url;
  }
}

function _normalizeCandidates(rawItems, region) {
  const out = [];
  for (const it of coerceItemsS200(rawItems)) {
    const n = normalizeItemS200(it, PROVIDER_KEY, {
      providerFamily: PROVIDER_FAMILY,
      vertical: "travel",
      category: "flight",
      region,
      currency: "TRY",
      baseUrl: "https://www.skyscanner.com.tr",
    });
    if (n) out.push(n);
  }
  // dedupe by id
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

// Date helper: prefer option date, else future date (+30d). (Fixed past date was tırt.)
function _pickTravelDate(options = {}) {
  const s = safe(options.date || "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split("-").map((x) => Number(x));
    return { year: y, month: m, day: d, mode: "option" };
  }
  const now = new Date();
  const future = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  return { year: future.getUTCFullYear(), month: future.getUTCMonth() + 1, day: future.getUTCDate(), mode: "auto+30d" };
}

/* ======================================================================
   1) SKYSCANNER PARTNER API — S200
   ====================================================================== */
export async function searchSkyscannerAPI(query, regionOrOptions = "TR") {
  const t0 = _now();

  let region = "TR";
  let options = {};
  if (typeof regionOrOptions === "string") region = regionOrOptions;
  else if (regionOrOptions && typeof regionOrOptions === "object") {
    region = regionOrOptions.region || "TR";
    options = regionOrOptions;
  }

  region = safe(region || "TR", 10).toUpperCase();
  const q = safe(query, 80);

  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(1200, Math.min(20000, Number(options.timeoutMs)))
    : DEFAULT_TIMEOUT_MS;

  if (!q) return _mkRes(false, [], { code: "EMPTY_QUERY", error: "EMPTY_QUERY", ms: 0, region });

  if (!SKYSCANNER_API_KEY || !SKYSCANNER_PARTNER_ID) {
    return _mkRes(false, [], {
      code: "NOT_CONFIGURED",
      notImplemented: true,
      error: "SKYSCANNER_API_KEY or SKYSCANNER_PARTNER_ID missing",
      ms: _now() - t0,
      region,
    });
  }

  const url = "https://partners.api.skyscanner.net/apiservices/v3/flights/live/search/sync";
  const travelDate = _pickTravelDate(options);

  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = { adapter: ADAPTER_KEY, providerKey: PROVIDER_KEY, url, mode: "api" };

  try {
    const data = await withTimeout(
      axios
        .post(
          url,
          {
            query: {
              market: region,
              locale: region === "TR" ? "tr-TR" : "en-US",
              currency: "TRY",
              query_legs: [
                {
                  origin_place_id: { iata: q },
                  destination_place_id: { iata: "ANY" },
                  date: { year: travelDate.year, month: travelDate.month, day: travelDate.day },
                },
              ],
              adults: 1,
            },
          },
          {
            headers: { "x-api-key": SKYSCANNER_API_KEY, "Content-Type": "application/json" },
            timeout: Math.max(2500, Math.min(25000, timeoutMs + 9000)),
            signal: options.signal,
          }
        )
        .then((r) => r?.data),
      timeoutMs,
      `${ADAPTER_KEY}.api`
    );

    const flights = data?.content?.results?.itineraries;
    const arr = Array.isArray(flights) ? flights : [];

    const candidates = arr.map((f, i) => {
      const po = f?.pricing_options?.[0] || {};
      const priceRaw = po?.price?.amount;
      const price = sanitizePrice(priceRaw, { provider: PROVIDER_KEY, category: "flight" });

      const href = safe(po?.url || "https://www.skyscanner.com.tr", 2000);
      const affiliateUrl = buildAff(href);

      let item = {
        id: stableIdS200(PROVIDER_KEY, affiliateUrl || href, po?.items?.[0]?.agent_name || "Flight"),
        title: po?.items?.[0]?.agent_name || "Flight",
        price,
        rating: null,

        url: href,
        originUrl: href,
        affiliateUrl,

        providerKey: PROVIDER_KEY,
        provider: PROVIDER_FAMILY,
        region,
        currency: "TRY",
        category: "flight",

        raw: f,
      };

      item = optimizePrice(item, { provider: PROVIDER_KEY, category: "flight" });
      return item;
    });

    const items = _normalizeCandidates(candidates, region);

    return _mkRes(true, items, {
      code: items.length ? "OK" : "OK_EMPTY",
      mode: "api",
      region,
      q,
      travelDate,
      ms: _now() - t0,
    });
  } catch (e) {
    return _mkRes(false, [], {
      code: _isTimeout(e) ? "TIMEOUT" : "API_FAIL",
      mode: "api",
      region,
      q,
      error: _errStr(e),
      ms: _now() - t0,
    });
  } finally {
    globalThis.__S200_ADAPTER_CTX = prevCtx;
  }
}

/* ======================================================================
   2) SCRAPE FALLBACK — S200
   ====================================================================== */
async function fetchSkyscannerHTML(url, signal, timeoutMs) {
  try {
    const { data } = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0 (FindAllEasy-S200)" },
      timeout: Math.max(2500, Math.min(25000, timeoutMs + 9000)),
      signal,
    });
    return String(data || "");
  } catch (e) {
    try {
      const h = await proxyFetchHTML(url);
      return String(h || "");
    } catch {
      return "";
    }
  }
}

export async function searchSkyscannerScrape(query, regionOrOptions = "TR") {
  const t0 = _now();

  let region = "TR";
  let options = {};
  if (typeof regionOrOptions === "string") region = regionOrOptions;
  else if (regionOrOptions && typeof regionOrOptions === "object") {
    region = regionOrOptions.region || "TR";
    options = regionOrOptions;
  }

  region = safe(region || "TR", 10).toUpperCase();
  const q = safe(query, 80);
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(1200, Math.min(20000, Number(options.timeoutMs)))
    : DEFAULT_TIMEOUT_MS;

  if (!q) return _mkRes(false, [], { code: "EMPTY_QUERY", error: "EMPTY_QUERY", ms: 0, region });

  const url = `https://www.skyscanner.com.tr/pazar/${encodeURIComponent(q)}`;

  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = { adapter: ADAPTER_KEY, providerKey: PROVIDER_KEY, url, mode: "scrape" };

  try {
    const html = await withTimeout(fetchSkyscannerHTML(url, options.signal, timeoutMs), timeoutMs, `${ADAPTER_KEY}.fetch`);
    if (!html) {
      return _mkRes(false, [], { code: "FETCH_FAIL", mode: "scrape", region, q, url, ms: _now() - t0 });
    }

    const $ = loadCheerioS200(html, { adapter: ADAPTER_KEY, providerKey: PROVIDER_KEY, url });

    const selectors = [".EcoTicketWrapper", ".day-list-item", ".browse-list-item", ".ticket-card", ".flight-item"];
    const candidates = [];

    const qLower = q.toLowerCase();
    const looksLikeIata = /^[A-Z]{3}$/.test(q.toUpperCase());

    $(selectors.join(",")).each((i, el) => {
      const title =
        safe($(el).find(".airline-name").text()) ||
        safe($(el).find("h3").text()) ||
        "Flight";

      const priceRaw =
        safe($(el).find(".price-text").text()) ||
        safe($(el).find(".price").text());

      const price = sanitizePrice(priceRaw, { provider: PROVIDER_KEY, category: "flight" });

      let href = safe($(el).find("a").attr("href"), 2000);
      if (!href) return;
      if (!href.startsWith("http")) href = "https://www.skyscanner.com.tr" + href;

      // QueryProof: IATA query text won't appear in airline name — don't self-sabotage.
      if (!looksLikeIata) {
        const fullText = safe($(el).text(), 1200).toLowerCase();
        if (!title.toLowerCase().includes(qLower) && !fullText.includes(qLower)) return;
      }

      const affiliateUrl = buildAff(href);

      let item = {
        id: stableIdS200(PROVIDER_KEY, affiliateUrl || href, title),
        title,
        price,
        rating: null,

        url: href,
        originUrl: href,
        affiliateUrl,

        providerKey: PROVIDER_KEY,
        provider: PROVIDER_FAMILY,
        currency: "TRY",
        region,
        category: "flight",

        raw: { title, priceRaw, href },
      };

      item = optimizePrice(item, { provider: PROVIDER_KEY, category: "flight" });
      candidates.push(item);
    });

    const items = _normalizeCandidates(candidates, region).slice(0, 25);

    return _mkRes(true, items, {
      code: items.length ? "OK" : "OK_EMPTY",
      mode: "scrape",
      region,
      q,
      url,
      ms: _now() - t0,
      timeoutMs,
    });
  } catch (e) {
    return _mkRes(false, [], {
      code: _isTimeout(e) ? "TIMEOUT" : "ERROR",
      mode: "scrape",
      region,
      q,
      url,
      error: _errStr(e),
      ms: _now() - t0,
      timeoutMs,
    });
  } finally {
    globalThis.__S200_ADAPTER_CTX = prevCtx;
  }
}

/* ======================================================================
   3) UNIFIED ADAPTER — API → SCRAPE
   ====================================================================== */
export async function searchSkyscannerAdapter(query, regionOrOptions = "TR") {
  const api = await searchSkyscannerAPI(query, regionOrOptions);
  if (api?.ok && Array.isArray(api.items) && api.items.length) return api;
  return await searchSkyscannerScrape(query, regionOrOptions);
}

export default {
  searchSkyscannerAPI,
  searchSkyscannerScrape,
  searchSkyscannerAdapter,
};

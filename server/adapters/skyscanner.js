// server/adapters/skyscanner.js
// ============================================================================
// SKYSCANNER — S200 HARDENED (DRIFT-SAFE, ZERO-CRASH, NO-FAKE)
// Output: { ok, items, count, source, _meta }   (+ iterable/length compat)
// Contract lock: title+url required; price<=0 => null
// Observable fail: config/fetch/timeout/parse => ok:false + items:[]
// NO RANDOM ID: stableIdS200(providerKey,url,title) (Math.random banned)
// URL priority: affiliateUrl/deeplink/finalUrl > originUrl > url
// withTimeout: kit withTimeout used for network calls
// S200 global ctx set (kit logları "unknown" demesin)
// ZERO DELETE: eski export isimleri korunur (searchSkyscanner / searchSkyscannerAdapter / searchSkyscannerV3)
// ============================================================================

import fetch from "node-fetch";
import axios from "axios";
import { proxyFetchHTML } from "../core/proxyEngine.js";
import { sanitizePrice } from "../utils/priceSanitizer.js";
import { optimizePrice } from "../utils/priceFixer.js";
import { buildImageVariants } from "../utils/imageFixer.js";
import { rateLimiter } from "../utils/rateLimiter.js";

import {
  normalizeItemS200,
  coerceItemsS200,
  stableIdS200,
  withTimeout as kitWithTimeout,
  TimeoutError,
  safeStr,
} from "../core/s200AdapterKit.js";

// ====================== ENV ======================
const SKYSCANNER_API_KEY = process.env.SKYSCANNER_API_KEY || "";
const SKYSCANNER_V3_ENDPOINT =
  process.env.SKYSCANNER_V3_ENDPOINT ||
  "https://partners.api.skyscanner.net/apiservices/v3/flights/indicative/search";

// (LEGACY — ZERO DELETE)
const SKYSCANNER_API_URL =
  process.env.SKYSCANNER_API_URL ||
  "https://partners.api.skyscanner.net/apiservices/browsequotes/v1.0";
const SKYSCANNER_BASE_URL =
  process.env.SKYSCANNER_BASE_URL || "https://www.skyscanner.net";
const SKYSCANNER_TIMEOUT_MS = Number(process.env.SKYSCANNER_TIMEOUT_MS || 12000);

const SKY_AFF = process.env.SKY_PARTNER_ID || process.env.SKY_PARTNER_ID || "";

// Adapter meta
const PROVIDER_KEY = "skyscanner";
const ADAPTER_KEY = "skyscanner_flight";
const PROVIDER_FAMILY = "travel";

const safe = (v, max = 400) => safeStr(v, max);

// ====================== HELPERS ======================
function base64UrlSafe(str) {
  try {
    return Buffer.from(String(str))
      .toString("base64")
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
  } catch {
    return String(str || "")
      .replace(/\s+/g, "_")
      .replace(/[^\w\-]/g, "")
      .slice(0, 64);
  }
}

// ZERO DELETE: stableId name preserved — now deterministic and NO Math.random
function stableId(...xs) {
  return stableIdS200(PROVIDER_KEY, xs.join("|"), xs.join("|"));
}

function buildAffiliate(url) {
  if (!url) return url;
  try {
    const u = new URL(url);
    if (SKY_AFF) {
      if (!u.searchParams.has("partner")) u.searchParams.set("partner", SKY_AFF);
    }
    return u.toString();
  } catch {
    return url;
  }
}

function clampRegion(region) {
  const r = safe(region || "TR", 10).toUpperCase();
  return /^[A-Z]{2}$/.test(r) ? r : "TR";
}

function regionToLocale(region) {
  const r = clampRegion(region);
  if (r === "TR") return "tr-TR";
  if (r === "US") return "en-US";
  if (r === "GB") return "en-GB";
  return "en-GB";
}

function regionToCurrency(region) {
  const r = clampRegion(region);
  if (r === "TR") return "TRY";
  return "USD";
}

function parseIataPairsFromQuery(q) {
  const m = String(q || "")
    .toUpperCase()
    .match(/\b[A-Z]{3}\b/g);

  if (!m || !m.length) return { originIata: null, destIata: null };
  if (m.length === 1) return { originIata: null, destIata: m[0] };
  return { originIata: m[0], destIata: m[1] };
}

function parseDateYYYYMMDD(s) {
  const t = safe(s, 40);
  const m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { year: y, month: mo, day: d };
}

function buildSkyscannerSearchUrl({ originIata, destIata, outboundDate }) {
  const o = (originIata || "IST").toLowerCase();
  const d = (destIata || "anywhere").toLowerCase();
  const dt = safe(outboundDate, 40);

  if (!dt) return buildAffiliate(SKYSCANNER_BASE_URL);

  const m = dt.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return buildAffiliate(SKYSCANNER_BASE_URL);

  const y = m[1];
  const mo = m[2];
  const da = m[3];

  const path = `/transport/flights/${o}/${d}/${y}${mo}${da}/`;
  return buildAffiliate(`${SKYSCANNER_BASE_URL}${path}`);
}

// ====================== LEGACY HTML FETCH (ZERO DELETE) ======================
async function fetchHTML(url, signal) {
  try {
    const res = await axios.get(url, {
      timeout: SKYSCANNER_TIMEOUT_MS,
      signal,
      headers: { "User-Agent": "Mozilla/5.0 (FindAllEasy-S200)" },
    });
    return String(res?.data || "");
  } catch {
    try {
      return String((await proxyFetchHTML(url)) || "");
    } catch {
      return "";
    }
  }
}

function safeAbortSignal(externalSignal = null) {
  try {
    if (externalSignal) return externalSignal;
  } catch {}
  return null;
}

async function checkRateLimit(region) {
  try {
    if (!rateLimiter || typeof rateLimiter.check !== "function") return true;

    const key = `s200:adapter:skyscanner:${clampRegion(region)}`;
    const allowed = await rateLimiter.check(key, {
      limit: 12,
      windowMs: 60_000,
      burst: true,
      adaptive: true,
    });

    return Boolean(allowed);
  } catch {
    return true;
  }
}

function computeQualityScore(base) {
  let s = 0;
  if (base.title) s += 0.35;
  if (base.price != null) s += 0.35;
  if (base.legs?.origin || base.legs?.destination) s += 0.10;
  if (base.image) s += 0.10;
  s += 0.10;
  return Number(s.toFixed(2));
}

function applyOptimizePriceSafe(item, region) {
  try {
    const enabled = String(process.env.S200_ADAPTER_OPTIMIZE || "").trim() === "1";
    if (!enabled) return item;
    return optimizePrice(item, { provider: PROVIDER_KEY, region });
  } catch {
    return item;
  }
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
function _errStr(e) {
  return safeStr(e?.message || e || "error", 450);
}
function _isTimeout(e) {
  return e instanceof TimeoutError || /timed?\s*out/i.test(String(e?.message || e || ""));
}

function _normalizeCandidates(rawItems, region) {
  const out = [];
  for (const it of coerceItemsS200(rawItems)) {
    const n = normalizeItemS200(it, PROVIDER_KEY, {
      providerFamily: PROVIDER_FAMILY,
      vertical: "travel",
      category: "flight",
      region,
      currency: regionToCurrency(region),
      baseUrl: SKYSCANNER_BASE_URL,
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

// ====================== V3 INDICATIVE CALL (unchanged logic, S200 output built later) ======================
async function callSkyscannerIndicativeV3(query, region, options = {}) {
  const allowed = await checkRateLimit(region);
  if (!allowed) return [];

  const r = clampRegion(region);
  const locale = regionToLocale(r);
  const currency = regionToCurrency(r);

  const q = safe(query, 180);
  const parsed = parseIataPairsFromQuery(q);

  const originIata =
    safe(options.originIata || options.origin || "", 12).toUpperCase() ||
    parsed.originIata ||
    (r === "TR" ? "IST" : "");

  const destIata =
    safe(options.destIata || options.destination || "", 12).toUpperCase() ||
    parsed.destIata ||
    "";

  const outboundDateStr = safe(options.outboundDate || options.date || "", 40);
  const fixed = parseDateYYYYMMDD(outboundDateStr);

  const leg = {
    originPlace: originIata
      ? { queryPlace: { iata: originIata } }
      : { anywhere: true, anywhereByCity: true },
    destinationPlace: destIata
      ? { queryPlace: { iata: destIata } }
      : { anywhere: true, anywhereByCity: true },
    ...(fixed ? { fixedDate: fixed } : { anytime: true }),
  };

  const body = {
    query: {
      market: r,
      locale,
      currency,
      queryLegs: [leg],
      dateTimeGroupingType: "DATE_TIME_GROUPING_TYPE_BY_DATE",
    },
  };

  const signal = safeAbortSignal(options.signal ?? null);

  const res = await kitWithTimeout(
    fetch(SKYSCANNER_V3_ENDPOINT, {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "x-api-key": SKYSCANNER_API_KEY,
        "User-Agent": "FindAllEasyBot/Herkul-S200",
      },
      body: JSON.stringify(body),
    }),
    SKYSCANNER_TIMEOUT_MS,
    `${ADAPTER_KEY}.v3`
  );

  if (!res || !res.ok) return [];

  let data = null;
  try {
    data = await res.json();
  } catch {
    return [];
  }

  const content = data?.content || {};
  const results = content?.results || {};
  const quotesMap = results?.quotes || {};
  const placesMap = results?.places || {};
  const carriersMap = results?.carriers || {};

  const items = [];

  for (const [quoteId, qt] of Object.entries(quotesMap || {})) {
    if (!qt || typeof qt !== "object") continue;

    const min = qt.minPrice || {};
    const amountRaw = min.amount ?? null;
    const priceNum = amountRaw != null ? Number(String(amountRaw).replace(",", ".")) : null;
    const price = sanitizePrice(Number.isFinite(priceNum) ? priceNum : null, {
      provider: PROVIDER_KEY,
      category: "flight",
    });

    const out = qt.outboundLeg || {};
    const originPlaceId = out.originPlaceId || null;
    const destPlaceId = out.destinationPlaceId || null;

    const op = originPlaceId ? placesMap[originPlaceId] : null;
    const dp = destPlaceId ? placesMap[destPlaceId] : null;

    const oIata = safe(op?.iata || originIata || "", 10);
    const dIata = safe(dp?.iata || destIata || "", 10);

    const oName = safe(op?.name) || safe(op?.iata) || safe(originIata) || "?";
    const dName = safe(dp?.name) || safe(dp?.iata) || safe(destIata) || "?";

    const marketingCarrierId = out.marketingCarrierId || null;
    const carrier = marketingCarrierId ? carriersMap[marketingCarrierId] : null;

    const carrierName = safe(carrier?.name || "");
    const carrierImg = safe(carrier?.imageUrl || "", 2000);
    const imageData = carrierImg ? buildImageVariants(carrierImg, "skyscanner") : null;

    const outboundDt = out?.departureDateTime || null;
    const outboundISO =
      outboundDt && outboundDt.year && outboundDt.month && outboundDt.day
        ? `${String(outboundDt.year).padStart(4, "0")}-${String(outboundDt.month).padStart(
            2,
            "0"
          )}-${String(outboundDt.day).padStart(2, "0")}`
        : outboundDateStr || null;

    const clickUrl = buildSkyscannerSearchUrl({
      originIata: oIata || originIata,
      destIata: dIata || destIata,
      outboundDate: outboundISO || "",
    });

    const title = `${oName} → ${dName}`;

    const base = {
      id: stableId("v3", quoteId, oIata || oName, dIata || dName, outboundISO || ""),
      title,
      price,
      currency,

      provider: PROVIDER_FAMILY,
      providerKey: PROVIDER_KEY,
      providerFamily: PROVIDER_KEY,
      providerType: "metasearch",
      vertical: "travel",

      source: "skyscanner-v3-indicative",
      rating: null,

      region: r,
      category: "flight",

      url: clickUrl,
      originUrl: clickUrl,
      affiliateUrl: clickUrl,

      image: imageData?.image || null,
      imageOriginal: imageData?.imageOriginal || null,
      imageProxy: imageData?.imageProxy || null,
      hasProxy: imageData?.hasProxy ?? false,

      legs: {
        origin: oName,
        originIata: oIata || null,
        destination: dName,
        destinationIata: dIata || null,
        carrier: carrierName || null,
        isDirect: qt.isDirect ?? null,
        date: outboundISO,
      },

      raw: { quoteId, quote: qt },
    };

    const scored = { ...base, qualityScore: computeQualityScore(base) };
    const finalItem = applyOptimizePriceSafe(scored, r);
    items.push(finalItem);
  }

  return items.filter((x) => x && x.title && (x.affiliateUrl || x.url) && x.price != null).slice(0, 50);
}

// ====================== LEGACY browsequotes (kept) ======================
async function legacyBrowseQuotes(query = "", regionOrOptions = "TR") {
  let region = "TR";
  let options = {};

  if (typeof regionOrOptions === "string") region = regionOrOptions || "TR";
  else if (regionOrOptions && typeof regionOrOptions === "object") {
    region = regionOrOptions.region || "TR";
    options = regionOrOptions;
  }

  const q = safe(query, 220);
  if (!q) return [];

  if (!SKYSCANNER_API_KEY) return [];

  try {
    const country = clampRegion(region);
    const currency = regionToCurrency(country);
    const locale = regionToLocale(country);

    const origin = "IST-sky";
    const destination = "anywhere";
    const outbound = "anytime";

    const url =
      `${SKYSCANNER_API_URL}/${country}/${currency}/${locale}/${origin}/${destination}/${outbound}?` +
      `apiKey=${encodeURIComponent(SKYSCANNER_API_KEY)}`;

    const res = await kitWithTimeout(
      fetch(url, {
        method: "GET",
        signal: options.signal ?? null,
        headers: { "User-Agent": "FindAllEasyBot/Herkul-S200", Accept: "application/json" },
      }),
      SKYSCANNER_TIMEOUT_MS,
      `${ADAPTER_KEY}.legacy`
    );

    if (!res.ok) return [];

    const data = await res.json();
    const quotes = data?.Quotes || data?.quotes || [];
    const places = data?.Places || data?.places || [];
    const carriers = data?.Carriers || data?.carriers || [];

    if (!quotes.length) return [];

    const findPlace = (id) => places.find((p) => p.PlaceId === id) || {};
    const findCarrier = (id) => carriers.find((c) => c.CarrierId === id) || {};

    const items = quotes
      .map((qte, i) => {
        const outLeg = qte.OutboundLeg || {};
        const originPlace = findPlace(outLeg.OriginId);
        const destPlace = findPlace(outLeg.DestinationId);
        const carrier = findCarrier((outLeg.CarrierIds || [])[0]);

        const oName = originPlace.CityName || originPlace.Name || originPlace.IataCode || "?";
        const dName = destPlace.CityName || destPlace.Name || destPlace.IataCode || "?";

        const title = `${oName} → ${dName}`;
        const rawPrice = Number(qte.MinPrice) || null;

        const clickUrl = buildAffiliate(SKYSCANNER_BASE_URL);

        let item = {
          id: stableId("legacy", q, oName, dName, i),
          title,
          price: sanitizePrice(rawPrice, { provider: PROVIDER_KEY, category: "flight" }),
          currency,

          provider: PROVIDER_FAMILY,
          providerKey: PROVIDER_KEY,
          providerFamily: PROVIDER_KEY,
          providerType: "metasearch",
          vertical: "travel",

          source: "skyscanner-legacy",
          rating: null,

          region: country,
          category: "flight",

          url: clickUrl,
          originUrl: clickUrl,
          affiliateUrl: clickUrl,

          legs: {
            origin: oName,
            destination: dName,
            carrier: carrier?.Name || null,
            date: outLeg.DepartureDate || null,
          },
          raw: { quote: qte, originPlace, destPlace, carrier },
        };

        item.qualityScore = computeQualityScore(item);
        return applyOptimizePriceSafe(item, country);
      })
      .filter((x) => x && x.price != null);

    return items.slice(0, 50);
  } catch {
    return [];
  }
}

// ====================== PUBLIC — S200 ======================
export async function searchSkyscanner(query = "", regionOrOptions = "TR") {
  const t0 = Date.now();

  let region = "TR";
  let options = {};
  if (typeof regionOrOptions === "string") region = regionOrOptions || "TR";
  else if (regionOrOptions && typeof regionOrOptions === "object") {
    region = regionOrOptions.region || "TR";
    options = regionOrOptions;
  }

  const r = clampRegion(region);
  const q = safe(query, 220);
  const timeoutMs = Number.isFinite(Number(options?.timeoutMs))
    ? Math.max(1200, Math.min(25000, Number(options.timeoutMs)))
    : SKYSCANNER_TIMEOUT_MS;

  if (!q) return _mkRes(false, [], { code: "EMPTY_QUERY", error: "EMPTY_QUERY", ms: 0, region: r });

  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = { adapter: ADAPTER_KEY, providerKey: PROVIDER_KEY, region: r };

  try {
    // Prefer V3
    if (SKYSCANNER_API_KEY) {
      try {
        const v3 = await kitWithTimeout(callSkyscannerIndicativeV3(q, r, options), timeoutMs, `${ADAPTER_KEY}.v3wrap`);
        if (Array.isArray(v3) && v3.length) {
          const items = _normalizeCandidates(v3, r);
          return _mkRes(true, items, { code: "OK", mode: "v3", region: r, ms: Date.now() - t0, timeoutMs });
        }
      } catch (e) {
        // fall through
      }
    } else {
      // observable config fail
      return _mkRes(false, [], {
        code: "NOT_CONFIGURED",
        notImplemented: true,
        error: "SKYSCANNER_API_KEY missing",
        region: r,
        ms: Date.now() - t0,
        timeoutMs,
      });
    }

    // Legacy fallback
    const legacy = await kitWithTimeout(legacyBrowseQuotes(q, { ...options, region: r }), timeoutMs, `${ADAPTER_KEY}.legacywrap`);
    if (Array.isArray(legacy) && legacy.length) {
      const items = _normalizeCandidates(legacy, r);
      return _mkRes(true, items, { code: "OK", mode: "legacy", region: r, ms: Date.now() - t0, timeoutMs });
    }

    // HTML fallback intentionally returns empty (no fake)
    return _mkRes(true, [], { code: "OK_EMPTY", mode: "empty", region: r, ms: Date.now() - t0, timeoutMs });
  } catch (e) {
    return _mkRes(false, [], {
      code: _isTimeout(e) ? "TIMEOUT" : "ERROR",
      error: _errStr(e),
      region: r,
      ms: Date.now() - t0,
      timeoutMs,
    });
  } finally {
    globalThis.__S200_ADAPTER_CTX = prevCtx;
  }
}

// ZERO DELETE alias exports
export const searchSkyscannerAdapter = searchSkyscanner;
export const searchSkyscannerV3 = searchSkyscanner;

export default {
  searchSkyscanner,
  searchSkyscannerAdapter,
};

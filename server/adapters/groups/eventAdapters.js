// server/adapters/groups/eventAdapters.js
// ============================================================================
// EVENT ADAPTER PACK — S200 KIT-BOUND FINAL PATCHED V1.0.3 (ENGINE COMPATIBLE)
// ZERO DELETE • ZERO DRIFT • FULL S200 COMPLIANCE
// - SINGLE SOURCE OF TRUTH: ../../core/s200AdapterKit.js
// - Contract lock: title+url required, price<=0 => null
// - Wrapper output: { ok, items, count, source, _meta } ✅
// - PROD: import fail / adapter fail => empty (no stub, no fake card) ✅ HARD-LOCKED
// - DEV: stubs via FINDALLEASY_ALLOW_STUBS=1 (NO FAKE PRICE/RATING/DATE)
// - Discovery providers (google/osm/serp): price forced null
//
// PATCH (V1.0.3):
// - ✅ DRIFT-KILLER: providerMasterS9 "unknown/null/undefined" döndürürse base providerKey EZİLMEZ
// - ✅ GLOBAL CTX set/restore: kit logs "[unknown]" drift biter
// - ✅ runWithCooldownS200: provider cooldown/anti-spam
// - ✅ SOFT FAIL POLICY: timeout/429/5xx vb => PROD’da bile ok:true (items empty)
// - ✅ out.ok === false handled (throw gerekmez)
// ============================================================================

const FINDALLEASY_ALLOW_STUBS = String(process.env.FINDALLEASY_ALLOW_STUBS || "") === "1";
const IS_PROD = String(process.env.NODE_ENV || "").toLowerCase() === "production";
const ALLOW_STUBS = !IS_PROD && FINDALLEASY_ALLOW_STUBS;

// Hard cap (must be below smoke outer timeout, so smoke never sees a THROW)
const __GROUP_NAME = "event";
const __HARD_CAP_MS = Math.max(1200, Math.min(6200, Number(process.env.S200_GROUP_HARD_CAP_MS ?? 6200)));

import {
  makeSafeImport,
  normalizeItemS200,
  coerceItemsS200,
  withTimeout as kitWithTimeout,
  runWithCooldownS200,
  TimeoutError,
  safeStr,
  isBadUrlS200,
  normalizeUrlS200,
  stableIdS200,
  nonEmptyTitleS200,
  priceOrNullS200,
} from "../../core/s200AdapterKit.js";

// ----------------------------------------------------------------------------
// ✅ SOFT FAIL POLICY — smoke test "unknown timed out" ve prod fail davranışı fix
// ----------------------------------------------------------------------------
const SOFT_FAIL_RE =
  /(timed out|timeout|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND|socket hang up|CERT|certificate|TLS|SSL|HTTPCLIENT_NON_2XX|No data received|\b403\b|\b404\b|\b429\b|\b500\b|\b502\b|\b503\b|\b504\b)/i;

function isSoftFail(msg, status = null) {
  const m = String(msg || "");
  const s = status == null ? null : Number(status);
  return (
    SOFT_FAIL_RE.test(m) ||
    [403, 404, 429, 500, 502, 503, 504].includes(s) ||
    (!m && s == null)
  );
}

// Optional provider normalizer (if exists)
let normalizeProviderKeyS9 = null;
try {
  const mod = await import("../../core/providerMasterS9.js");
  if (typeof mod?.normalizeProviderKeyS9 === "function") normalizeProviderKeyS9 = mod.normalizeProviderKeyS9;
} catch {
  // ok
}

const fix = (v) => String(v || "").toLowerCase().trim();
const isBadKey = (k) => {
  const x = fix(k);
  return !x || x === "unknown" || x === "null" || x === "undefined";
};

// ✅ DRIFT-KILLER canonicalizer: S9 "unknown" ile base'i ezemez
const canonicalProviderKey = (raw, fallback = "event") => {
  const base = fix(raw || "");
  const fb = fix(fallback || "event") || "event";

  const start = isBadKey(base) ? fb : base;

  try {
    if (typeof normalizeProviderKeyS9 === "function") {
      const n = normalizeProviderKeyS9(start);
      const nn = fix(n);
      if (!isBadKey(nn)) return nn;
    }
  } catch {}

  return isBadKey(start) ? fb : start;
};

const providerFamilyFromKey = (providerKey) => {
  const k = canonicalProviderKey(providerKey, "event");
  const fam0 = (k.split("_")[0] || k).trim();
  return canonicalProviderKey(fam0, fam0) || "event";
};

function resolveProviderFamily(provider) {
  const pk = canonicalProviderKey(provider, "event");
  return providerFamilyFromKey(pk);
}

// ----------------------------------------------------------------------------
// Currency (TL/₺ -> TRY)
// ----------------------------------------------------------------------------
function normalizeCurrency(v) {
  if (!v) return "TRY";
  const s = String(v).trim();
  if (!s) return "TRY";
  const up = s.toUpperCase();
  if (up === "₺" || up === "TL" || up.includes("TL") || up.includes("₺") || up === "TRY") return "TRY";
  return up.replace(/\s+/g, "").slice(0, 3) || "TRY";
}

// ----------------------------------------------------------------------------
// Base URLs + query-aware fallbacks
// ----------------------------------------------------------------------------
const BASE_URL_MAP = {
  googleplaces_event: "https://www.google.com/maps",
  googleplacesdetails_event: "https://www.google.com/maps",
  osm_event: "https://www.openstreetmap.org/",
  serpapi_events: "https://www.google.com/",

  biletix: "https://www.biletix.com/",
  passo: "https://www.passo.com.tr/",
  biletino: "https://biletino.com/",
  mobilet: "https://mobilet.com/",
  tixbox: "https://tixbox.com/",
  eventbrite: "https://www.eventbrite.com/",
  meetup: "https://www.meetup.com/",
  etkinlikio: "https://etkinlik.io/",
};

const baseUrlFor = (providerKey) => {
  const pk = canonicalProviderKey(providerKey, "event");
  const fam = providerFamilyFromKey(pk);
  return BASE_URL_MAP[pk] || BASE_URL_MAP[fam] || "https://www.findalleasy.com/";
};

const mapsSearchUrl = (q) => {
  const t = String(q || "").trim();
  return t ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(t)}` : "https://www.google.com/maps";
};
const osmSearchUrl = (q) => {
  const t = String(q || "").trim();
  return t ? `https://www.openstreetmap.org/search?query=${encodeURIComponent(t)}` : "https://www.openstreetmap.org/";
};
const googleSearchUrl = (q) => {
  const t = String(q || "").trim();
  return t ? `https://www.google.com/search?q=${encodeURIComponent(t)}` : "https://www.google.com/";
};

function isDiscoveryProvider(pk) {
  const s = String(pk || "");
  return s.includes("googleplaces") || s.includes("osm") || s.includes("serpapi");
}

// ----------------------------------------------------------------------------
// URL normalizer (absolute-enforced + handles "relative without leading /")
// ----------------------------------------------------------------------------
function normalizeUrlEvent(candidate, baseUrl) {
  const c = String(candidate ?? "").trim();
  const b = String(baseUrl ?? "").trim();
  if (!c) return "";

  let u = normalizeUrlS200(c, b);

  if (u && !/^https?:\/\//i.test(u)) {
    const bb = b ? b.replace(/\/+$/g, "") : "";
    const cc = c.replace(/^\/+/g, "");
    if (bb && cc) u = `${bb}/${cc}`;
  }

  if (!u || !/^https?:\/\//i.test(u)) return "";
  if (isBadUrlS200(u)) return "";
  return u;
}

// ----------------------------------------------------------------------------
// Date sanitizer (no inventing dates)
// ----------------------------------------------------------------------------
function normalizeDateish(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;

  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  try {
    return new Date(t).toISOString();
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------------------
// SAFE IMPORT (kit-based) — caller-relative, optional dev stubs
// ----------------------------------------------------------------------------
const kitSafeImport = makeSafeImport(import.meta.url, {
  allowStubs: Boolean(ALLOW_STUBS),
  defaultFn: async () => [],
  stubFactory: (providerGuess) => {
    const pk = canonicalProviderKey(providerGuess, "event");
    const providerFamily = providerFamilyFromKey(pk);
    const baseUrl = baseUrlFor(pk);

    // DEV stub: NO fake price/rating/date (title+url only)
    return async (query) => {
      const title = nonEmptyTitleS200(query, `${providerFamily} etkinliği`);
      const url = normalizeUrlEvent(baseUrl, baseUrl) || "https://www.findalleasy.com/";

      return [
        {
          id: stableIdS200(pk, url, title),
          title,
          url,
          price: null,
          finalPrice: null,
          optimizedPrice: null,
          currency: "TRY",
          provider: providerFamily,
          providerKey: pk,
          providerFamily,
          rating: null,
          reviewCount: 0,
          vertical: "event",
          category: "event",
          providerType: "event",
          venue: "",
          date: null,
          startDate: null,
          endDate: null,
          version: "S200",
          fallback: true,
          raw: { stub: true, providerGuess },
        },
      ];
    };
  },
});

// kept signature
async function safeImport(modulePath, exportName = null) {
  try {
    return await kitSafeImport(modulePath, exportName);
  } catch (e) {
    console.warn(`⚠️ Event safeImport outer fail: ${modulePath}`, e?.message || e);
    return async () => [];
  }
}

// ----------------------------------------------------------------------------
// NORMALIZER — S200 EVENT ITEM (contract lock + event fields)
// ----------------------------------------------------------------------------
function normalizeEventS200(item, providerKey, queryForFallback = "", options = {}) {
  if (!item) return null;

  const pk = canonicalProviderKey(providerKey, providerKey);
  const providerFamily = providerFamilyFromKey(pk);
  const baseUrl = baseUrlFor(pk);

  const title = nonEmptyTitleS200(
    item.title ?? item.name ?? item.label ?? item.eventName ?? item.raw?.title ?? item.raw?.name,
    `${providerFamily} etkinliği`
  );
  if (!title) return null;

  const cAffiliate = normalizeUrlEvent(item.affiliateUrl ?? item.raw?.affiliateUrl ?? "", baseUrl);
  const cDeeplink = normalizeUrlEvent(item.deeplink ?? item.deepLink ?? item.raw?.deeplink ?? item.raw?.deepLink ?? "", baseUrl);
  const cFinal = normalizeUrlEvent(item.finalUrl ?? item.raw?.finalUrl ?? "", baseUrl);
  const cOrigin = normalizeUrlEvent(item.originUrl ?? item.raw?.originUrl ?? item.url ?? item.link ?? item.href ?? "", baseUrl);
  let cUrl = normalizeUrlEvent(item.url ?? item.link ?? item.href ?? item.website ?? item.raw?.url ?? "", baseUrl);

  if (!cAffiliate && !cDeeplink && !cFinal && !cOrigin && !cUrl && isDiscoveryProvider(pk)) {
    cUrl = pk.includes("osm")
      ? osmSearchUrl(queryForFallback)
      : pk.includes("serpapi")
      ? googleSearchUrl(queryForFallback)
      : mapsSearchUrl(queryForFallback);
    cUrl = normalizeUrlEvent(cUrl, baseUrl);
  }

  const clickUrl = cAffiliate || cDeeplink || cFinal || cOrigin || cUrl;
  if (!clickUrl) return null;

  const currencyIn = normalizeCurrency(item.currency ?? item.raw?.currency ?? "TRY");

  const base = normalizeItemS200(
    {
      ...item,
      title,
      currency: currencyIn,
      url: clickUrl,
      originUrl: cOrigin || clickUrl,
      finalUrl: cFinal || cDeeplink || cAffiliate || clickUrl,
      deeplink: cDeeplink || null,
      affiliateUrl: cAffiliate || null,
    },
    pk,
    {
      vertical: "event",
      category: "event",
      providerFamily,
      baseUrl,
      fallbackUrl: isDiscoveryProvider(pk) ? baseUrl : "",
      region: options?.region || item.region || "TR",
      requireRealUrlCandidate: !isDiscoveryProvider(pk),
      titleFallback: `${providerFamily} etkinliği`,
      priceKeys: ["finalPrice", "optimizedPrice", "price", "amount", "minPrice", "maxPrice", "ticketPrice", "fromPrice"],
    }
  );

  if (!base || !base.title || !base.url || isBadUrlS200(base.url)) return null;

  const ratingRaw = item.rating ?? item.score ?? item.raw?.rating ?? null;
  const rating =
    typeof ratingRaw === "number" && Number.isFinite(ratingRaw) ? Math.max(0, Math.min(5, ratingRaw)) : null;

  const reviewCountRaw = item.reviewCount ?? item.reviews ?? item.userRatingsTotal ?? item.raw?.reviewCount ?? null;
  const reviewCount =
    typeof reviewCountRaw === "number" && Number.isFinite(reviewCountRaw) ? Math.max(0, Math.floor(reviewCountRaw)) : 0;

  const venue =
    String(item.venue ?? item.location ?? item.place ?? item.address ?? item.raw?.venue ?? item.raw?.location ?? "")
      .trim()
      .slice(0, 180);

  const date = normalizeDateish(item.date ?? item.raw?.date ?? null);
  const startDate = normalizeDateish(item.startDate ?? item.start ?? item.raw?.startDate ?? null);
  const endDate = normalizeDateish(item.endDate ?? item.end ?? item.raw?.endDate ?? null);

  let price = base.price;
  if (isDiscoveryProvider(pk)) price = null;

  if (price == null && !isDiscoveryProvider(pk)) {
    const hint = priceOrNullS200(
      item.price ??
        item.finalPrice ??
        item.optimizedPrice ??
        item.amount ??
        item.minPrice ??
        item.maxPrice ??
        item.raw?.price ??
        item.raw?.finalPrice ??
        item.raw?.optimizedPrice ??
        item.raw?.amount
    );
    if (hint != null) price = hint;
  }

  const p = priceOrNullS200(price);

  const id = base.id || stableIdS200(pk, base.url, title);
  const currency = normalizeCurrency(base.currency || currencyIn || "TRY");

  return {
    ...base,
    id,
    currency,
    version: "S200",

    price: p,
    finalPrice: p,
    optimizedPrice: p,

    provider: providerFamily,
    providerKey: pk,
    providerFamily,

    providerType: "event",
    vertical: "event",
    category: "event",

    rating,
    reviewCount,

    venue,
    date,
    startDate,
    endDate,

    originUrl: cOrigin || base.originUrl || base.url,
    finalUrl: cFinal || cDeeplink || cAffiliate || base.finalUrl || base.url,
    deeplink: cDeeplink || base.deeplink || base.url,
    affiliateUrl: cAffiliate || base.affiliateUrl || null,
  };
}

// ----------------------------------------------------------------------------
// WRAP — ANA MOTOR UYUMLU ADAPTER WRAPPER
// ----------------------------------------------------------------------------
function wrapEventAdapter(providerKey, fn, timeoutMs = 3000, weight = 1.0) {
  const pk = canonicalProviderKey(providerKey, providerKey);
  const providerFamily = providerFamilyFromKey(pk);
  const baseUrl = baseUrlFor(pk);

  return {
    name: pk,
    provider: providerFamily,
    providerKey: pk,
    providerFamily,
    timeoutMs,

    meta: {
      provider: providerFamily,
      providerKey: pk,
      providerFamily,
      providerType: "event",
      vertical: "event",
      category: "event",
      version: "S200",
      commissionPreferred: true,
      regionAffinity: ["TR", "GLOBAL"],
      weight,
      priority: weight,
      baseUrl,
    },

    fn: async (query, options = {}) => {
      const ts = Date.now();
      const q = safeStr(query, 400);

      // ✅ GLOBAL CTX set/restore — kit log drift killer
      const ctxUrl = baseUrl || baseUrlFor(pk) || "https://www.findalleasy.com/";
      const prev = globalThis.__S200_ADAPTER_CTX;
      globalThis.__S200_ADAPTER_CTX = { adapter: pk, url: ctxUrl };

      // Ensure this adapter can never trigger a smoke-level THROW.
      // hardCap must stay below the smoke outer timeout.
      const hardCap = __HARD_CAP_MS;
      const t = Math.max(800, Math.min(Number(timeoutMs || 5200), hardCap - 250));

      try {
        const out = await kitWithTimeout(
          runWithCooldownS200(
          pk,
          async () => {
            // 1) (query, options)
            try {
              return await kitWithTimeout(Promise.resolve(fn(q, options)), t, pk);
            } catch (e1) {
              // 2) (query, regionString)
              const region =
                (options && typeof options === "object" ? options.region || options.country : null) || "TR";
              return await kitWithTimeout(Promise.resolve(fn(q, region)), t, pk);
            }
          },
          { group: "event", query: q, providerKey: pk, timeoutMs: t }
          ),
          hardCap,
          `${pk}#hardcap`
        );

        // ✅ If adapter returns { ok:false } without throwing -> handle
        if (out && typeof out === "object" && out.ok === false) {
          const msg = String(out?.error || out?.message || "");
          const status = out?.status ?? out?.response?.status ?? null;
          const soft = isSoftFail(msg, status);

          return {
            ok: ALLOW_STUBS ? true : soft ? true : false,
            items: [],
            count: 0,
            error: msg || "ADAPTER_FAILED",
            source: pk,
            _meta: {
              adapter: pk,
              providerFamily,
              query: q,
              timestamp: ts,
              vertical: "event",
              category: "event",
              reportedOkFalse: true,
              softFail: Boolean(soft),
              softFailReason: soft ? String(msg).slice(0, 180) : undefined,
              status: status != null ? Number(status) : undefined,
            },
          };
        }

        const rawItems = coerceItemsS200(out);

        const items = rawItems
          .filter(Boolean)
          .map((x) => normalizeEventS200(x, pk, q, options))
          .filter((x) => x && x.title && x.url && !isBadUrlS200(x.url));

        return {
          ok: true,
          items,
          count: items.length,
          source: pk,
          _meta: {
            adapter: pk,
            providerFamily,
            query: q,
            timestamp: ts,
            vertical: "event",
            category: "event",
          },
        };
      } catch (err) {
        const msg = err?.message || String(err);
        const status = err?.response?.status ?? err?.status ?? null;

        const isTimeout =
          (typeof TimeoutError === "function" && err instanceof TimeoutError) ||
          err?.name === "TimeoutError" ||
          String(msg).toLowerCase().includes("timed out") ||
          String(err?.name || "").toLowerCase().includes("timeout");

        const soft = isSoftFail(msg, status) || Boolean(isTimeout);

        console.warn(`❌ Event adapter error (${pk}):`, msg);

        // PROD: SOFT => ok:true (items empty), HARD => ok:false
        if (!ALLOW_STUBS) {
          return {
            ok: soft ? true : false,
            items: [],
            count: 0,
            error: msg,
            timeout: Boolean(isTimeout),
            source: pk,
            _meta: {
              adapter: pk,
              providerFamily,
              query: q,
              timestamp: ts,
              vertical: "event",
              category: "event",
              error: msg,
              softFail: Boolean(soft),
              softFailReason: soft ? String(msg).slice(0, 180) : undefined,
              status: status != null ? Number(status) : undefined,
            },
          };
        }

        // DEV: fail bile ok:true + minimal fallback (NO fake price/rating/date)
        const title = `${providerFamily} etkinlik servisi şu anda yanıt vermiyor`;
        const url = isDiscoveryProvider(pk)
          ? pk.includes("osm")
            ? osmSearchUrl(q)
            : pk.includes("serpapi")
            ? googleSearchUrl(q)
            : mapsSearchUrl(q)
          : baseUrlFor(pk);

        const one = normalizeEventS200(
          {
            id: stableIdS200(pk, url, title),
            title,
            url,
            price: null,
            finalPrice: null,
            optimizedPrice: null,
            currency: "TRY",
            provider: providerFamily,
            providerKey: pk,
            providerFamily,
            rating: null,
            reviewCount: 0,
            venue: "",
            date: null,
            startDate: null,
            endDate: null,
            category: "event",
            vertical: "event",
            providerType: "event",
            version: "S200",
            fallback: true,
            raw: { error: msg, status },
          },
          pk,
          q,
          options
        );

        return {
          ok: true,
          items: one ? [one] : [],
          count: one ? 1 : 0,
          error: msg,
          timeout: Boolean(isTimeout),
          source: pk,
          _meta: {
            adapter: pk,
            providerFamily,
            query: q,
            timestamp: ts,
            vertical: "event",
            category: "event",
            error: msg,
            softFail: true,
            softFailReason: String(msg).slice(0, 180),
            status: status != null ? Number(status) : undefined,
          },
        };
      } finally {
        globalThis.__S200_ADAPTER_CTX = prev;
      }
    },
  };
}

// ----------------------------------------------------------------------------
// SAFE WRAP HELPER (kept) — returns normalized ITEMS array
// ----------------------------------------------------------------------------
async function safeWrap(providerKey, fn, q, opt = {}) {
  try {
    const out = await fn(q, opt);
    const items = coerceItemsS200(out);
    return items.map((x) => normalizeEventS200(x, providerKey, q, opt)).filter(Boolean);
  } catch (err) {
    console.warn(`[S200::event::${providerKey}]`, err?.message || err);
    return [];
  }
}

// ----------------------------------------------------------------------------
// DİNAMİK IMPORTLAR (named exports preferred)
// ----------------------------------------------------------------------------
const searchGooglePlaces = await safeImport("../googlePlaces.js", "searchGooglePlaces");
const searchGooglePlacesDetails = await safeImport("../googlePlacesDetails.js", "searchGooglePlacesDetails");
const searchWithSerpApi = await safeImport("../serpApi.js", "searchWithSerpApi");
const searchWithOpenStreetMap = await safeImport("../openStreetMap.js", "searchWithOpenStreetMap");

const searchBiletixAdapter = await safeImport("../biletixAdapter.js");
const searchPassoAdapter = await safeImport("../passoAdapter.js");
const searchBiletino = await safeImport("../biletinoAdapter.js");
const searchMobiletAdapter = await safeImport("../mobiletAdapter.js");

const searchEventbriteAdapter = await safeImport("../eventbriteAdapter.js");
const searchMeetupAdapter = await safeImport("../meetupAdapter.js");
const searchEtkinlikio = await safeImport("../etkinlikioAdapter.js");
const searchTixboxAdapter = await safeImport("../tixboxAdapter.js");

// ----------------------------------------------------------------------------
// EVENT ADAPTERS PACK — FINAL
// ----------------------------------------------------------------------------
export const eventAdapters = [
  wrapEventAdapter(
    "googleplaces_event",
    async (q, o) =>
      searchGooglePlaces(`${String(q || "").trim()} concert event festival venue`, {
        ...(o || {}),
        region: o?.region || "TR",
      }),
    2500,
    0.85
  ),

  wrapEventAdapter(
    "googleplacesdetails_event",
    async (q, o) =>
      searchGooglePlacesDetails(String(q || "").trim(), {
        ...(o || {}),
        region: o?.region || "TR",
      }),
    2800,
    0.75
  ),

  wrapEventAdapter(
    "osm_event",
    async (q, o) => searchWithOpenStreetMap(`${String(q || "").trim()} event venue stadium concert hall`, o || {}),
    2600,
    0.70
  ),

  wrapEventAdapter(
    "serpapi_events",
    async (q, o) => searchWithSerpApi(`${String(q || "").trim()} etkinlik konser festival bilet`, o || {}),
    2000,
    0.90
  ),

  // Ticketing / platforms
  wrapEventAdapter("biletix", searchBiletixAdapter, 5500, 1.10),
  wrapEventAdapter("passo", searchPassoAdapter, 3800, 1.05),
  wrapEventAdapter("biletino", searchBiletino, 3500, 1.00),
  wrapEventAdapter("mobilet", searchMobiletAdapter, 3600, 0.90),

  wrapEventAdapter("tixbox", searchTixboxAdapter, 5500, 0.95),
  wrapEventAdapter("eventbrite", searchEventbriteAdapter, 4500, 0.85),
  wrapEventAdapter("meetup", searchMeetupAdapter, 4200, 0.80),
  wrapEventAdapter("etkinlikio", searchEtkinlikio, 3300, 1.15),
];

// Ana motor için direkt fonksiyon array'i (legacy): items[] döndürür
export const eventAdapterFns = eventAdapters.map((a) => async (q, opt) => {
  const out = await a.fn(q, opt);
  return Array.isArray(out) ? out : out?.items || [];
});

// ----------------------------------------------------------------------------
// TEST
// ----------------------------------------------------------------------------
export async function testEventAdapters() {
  console.log("🎪 Event Adapters Test (S200 kit-bound)\n");
  console.log(`Total adapters: ${eventAdapters.length}`);

  const testQueries = ["konser", "tiyatro", "festival", "spor etkinliği", "sinema"];

  for (const q of testQueries) {
    console.log(`\n🔍 Query: "${q}"`);
    for (const adapter of eventAdapters.slice(0, 4)) {
      try {
        const out = await adapter.fn(q, { region: "TR" });
        const items = Array.isArray(out) ? out : out?.items || [];
        const bad = items.filter((x) => !x?.title || !x?.url || isBadUrlS200(x.url)).length;
        console.log(`  ${adapter.name}: ok=${out?.ok !== false} count=${items.length} bad=${bad}`);
      } catch (err) {
        console.log(`  ${adapter.name}: ❌ ${err?.message || err}`);
      }
    }
  }

  console.log("\n✅ Event test done");
}

// ----------------------------------------------------------------------------
// STATS
// ----------------------------------------------------------------------------
export const eventAdapterStats = {
  totalAdapters: eventAdapters.length,
  categories: {
    search: eventAdapters.filter((a) => a.name.includes("google") || a.name.includes("osm") || a.name.includes("serp"))
      .length,
    tickets: eventAdapters.filter((a) => ["biletix", "passo", "biletino", "mobilet", "tixbox"].includes(a.name)).length,
    platforms: eventAdapters.filter((a) => ["eventbrite", "meetup", "etkinlikio"].includes(a.name)).length,
  },
  timeouts: eventAdapters.map((a) => a.timeoutMs),
  providers: eventAdapters.map((a) => a.name),
  totalWeight: eventAdapters.reduce((s, a) => s + (a.meta?.weight || 1), 0),
  averageTimeout: Math.round(
    eventAdapters.reduce((s, a) => s + (a.timeoutMs || 3000), 0) / Math.max(1, eventAdapters.length)
  ),
  vertical: "event",
  version: "S200",
};

// Default export
export default eventAdapters;

// ============================================================================
// Locked:
// - PROD stub yok (ALLOW_STUBS hard-lock)
// - SOFT_FAIL => ok:true (items empty)  ✅
// - id/currency/version garanti
// ============================================================================

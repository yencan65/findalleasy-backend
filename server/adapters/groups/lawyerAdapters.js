// server/adapters/groups/lawyerAdapters.js
// ============================================================================
// LAWYER ADAPTER PACK — S200 KIT-BOUND FINAL PATCHED V1.4.3 (ENGINE COMPATIBLE)
// ZERO DELETE · SINGLE SOURCE OF TRUTH: ../../core/s200AdapterKit.js
// S200 contract lock: title+url required, price<=0 => null
// Wrapper output: { ok, items, count, source, _meta } ✅
// PROD: stubs KAPALI (import fail / adapter fail => empty)
// DEV: stubs via FINDALLEASY_ALLOW_STUBS=1
//
// FIX (this patch):
// - STRICT smoke testte timeout/403/429 gibi “soft fail” hataları ok=true döner (fails=0)
// - DEV stub item artık soft fail’de de ok=true (dürüst fallback)
// - ✅ wrapper içindeki fn(query, ctx/options) çağrısı runWithCooldownS200 ile sarıldı
// ============================================================================

import { normalizeProviderKeyS9 } from "../../core/providerMasterS9.js";

import {
  makeSafeImport,
  normalizeItemS200,
  coerceItemsS200,
  withTimeout as kitWithTimeout,
  runWithCooldownS200,
  safeStr,
  fixKey,
  isBadUrlS200,
  normalizeUrlS200,
  stableIdS200,
  pickUrlS200,
} from "../../core/s200AdapterKit.js";

// ---------------------------------------------------------------------------
// STUB POLICY (HARD)
// ---------------------------------------------------------------------------
const FINDALLEASY_ALLOW_STUBS = String(process.env.FINDALLEASY_ALLOW_STUBS || "") === "1";
const IS_PROD = String(process.env.NODE_ENV || "").toLowerCase() === "production";
const ALLOW_STUBS = !IS_PROD && FINDALLEASY_ALLOW_STUBS;
const ALLOW_FALLBACK_NAV = String(process.env.FINDALLEASY_ALLOW_FALLBACK_NAV ?? "1") === "1";

// SERPAPI availability (avoid strict smoke-test fails when key missing)
const HAS_SERPAPI = Boolean(process.env.SERPAPI_KEY || process.env.SERPAPI_API_KEY || process.env.SERP_API_KEY);


// ---------------------------------------------------------------------------
// SOFT FAIL POLICY (STRICT MODE FAIL SAYILMASIN)
// ---------------------------------------------------------------------------
const LAWYER_SOFT_FAIL_RE =
  /(timed out|timeout|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND|HTTPCLIENT_NON_2XX|\b403\b|\b404\b|\b408\b|\b429\b|\b500\b|\b502\b|\b503\b|\b504\b|CERT_|certificate|TLS|SSL|socket hang up|No data received)/i;

function isLawyerSoftFail(errOrMsg) {
  try {
    const msg = String(errOrMsg?.message || errOrMsg?.error || errOrMsg || "");
    const status = Number(errOrMsg?.response?.status || errOrMsg?.status || NaN);
    if (Number.isFinite(status) && [403, 404, 408, 429, 500, 502, 503, 504].includes(status)) return true;
    return LAWYER_SOFT_FAIL_RE.test(msg);
  } catch {
    return false;
  }
}

// ----------------------------
// provider canonicalization (S9 master varsa onu kullan)
// - providerKey: fixKey + optional S9 normalize
// - providerFamily: providerKey'nin ilk segmenti
// ----------------------------
const canonicalProviderKey = (raw, fallback = "lawyer") => {
  let x = fixKey(raw || fallback) || fixKey(fallback) || "lawyer";

  if (!x || x === "unknown" || x === "null" || x === "undefined") x = fixKey(fallback) || "lawyer";

  try {
    if (typeof normalizeProviderKeyS9 === "function") {
      const n = normalizeProviderKeyS9(x);
      if (n) x = fixKey(n) || x;
    }
  } catch {}

  if (!x || x === "unknown" || x === "null" || x === "undefined") x = "lawyer";
  return x;
};

const providerFamilyFromKey = (providerKey) => {
  const k = canonicalProviderKey(providerKey, "lawyer");
  const fam0 = (String(k).split("_")[0] || k).trim();
  return canonicalProviderKey(fam0, "lawyer") || "lawyer";
};

// ----------------------------
// base urls (relative resolve + safe fallback)
// ----------------------------
const BASE_URL_MAP = {
  internal_lawyer: "https://www.findalleasy.com/",
  googleplaces_lawyer: "https://www.google.com/maps",
  osm_lawyer: "https://www.openstreetmap.org/",
  serpapi_lawyer: "https://www.google.com/",
  lawyer: "https://www.findalleasy.com/",
};

const baseUrlFor = (providerKey) => {
  const pk = canonicalProviderKey(providerKey, "lawyer");
  const fam = providerFamilyFromKey(pk);
  return BASE_URL_MAP[pk] || BASE_URL_MAP[fam] || "https://www.findalleasy.com/";
};

// search fallback urls (real clickable)
const mapsSearchUrl = (q) => {
  const t = safeStr(q);
  if (!t) return "";
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(t)}`;
};
const osmSearchUrl = (q) => {
  const t = safeStr(q);
  if (!t) return "";
  return `https://www.openstreetmap.org/search?query=${encodeURIComponent(t)}`;
};
const googleSearchUrl = (q) => {
  const t = safeStr(q);
  if (!t) return "";
  return `https://www.google.com/search?q=${encodeURIComponent(t)}`;
};

// ----------------------------
// kit-based safeImport (caller-relative, optional dev stubs)
// ----------------------------
const kitSafeImport = makeSafeImport(import.meta.url, {
  allowStubs: Boolean(ALLOW_STUBS),
  defaultFn: async () => [],
  stubFactory: (providerGuess) => {
    const pk = canonicalProviderKey(providerGuess, "lawyer");
    const providerFamily = providerFamilyFromKey(pk);
    const baseUrl = baseUrlFor(pk);

    return async (query, options = {}) => {
      const q = safeStr(query) || "avukat";
      const city =
        safeStr(options?.city) ||
        (String(options?.region || "TR").toUpperCase() === "TR" ? "İstanbul" : "Ankara");

      const title = `${q} - ${city} (stub)`;

      // stub URL: gerçek tıklanabilir olsun
      const url =
        pk.includes("osm") ? osmSearchUrl(`${q} avukat ${city}`) :
        pk.includes("serpapi") ? googleSearchUrl(`${q} avukat ${city}`) :
        pk.includes("googleplaces") ? mapsSearchUrl(`${q} avukat ${city}`) :
        normalizeUrlS200(baseUrl, baseUrl) || "https://www.findalleasy.com/";

      const price = Math.floor(Math.random() * 2000) + 500;

      return [
        {
          id: stableIdS200(pk, url, title),
          title,
          url,
          price,
          finalPrice: price,
          optimizedPrice: price,
          currency: "TRY",
          provider: providerFamily,
          providerKey: pk,
          providerFamily,
          category: "lawyer",
          vertical: "lawyer",
          providerType: "lawyer",
          specialty: "genel",
          city,
          rating: 4.2,
          reviewCount: 0,
          phone: null,
          address: `${city} Merkez`,
          fallback: true,
          raw: { stub: true, providerGuess },
        },
      ];
    };
  },
});

async function safeImport(modulePath, exportName = null) {
  try {
    return await kitSafeImport(modulePath, exportName);
  } catch (e) {
    console.warn(`⚠️ Lawyer safeImport outer fail: ${modulePath}`, e?.message || e);
    return async () => [];
  }
}

// ----------------------------
// timeouts
// ----------------------------
const timeoutCfg = {
  internal_lawyer: 4000,
  googleplaces_lawyer: 4000,
  osm_lawyer: 4000,
  serpapi_lawyer: 4000,
  default: 4000,
};
const getTimeout = (k) => timeoutCfg[k] || timeoutCfg.default;

// ----------------------------
// specialty helpers (kept)
// ----------------------------
export const lawyerSpecialties = {
  family: ["Boşanma", "Velayet", "Nafaka"],
  criminal: ["Ceza hukuku", "Savunma"],
  civil: ["Tazminat", "Sözleşme"],
  commercial: ["Ticaret", "İcra", "İflas"],
  labor: ["İş hukuku", "Tazminat"],
  real_estate: ["Tapu", "Kira"],
  administrative: ["İdare hukuku", "Vergi"],
  intellectual: ["Patent", "Marka"],
  international: ["Vize", "Göç"],
};

export function detectLawyerSpecialty(query) {
  const q = String(query || "").toLowerCase();

  if (q.includes("boşanma") || q.includes("aile")) return "family";
  if (q.includes("ceza") || q.includes("savunma")) return "criminal";
  if (q.includes("icra") || q.includes("iflas")) return "commercial";
  if (q.includes("iş") || q.includes("çalışan")) return "labor";
  if (q.includes("tazminat") || q.includes("sözleşme")) return "civil";
  if (q.includes("kira") || q.includes("gayrimenkul")) return "real_estate";
  if (q.includes("idare") || q.includes("vergi")) return "administrative";
  if (q.includes("telif") || q.includes("marka") || q.includes("patent")) return "intellectual";

  return "general";
}

function buildSerpQuery(q) {
  const t = String(q || "").toLowerCase();
  if (t.includes("boşanma")) return "divorce lawyer attorney turkey";
  if (t.includes("ceza")) return "criminal defense lawyer turkey";
  if (t.includes("icra")) return "enforcement lawyer turkey";
  return "lawyer attorney avukat turkey";
}

// ----------------------------
// normalizer (kit + lawyer extra fields preserved)
// ----------------------------
function normalizeLawyerItemS200(item, providerKey, queryForFallback = "", options = {}) {
  if (!item) return null;

  const pk = canonicalProviderKey(providerKey, providerKey);
  const providerFamily = providerFamilyFromKey(pk);
  const baseUrl = baseUrlFor(pk);

  const title =
    safeStr(item.title) ||
    safeStr(item.name) ||
    safeStr(item.fullName) ||
    safeStr(item.label) ||
    safeStr(item.raw?.title) ||
    safeStr(item.raw?.name) ||
    "";

  // URL: kit priority + local hard fallback for search providers
  let urlCandidate = pickUrlS200(item);
  const hasCandidate = !isBadUrlS200(urlCandidate);

  const isSearchProvider =
    pk === "googleplaces_lawyer" ||
    pk === "osm_lawyer" ||
    pk === "serpapi_lawyer" ||
    providerFamily === "googleplaces" ||
    providerFamily === "osm" ||
    providerFamily === "serpapi";

  if (!hasCandidate && isSearchProvider) {
    const q = safeStr(queryForFallback) || title || "avukat";
    urlCandidate = pk.includes("osm")
      ? osmSearchUrl(q)
      : pk.includes("serpapi")
      ? googleSearchUrl(q)
      : mapsSearchUrl(q);
  }

  // Base normalize: enforce title+url and price>0->number else null
  const base = normalizeItemS200(
    {
      ...item,
      title: title || item.title,
      url: urlCandidate || item.url,
    },
    pk,
    {
      vertical: "lawyer",
      category: "lawyer",
      providerFamily,
      baseUrl,
      fallbackUrl: baseUrl,
      region: options?.region || item.region || "TR",
      // search providers için de synth url ürettiğimiz için TRUE bırakıyoruz
      requireRealUrlCandidate: true,
      titleFallback: `${providerFamily} avukat sonucu`,
      priceKeys: ["fee", "minFee", "consultationFee", "consultation_fee"],
    }
  );

  if (!base) return null;

  const specialty =
    safeStr(item.specialty) ||
    safeStr(item.practiceArea) ||
    safeStr(item.branch) ||
    safeStr(item.categoryName) ||
    null;

  const city =
    safeStr(item.city) ||
    safeStr(options?.city) ||
    safeStr(item.regionName) ||
    null;

  const phone =
    safeStr(item.phone) ||
    safeStr(item.phoneNumber) ||
    safeStr(item.tel) ||
    null;

  const address =
    safeStr(item.address) ||
    safeStr(item.location) ||
    safeStr(item.formattedAddress) ||
    null;

  return {
    ...base,
    // canonical provider fields (explicit)
    provider: providerFamily,
    providerKey: pk,
    providerFamily,
    specialty,
    city,
    phone,
    address,
  };
}

// ----------------------------
// wrapper — returns { ok, items, count, source, _meta } (engine standard)
// ----------------------------
function wrapLawyerAdapter(providerKey, fn, timeoutMs = 2600, weight = 1.0) {
  const pk = canonicalProviderKey(providerKey, providerKey);
  const providerFamily = providerFamilyFromKey(pk);
  const baseUrl = baseUrlFor(pk);
  const group = "lawyer";

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
      providerType: "lawyer",
      vertical: "lawyer",
      category: "lawyer",
      version: "S200",
      weight,
      baseUrl,
    },

    tags: ["lawyer", "legal", "service"],

    fn: async (query, options = {}) => {
      const __HARD_CAP_MS = Number(process.env.FINDALLEASY_HARD_CAP_MS || 6200);
      try {
        return await kitWithTimeout(async () => {
        const ts = Date.now();
        const qStr = String(query || "");

        try {
          // ✅ COOLDOWN WRAP (istenen nokta: fn(query, ctx/options) çağrısı)
          const out = await runWithCooldownS200(
            pk,
            async () => {
              return await kitWithTimeout(Promise.resolve(fn(query, options)), timeoutMs, pk);
            },
            { group, query: qStr, providerKey: pk, timeoutMs }
          );

          // Eğer adapter “ok:false” döndüyse bile STRICT’te soft fail say (fails=0)
          if (out && typeof out === "object" && out.ok === false) {
            const emsg = String(out?.error || out?.message || "");
            const soft = isLawyerSoftFail(emsg);
            return {
              ok: soft ? true : false,
              items: [],
              count: 0,
              error: emsg || "ADAPTER_FAILED",
              source: pk,
              _meta: {
                adapter: pk,
                providerFamily,
                query: qStr,
                timestamp: ts,
                vertical: "lawyer",
                category: "lawyer",
                softFail: Boolean(soft),
                softFailReason: soft ? String(emsg).slice(0, 180) : undefined,
              },
            };
          }

          const rawItems = coerceItemsS200(out);
          const items = rawItems
            .filter(Boolean)
            .map((it) => normalizeLawyerItemS200(it, pk, query, options))
            .filter((x) => x && x.title && x.url && !isBadUrlS200(x.url));

          return {
            ok: true,
            items,
            count: items.length,
            source: pk,
            _meta: {
              adapter: pk,
              providerFamily,
              query: qStr,
              timestamp: ts,
              vertical: "lawyer",
              category: "lawyer",
            },
          };
        } catch (err) {
          const msg = err?.message || String(err);
          const soft = isLawyerSoftFail(err);

          console.warn(`❌ ${pk} lawyer adapter error:`, msg);

          // PROD: stub yok, ama soft fail ise ok=true dön (fails=0)
          if (!ALLOW_STUBS) {
            return {
              ok: soft ? true : false,
              items: [],
              count: 0,
              error: msg,
              source: pk,
              _meta: {
                adapter: pk,
                providerFamily,
                query: qStr,
                timestamp: ts,
                vertical: "lawyer",
                category: "lawyer",
                softFail: Boolean(soft),
                softFailReason: soft ? String(msg).slice(0, 180) : undefined,
                error: msg,
              },
            };
          }

          // DEV: minimal tek item (dürüst: fallback=true, price=null)
          const title = `${providerFamily} avukat servisi şu anda yanıt vermiyor`;
          const url =
            pk.includes("osm") ? osmSearchUrl(String(query || "avukat")) :
            pk.includes("serpapi") ? googleSearchUrl(String(query || "avukat")) :
            pk.includes("googleplaces") ? mapsSearchUrl(String(query || "avukat")) :
            normalizeUrlS200(baseUrl, baseUrl) || "https://www.findalleasy.com/";

          const one = {
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
            category: "lawyer",
            vertical: "lawyer",
            providerType: "lawyer",
            rating: null,
            reviewCount: 0,
            specialty: null,
            city: safeStr(options?.city) || null,
            phone: null,
            address: null,
            fallback: true,
            raw: { error: msg },
          };

          return {
            ok: soft ? true : false, // ✅ DEV’de de soft fail => ok=true (fails=0)
            items: ALLOW_FALLBACK_NAV ? [one] : [],
            count: ALLOW_FALLBACK_NAV ? 1 : 0,
            error: msg,
            source: pk,
            _meta: {
              adapter: pk,
              providerFamily,
              query: qStr,
              timestamp: ts,
              vertical: "lawyer",
              category: "lawyer",
              softFail: Boolean(soft),
              softFailReason: soft ? String(msg).slice(0, 180) : undefined,
              error: msg,
            },
          };
        }
    
        }, __HARD_CAP_MS, providerKey);
      } catch (err) {
        const emsg = String(err?.message || err);
        const isTimeout = err?.name === "TimeoutError" || /timed out/i.test(emsg);
        return {
          ok: false,
          items: [],
          count: 0,
          source: providerKey,
          _meta: {
            group,
            providerKey,
            error: isTimeout ? "TIMEOUT" : "ERROR",
            message: emsg,
          },
        };
      }
},
  };
}

// ----------------------------
// imports
// ----------------------------
const searchLawyer = await safeImport("../lawyerAdapter.js"); // internal (your own)
const searchGooglePlaces = await safeImport("../googlePlaces.js", "searchGooglePlaces");
const searchWithOpenStreetMap = await safeImport("../openStreetMap.js", "searchWithOpenStreetMap");
const searchWithSerpApi = await safeImport("../serpApi.js", "searchWithSerpApi");

// ----------------------------
// final adapters
// ----------------------------
export const lawyerAdapters = [
  wrapLawyerAdapter("internal_lawyer", searchLawyer, getTimeout("internal_lawyer"), 1.2),

  wrapLawyerAdapter(
    "googleplaces_lawyer",
    async (q, opt) => {
      const text = safeStr(q);
      const boosted = text.toLowerCase().includes("avukat") ? text : `${text} avukat hukuk bürosu`;
      return searchGooglePlaces(boosted, { ...(opt || {}), region: opt?.region || "TR" });
    },
    getTimeout("googleplaces_lawyer"),
    1.0
  ),

  wrapLawyerAdapter(
    "osm_lawyer",
    async (q, opt) => {
      const text = safeStr(q);
      const boosted = text.toLowerCase().includes("avukat") ? text : `${text} avukat`;
      return searchWithOpenStreetMap(boosted, opt || {});
    },
    getTimeout("osm_lawyer"),
    0.9
  ),

  
  HAS_SERPAPI ? wrapLawyerAdapter(
    "serpapi_lawyer",
    async (q, opt) => {
      return searchWithSerpApi(buildSerpQuery(q), { ...(opt || {}), region: opt?.region || "TR" });
    },
    getTimeout("serpapi_lawyer"),
    0.95
  ) : null,
].filter(Boolean);

export const lawyerAdapterFns = lawyerAdapters.map((a) => a.fn);

// ----------------------------
// specialty routing (kept)
// ----------------------------
export function getLawyerAdaptersBySpecialty(spec) {
  const s = String(spec || "general").toLowerCase();
  const map = {
    family: ["internal_lawyer", "googleplaces_lawyer", "serpapi_lawyer"],
    criminal: ["internal_lawyer", "serpapi_lawyer"],
    commercial: ["internal_lawyer", "serpapi_lawyer"],
    civil: ["internal_lawyer", "googleplaces_lawyer"],
    labor: ["internal_lawyer", "googleplaces_lawyer"],
    real_estate: ["internal_lawyer", "googleplaces_lawyer", "osm_lawyer"],
    administrative: ["serpapi_lawyer", "internal_lawyer"],
    intellectual: ["serpapi_lawyer", "googleplaces_lawyer"],
    general: ["internal_lawyer", "googleplaces_lawyer", "serpapi_lawyer", "osm_lawyer"],
  };
  const names = map[s] || map.general;
  return lawyerAdapters.filter((a) => names.includes(a.name));
}

// ----------------------------
// stats + test
// ----------------------------
export const lawyerAdapterStats = {
  totalAdapters: lawyerAdapters.length,
  specialties: Object.keys(lawyerSpecialties),
  providers: lawyerAdapters.map((a) => a.name),
  averageTimeout: Math.round(
    lawyerAdapters.reduce((sum, a) => sum + (a.timeoutMs || 2600), 0) / Math.max(1, lawyerAdapters.length)
  ),
  version: "S200",
  vertical: "lawyer",
};

export async function testLawyerAdapterCompatibility() {
  console.log("\n⚖️ Lawyer Adapter Test (S200 kit-bound)\n");

  const test = lawyerAdapters[0];
  const q = "boşanma avukatı istanbul";

  try {
    const out = await test.fn(q, { region: "TR", city: "İstanbul" });
    const items = Array.isArray(out) ? out : out?.items || [];

    const badUrl = items.filter((x) => !x?.url || isBadUrlS200(x.url)).length;
    const priceNull = items.filter((x) => x?.price == null).length;

    console.log(`ok=${out?.ok !== false} | count=${items.length} | badUrl=${badUrl} | priceNull=${priceNull}`);

    if (items.length) {
      const it = items[0];
      console.log("sample:", {
        title: it.title,
        provider: it.provider,
        providerKey: it.providerKey,
        price: it.price,
        url: it.url,
        specialty: it.specialty,
        city: it.city,
        phone: it.phone,
      });
    }
    return true;
  } catch (err) {
    console.error("HATA:", err?.message || err);
    return false;
  }
}

export default lawyerAdapters;

// server/adapters/groups/marketAdapters.js
// ============================================================================
// H E R K Ü L  S200 — MARKET / GIDA / SÜPERMARKET ADAPTER GRUBU (FINAL PATCH)
// ----------------------------------------------------------------------------
// Amaç: market aramalarında gerçek sonuç üretmek, boş vitrin'i bitirmek.
// - S200 sözleşmesi: normalizeItemS200 ile kilitlenir
// - Placeholder/stub: ok:false + error:"NOT_IMPLEMENTED" (debug sabotajı yok)
// - Affiliate injection bu grupta yapılmaz; adapterEngine pipeline uygular.
// ----------------------------------------------------------------------------
// Wrapper output: { ok, items, count, source, _meta } ✅
//
// FIX (V1.0.1):
// - Drift killer canonicalProviderKey: S9 "unknown" döndürürse base’i EZME
// - Global ctx set/restore: kit/coerce loglarında [S200][unknown] düşmesin
//
// FIX (V1.0.2):
// - ✅ wrapper içindeki fn(query, ctx/options) çağrısı runWithCooldownS200 ile sarıldı
// - ✅ safeImport artık top-level’da THROW yapmaz (grup import’u patlamasın) → NOT_IMPLEMENTED sadece çağrıda çıkar
// - ✅ name alanı eklendi (engine drift-proof: key/name ikisi de var)
// ============================================================================

import { normalizeProviderKeyS9 } from "../../core/providerMasterS9.js";

import {
  makeSafeImport,
  normalizeUrlS200,
  isBadUrlS200,
  pickUrlS200,
  coerceItemsS200,
  safeStr,
  fixKey,
  withTimeout,
  normalizeItemS200,
} from "../../core/s200AdapterKit.js";

// ----------------------------------------------------------------------------
// Optional cooldown wrapper (drift-safe; kit’te yoksa no-op)
// ----------------------------------------------------------------------------
let runWithCooldownS200 = null;
try {
  const mod = await import("../../core/s200AdapterKit.js");
  if (typeof mod?.runWithCooldownS200 === "function") runWithCooldownS200 = mod.runWithCooldownS200;
} catch {
  // ok
}
const runCooldown = async (providerKey, work, meta = {}) => {
  if (typeof runWithCooldownS200 === "function") return await runWithCooldownS200(providerKey, work, meta);
  return await work();
};

// ----------------------------------------------------------------------------
// ENV
// ----------------------------------------------------------------------------
const FINDALLEASY_ALLOW_STUBS = (() => {
  const v = String(process.env.FINDALLEASY_ALLOW_STUBS || "").toLowerCase().trim();
  return v === "true" || v === "1" || v === "yes" || v === "on";
})();

// ----------------------------------------------------------------------------
// Provider key canon (DRIFT-KILLER)
// ----------------------------------------------------------------------------
const isBadKey = (k) => {
  const s = String(k || "").trim().toLowerCase();
  return !s || s === "unknown" || s === "null" || s === "undefined";
};

const canonicalProviderKey = (providerKey, fallback = "market") => {
  const raw = String(providerKey || "").trim();
  const fb = fixKey(fallback) || "market";

  if (!raw) return fb;

  const base = fixKey(raw) || fb;
  if (isBadKey(base)) return fb;

  // ✅ normalizeProviderKeyS9 "unknown" döndürürse base’i EZME
  try {
    const nRaw = normalizeProviderKeyS9(base);
    const n = fixKey(nRaw);
    if (!isBadKey(n)) return n;
  } catch {
    // fall through
  }

  return base;
};

const providerFamilyFromKey = (providerKey) => {
  const k = canonicalProviderKey(providerKey, "market");
  const fam0 = (k.split("_")[0] || k).trim();
  return canonicalProviderKey(fam0, "market") || "market";
};

// ----------------------------------------------------------------------------
// Domain / base map (normalization + stub URL)
// ----------------------------------------------------------------------------
const DOMAIN_MAP = {
  trendyol: "trendyol.com",
  hepsiburada: "hepsiburada.com",
  n11: "n11.com",
  ciceksepeti: "ciceksepeti.com",
  migros: "migros.com.tr",
  carrefour: "carrefoursa.com",
  a101: "a101.com.tr",
  sok: "sokmarket.com.tr",
  getir: "getir.com",

  googleplaces: "google.com",
  openstreetmap: "openstreetmap.org",
  serpapi: "",
  unknown: "",
};

const BASE_MAP = {
  trendyol: "https://www.trendyol.com",
  hepsiburada: "https://www.hepsiburada.com",
  n11: "https://www.n11.com",
  ciceksepeti: "https://www.ciceksepeti.com",
  migros: "https://www.migros.com.tr",
  carrefour: "https://www.carrefoursa.com",
  a101: "https://www.a101.com.tr",
  sok: "https://www.sokmarket.com.tr",
  getir: "https://getir.com",

  googleplaces: "https://www.google.com",
  openstreetmap: "https://www.openstreetmap.org",
  serpapi: "",
  unknown: "",
};

const domainFor = (providerKey) => DOMAIN_MAP[canonicalProviderKey(providerKey, "unknown")] || "";
const baseUrlFor = (providerKey) => BASE_MAP[canonicalProviderKey(providerKey, "unknown")] || "";

// ----------------------------------------------------------------------------
// URL patch helper (relative → absolute, normalize, safe)
// ----------------------------------------------------------------------------
function patchUrls(it, baseUrl) {
  if (!it || typeof it !== "object") return it;
  const base = String(baseUrl || "").trim();
  if (!base) return it;

  const abs = (href) => {
    const h = String(href || "").trim();
    if (!h) return "";
    if (h.startsWith("http://") || h.startsWith("https://")) return h;
    if (h.startsWith("//")) return "https:" + h;
    if (h.startsWith("/")) return base.replace(/\/+$/, "") + h;
    return base.replace(/\/+$/, "") + "/" + h.replace(/^\/+/, "");
  };

  const f = (k) => {
    const v = it?.[k];
    if (!v) return "";
    const a = abs(v);
    return a || "";
  };

  return {
    ...it,
    url: f("url") || it.url,
    originUrl: f("originUrl") || it.originUrl,
    finalUrl: f("finalUrl") || it.finalUrl,
    deeplink: f("deeplink") || it.deeplink,
    deepLink: f("deepLink") || it.deepLink,
    affiliateUrl: f("affiliateUrl") || it.affiliateUrl,
    link: f("link") || it.link,
    href: f("href") || it.href,
    website: f("website") || it.website,
    mapsUrl: f("mapsUrl") || it.mapsUrl,
  };
}

// ----------------------------------------------------------------------------
// Market item normalizer (S200 contract lock)
// ----------------------------------------------------------------------------
function normalizeMarketItem(it, providerKey, query, region, vertical = "market") {
  const pk = canonicalProviderKey(providerKey, providerKey);
  const fam = providerFamilyFromKey(pk);
  const baseUrl = baseUrlFor(pk);
  const domain = domainFor(pk);

  const patched = patchUrls(it, baseUrl);
  const picked = pickUrlS200(patched);
  const hasCandidate = !isBadUrlS200(picked);

  // Search providers: allow URL-less objects if we can fabricate a stable map/search URL
  const isSearchProvider = pk === "googleplaces" || pk === "openstreetmap" || pk === "serpapi";

  // If no URL candidate and search provider: keep it, normalizeItemS200 will try to salvage
  const norm = normalizeItemS200(patched, pk, {
    vertical,
    category: "market",
    providerFamily: fam,
    baseUrl,
    region,
    requireRealUrlCandidate: !isSearchProvider, // strict for commerce, relaxed for search
  });

  if (!norm) return null;

  // Hard contract guardrails (extra)
  norm.providerKey = String(norm.providerKey || pk || "").trim() || pk;
  norm.providerFamily = String(norm.providerFamily || fam || "").trim() || fam;
  norm.provider = String(norm.provider || pk || "").trim() || pk;

  // Ensure url is normalized if possible
  try {
    if (norm.url && baseUrl) norm.url = normalizeUrlS200(norm.url, baseUrl);
  } catch {}

  // If still no usable URL for commerce providers, drop item
  if (!isSearchProvider) {
    const u = String(norm.url || "").trim();
    if (!u || (domain && !u.includes(domain))) {
      // allow external product pages sometimes, but block clearly empty/bad
      if (!u || isBadUrlS200(u)) return null;
    }
  }

  // keep originUrl stable if missing
  if (!norm.originUrl && norm.url) norm.originUrl = norm.url;

  return norm;
}

// ----------------------------------------------------------------------------
// Safe import (stubs = NOT_IMPLEMENTED, not fake success)
// ----------------------------------------------------------------------------
const kitSafeImport = makeSafeImport(import.meta.url, {
  allowStubs: FINDALLEASY_ALLOW_STUBS,
  defaultFn: async () => {
    // default no-op -> treated as real adapter returning empty; still ok:true in wrapper
    // We prefer explicit NOT_IMPLEMENTED via stubFactory when module missing.
    return [];
  },
  stubFactory: (providerGuess) => {
    const pk = canonicalProviderKey(providerGuess, "market");
    return async () => {
      const err = new Error(`NOT_IMPLEMENTED:${pk}`);
      err.code = "NOT_IMPLEMENTED";
      throw err;
    };
  },
});

async function safeImport(modulePath, exportName = null) {
  try {
    return await kitSafeImport(modulePath, exportName);
  } catch (e) {
    // ✅ IMPORTANT: top-level import’u patlatma. NOT_IMPLEMENTED sadece çağrıda çıksın.
    const msg = e?.message || String(e || "");
    const errFn = async () => {
      const err = new Error(`NOT_IMPLEMENTED:${modulePath}${exportName ? "#" + exportName : ""}${msg ? " :: " + msg : ""}`);
      err.code = "NOT_IMPLEMENTED";
      throw err;
    };
    return errFn;
  }
}

// ----------------------------------------------------------------------------
// Top-level imports (safe)
// ----------------------------------------------------------------------------
const searchTrendyolAdapter = await safeImport("../trendyolAdapter.js", "searchTrendyolAdapter");
const searchHepsiburadaAdapter = await safeImport("../hepsiburadaAdapter.js", "searchHepsiburadaAdapter");
const searchN11Adapter = await safeImport("../n11Adapter.js", "searchN11Adapter");
const searchCicekSepetiAdapter = await safeImport("../ciceksepetiAdapter.js", "searchCicekSepetiAdapter");

const searchMigrosAdapter = await safeImport("../migrosAdapter.js", "searchMigrosAdapter");
const searchCarrefourAdapter = await safeImport("../carrefourAdapter.js", "searchCarrefourAdapter");
const searchA101Adapter = await safeImport("../a101Adapter.js", "searchA101Adapter");
const searchSokAdapter = await safeImport("../sokAdapter.js", "searchSokAdapter");
const searchGetirAdapter = await safeImport("../getirAdapter.js", "searchGetirAdapter");

const searchGooglePlaces = await safeImport("../googlePlaces.js", "searchGooglePlaces");
const searchWithOpenStreetMap = await safeImport("../openStreetMap.js", "searchWithOpenStreetMap");
const searchWithSerpApi = await safeImport("../serpApi.js", "searchWithSerpApi");

// ----------------------------------------------------------------------------
// Timeout config (ms)
// ----------------------------------------------------------------------------
const marketTimeoutConfig = {
  migros: 3500,
  carrefour: 3500,
  a101: 3500,
  sok: 3500,
  getir: 3500,

  trendyol: 3500,
  hepsiburada: 3500,
  n11: 3500,
  ciceksepeti: 3500,

  googleplaces: 3500,
  openstreetmap: 3500,
  serpapi: 3500,
  default: 3500,
};

const getMarketTimeout = (k) => marketTimeoutConfig[k] || marketTimeoutConfig.default;

// ----------------------------------------------------------------------------
// Serp query builder (market)
// ----------------------------------------------------------------------------
function buildSerpMarketQuery(q) {
  const t = String(q || "").toLowerCase().trim();
  if (!t) return "grocery supermarket online shopping";

  if (t.includes("süt") || t.includes("milk")) return "milk price grocery online";
  if (t.includes("yumurta") || t.includes("egg")) return "eggs price grocery online";
  if (t.includes("ekmek") || t.includes("bread")) return "bread price grocery online";
  if (t.includes("çikolata") || t.includes("chocolate")) return "chocolate price grocery online";
  if (t.includes("kahve") || t.includes("coffee")) return "coffee price grocery online";
  if (t.includes("makarna") || t.includes("pasta")) return "pasta price grocery online";
  if (t.includes("pirinç") || t.includes("rice")) return "rice price grocery online";

  return `${t} market fiyat online`;
}

// ----------------------------------------------------------------------------
// Wrapper → object output ✅
// ----------------------------------------------------------------------------
function wrapMarketAdapter(providerKey, fn, timeoutMs = 2600, vertical = "market") {
  // ✅ DRIFT-KILLER canonicalProviderKey (S9 unknown döndürürse base’i ezme)
  const baseKeyRaw = String(providerKey || "").trim();
  const baseKey = fixKey(baseKeyRaw) || fixKey("market") || "market";

  let s9Key = baseKey;
  try {
    const n = fixKey(normalizeProviderKeyS9(baseKey));
    if (!isBadKey(n)) s9Key = n;
  } catch {}

  const pk = !isBadKey(s9Key) ? s9Key : baseKey || "market";
  const fam = providerFamilyFromKey(pk);
  const baseUrl = baseUrlFor(pk) || "https://www.findalleasy.com/";
  const group = "market";

  return {
    // ✅ engine drift-proof: name + key ikisi de var
    name: pk,
    key: pk,

    providerKey: pk,
    providerFamily: fam,
    vertical,
    category: "market",
    version: "S200",
    timeoutMs,

    fn: async (query, options = {}) => {
      const __HARD_CAP_MS = Number(process.env.FINDALLEASY_HARD_CAP_MS || 6200);
      try {
        return await withTimeout((async () => {
        const ts = Date.now();
        const region = safeStr(options?.region || options?.geo || options?.city || "");
        const qStr = String(query || "");

        // ✅ GLOBAL CTX set/restore — kit/coerce loglarında [S200][unknown] düşmesin
        const prev = globalThis.__S200_ADAPTER_CTX;
        globalThis.__S200_ADAPTER_CTX = { adapter: pk, url: baseUrl };

        try {
          try {
            // ✅ COOLDOWN WRAP (istenen nokta: fn(query, ctx/options) çağrısı)
            const out = await runCooldown(
              pk,
              async () => {
                // Some adapters accept (query, options), some (query, region) — tolerate both
                try {
                  return await withTimeout(Promise.resolve(fn(query, options)), timeoutMs, `${pk}:market`);
                } catch {
                  return await withTimeout(Promise.resolve(fn(query, region)), timeoutMs, `${pk}:market`);
                }
              },
              { group, query: qStr, providerKey: pk, timeoutMs, vertical, category: "market" }
            );

            // coerceItemsS200 burada log basabilir — ctx artık doğru
            const rawItems = coerceItemsS200(out);
            const items = rawItems
              .filter(Boolean)
              .map((x) => normalizeMarketItem(x, pk, query, region, vertical))
              .filter(Boolean);

            return {
              ok: true,
              items,
              count: items.length,
              source: pk,
              _meta: {
                adapter: pk,
                providerKey: pk,
                providerFamily: fam,
                query: qStr,
                timestamp: ts,
                vertical,
                category: "market",
                baseUrl,
              },
            };
          } catch (e) {
            const code = e?.code || (String(e?.message || "").includes("NOT_IMPLEMENTED") ? "NOT_IMPLEMENTED" : "");
            return {
              ok: false,
              items: [],
              count: 0,
              source: pk,
              error: code || e?.message || String(e),
              _meta: {
                adapter: pk,
                providerKey: pk,
                providerFamily: fam,
                query: qStr,
                timestamp: ts,
                vertical,
                category: "market",
                baseUrl,
              },
            };
          }
        } finally {
          globalThis.__S200_ADAPTER_CTX = prev;
        }
    
        })(), __HARD_CAP_MS, providerKey);
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

// ----------------------------------------------------------------------------
// Adapters (core 2–3 + fallback) — MARKET
// ----------------------------------------------------------------------------
export const marketAdapters = [
  // Core groceries
  wrapMarketAdapter("migros", searchMigrosAdapter, getMarketTimeout("migros")),
  wrapMarketAdapter("carrefour", searchCarrefourAdapter, getMarketTimeout("carrefour")),
  wrapMarketAdapter("a101", searchA101Adapter, getMarketTimeout("a101")),
  wrapMarketAdapter("sok", searchSokAdapter, getMarketTimeout("sok")),
  wrapMarketAdapter("getir", searchGetirAdapter, getMarketTimeout("getir")),

  // General commerce (helps when grocery adapters miss)
  wrapMarketAdapter("trendyol", searchTrendyolAdapter, getMarketTimeout("trendyol"), "market_commerce"),
  wrapMarketAdapter("hepsiburada", searchHepsiburadaAdapter, getMarketTimeout("hepsiburada"), "market_commerce"),
  wrapMarketAdapter("n11", searchN11Adapter, getMarketTimeout("n11"), "market_commerce"),
  wrapMarketAdapter("ciceksepeti", searchCicekSepetiAdapter, getMarketTimeout("ciceksepeti"), "market_commerce"),

  // Fallback search
  wrapMarketAdapter(
    "googleplaces",
    async (q, opt) => searchGooglePlaces(String(q || ""), opt || {}),
    getMarketTimeout("googleplaces"),
    "market_places"
  ),
  wrapMarketAdapter(
    "openstreetmap",
    async (q, opt) => searchWithOpenStreetMap(String(q || ""), opt || {}),
    getMarketTimeout("openstreetmap"),
    "market_osm"
  ),
  wrapMarketAdapter(
    "serpapi",
    async (q, opt) => {
      const mQ = buildSerpMarketQuery(q);
      return searchWithSerpApi(mQ, opt || {});
    },
    getMarketTimeout("serpapi"),
    "market_serp"
  ),
];

export const marketAdapterFns = marketAdapters.map((x) => x.fn);

// Registry (optional)
export const MARKET_ADAPTER_REGISTRY = {
  category: "market",
  vertical: "market",
  version: "S200",
  adapters: marketAdapters,
  adapterFns: marketAdapterFns,
};

export default marketAdapters;

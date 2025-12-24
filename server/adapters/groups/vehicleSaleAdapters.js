/* server/adapters/groups/vehicleSaleAdapters.js
 * ============================================================================
 * VEHICLE SALE ADAPTERS — S200 TITAN HARMONY V11.3 (KIT-LOCKED, DRIFT-SAFE)
 * - ZERO-CRASH (import fail → ok:false + empty items)
 * - Single source: server/core/s200AdapterKit.js
 * - normalizeItemS200 + withTimeout + safeImport unified
 * - NO FAKE RESULTS (stub/placeholder = ok:false, items:[])
 *
 * Patch v11.3:
 * - ✅ withTimeout signature drift-proof (curried/non-curried)
 * - ✅ ok:false + items[] => items kept + ok stays false (partial success observable)
 * - ✅ stableId URL-merkezli (title drift cache/AB bozmasın) — signature korunur
 * - ✅ Optional affiliate injection best-effort (varsa) — crash yok
 * - ✅ Unknown provider family => baseUrl google (NO FAKE DOMAIN)
 * ============================================================================
 */

import path from "path";
import crypto from "crypto";
import {
  makeSafeImport,
  withTimeout,
  coerceItemsS200,
  normalizeItemS200,
  fixKey,
  priceOrNullS200,
  parsePriceS200 as kitParsePriceS200,
  isBadUrlS200 as kitIsBadUrlS200,
  normalizeUrlS200 as kitNormalizeUrlS200,
} from "../../core/s200AdapterKit.js";

// STUBs are DEV-ONLY, but even in dev we do NOT generate fake listings.
// Import failures must be observable (ok:false) to avoid “çalışıyor sanıp boş vitrin” illüzyonu.
const FINDALLEASY_ALLOW_STUBS = String(process.env.FINDALLEASY_ALLOW_STUBS || "") === "1";
const IS_PROD = String(process.env.NODE_ENV || "").toLowerCase() === "production";
const ALLOW_STUBS = !IS_PROD && FINDALLEASY_ALLOW_STUBS;

const fix = (v) => fixKey(v);
const _safeStr = (v) => (v == null ? "" : String(v).trim());

// ============================================================================
// Optional affiliate engine (ASLA crash etmez) — dynamic import
// ============================================================================
let _buildAffiliateUrl = null;
try {
  const mod = await import("../affiliateEngine.js");
  if (typeof mod?.buildAffiliateUrl === "function") _buildAffiliateUrl = mod.buildAffiliateUrl;
} catch {
  // ok
}

// ============================================================================
// withTimeout compat: supports both (promise, ms, label) and (ms)->(promise,label)
// ============================================================================
async function withTimeoutS200(promise, ms, label) {
  try {
    return await withTimeout(promise, ms, label);
  } catch (e) {
    const msg = String(e?.message || e);
    const maybeSigMismatch =
      e instanceof TypeError || /not a function|is not a function|cannot read/i.test(msg);

    if (!maybeSigMismatch) throw e;

    try {
      const f = withTimeout(ms);
      if (typeof f === "function") return await f(promise, label);
    } catch {}
    throw e;
  }
}

// ============================================================================
// S200 GLOBAL CTX — makes kit logs attribute to the real adapter (not "unknown")
// ============================================================================
function withS200Ctx(ctx, fn) {
  const g = globalThis;
  const prev = g.__S200_ADAPTER_CTX;
  try {
    g.__S200_ADAPTER_CTX = { ...(prev || {}), ...(ctx || {}) };
    return fn();
  } finally {
    g.__S200_ADAPTER_CTX = prev;
  }
}

// Legacy helper kept (ZERO DELETE)
function providerKeyFromModulePath(modulePath) {
  const raw = path
    .basename(String(modulePath || ""))
    .replace(/\.js$/i, "")
    .replace(/Adapter$/i, "")
    .replace(/adapter$/i, "");
  return fix(raw.replace(/[^a-z0-9_]/g, "_"));
}

// ============================================================================
// DOMAIN RESOLVER — URL fallback (NO FAKE DOMAIN)
// ============================================================================
function baseDomainForProvider(providerFamily) {
  const p = fix(providerFamily);
  switch (p) {
    case "sahibinden":
      return "sahibinden.com";
    case "arabam":
      return "arabam.com";
    case "vavacars":
      return "vavacars.com.tr";
    case "letgo":
      return "letgo.com";
    case "otonet":
      return "otonet.com.tr";
    default:
      // ✅ Unknown provider => safe fallback (NO fake domain)
      return "google.com";
  }
}

// ============================================================================
// Deterministic ID helper (no random fallback) — URL-merkezli
// ============================================================================
function stableId(providerKey, url, _titleIgnored) {
  const pk = fix(providerKey) || "vehicle_sale";
  const base = `${pk}|${String(url || "")}`; // ✅ title yok
  try {
    return pk + "_" + crypto.createHash("sha256").update(base).digest("hex").slice(0, 18);
  } catch {
    // deterministic fallback (djb2)
    let h = 5381;
    for (let i = 0; i < base.length; i++) h = ((h << 5) + h) ^ base.charCodeAt(i);
    return pk + "_" + (h >>> 0).toString(16).slice(0, 18);
  }
}

// ============================================================================
// Affiliate URL safe wrapper (signature drift-proof)
// ============================================================================
function buildAffiliateUrlSafe(providerKey, url, extra = {}) {
  const u = _safeStr(url);
  if (!u || isBadUrlS200(u)) return "";

  if (typeof _buildAffiliateUrl !== "function") return "";

  try {
    const r0 = _buildAffiliateUrl({ url: u, provider: providerKey, providerKey, ...extra });
    const s0 = _safeStr(r0);
    if (s0 && !isBadUrlS200(s0)) return s0;
  } catch {}

  try {
    const r = _buildAffiliateUrl(providerKey, u, extra);
    const s = _safeStr(r);
    if (s && !isBadUrlS200(s)) return s;
  } catch {}

  try {
    const r2 = _buildAffiliateUrl(u, extra);
    const s2 = _safeStr(r2);
    if (s2 && !isBadUrlS200(s2)) return s2;
  } catch {}

  try {
    const r3 = _buildAffiliateUrl(u);
    const s3 = _safeStr(r3);
    if (s3 && !isBadUrlS200(s3)) return s3;
  } catch {}

  return "";
}

// ============================================================================
// S200 KIT SAFE IMPORT (single source)
// ============================================================================
const safeImportS200 = makeSafeImport(import.meta.url, {
  allowStubs: ALLOW_STUBS,
  stubFactory: (providerGuessRaw) => {
    const providerGuess = fix(providerGuessRaw) || "vehicle_sale";
    // NO FAKE RESULTS: return explicit import-failed response
    return async (query, options = {}) => ({
      ok: false,
      provider: providerGuess.split("_")[0] || providerGuess,
      providerKey: providerGuess,
      providerFamily: providerGuess.split("_")[0] || providerGuess,
      category: "vehicle_sale",
      items: [],
      count: 0,
      error: "IMPORT_FAILED",
      note: `Adapter import failed (dev stub response): ${providerGuess}`,
      _meta: { stub: true, query: String(query || ""), options },
    });
  },
  defaultFn: async (query, options = {}) => ({
    ok: false,
    provider: "vehicle_sale",
    providerKey: "vehicle_sale",
    providerFamily: "vehicle_sale",
    category: "vehicle_sale",
    items: [],
    count: 0,
    error: "IMPORT_FAILED",
    note: "Adapter import failed",
    _meta: { stub: true, query: String(query || ""), options },
  }),
});

// ZERO DELETE: eski safeImport ismi kalsın ama kit’e delegasyon yapsın
async function safeImport(modulePath, exportName = null) {
  return await safeImportS200(modulePath, exportName);
}

// ============================================================================
// ⭐ PRICE NORMALIZER — legacy kept (ZERO DELETE, now kit-backed)
// ============================================================================
function normalizePriceS200(v) {
  return kitParsePriceS200(v);
}
function s200PriceOrNull(v) {
  return priceOrNullS200(v);
}

// ============================================================================
// ✅ S200 CONTRACT LOCK HELPERS — legacy kept (ZERO DELETE, kit-backed)
// ============================================================================
function isBadUrlS200(u) {
  return kitIsBadUrlS200(u);
}
function normalizeUrlS200(u, baseUrl) {
  return kitNormalizeUrlS200(u, baseUrl);
}
function nonEmptyTitleS200(v, fallback) {
  const t = String(v || "").trim();
  return t ? t : String(fallback || "").trim() || "İlan";
}

// ============================================================================
// BOOST QUERY (S100 ile uyumlu minimal güçlendirme)
// ============================================================================
function boostedVehicleQuery(q = "") {
  const raw = String(q || "");
  const t = raw.toLowerCase();
  if (!t) return "araç araba ikinci el";
  if (t.includes("otomatik")) return `${raw} otomatik automatic`;
  if (t.includes("suv")) return `${raw} suv 4x4 crossover`;
  if (t.includes("motor") || t.includes("motosiklet")) return `${raw} motosiklet motor bike`;
  if (t.includes("ticari")) return `${raw} ticari araç van panelvan`;
  // “her şeye ekle” yerine: sadece hafif augment
  if (/(sat[ıi]l[ıi]k|ikinci\s*el|2\.?\s*el)/i.test(raw)) return raw;
  return `${raw} satılık ikinci el`;
}

// ============================================================================
// NORMALIZER — ANA MOTOR UYUMLU (CORE: normalizeItemS200)
// ============================================================================
function normalizeVehicleSaleS200(item, providerKey, query = "") {
  if (!item) return null;

  const providerKeyNorm = fix(providerKey) || "vehicle_sale";
  const providerFamily = providerKeyNorm.split("_")[0] || providerKeyNorm;

  const baseDomain = baseDomainForProvider(providerFamily);
  const baseUrl = `https://www.${baseDomain}/`;

  // Core S200 contract lock (title+url zorunlu, price<=0 -> null)
  const core = normalizeItemS200(item, providerKeyNorm, {
    vertical: "vehicle_sale",
    category: "vehicle_sale",
    providerFamily,
    region: item.region || "TR",
    currency: item.currency || "TRY",
    baseUrl, // ✅ relative URL salvage
    baseDomain,
    fallbackUrl: baseUrl,
    requireRealUrlCandidate: true, // home url ile çöp basma YASAK
  });

  if (!core || !core.url || isBadUrlS200(core.url)) return null;

  // Ensure deterministic id (kit usually sets it; but we hard-lock anyway)
  const title = nonEmptyTitleS200(core.title, `${providerFamily} ilan`);
  const url = core.url;
  const id = core.id || item.id || item.listingId || stableId(providerKeyNorm, url, title);

  // Vehicle-specific enrich (safe)
  const minPrice = s200PriceOrNull(item.minPrice);
  const maxPrice = s200PriceOrNull(item.maxPrice);

  const year = typeof item.year === "number" && Number.isFinite(item.year) ? item.year : item.year || null;
  const km = typeof item.km === "number" && Number.isFinite(item.km) ? item.km : item.km || null;

  const commissionRate =
    typeof item.commissionRate === "number" && Number.isFinite(item.commissionRate) ? item.commissionRate : 0;

  const qualityScore =
    typeof item.qualityScore === "number" && Number.isFinite(item.qualityScore) ? item.qualityScore : 0.75;

  const metaScore = typeof item.metaScore === "number" && Number.isFinite(item.metaScore) ? item.metaScore : 0;

  // Affiliate best-effort (asla crash yok)
  let affiliateUrl = _safeStr(core.affiliateUrl || item.affiliateUrl || "");
  if (!affiliateUrl || isBadUrlS200(affiliateUrl)) {
    const built = buildAffiliateUrlSafe(providerKeyNorm, url, { query: _safeStr(query), providerFamily });
    affiliateUrl = built ? normalizeUrlS200(built, baseUrl) : "";
  }
  if (!affiliateUrl || isBadUrlS200(affiliateUrl)) affiliateUrl = null;

  return {
    ...core,
    id,
    title,

    // canonical provider: family (UI’da “sahibinden” görünsün, “sahibinden_vehicle” değil)
    provider: core.providerFamily || providerFamily,
    providerFamily: core.providerFamily || providerFamily,
    providerKey: core.providerKey || providerKeyNorm,

    description: item.description || core.description || "",
    location: item.location || "",
    image: item.image || item.thumbnail || core.image || "",

    brand: item.brand || "",
    model: item.model || "",
    year,
    km,
    color: item.color || "",
    transmission: item.transmission || "",
    fuel: item.fuel || "",
    horsepower: item.horsepower || null,

    minPrice,
    maxPrice,
    imageGallery: Array.isArray(item.images) ? item.images : [],

    availability: item.availability || "available",
    stockStatus: item.stockStatus || "available",
    commissionRate,

    affiliateUrl,
    deeplink: normalizeUrlS200(item.deeplink || item.deepLink || core.deeplink || url, baseUrl) || url,

    qualityScore,
    metaScore,

    fallback: Boolean(item.fallback),
    raw: item.raw || core.raw || { legacy: item },
  };
}

// ============================================================================
// Helper: detect placeholders / not-implemented
// ============================================================================
function isNotImplementedResponse(out) {
  if (!out || typeof out !== "object") return false;
  const err = String(out.error || "").toUpperCase();
  const note = String(out.note || out.message || "").toUpperCase();
  if (err.includes("NOT_IMPLEMENTED") || err.includes("IMPORT_FAILED")) return true;
  if (note.includes("NOT_IMPLEMENTED") || note.includes("PLACEHOLDER") || note.includes("IMPORT_FAILED")) return true;
  if (out?._meta?.stub) return true;
  return false;
}

// ============================================================================
// WRAP — S200 VEHICLE SALE FORMAT (ANA MOTOR UYUMLU + TIMEOUT)
// ============================================================================
async function callVehicleProvider(fn, query, options = {}) {
  if (typeof fn !== "function") {
    const err = new Error("NOT_IMPLEMENTED:adapter_fn_missing");
    err.code = "NOT_IMPLEMENTED";
    throw err;
  }
  try {
    return await fn(query, options);
  } catch {}
  try {
    return await fn({ query, q: query, ...options });
  } catch {}
  return await fn(query);
}

function wrapVehicleSaleAdapter(providerKey, fn, timeoutMs = 3500, weight = 1.0) {
  const providerKeyNorm = fix(providerKey) || "vehicle_sale";
  const providerFamily = providerKeyNorm.split("_")[0] || providerKeyNorm;

  const baseDomain = baseDomainForProvider(providerFamily);
  const baseUrl = `https://www.${baseDomain}/`;

  return {
    name: providerKeyNorm,
    provider: providerFamily,
    providerKey: providerKeyNorm,
    providerFamily, // ✅ drift fix
    timeoutMs,

    meta: {
      provider: providerFamily,
      providerKey: providerKeyNorm,
      providerFamily,
      providerType: "vehicle_sale",
      vertical: "vehicle_sale",
      category: "vehicle_sale",
      version: "S200",
      commissionPreferred: false,
      regionAffinity: ["TR"],
      weight,
      priority: weight,
      baseUrl, // ✅ ops + UI consistency
    },

    tags: ["vehicle_sale", "car", "automotive"],

    fn: async (query, options = {}) => {
      const boostedQuery = boostedVehicleQuery(query);
      const ts = Date.now();

      // ✅ Ensure kit diagnostics attribute logs to this adapter (not "unknown")
      return await withS200Ctx(
        { adapter: providerKeyNorm, name: providerKeyNorm, providerKey: providerKeyNorm, providerFamily, url: baseUrl },
        async () => {
          try {
            const opt2 = {
            ...(options && typeof options === "object" ? options : {}),
            group: "vehicle_sale",
            vertical: "vehicle_sale",
            category: "vehicle_sale",
            providerKey: providerKeyNorm,
            key: providerKeyNorm,
          };

            const out = await withTimeoutS200(
              Promise.resolve(callVehicleProvider(fn, boostedQuery, opt2)),
              timeoutMs,
              providerKeyNorm
            );

            const reportedOkFalse = Boolean(out && typeof out === "object" && out.ok === false);
            const reportedNotImpl = isNotImplementedResponse(out);

            const coerced = coerceItemsS200(out);
            const normalizedItems = Array.isArray(coerced)
              ? coerced.map((it) => normalizeVehicleSaleS200(it, providerKeyNorm, boostedQuery)).filter(Boolean)
              : [];

            // Hard fail: not implemented/import fail AND no real items
            if ((reportedOkFalse || reportedNotImpl) && normalizedItems.length === 0) {
              return {
                ok: false,
                items: [],
                count: 0,
                error: out?.error || (reportedNotImpl ? "NOT_IMPLEMENTED" : "ADAPTER_FAILED"),
                source: providerKeyNorm,
                provider: providerFamily,
                providerFamily,
                _meta: {
                  ...(out && typeof out === "object" ? out._meta : null),
                  adapter: providerKeyNorm,
                  providerFamily,
                  query: boostedQuery,
                  timestamp: ts,
                  vertical: "vehicle_sale",
                  baseUrl,
                  reportedOkFalse,
                  notImplemented: reportedNotImpl,
                },
              };
            }

            // ✅ Partial success: out.ok=false but items exist => ok remains false (observable)
            const ok = reportedOkFalse ? false : true;

            return {
              ok,
              items: normalizedItems,
              count: normalizedItems.length,
              source: providerKeyNorm,
              provider: providerFamily,
              providerFamily,
              _meta: {
                ...(out && typeof out === "object" ? out._meta : null),
                adapter: providerKeyNorm,
                providerFamily,
                query: boostedQuery,
                timestamp: ts,
                vertical: "vehicle_sale",
                baseUrl,
                reportedOkFalse,
                partialOkFalseWithItems: Boolean(reportedOkFalse && normalizedItems.length > 0),
                notImplemented: reportedNotImpl,
              },
            };
          } catch (err) {
            const msg = err?.message || String(err);
            console.warn(`❌ Vehicle Sale adapter error (${providerKeyNorm}):`, msg);

            return {
              ok: false,
              items: [],
              count: 0,
              error: msg || "VEHICLE_SALE_ADAPTER_ERROR",
              timeout: String(err?.name || "").toLowerCase().includes("timeout"),
              source: providerKeyNorm,
              provider: providerFamily,
              providerFamily,
              _meta: {
                adapter: providerKeyNorm,
                providerFamily,
                query: boostedQuery,
                timestamp: ts,
                error: msg,
                vertical: "vehicle_sale",
                baseUrl,
              },
            };
          }
        }
      );
    },
  };
}

// ============================================================================
// DİNAMİK IMPORTLAR TAMAMI
// ============================================================================
const searchSahibindenVehicle = await safeImport("../sahibindenAdapter.js", "searchSahibinden");
const searchSahibindenVehicleScrape = await safeImport("../sahibindenAdapter.js", "searchSahibindenScrape");
const searchSahibindenVehicleAdapter = await safeImport("../sahibindenAdapter.js", "searchSahibindenAdapter");

const searchArabam = await safeImport("../vehiclePlaceholders.js", "searchArabam");
const searchArabamScrape = await safeImport("../vehiclePlaceholders.js", "searchArabamScrape");
const searchArabamAdapter = await safeImport("../vehiclePlaceholders.js", "searchArabamAdapter");

const searchVavaCars = await safeImport("../vehiclePlaceholders.js", "searchVavaCars");
const searchVavaCarsScrape = await safeImport("../vehiclePlaceholders.js", "searchVavaCarsScrape");
const searchVavaCarsAdapter = await safeImport("../vehiclePlaceholders.js", "searchVavaCarsAdapter");

const searchLetgoCar = await safeImport("../vehiclePlaceholders.js", "searchLetgoCar");
const searchLetgoCarScrape = await safeImport("../vehiclePlaceholders.js", "searchLetgoCarScrape");
const searchLetgoCarAdapter = await safeImport("../vehiclePlaceholders.js", "searchLetgoCarAdapter");

const searchOtoNet = await safeImport("../vehiclePlaceholders.js", "searchOtoNet");
const searchOtoNetScrape = await safeImport("../vehiclePlaceholders.js", "searchOtoNetScrape");
const searchOtoNetAdapter = await safeImport("../vehiclePlaceholders.js", "searchOtoNetAdapter");

// ============================================================================
// VEHICLE CATEGORIES HELPER
// ============================================================================
export const vehicleCategories = {
  sedan: {
    name: "Sedan",
    priceRange: [50000, 300000],
    brands: ["Toyota", "Honda", "Volkswagen", "Ford", "Renault"],
    keywords: ["sedan", "binek", "otomobil", "araba"],
  },
  suv: {
    name: "SUV",
    priceRange: [100000, 500000],
    brands: ["BMW", "Mercedes", "Audi", "Land Rover", "Jeep"],
    keywords: ["suv", "4x4", "jip", "crossover"],
  },
  hatchback: {
    name: "Hatchback",
    priceRange: [40000, 200000],
    brands: ["Fiat", "Opel", "Peugeot", "Citroen", "Mini"],
    keywords: ["hatchback", "compact", "küçük"],
  },
  commercial: {
    name: "Ticari Araç",
    priceRange: [80000, 350000],
    brands: ["Ford", "Mercedes", "Fiat", "Renault", "Iveco"],
    keywords: ["ticari", "kamyonet", "van", "panelvan", "minibüs"],
  },
  motorcycle: {
    name: "Motosiklet",
    priceRange: [20000, 150000],
    brands: ["Honda", "Yamaha", "Kawasaki", "BMW", "Ducati"],
    keywords: ["motosiklet", "motor", "scooter", "bisiklet"],
  },
  luxury: {
    name: "Lüks Araç",
    priceRange: [300000, 1000000],
    brands: ["Mercedes-Benz", "BMW", "Audi", "Porsche", "Jaguar"],
    keywords: ["lüks", "premium", "luxury", "spor"],
  },
};

export function detectVehicleCategory(query) {
  const q = String(query || "").toLowerCase();
  for (const [category, info] of Object.entries(vehicleCategories)) {
    if (info.keywords.some((keyword) => q.includes(keyword))) return category;
  }
  return "sedan";
}

// ============================================================================
// VEHICLE SALE ADAPTERS PACK — FINAL (ANA MOTOR FORMATINDA)
// ============================================================================
export const vehicleSaleAdapters = [
  wrapVehicleSaleAdapter("sahibinden_vehicle", searchSahibindenVehicle, 4200, 1.5),
  wrapVehicleSaleAdapter("sahibinden_vehicle_scrape", searchSahibindenVehicleScrape, 6000, 1.4),
  wrapVehicleSaleAdapter("sahibinden_vehicle_adapter", searchSahibindenVehicleAdapter, 4200, 1.45),

  wrapVehicleSaleAdapter("arabam_vehicle", searchArabam, 3200, 1.0),
  wrapVehicleSaleAdapter("arabam_vehicle_scrape", searchArabamScrape, 3200, 0.9),
  wrapVehicleSaleAdapter("arabam_vehicle_adapter", searchArabamAdapter, 3200, 0.95),

  wrapVehicleSaleAdapter("vavacars_vehicle", searchVavaCars, 3000, 0.95),
  wrapVehicleSaleAdapter("vavacars_vehicle_scrape", searchVavaCarsScrape, 3000, 0.88),
  wrapVehicleSaleAdapter("vavacars_vehicle_adapter", searchVavaCarsAdapter, 3000, 0.9),

  wrapVehicleSaleAdapter("letgo_vehicle", searchLetgoCar, 3000, 0.95),
  wrapVehicleSaleAdapter("letgo_vehicle_scrape", searchLetgoCarScrape, 3000, 0.88),
  wrapVehicleSaleAdapter("letgo_vehicle_adapter", searchLetgoCarAdapter, 3000, 0.9),

  wrapVehicleSaleAdapter("otonet_vehicle", searchOtoNet, 3000, 0.95),
  wrapVehicleSaleAdapter("otonet_vehicle_scrape", searchOtoNetScrape, 3000, 0.88),
  wrapVehicleSaleAdapter("otonet_vehicle_adapter", searchOtoNetAdapter, 3000, 0.9),
];

export const vehicleSaleAdapterFns = vehicleSaleAdapters.map((a) => a.fn);

// ============================================================================
// UNIFIED VEHICLE SEARCH (dedupe by id) — honest ok
// ============================================================================
export async function searchVehicles(query, options = {}) {
  const vehicleCategory = detectVehicleCategory(query);
  const location = options?.location || "";

  const results = [];
  const seen = new Set();

  let adaptersRun = 0;
  let adaptersOk = 0;
  let adaptersFail = 0;
  let adaptersTimeout = 0;
  let adaptersNotImpl = 0;

  const promises = vehicleSaleAdapters.map(async (adapter) => {
    try {
      adaptersRun += 1;
      const result = await adapter.fn(query, options);

      const ok = result?.ok === true;
      if (ok) adaptersOk += 1;
      else {
        adaptersFail += 1;
        if (result?.timeout) adaptersTimeout += 1;
        if (result?._meta?.notImplemented) adaptersNotImpl += 1;
      }

      const items = Array.isArray(result?.items) ? result.items : [];
      for (const it of items) {
        const id = String(it?.id || "").trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        results.push(it);
      }
    } catch (err) {
      adaptersRun += 1;
      adaptersFail += 1;
      console.warn(`  ${adapter.name} hatası:`, err?.message || err);
    }
  });

  await Promise.allSettled(promises);

  const categoryInfo = vehicleCategories[vehicleCategory];

  const filteredResults = results.filter((item) => {
    if (vehicleCategory === "sedan") return true;

    const title = (item.title || "").toLowerCase();
    const desc = (item.description || "").toLowerCase();
    const brand = (item.brand || "").toLowerCase();
    const model = (item.model || "").toLowerCase();

    return (
      categoryInfo.keywords.some((k) => title.includes(k) || desc.includes(k) || model.includes(k)) ||
      categoryInfo.brands.some((b) => title.includes(b.toLowerCase()) || brand.includes(b.toLowerCase()))
    );
  });

  const finalItems = filteredResults.length ? filteredResults : results;
  const ok = finalItems.length > 0 || adaptersOk > 0;

  return {
    ok,
    items: finalItems,
    count: finalItems.length,
    vehicleCategory,
    categoryInfo: categoryInfo?.name || vehicleCategory,
    priceRange: categoryInfo?.priceRange || null,
    source: "vehicle_sale_search",
    _meta: {
      query,
      location,
      timestamp: Date.now(),
      adaptersRun,
      adaptersOk,
      adaptersFail,
      adaptersTimeout,
      adaptersNotImplemented: adaptersNotImpl,
      usedFallbackToRaw: filteredResults.length === 0 && results.length > 0,
    },
  };
}

// ============================================================================
// TEST
// ============================================================================
export async function testVehicleSaleAdapters() {
  console.log("🚗 Vehicle Sale Adapters Test Başlıyor...");
  console.log(`Toplam ${vehicleSaleAdapters.length} adapter yüklendi`);

  const testQueries = ["ikinci el araba", "suv satılık", "ticari araç", "motosiklet", "bmw 3 serisi"];

  for (const query of testQueries) {
    console.log(`\n🔍 Test sorgusu: "${query}"`);
    console.log(`  Tespit edilen kategori: ${detectVehicleCategory(query)}`);

    const providers = new Set();
    const testAdapters = [];

    for (const adapter of vehicleSaleAdapters) {
      const provider = adapter.name.split("_")[0];
      if (!providers.has(provider) && providers.size < 3) {
        providers.add(provider);
        testAdapters.push(adapter);
      }
    }

    for (const adapter of testAdapters) {
      try {
        const result = await adapter.fn(query, { region: "TR", location: "İstanbul" });
        console.log(`  ${adapter.name}: ${result?.ok ? "✅" : "❌"} ${result?.items?.length || 0} sonuç`);

        if (result?.items?.[0]) {
          const item = result.items[0];
          console.log(`    Örnek: ${item.title} - ${item.price} TL (${item.year} model)`);
          if (isBadUrlS200(item.url)) console.log("    ⚠️ UYARI: URL kötü görünüyor (kit zaten drop etmeli)");
        } else if (result?.ok === false) {
          console.log(`    ⛔ ${result.error || "NOT_IMPLEMENTED"}`);
        }
      } catch (err) {
        console.log(`  ${adapter.name}: ❌ HATA: ${err?.message || err}`);
      }
    }
  }

  console.log("\n🎉 Vehicle Sale Adapters Test Tamamlandı!");
}

// ============================================================================
// STATS
// ============================================================================
export const vehicleSaleAdapterStats = {
  totalAdapters: vehicleSaleAdapters.length,
  vehicleCategories,
  timeouts: vehicleSaleAdapters.map((a) => a.timeoutMs),
  providers: vehicleSaleAdapters
    .map((a) => a.name.split("_")[0])
    .filter((v, i, a) => a.indexOf(v) === i),
  totalWeight: vehicleSaleAdapters.reduce((sum, a) => sum + (a.meta?.weight || 1), 0),
};

// ============================================================================
// DEFAULT EXPORT
// ============================================================================
export default vehicleSaleAdapters;

// ============================================================================
// S200 TITAN HARMONY V11.3 → KIT-LOCKED (DRIFT STOPPER)
// ============================================================================

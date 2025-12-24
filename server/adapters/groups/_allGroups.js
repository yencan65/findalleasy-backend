// server/adapters/groups/_allGroups.js
// ======================================================================
//  S120/TITAN — UNIFIED ADAPTER GROUP REGISTRY (S200 FINAL)
//  ZERO DELETE · ZERO DRIFT · FULL S200 ENGINE COMPATIBILITY
//  ✅ ZERO-CRASH: group import fail -> empty array (no hard crash)
//  ✅ IDENTITY FIX: unknown name/providerKey -> stabilized + debuggable
// ======================================================================

/**
 * Bu dosya sadece "group exports" kilidi.
 * Product için doğru kaynak: ./productAdapters.js
 * Fallback: legacy/raw adapter modülleri (dinamik import + S200 wrapper)
 *
 * NOT:
 * - Burada statik import YOK. Çünkü missing file -> tüm engine çöker.
 * - Tüm gruplar "export let" ile live binding; module init sırasında doldurulur.
 */

const IS_PROD = String(process.env.NODE_ENV || "").toLowerCase() === "production";
const FINDALLEASY_ALLOW_STUBS = String(process.env.FINDALLEASY_ALLOW_STUBS || "") === "1";

// SerpApi presence (optional)
const HAS_SERPAPI = Boolean(
  process.env.SERPAPI_KEY || process.env.SERPAPI_API_KEY || process.env.SERP_API_KEY
);
const ALLOW_STUBS = !IS_PROD && FINDALLEASY_ALLOW_STUBS;

// ------------------------------------------------------------
//  EXPORT LOCKS (S200 engine bunları okur)
// ------------------------------------------------------------
export let productAdapters = [];

export let lawyerAdapters = [];
export let marketAdapters = [];
export let fashionAdapters = [];
export let foodAdapters = [];
export let travelAdapters = [];
export let carRentalAdapters = [];
export let tourAdapters = [];
export let spaWellnessAdapters = [];
export let estateAdapters = [];
export let insuranceAdapters = [];
export let healthAdapters = [];
export let checkupAdapters = [];
export let educationAdapters = [];
export let eventAdapters = [];
export let officeAdapters = [];
export let craftAdapters = [];
export let rentalAdapters = [];
export let repairAdapters = [];
export let vehicleSaleAdapters = [];

// ------------------------------------------------------------
// ---- internal helpers (crash yok, drift-safe)
// ------------------------------------------------------------
function isFn(x) {
  return typeof x === "function";
}
function isArr(x) {
  return Array.isArray(x);
}
function isObj(x) {
  return !!x && typeof x === "object";
}

function coerceItems(out) {
  if (isArr(out)) return out;
  if (out && isArr(out.items)) return out.items;
  if (out && isArr(out.results)) return out.results;
  if (out && isArr(out.data)) return out.data;
  return [];
}

// ------------------------------------------------------------
// ✅ S200 IDENTITY NORMALIZER (UNKNOWN FIX) — ZERO DELETE
// ------------------------------------------------------------
const __fixKey = (v) =>
  String(v ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "unknown";

const __isUnknownKey = (v) => __fixKey(v) === "unknown";

function __familyFromTarget(targetName) {
  const base = String(targetName || "")
    .replace(/adapters$/i, "")
    .trim();
  const k = __fixKey(base || "group");
  return k === "unknown" ? "group" : k;
}

function __normalizeAdapterIdentities(list, targetName) {
  if (!isArr(list)) return list;

  const fam = __familyFromTarget(targetName);

  for (let i = 0; i < list.length; i++) {
    const a = list[i];

    // function adapters (rare) — don't convert type (drift risk), just annotate best-effort
    if (isFn(a)) {
      try {
        if (__isUnknownKey(a.providerKey)) a.providerKey = `${fam}_${i}`;
        if (__isUnknownKey(a.provider)) a.provider = fam; // provider = family (unknown kalmasın)
        if (__isUnknownKey(a.adapterName)) a.adapterName = a.providerKey || `${fam}_${i}`;
        if (__isUnknownKey(a.providerFamily)) a.providerFamily = fam;
      } catch {}
      continue;
    }

    if (!isObj(a)) continue;

    const meta = isObj(a.meta) ? a.meta : {};
    const tags = isArr(a.tags) ? a.tags : [];

    const metaProviderFamilyRaw = meta.providerFamily || a.providerFamily || fam;
    const metaProviderFamily = __fixKey(metaProviderFamilyRaw);
    const providerFamily = metaProviderFamily === "unknown" ? fam : metaProviderFamily;

    // candidate selection (skip "unknown" explicitly)
    const cand =
      (!__isUnknownKey(meta.providerKey) ? meta.providerKey : null) ||
      (!__isUnknownKey(a.providerKey) ? a.providerKey : null) ||
      (!__isUnknownKey(meta.key) ? meta.key : null) ||
      (!__isUnknownKey(meta.name) ? meta.name : null) ||
      (!__isUnknownKey(a.name) ? a.name : null) ||
      (!__isUnknownKey(a.id) ? a.id : null) ||
      // provider alanlarını EN SON dene (provider=family olabilir)
      (!__isUnknownKey(meta.provider) ? meta.provider : null) ||
      (!__isUnknownKey(a.provider) ? a.provider : null) ||
      (tags.length ? tags[0] : null) ||
      "";

    let pk = __fixKey(cand);

    // stabilize if still unknown/meaningless
    if (!pk || pk === "unknown" || pk === providerFamily || pk === fam) pk = `${providerFamily}_${i}`;

    const nm = !__isUnknownKey(a.name)
      ? a.name
      : !__isUnknownKey(meta.name)
      ? meta.name
      : pk;

    // top-level fields
    if (__isUnknownKey(a.providerKey)) a.providerKey = pk;
    if (__isUnknownKey(a.provider)) a.provider = providerFamily; // provider = family
    if (__isUnknownKey(a.name)) a.name = nm;

    // meta fields
    a.meta = {
      ...meta,
      providerFamily: meta.providerFamily || providerFamily,
      providerKey: __isUnknownKey(meta.providerKey) ? pk : meta.providerKey,
      provider: __isUnknownKey(meta.provider) ? a.provider : meta.provider,
      name: __isUnknownKey(meta.name) ? nm : meta.name,
      key: __isUnknownKey(meta.key) ? pk : meta.key,
    };

    // Some group files store meta.providerFamily but top-level providerFamily may be used elsewhere
    if (__isUnknownKey(a.providerFamily)) {
      a.providerFamily = a.meta.providerFamily || providerFamily;
    }

    // Final safety: ensure fn exists if object adapter
    if (!isFn(a.fn) && typeof a.fn !== "string") {
      // leave as-is; caller filter should have removed it
    }
  }

  return list;
}

// ------------------------------------------------------------
// S200 wrapper: motorun "items-meta dual compat" beklentisine uygun
// ✅ returns adapter object {fn,...} to keep identity visible
// ------------------------------------------------------------
function wrapAsS200(fn, meta) {
  const providerFamilyRaw = meta?.providerFamily || meta?.provider || "group";
  const providerFamily = __fixKey(providerFamilyRaw);
  const fam = providerFamily === "unknown" ? "group" : providerFamily;

  const keyRaw = meta?.key || meta?.providerKey || meta?.name || fam;
  let providerKey = __fixKey(keyRaw);
  if (!providerKey || providerKey === "unknown") providerKey = `${fam}_0`;

  const name = !__isUnknownKey(meta?.name) ? meta.name : providerKey;
  const provider = !__isUnknownKey(meta?.provider) ? meta.provider : fam;

  const wrappedFn = async (query, opts = {}) => {
    try {
      const out = await fn(query, opts);

      // Zaten S200 wrapped ise elleme
      if (out && typeof out === "object" && isArr(out.items) && typeof out.ok === "boolean") {
        return out;
      }

      const items = coerceItems(out);
      return {
        ok: true,
        items,
        count: items.length,
        source: providerKey,
        provider,
        providerKey,
        providerFamily: fam,
        _meta: {
          wrappedS200: true,
          adapterName: name,
          key: providerKey,
          providerFamily: fam,
        },
      };
    } catch (e) {
      return {
        ok: false,
        items: [],
        count: 0,
        source: providerKey,
        provider,
        providerKey,
        providerFamily: fam,
        error: e?.message || String(e || "ERROR"),
        _meta: {
          wrappedS200: true,
          adapterName: name,
          key: providerKey,
          providerFamily: fam,
          crashed: true,
        },
      };
    }
  };

  // annotate fn for debuggers
  wrappedFn.adapterName = name;
  wrappedFn.provider = provider;
  wrappedFn.providerKey = providerKey;
  wrappedFn.providerFamily = fam;
  wrappedFn.__s200Wrapped = true;

  const adapterObj = {
    name,
    provider,
    providerKey,
    providerFamily: fam,
    meta: {
     ...(isObj(meta) ? meta : {}),

      key: providerKey,
      name,
      provider,
      providerKey,
      providerFamily: fam,
    },
    fn: wrappedFn,
  };

  // make sure identity is never unknown
  __normalizeAdapterIdentities([adapterObj], `${fam}Adapters`);

  return adapterObj;
}

async function safeImport(spec) {
  try {
    const mod = await import(spec);
    return { ok: true, mod };
  } catch (e) {
    return { ok: false, error: e };
  }
}

function pickFnFromModule(mod, preferredNames = []) {
  if (!mod) return null;

  // 1) preferred named exports
  for (const n of preferredNames) {
    if (isFn(mod[n])) return mod[n];
  }

  // 2) default export (function)
  if (isFn(mod.default)) return mod.default;

  // 3) first function export
  for (const k of Object.keys(mod)) {
    if (isFn(mod[k])) return mod[k];
  }

  return null;
}

function pickArrayFromModule(mod, exportName) {
  if (!mod) return null;

  // 1) named export
  if (exportName && isArr(mod[exportName])) return mod[exportName];

  // 2) default export array
  if (isArr(mod.default)) return mod.default;

  // 3) first array export
  for (const k of Object.keys(mod)) {
    if (isArr(mod[k])) return mod[k];
  }

  return null;
}

function normalizeAdapterList(list) {
  if (!isArr(list)) return [];
  // S200 engine: adapter elemanı function | object {fn} | string olabilir
  return list.filter((x) => {
    if (!x) return false;
    if (isFn(x)) return true;
    if (typeof x === "string" && x.trim()) return true;
    if (x && typeof x === "object") {
      if (isFn(x.fn)) return true;
      if (typeof x.fn === "string" && x.fn.trim()) return true;
      return false;
    }
    return false;
  });
}

async function loadGroupInto(targetName, spec, exportName) {
  const r = await safeImport(spec);
  if (!r.ok) {
    if (!IS_PROD) {
      console.warn(`⚠️ group import fail → ${targetName} (${spec})`, r.error?.message || r.error);
    }
    return [];
  }

  const arr = pickArrayFromModule(r.mod, exportName);
  if (!arr) return [];

  const normalized = normalizeAdapterList(arr);

  // ✅ identity normalize to kill "unknown"
  __normalizeAdapterIdentities(normalized, targetName);

  return normalized;
}

// ------------------------------------------------------------
//  PRODUCT RESOLVE (primary + fallback legacy wrappers)
// ------------------------------------------------------------
async function resolveProductAdapters() {
  // ✅ 1) Doğru kaynak: ./productAdapters.js (S200 group)
  {
    const r = await safeImport("./productAdapters.js");
    if (r.ok) {
      const m = r.mod || {};
      const arr = pickArrayFromModule(m, "productAdapters");
      if (isArr(arr) && arr.length) {
        const normalized = normalizeAdapterList(arr);
        __normalizeAdapterIdentities(normalized, "productAdapters");
        if (normalized.length) return normalized;
      }
    }
  }

  // ✅ 2) Fallback: legacy/raw product adapter modülleri (dinamik import)
  const legacySpecs = [
    { key: "trendyol", spec: "../trendyolAdapter.js", prefer: ["searchTrendyolAdapter"] },
    { key: "hepsiburada", spec: "../hepsiburadaAdapter.js", prefer: ["searchHepsiburadaAdapter"] },
    { key: "hepsiburada_scraper", spec: "../hepsiburadaScraper.js", prefer: ["searchHepsiburadaAdapter"] },
    { key: "n11", spec: "../n11Adapter.js", prefer: ["searchN11Adapter"] },
    { key: "amazon", spec: "../amazonAdapter.js", prefer: ["searchAmazonAdapter"] },
    { key: "a101", spec: "../a101Adapter.js", prefer: ["searchA101Adapter"] },
  ];

  const out = [];
  for (const it of legacySpecs) {
    // eslint-disable-next-line no-await-in-loop
    const r = await safeImport(it.spec);
    if (!r.ok) continue;

    const fn = pickFnFromModule(r.mod, it.prefer);
    if (!fn) continue;

    out.push(
      wrapAsS200(fn, {
        key: it.key,
        name: it.key,
        provider: "product",
        providerFamily: "product",
      })
    );
  }

  const normalized = normalizeAdapterList(out);
  __normalizeAdapterIdentities(normalized, "productAdapters");
  return normalized;
}

// ------------------------------------------------------------
//  TOP-LEVEL INIT (module load anında kilitle)
// ------------------------------------------------------------
try {
  // ✅ groups (missing file -> [])
  lawyerAdapters = await loadGroupInto("lawyerAdapters", "./lawyerAdapters.js", "lawyerAdapters");
  marketAdapters = await loadGroupInto("marketAdapters", "./marketAdapters.js", "marketAdapters");
  fashionAdapters = await loadGroupInto("fashionAdapters", "./fashionAdapters.js", "fashionAdapters");
  foodAdapters = await loadGroupInto("foodAdapters", "./foodAdapters.js", "foodAdapters");
  travelAdapters = await loadGroupInto("travelAdapters", "./travelAdapters.js", "travelAdapters");
  carRentalAdapters = await loadGroupInto("carRentalAdapters", "./carRentalAdapters.js", "carRentalAdapters");
  tourAdapters = await loadGroupInto("tourAdapters", "./tourAdapters.js", "tourAdapters");

  // ✅ smoke-test killer fix: spaWellnessAdapters.js yoksa artık patlamaz
  spaWellnessAdapters = await loadGroupInto("spaWellnessAdapters", "./spaWellnessAdapters.js", "spaWellnessAdapters");

  estateAdapters = await loadGroupInto("estateAdapters", "./estateAdapters.js", "estateAdapters");
  insuranceAdapters = await loadGroupInto("insuranceAdapters", "./insuranceAdapters.js", "insuranceAdapters");
  healthAdapters = await loadGroupInto("healthAdapters", "./healthAdapters.js", "healthAdapters");
  checkupAdapters = await loadGroupInto("checkupAdapters", "./checkupAdapters.js", "checkupAdapters");
  educationAdapters = await loadGroupInto("educationAdapters", "./educationAdapters.js", "educationAdapters");
  eventAdapters = await loadGroupInto("eventAdapters", "./eventAdapters.js", "eventAdapters");
  officeAdapters = await loadGroupInto("officeAdapters", "./officeAdapters.js", "officeAdapters");
  craftAdapters = await loadGroupInto("craftAdapters", "./craftAdapters.js", "craftAdapters");
  rentalAdapters = await loadGroupInto("rentalAdapters", "./rentalAdapters.js", "rentalAdapters");
  repairAdapters = await loadGroupInto("repairAdapters", "./repairAdapters.js", "repairAdapters");
  vehicleSaleAdapters = await loadGroupInto("vehicleSaleAdapters", "./vehicleSaleAdapters.js", "vehicleSaleAdapters");

  // ✅ productAdapters resolve
  productAdapters = await resolveProductAdapters();

  // Son emniyet: boş kalırsa engine "product" için hiç adapter görmez
  if (!isArr(productAdapters)) productAdapters = [];

  __normalizeAdapterIdentities(productAdapters, "productAdapters");

  if (!productAdapters.length && ALLOW_STUBS) {
    // DEV-only: import kırıkken engine yine de koşsun diye “empty ok” stub
    productAdapters = [
      wrapAsS200(async () => [], {
        key: "product_stub",
        name: "product_stub",
        provider: "product",
        providerFamily: "product",
      }),
    ];
    __normalizeAdapterIdentities(productAdapters, "productAdapters");
  }
} catch (e) {
  if (!IS_PROD) console.warn("⚠️ TITAN group registry init failed:", e?.message || e);
  // her şeyi güvenli boş bırak
  productAdapters = [];
  lawyerAdapters = [];
  marketAdapters = [];
  fashionAdapters = [];
  foodAdapters = [];
  travelAdapters = [];
  carRentalAdapters = [];
  tourAdapters = [];
  spaWellnessAdapters = [];
  estateAdapters = [];
  insuranceAdapters = [];
  healthAdapters = [];
  checkupAdapters = [];
  educationAdapters = [];
  eventAdapters = [];
  officeAdapters = [];
  craftAdapters = [];
  rentalAdapters = [];
  repairAdapters = [];
  vehicleSaleAdapters = [];
}

// ---------------------------------------------------------------------------
// Alias exports (route/category drift guard) — ZERO DELETE
// - These are live bindings (same underlying arrays)
// ---------------------------------------------------------------------------
export { rentalAdapters as rentAdapters };
export { rentalAdapters as vehicleRentalAdapters };
export { rentalAdapters as aracKiralamaAdapters };
export { carRentalAdapters as rentacarAdapters };

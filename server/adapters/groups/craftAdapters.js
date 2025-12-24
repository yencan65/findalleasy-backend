// server/adapters/groups/craftAdapters.js
// ============================================================================
// CRAFT ADAPTER PACK — S200 KIT-DRIVEN FINAL PATCHED V1.3 (HARDENED)
// ZERO DELETE • S200 contract lock via s200AdapterKit
// PROD: import fail / adapter fail => empty (NO STUB) ✅ HARD-LOCKED
// DEV: stubs via FINDALLEASY_ALLOW_STUBS=1 (NO FAKE PRICE)
// Timeout guard (kit) + provider canonical + URL sanitize (kit) + stable id (kit)
// ============================================================================

import {
  makeSafeImport,
  withTimeout as kitWithTimeout,
  runWithCooldownS200, // ✅ ADDED
  TimeoutError,
  coerceItemsS200,
  normalizeItemS200,
  safeStr,
  fixKey,
  isBadUrlS200,
  normalizeUrlS200,
  stableIdS200,
  pickUrlS200,
} from "../../core/s200AdapterKit.js";

// ----------------------------------------------------------------------------
// STUB HARD-LOCK (prod'da ASLA stub yok)
// ----------------------------------------------------------------------------
const FINDALLEASY_ALLOW_STUBS = String(process.env.FINDALLEASY_ALLOW_STUBS || "") === "1";
const IS_PROD = String(process.env.NODE_ENV || "").toLowerCase() === "production";
const ALLOW_STUBS = !IS_PROD && FINDALLEASY_ALLOW_STUBS;

// ----------------------------------------------------------------------------
// Optional provider normalizer (if exists) — NO CRASH
// ----------------------------------------------------------------------------
let normalizeProviderKeyS9 = null;
try {
  const mod = await import("../../core/providerMasterS9.js");
  if (typeof mod?.normalizeProviderKeyS9 === "function") normalizeProviderKeyS9 = mod.normalizeProviderKeyS9;
} catch {
  // ok
}

const fix = (v) => String(v || "").toLowerCase().trim();

const canonicalProviderKey = (raw, fallback = "craft") => {
  const base = fix(raw || fallback);
  if (!base || base === "unknown" || base === "unknown_adapter" || base === "na" || base === "n/a") {
    return fix(fallback) || "craft";
  }

  // Preserve suffix to avoid collisions (googleplaces_craft vs googleplaces_education, etc.)
  const parts = base.split("_").filter(Boolean);
  const fam = parts[0] || base;
  const suffix = parts.slice(1).join("_");

  let famNorm = fam;

  try {
    if (typeof normalizeProviderKeyS9 === "function") {
      const n = fix(normalizeProviderKeyS9(fam));
      if (n && n !== "unknown" && n !== "unknown_adapter" && n !== "na" && n !== "n/a") famNorm = n;
    }
  } catch {}

  const key = suffix ? `${famNorm}_${suffix}` : famNorm;
  return key && key !== "unknown" ? key : (fix(fallback) || "craft");
};

const providerFamilyFromKey = (providerKey) => {
  const pk = canonicalProviderKey(providerKey, "craft");
  const fam0 = (pk.split("_")[0] || pk).trim() || "craft";
  return canonicalProviderKey(fam0, fam0) || "craft";
};

function isDiscoveryProvider(providerKey) {
  const pk = canonicalProviderKey(providerKey, providerKey);
  return pk.includes("googleplaces") || pk.includes("osm") || pk.includes("serpapi");
}

function normalizeTitle(t = "") {
  return String(t).replace(/\s+/g, " ").trim();
}

// Query-aware fallbacks
const fallbackSearchUrl = (providerKey, query) => {
  const q = encodeURIComponent(String(query || "").trim() || "usta");
  const pk = canonicalProviderKey(providerKey, providerKey);

  if (pk.includes("googleplaces")) return `https://www.google.com/maps/search/?api=1&query=${q}`;
  if (pk.includes("osm")) return `https://www.openstreetmap.org/search?query=${q}`;
  if (pk.includes("serpapi")) return `https://www.google.com/search?q=${q}`;

  return "https://www.findalleasy.com/";
};

// ============================================================================
// SAFE IMPORT — KIT BASED (tek davranış) + HARD-LOCK prod
// ============================================================================
const kitSafeImport = makeSafeImport(import.meta.url, {
  allowStubs: Boolean(ALLOW_STUBS), // ✅ PROD'da ASLA stub
  defaultFn: async () => [],
  stubFactory: (providerGuess) => {
    // DEV: minimal stub (NO FAKE PRICE)
    const pk = canonicalProviderKey(providerGuess, "craft");
    const providerFamily = providerFamilyFromKey(pk);

    return async (query, options = {}) => {
      const q = String(query || "").trim();
      const url = normalizeUrlS200(fallbackSearchUrl(pk, q), "") || "https://www.findalleasy.com/";

      // fallback=true => kit normalizeItemS200 "real url" kilidine takılmaz (DEV only)
      const core = normalizeItemS200(
        {
          id: stableIdS200(pk, url, `${q || "usta hizmeti"} - ${providerFamily} (stub)`),
          title: `${q || "usta hizmeti"} - ${providerFamily} (stub)`,
          url,
          price: null,
          finalPrice: null,
          optimizedPrice: null,
          currency: "TRY",
          fallback: true,
          raw: { stub: true, providerGuess },
        },
        pk,
        {
          vertical: "craft",
          category: "craft",
          providerFamily,
          region: "TR",
          baseUrl: url,
          fallbackUrl: url,
          requireRealUrlCandidate: false,
          titleFallback: `${providerFamily} sonucu`,
        }
      );

      if (!core) return [];

      return [
        {
          ...core,
          provider: providerFamily,
          providerKey: pk,
          providerFamily,
          providerType: "craft_service",
          serviceType: detectCraftServiceType(q),
          city: String(options?.city || "").trim(),
          district: String(options?.district || "").trim(),
          version: "S200",
        },
      ];
    };
  },
});

async function safeImport(modulePath, exportName = null) {
  // eski signature korunur + zero-crash
  try {
    return await kitSafeImport(modulePath, exportName);
  } catch (e) {
    console.warn(`⚠️ Craft safeImport fail: ${modulePath}`, e?.message || e);
    return async () => [];
  }
}

// ============================================================================
// CRAFT SERVICE CATEGORY HELPER (kept)
// ============================================================================
export const craftServiceCategories = {
  tamir: ["tamir", "onarım", "bakım", "servis", "arıza"],
  elektrik: ["elektrik", "tesisat", "priz", "sigorta", "kablo"],
  su: ["su", "tesisat", "musluk", "boru", "lavabo", "tuvalet"],
  marangoz: ["marangoz", "mobilya", "ahşap", "dolap", "masa", "sandalye"],
  boya: ["boya", "badana", "sıva", "alçı", "duvar"],
  cam: ["cam", "pencere", "vitrin", "kırık cam"],
  kilit: ["kilit", "anahtar", "kapı", "çilingir"],
  iklim: ["klima", "ısıtma", "soğutma", "havalandırma"],
  beyaz_esya: ["beyaz eşya", "çamaşır makinesi", "bulaşık makinesi", "buzdolabı", "fırın"],
  temizlik: ["temizlik", "halı yıkama", "pencere temizliği", "genel temizlik"],
};

export function detectCraftServiceType(query) {
  const q = String(query || "").toLowerCase();
  for (const [category, keywords] of Object.entries(craftServiceCategories)) {
    if (keywords.some((k) => q.includes(String(k).toLowerCase()))) return category;
  }
  return "genel";
}

// ============================================================================
// PRICE SCRUB (discovery providers must NEVER carry price)
// ============================================================================
function scrubAllPriceKeys(x) {
  if (!x || typeof x !== "object") return x;
  const o = { ...x };

  const keys = [
    "price",
    "finalPrice",
    "optimizedPrice",
    "amount",
    "rate",
    "minPrice",
    "maxPrice",
    "totalPrice",
    "total_price",
  ];
  for (const k of keys) o[k] = null;

  if (o.raw && typeof o.raw === "object") {
    o.raw = { ...o.raw };
    for (const k of keys) o.raw[k] = null;
  }
  return o;
}

// ============================================================================
// NORMALIZER — KIT CORE + craft extras
// ============================================================================
function normalizeCraftS200(item, providerKey, adapterName = providerKey, queryForFallback = "", options = {}) {
  if (!item) return null;

  const pk = canonicalProviderKey(providerKey, "craft");
  const providerFamily = providerFamilyFromKey(pk);
  const q = String(queryForFallback || "").trim();

  // priority-safe url pick (kit) + absolute normalize
  const picked = pickUrlS200(item);
  const baseUrl = fallbackSearchUrl(pk, q);

  const input0 = isDiscoveryProvider(pk) ? scrubAllPriceKeys(item) : item;

  // strengthen: if adapter forgot url, inject picked candidate
  const injectedUrl = normalizeUrlS200(String(input0.url || picked || ""), baseUrl) || "";
  const input = {
    ...input0,
    url: input0.url || injectedUrl || input0.link || input0.href || input0.website || "",
    originUrl: input0.originUrl || injectedUrl || "",
    finalUrl: input0.finalUrl || injectedUrl || "",
  };

  // requireRealUrlCandidate=true prevents "search url" masquerading as a listing
  const core = normalizeItemS200(input, pk, {
    vertical: "craft",
    category: "craft",
    providerFamily,
    region: String(options?.region || input?.region || "TR"),
    baseUrl,
    fallbackUrl: baseUrl,
    requireRealUrlCandidate: true,
    titleFallback: `${providerFamily} sonucu`,
  });

  if (!core) return null;

  const title = normalizeTitle(core.title);
  if (!title) return null;

  // discovery providers: hard force price null (no leakage)
  const forceNoPrice = isDiscoveryProvider(pk);

  const address = String(
    input.address || input.location || input.fullAddress || input.formattedAddress || ""
  ).trim();

  const city = String(input.city || options?.city || "").trim();
  const district = String(input.district || options?.district || "").trim();
  const neighborhood = String(input.neighborhood || "").trim();

  const serviceType = String(input.serviceType || input.subcategory || detectCraftServiceType(q)).trim() || "genel";

  const id = String(core.id || "").trim() || stableIdS200(pk, core.url, title);

  return {
    ...core,

    id,
    title,

    provider: providerFamily,
    providerKey: pk,
    providerFamily,

    // strict price behavior
    price: forceNoPrice ? null : core.price ?? null,
    finalPrice: forceNoPrice ? null : core.finalPrice ?? null,
    optimizedPrice: forceNoPrice ? null : core.optimizedPrice ?? null,

    providerType: "craft_service",
    serviceType,
    address,
    city,
    district,
    neighborhood,

    adapterSource: adapterName || pk,
    version: "S200",
  };
}

// ============================================================================
// WRAP — Motor format: returns { ok, items, count, source, _meta }
// ============================================================================
function wrapCraftAdapter(providerKey, fn, timeoutMs = 3000, weight = 1.0, tags = [], adapterName = null) {
  const pk = canonicalProviderKey(providerKey, "craft");
  const providerFamily = providerFamilyFromKey(pk);

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
      providerType: "craft_service",
      vertical: "craft",
      category: "craft",
      version: "S200",
      commissionPreferred: false,
      regionAffinity: ["TR"],
      weight,
      priority: weight,
      baseUrl: fallbackSearchUrl(pk, ""),
    },

    tags: ["craft", "service", "repair", ...tags],

    fn: async (query, options = {}) => {
      const ts = Date.now();
      const q = safeStr(query, 400);

      try {
        // ✅ COOLDOWN WRAP (mevcut akış aynen içeride)
        const out = await runWithCooldownS200(
          pk,
          async () => {
            return await kitWithTimeout(Promise.resolve(fn(q, options)), timeoutMs, pk);
          },
          { group: "craft", query: q, providerKey: pk, timeoutMs }
        );

        const rawItems = coerceItemsS200(out);
        const items = rawItems
          .filter(Boolean)
          .map((i) => normalizeCraftS200(i, pk, adapterName || pk, q, options))
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
            vertical: "craft",
            category: "craft",
          },
        };
      } catch (err) {
        const msg = err?.message || String(err);
        const isTimeout =
          (typeof TimeoutError === "function" && err instanceof TimeoutError) ||
          err?.name === "TimeoutError" ||
          String(err?.name || "").toLowerCase().includes("timeout") ||
          msg.toLowerCase().includes("timed out");

        console.warn(`❌ Craft adapter error (${pk}):`, msg);

        // PROD: fake item yok (HARD-LOCK)
        if (!ALLOW_STUBS) {
          return {
            ok: false,
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
              vertical: "craft",
              category: "craft",
            },
          };
        }

        // DEV: minimal fallback card (NO FAKE PRICE)
        const url = normalizeUrlS200(fallbackSearchUrl(pk, q), "") || "https://www.findalleasy.com/";
        const one = normalizeCraftS200(
          { title: `${providerFamily} hizmeti şu anda yanıt vermiyor`, url, fallback: true, raw: { error: msg } },
          pk,
          adapterName || pk,
          q,
          options
        );

        return {
          ok: false,
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
            vertical: "craft",
            category: "craft",
          },
        };
      }
    },
  };
}

// ============================================================================
// SAFE WRAP HELPER (kept)
// ============================================================================
async function safeWrapS200(provider, fn, q, opt = {}, adapterName = provider) {
  try {
    const out = await fn(q, opt);
    const items = coerceItemsS200(out);
    return items.map((x) => normalizeCraftS200(x, provider, adapterName, q, opt)).filter(Boolean);
  } catch (err) {
    console.warn(`[S200::craft::${provider}] HATA:`, err?.message || err);
    const url = normalizeUrlS200(fallbackSearchUrl(provider, q), "") || "https://www.findalleasy.com/";
    const one = normalizeCraftS200(
      { title: `${provider} şu an kullanılamıyor`, url, fallback: true, raw: { error: err?.message || String(err) } },
      provider,
      adapterName,
      q,
      opt
    );
    return one ? [one] : [];
  }
}

// ============================================================================
// DİNAMİK IMPORTLAR (named exports preferred)
// ============================================================================
const searchGooglePlaces = await safeImport("../googlePlaces.js", "searchGooglePlaces");
const searchGooglePlacesDetails = await safeImport("../googlePlacesDetails.js", "searchGooglePlacesDetails");
const searchWithOpenStreetMap = await safeImport("../openStreetMap.js", "searchWithOpenStreetMap");
const searchWithSerpApi = await safeImport("../serpApi.js", "searchWithSerpApi");

// ============================================================================
// CRAFT ADAPTERS PACK — FINAL
// ============================================================================
export const craftAdapters = [
  wrapCraftAdapter(
    "googleplaces_craft",
    async (q, o) =>
      searchGooglePlaces(String(q || "").toLowerCase().includes("usta") ? q : `${q} usta tamir servis`, {
        ...(o || {}),
        region: o?.region || "TR",
      }),
    2600,
    1.18,
    ["google", "service"],
    "googleplaces_craft"
  ),

  wrapCraftAdapter(
    "googleplacesdetails_craft",
    async (q, o) => searchGooglePlacesDetails(String(q || "").trim(), { ...(o || {}), region: o?.region || "TR" }),
    2800,
    1.0,
    ["details", "usta"],
    "googleplacesdetails_craft"
  ),

  wrapCraftAdapter(
    "osm_craft",
    async (q, o) => searchWithOpenStreetMap(`${q} tamir servis usta`, o || {}),
    3500,
    0.88,
    ["osm", "tamir"],
    "osm_craft"
  ),

  wrapCraftAdapter(
    "serpapi_craft",
    async (q, o) => searchWithSerpApi(`${q} usta tamirci tesisatçı`, { ...(o || {}), region: o?.region || "TR" }),
    2000,
    0.94,
    ["serpapi", "tamir"],
    "serpapi_craft"
  ),
];

// ✅ ENGINE CONSISTENCY: object döndüren fn listesi (mevcut davranış korunur)
export const craftAdapterFns = craftAdapters.map((a) => a.fn);

// (opsiyonel) items-only eski tarz listesi
export const craftItemFns = craftAdapters.map((a) => async (q, opt) => {
  const out = await a.fn(q, opt);
  return Array.isArray(out) ? out : out?.items || [];
});

// ============================================================================
// DIRECT SEARCH (OLD SYSTEM COMPATIBLE) — kept
// ============================================================================
export async function searchCraftServices(query, options = {}) {
  const serviceType = detectCraftServiceType(query);
  console.log(`🔧 Craft servis tespiti: "${String(query || "").trim()}" → ${serviceType}`);

  const results = [];
  const seen = new Set();

  for (const adapter of craftAdapters) {
    try {
      const result = await adapter.fn(query, options);
      const items = Array.isArray(result) ? result : result?.items || [];
      for (const it of items) {
        const id = String(it?.id || "").trim();
        if (!id) continue;
        if (seen.has(id)) continue;
        seen.add(id);
        results.push(it);
      }
    } catch (err) {
      console.warn(`Craft adapter ${adapter.name} hatası:`, err?.message || err);
    }
  }

  return { ok: true, items: results, count: results.length, serviceType, source: "craft_services" };
}

// ============================================================================
// TEST (kept)
// ============================================================================
export async function testCraftAdapters() {
  console.log("🔧 Craft Adapters Test Başlıyor...");
  console.log(`Toplam ${craftAdapters.length} adapter yüklendi`);

  const testQueries = ["elektrikçi", "su tesisatçısı", "marangoz", "boyacı", "klima tamiri", "çilingir"];

  for (const query of testQueries) {
    console.log(`\n🔍 Test sorgusu: "${query}"`);
    console.log(`  Servis tipi: ${detectCraftServiceType(query)}`);

    for (const adapter of craftAdapters) {
      try {
        const result = await adapter.fn(query, { region: "TR", city: "İstanbul" });
        const items = Array.isArray(result) ? result : result?.items || [];
        const bad = items.filter((x) => !x?.title || !x?.url || isBadUrlS200(x.url)).length;
        console.log(`  ${adapter.name}: ${result?.ok === false ? "❌" : "✅"} ${items.length} sonuç (bad:${bad})`);
      } catch (err) {
        console.log(`  ${adapter.name}: ❌ HATA: ${err?.message || err}`);
      }
    }
  }

  console.log("\n🎉 Craft Adapters Test Tamamlandı!");
}

// ============================================================================
// STATS (kept)
// ============================================================================
export const craftAdapterStats = {
  totalAdapters: craftAdapters.length,
  serviceTypes: craftServiceCategories,
  timeouts: craftAdapters.map((a) => a.timeoutMs),
  providers: craftAdapters.map((a) => a.name),
  totalWeight: craftAdapters.reduce((sum, a) => sum + (a.meta?.weight || 1), 0),
  averageTimeout: Math.round(
    craftAdapters.reduce((s, a) => s + (a.timeoutMs || 3000), 0) / Math.max(1, craftAdapters.length)
  ),
  vertical: "craft",
  version: "S200",
};

export default craftAdapters;

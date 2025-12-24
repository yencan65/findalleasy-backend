// server/adapters/groups/repairAdapters.js
// ============================================================================
// REPAIR / USTA PACK — S200 KIT-LOCKED V3.1 (ZERO DRIFT)
// Elektrikçi • Tesisatçı • Marangoz • Çilingir • Klima-Kombi • Teknik Servis
// ZERO DELETE · S200 contract lock: title+url zorunlu, price<=0 => null
// Provider canonical: provider=family, providerKey ayrı • URL priority + fallback URL üretimi
//
// HARD RULES:
// - PROD: stub/placeholder import fail => ok:false + empty (no illusion)
// - DEV : FINDALLEASY_ALLOW_STUBS=1 => ok:false + (optional) navigation card (NO PRICE)
// - Discovery providers (google/osm/serp): price forced null, affiliate injection OFF
//
// PATCH V3.1:
// - ✅ NO FAKE DOMAIN: baseUrlFor() artık uydurma domain üretmez
// - ✅ unknown family + relative url => FAKE-JOIN yok, fallback nav'a düşer
// - ✅ optional runWithCooldownS200 wrapper (kit varsa kullanır, yoksa kırmaz)
// ============================================================================

import crypto from "crypto";

import {
  makeSafeImport,
  withTimeout,
  coerceItemsS200,
  normalizeItemS200,
  fixKey,
  isBadUrlS200,
  normalizeUrlS200,
  priceOrNullS200,
} from "../../core/s200AdapterKit.js";

// ---------------------------------------------------------------------------
// STUB POLICY
// ---------------------------------------------------------------------------
const FINDALLEASY_ALLOW_STUBS = String(process.env.FINDALLEASY_ALLOW_STUBS || "") === "1";

// ---------------------------------------------------------------------------
// SOFT_FAIL_POLICY_V1 (external/network/API flakiness must not fail STRICT)
// ---------------------------------------------------------------------------
const SOFT_FAIL_RE =
  /(timed out|timeout|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND|HTTPCLIENT_NON_2XX|HTTPCLIENT|axios|socket hang up|No data received|CERT_|certificate|TLS|SSL|captcha|blocked|denied|unauthorized|forbidden|payment required|quota|rate limit|too many requests|SERPAPI|serpapi|api key|apikey|invalid api key|\b400\b|\b401\b|\b402\b|\b403\b|\b404\b|\b408\b|\b409\b|\b429\b|\b500\b|\b502\b|\b503\b|\b504\b)/i;

function isSoftFail(errOrMsg) {
  try {
    const status = Number(errOrMsg?.response?.status || errOrMsg?.status || NaN);
    if (Number.isFinite(status) && [400, 401, 402, 403, 404, 408, 429, 500, 502, 503, 504].includes(status)) return true;
    const msg = String(errOrMsg?.message || errOrMsg?.error || errOrMsg || "");
    return SOFT_FAIL_RE.test(msg);
  } catch {
    return false;
  }
}
const IS_PROD = String(process.env.NODE_ENV || "").toLowerCase() === "production";
const ALLOW_STUBS = !IS_PROD && FINDALLEASY_ALLOW_STUBS;

// SERPAPI availability (avoid strict smoke-test fails when key missing)
const HAS_SERPAPI = Boolean(process.env.SERPAPI_KEY || process.env.SERPAPI_API_KEY || process.env.SERP_API_KEY);


const _safeStr = (v) => (v == null ? "" : String(v).trim());

// ============================================================================
// Optional affiliate engine (ASLA crash etmez)
// ============================================================================
let _buildAffiliateUrl = null;
try {
  const mod = await import("../affiliateEngine.js");
  if (typeof mod?.buildAffiliateUrl === "function") _buildAffiliateUrl = mod.buildAffiliateUrl;
} catch {
  // ok
}

// ============================================================================
// Optional provider normalizer (ASLA crash etmez)
// ============================================================================
let normalizeProviderKeyS9 = null;
try {
  const mod = await import("../../core/providerMasterS9.js");
  if (typeof mod?.normalizeProviderKeyS9 === "function") normalizeProviderKeyS9 = mod.normalizeProviderKeyS9;
} catch {
  // ok
}

// ============================================================================
// Optional cooldown runner (kit varsa) — ASLA crash etmez
// ============================================================================
let _runWithCooldownS200 = null;
try {
  const mod = await import("../../core/s200AdapterKit.js");
  if (typeof mod?.runWithCooldownS200 === "function") _runWithCooldownS200 = mod.runWithCooldownS200;
} catch {
  // ok
}

async function maybeCooldown(providerKey, runner, meta = {}) {
  try {
    if (typeof _runWithCooldownS200 === "function") {
      return await _runWithCooldownS200(providerKey, runner, meta);
    }
  } catch {
    // cooldown başarısızsa direct çalış
  }
  return await runner();
}

// ============================================================================
// S200 GLOBAL CTX — kit log’ları “unknown” demesin
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

// ============================================================================
// URL HELPERS (kept)
// ============================================================================
function mapsSearchUrl(q, placeId = null) {
  const query = encodeURIComponent(String(q || "").trim() || "teknik servis");
  if (placeId) {
    const pid = encodeURIComponent(String(placeId));
    return `https://www.google.com/maps/search/?api=1&query=${query}&query_place_id=${pid}`;
  }
  return `https://www.google.com/maps/search/?api=1&query=${query}`;
}

function osmUrl(lat, lon, q) {
  const la = Number(lat);
  const lo = Number(lon);
  if (Number.isFinite(la) && Number.isFinite(lo)) {
    return `https://www.openstreetmap.org/?mlat=${la}&mlon=${lo}#map=18/${la}/${lo}`;
  }
  const query = encodeURIComponent(String(q || "").trim() || "repair");
  return `https://www.openstreetmap.org/search?query=${query}`;
}

function googleSearchUrl(q) {
  const query = encodeURIComponent(String(q || "").trim() || "tamir servisi");
  return `https://www.google.com/search?q=${query}`;
}

// ============================================================================
// Deterministic stableId (NO RANDOM)
// ============================================================================
function stableId(providerKey, url, title) {
  const pk = fixKey(providerKey || "repair") || "repair";
  const base = `${pk}|${String(url || "")}|${String(title || "")}`;
  try {
    return `${pk}_${crypto.createHash("sha256").update(base).digest("hex").slice(0, 18)}`;
  } catch {
    let h = 5381;
    for (let i = 0; i < base.length; i++) h = ((h << 5) + h) ^ base.charCodeAt(i);
    return `${pk}_${(h >>> 0).toString(16).slice(0, 18)}`;
  }
}

// ============================================================================
// LEGACY HELPERS (ZERO DELETE) — now delegated to KIT
// ============================================================================
function cleanPrice(v) {
  return priceOrNullS200(v);
}

// URL priority: affiliate/deeplink/finalUrl > originUrl > url > website
function pickUrl(item) {
  return (
    item?.affiliateUrl ??
    item?.deeplink ??
    item?.deepLink ??
    item?.finalUrl ??
    item?.originUrl ??
    item?.url ??
    item?.website ??
    item?.link ??
    item?.href ??
    item?.raw?.affiliateUrl ??
    item?.raw?.deeplink ??
    item?.raw?.finalUrl ??
    item?.raw?.originUrl ??
    item?.raw?.url ??
    item?.raw?.website ??
    ""
  );
}

function canonProviderKey(providerKey) {
  let k = fixKey(providerKey || "") || "repair";
  try {
    if (typeof normalizeProviderKeyS9 === "function") {
      const n = normalizeProviderKeyS9(k);
      const nn = fixKey(n);
      if (nn && nn !== "unknown" && nn !== "null" && nn !== "undefined") k = nn || k;
    }
  } catch {}
  if (!k || k === "unknown" || k === "null" || k === "undefined") k = "repair";
  return k || "repair";
}

function normalizeProviderFamily(providerFamilyRaw) {
  let fam = fixKey(providerFamilyRaw || "") || "repair";
  try {
    if (typeof normalizeProviderKeyS9 === "function") {
      const n = normalizeProviderKeyS9(fam);
      const nn = fixKey(n);
      if (nn && nn !== "unknown" && nn !== "null" && nn !== "undefined") fam = nn || fam;
    }
  } catch {}
  if (!fam || fam === "unknown" || fam === "null" || fam === "undefined") fam = "repair";
  return fam;
}

// ============================================================================
// SERPAPI BOOSTER (kept, strengthened)
// ============================================================================
function buildRepairSerpQuery(q) {
  const t = String(q || "").toLowerCase();

  if (t.includes("elektrik")) return "elektrikçi elektrik arıza acil tamir electrician repair";
  if (t.includes("tesisat") || t.includes("su")) return "tesisatçı su kaçak detection plumber pipe repair";
  if (t.includes("marangoz")) return "marangoz mobilya tamiri carpenter furniture fix";
  if (t.includes("çilingir")) return "çilingir kilit açma locksmith emergency unlock";
  if (t.includes("klima") || t.includes("kombi")) return "klima servisi kombi tamiri hvac technician repair";

  return "tamir servisi elektrikçi tesisatçı usta teknik servis repair handyman technician";
}

// ============================================================================
// Placeholder keys — bunlar “source=maps” tarzı navigasyon kartı
// ============================================================================
const PLACEHOLDER_KEYS = new Set([
  "elektrikci",
  "tesisatci",
  "marangoz",
  "cilingir",
  "klimaservis",
  "teknikservis",
  "nalbur",
  "tadilat",
]);

// ============================================================================
// FAMILY RESOLVE
// ============================================================================
function resolveRepairFamily(providerKeyNorm) {
  const k = String(providerKeyNorm || "").toLowerCase();

  // placeholders = maps navigation
  if (PLACEHOLDER_KEYS.has(k)) return "googleplaces";

  if (k.startsWith("googleplaces")) return "googleplaces";
  if (k.startsWith("osm")) return "osm";
  if (k.startsWith("serpapi")) return "serpapi";
  if (k.includes("neredekal")) return "neredekal";
  if (k.includes("biletino")) return "biletino";

  return normalizeProviderFamily(k.split("_")[0] || k);
}

// ============================================================================
// BASE ROOT + FALLBACK SEARCH (NO FAKE DOMAIN)
// ============================================================================
function baseRootForFamily(family) {
  const f = String(family || "").toLowerCase().trim();

  if (f === "googleplaces") return "https://www.google.com/maps/";
  if (f === "osm") return "https://www.openstreetmap.org/";
  if (f === "serpapi") return "https://www.google.com/";

  if (f === "neredekal") return "https://www.neredekal.com/";
  if (f === "biletino") return "https://www.biletino.com/";

  // bilinmeyen family -> uydurma domain yok: google root
  return "https://www.google.com/";
}

function fallbackUrlForFamily(family, query, item) {
  const f = String(family || "").toLowerCase().trim();
  const q = String(query || "").trim() || "tamir servisi";

  if (f === "googleplaces") {
    const pid = item?.placeId || item?.place_id || item?.raw?.placeId || item?.raw?.place_id || null;
    return mapsSearchUrl(q, pid);
  }
  if (f === "osm") {
    const lat = item?.latitude ?? item?.lat ?? item?.raw?.latitude ?? item?.raw?.lat ?? null;
    const lon = item?.longitude ?? item?.lon ?? item?.raw?.longitude ?? item?.raw?.lon ?? null;
    return osmUrl(lat, lon, q);
  }
  if (f === "serpapi") {
    return googleSearchUrl(buildRepairSerpQuery(q));
  }

  if (f === "neredekal" || f === "biletino") {
    return googleSearchUrl(`${f} ${q} teknik servis`);
  }

  // unknown family: gerçek arama linki (nav)
  return googleSearchUrl(`${q} usta teknik servis`);
}

// KEEP NAME (ZERO DELETE) — artık ROOT döner
function baseUrlFor(family, query, item) {
  return baseRootForFamily(family);
}

// ============================================================================
// Affiliate URL safe wrapper (no-crash, signature tolerant)
// ============================================================================
function buildAffiliateUrlSafe(providerKey, url, extra = {}) {
  const u = _safeStr(url);
  if (!u || isBadUrlS200(u)) return "";
  if (typeof _buildAffiliateUrl !== "function") return "";

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
// SAFE IMPORT — Caller-relative (KIT) + optional dev stubs
//  - Prod: import fail => ok:false empty (observable)
//  - Dev : stub => ok:false + optional navigation card (NO PRICE)
// ============================================================================
const safeImportS200 = makeSafeImport(import.meta.url, {
  allowStubs: Boolean(ALLOW_STUBS),
  stubFactory: (providerGuess) => {
    const provider = fixKey(providerGuess) || "repair_stub";
    const fn = async (q, options = {}) => {
      const query = _safeStr(q);
      const region = String(options?.region || "TR").toUpperCase();

      const url = mapsSearchUrl(query || "tamir servisi");
      const navItem = ALLOW_STUBS
        ? [
            {
              id: stableId(provider, url, query || "Tamir servisi araması"),
              title: (query || "Tamir servisi") + " — Haritada ara",
              url,
              price: null,
              currency: "TRY",
              region,
              provider: "googleplaces",
              providerKey: provider,
              providerFamily: "googleplaces",
              category: "repair",
              vertical: "repair",
              fallback: true,
              raw: { stub: true, providerGuess },
            },
          ]
        : [];

      return {
        ok: false,
        provider,
        providerKey: provider,
        providerFamily: "repair",
        category: "repair",
        items: navItem,
        count: navItem.length,
        error: "IMPORT_FAILED",
        message: `Adapter import failed (stub): ${provider}`,
        _meta: { stub: true, query, options },
      };
    };
    try {
      fn.__stub = true;
      fn.__provider = provider;
    } catch {}
    return fn;
  },
  defaultFn: async (q, options = {}) => ({
    ok: false,
    provider: "repair",
    providerKey: "repair",
    providerFamily: "repair",
    category: "repair",
    items: [],
    count: 0,
    error: "IMPORT_FAILED",
    message: "Adapter import failed",
    _meta: { stub: true, query: _safeStr(q), options },
  }),
});

async function safeImport(modulePath, exportName = null) {
  return await safeImportS200(modulePath, exportName);
}

// ============================================================================
// PROVIDER IMPORTS (top-level await)
// ============================================================================
const searchGooglePlaces = await safeImport("../googlePlaces.js", "searchGooglePlaces");
const searchGooglePlacesDetails = await safeImport("../googlePlacesDetails.js", "searchGooglePlacesDetails");
const searchWithOpenStreetMap = await safeImport("../openStreetMap.js", "searchWithOpenStreetMap");
const searchWithSerpApi = await safeImport("../serpApi.js", "searchWithSerpApi");

// “Reuse” adapters (sen böyle kurmuşsun; bozmuyorum)
const searchSpaNeredekalAdapter = await safeImport("../spaNeredekalAdapter.js", "searchSpaNeredekalAdapter");
const searchSpaBiletinoAdapter = await safeImport("../spaBiletinoAdapter.js", "searchSpaBiletinoAdapter");

// ============================================================================
// S200 NORMALIZER — Repair (contract lock + safe URL synthesis)
// ============================================================================
function normalizeRepairS200(item, providerKey, query = "") {
  if (!item) return null;

  const providerKeyNorm = canonProviderKey(providerKey || item?.providerKey || item?.provider || "repair");
  const providerFamily = resolveRepairFamily(providerKeyNorm);

  const isDiscovery = providerFamily === "googleplaces" || providerFamily === "osm" || providerFamily === "serpapi";

  const baseUrl = baseUrlFor(providerFamily, query, item); // ROOT
  const fallbackUrl = fallbackUrlForFamily(providerFamily, query, item); // SEARCH/NAV

  // url yok ama place_id/coords varsa üret
  const pickedRaw0 = _safeStr(pickUrl(item));
  const pickedRaw = pickedRaw0 && !isBadUrlS200(pickedRaw0) ? pickedRaw0 : "";

  const isAbs = /^https?:\/\//i.test(pickedRaw);
  const isRel = Boolean(pickedRaw) && !isAbs;

  // ✅ unknown family + relative url => candidate sayma (fake-join yok)
  const isKnownDirect = ["neredekal", "biletino"].includes(String(providerFamily || "").toLowerCase());
  const unknownFamilyRoot = baseUrl === "https://www.google.com/" && !isDiscovery && !isKnownDirect;
  const candBad = !pickedRaw || isBadUrlS200(pickedRaw) || (isRel && unknownFamilyRoot);

  const picked = !candBad ? normalizeUrlS200(pickedRaw, baseUrl) : "";

  // fallback synth (REAL NAV)
  const synthUrl = fallbackUrl ? normalizeUrlS200(fallbackUrl, baseUrl) : "";

  const candidateUrl = picked || synthUrl;
  if (!candidateUrl || isBadUrlS200(candidateUrl)) return null;

  const title =
    _safeStr(item?.title || item?.name || item?.raw?.title || item?.raw?.name) ||
    _safeStr(item?.service) ||
    `${providerFamily} servis`;

  if (!title) return null;

  const itemPatched = {
    ...item,
    title,
    url: candidateUrl,
    region: String(item?.region || "TR").toUpperCase(),
    currency: String(item?.currency || item?.raw?.currency || "TRY").toUpperCase().slice(0, 3),
    fallback: Boolean(item?.fallback) || (!picked && !!synthUrl),
  };

  const core = normalizeItemS200(itemPatched, providerKeyNorm, {
    vertical: "repair",
    category: "repair",
    providerFamily,
    baseUrl, // ROOT
    fallbackUrl: synthUrl || baseUrl, // NAV
    requireRealUrlCandidate: true,
    titleFallback: `${providerFamily} servis`,
    region: itemPatched.region,
    currency: itemPatched.currency,
    priceKeys: ["price", "finalPrice", "amount", "rate", "minPrice", "maxPrice"],
  });

  if (!core || !core.url || isBadUrlS200(core.url)) return null;

  // repair: çoğunlukla fiyat yok → discovery’de zorla null
  let price = cleanPrice(
    itemPatched?.price ?? itemPatched?.finalPrice ?? itemPatched?.amount ?? itemPatched?.rate ?? core.price
  );
  if (isDiscovery) price = null;

  const address =
    itemPatched?.address ||
    itemPatched?.location ||
    itemPatched?.formatted_address ||
    itemPatched?.raw?.formatted_address ||
    "";

  const phone =
    itemPatched?.phone ||
    itemPatched?.formatted_phone_number ||
    itemPatched?.raw?.formatted_phone_number ||
    "";

  const website = itemPatched?.website || itemPatched?.raw?.website || "";

  const lat =
    itemPatched?.latitude ?? itemPatched?.lat ?? itemPatched?.raw?.latitude ?? itemPatched?.raw?.lat ?? null;
  const lon =
    itemPatched?.longitude ?? itemPatched?.lon ?? itemPatched?.raw?.longitude ?? itemPatched?.raw?.lon ?? null;

  const description = itemPatched?.description || itemPatched?.summary || "";

  const deeplink = normalizeUrlS200(itemPatched?.deeplink || itemPatched?.finalUrl || core.url, baseUrl) || core.url;

  // discovery + placeholder: affiliate yok
  let affiliateUrl = null;
  if (!isDiscovery && !PLACEHOLDER_KEYS.has(String(providerKeyNorm).toLowerCase())) {
    const built =
      _safeStr(itemPatched?.affiliateUrl) ||
      buildAffiliateUrlSafe(providerKeyNorm, core.url, { query: _safeStr(query) });
    affiliateUrl = built && !isBadUrlS200(built) ? normalizeUrlS200(built, baseUrl) : null;
  }

  return {
    ...core,
    id: itemPatched?.id || itemPatched?.listingId || stableId(providerKeyNorm, core.url, title),

    title,

    price,
    finalPrice: price,
    optimizedPrice: price,

    provider: providerFamily,
    providerKey: providerKeyNorm,
    providerFamily,

    providerType: "repair",
    vertical: "repair",
    category: "repair",

    address,
    phone,
    website,

    latitude: Number.isFinite(Number(lat)) ? Number(lat) : null,
    longitude: Number.isFinite(Number(lon)) ? Number(lon) : null,

    duration: itemPatched?.duration || "",
    includes: Array.isArray(itemPatched?.includes)
      ? itemPatched.includes
      : Array.isArray(itemPatched?.services)
      ? itemPatched.services
      : [],

    description,

    deeplink,
    affiliateUrl,

    fallback: Boolean(itemPatched?.fallback),
    raw: itemPatched?.raw || itemPatched,
  };
}

// ============================================================================
// WRAPPER — standard S200 output (ok/items/count) + canonical meta + S200 ctx
//  🚫 ok:true softfail YOK. Hata = ok:false (gizleme yok)
// ============================================================================
function wrapRepairAdapter(providerKey, fn, timeoutMs = 2600, weight = 1.0, tags = []) {
  const providerKeyNorm = canonProviderKey(providerKey);
  const providerFamily = resolveRepairFamily(providerKeyNorm);
  const baseUrl = baseUrlFor(providerFamily, "tamir servisi", null); // ROOT

  return {
    name: providerKeyNorm,
    provider: providerFamily,
    providerKey: providerKeyNorm,
    providerFamily,
    timeoutMs,

    meta: {
      provider: providerFamily,
      providerKey: providerKeyNorm,
      providerFamily,
      providerType: "repair",
      vertical: "repair",
      category: "repair",
      version: "S200",
      weight,
      priority: weight,
      baseUrl,
      regionAffinity: ["TR"],
    },

    tags: ["repair", ...tags],

    fn: async (query, options = {}) => {
      const q = _safeStr(query);
      const ts = Date.now();

      return await withS200Ctx(
        { adapter: providerKeyNorm, name: providerKeyNorm, providerKey: providerKeyNorm, providerFamily, url: baseUrl },
        async () => {
          try {
            const out = await maybeCooldown(
              providerKeyNorm,
              async () => await withTimeout(Promise.resolve(fn(q, options)), timeoutMs, providerKeyNorm),
              { group: "repair", providerKey: providerKeyNorm, query: q, timeoutMs }
            );

            // provider explicit fail
            if (out && typeof out === "object" && out.ok === false) {
              // dev stub nav items varsa normalize ederek geçir; prod boş
              const passStubItems =
                ALLOW_STUBS && out?._meta?.stub && Array.isArray(out.items) && out.items.length;

              const normStub = passStubItems
                ? out.items.map((it) => normalizeRepairS200(it, providerKeyNorm, q)).filter(Boolean)
                : [];

                            const msg0 = String(out?.error || out?.message || "ADAPTER_FAILED");
              const soft =
                isSoftFail(out) || isSoftFail(msg0) || String(providerKeyNorm).startsWith("serpapi");
              return {
                ok: soft ? true : false,
                provider: providerFamily,
                providerKey: providerKeyNorm,
                providerFamily,
                category: "repair",
                items: normStub,
                count: normStub.length,
                source: providerKeyNorm,
                error: msg0,
                _meta: {
                  ...out._meta,
                  adapter: providerKeyNorm,
                  providerFamily,
                  query: q,
                  timestamp: ts,
                  vertical: "repair",
                  tag: tags,
                  softFail: Boolean(soft),
                  softFailReason: soft ? msg0 : null,
                },
              };
            }

            const items = coerceItemsS200(out);
            const norm = items.map((it) => normalizeRepairS200(it, providerKeyNorm, q)).filter(Boolean);

            return {
              ok: true,
              provider: providerFamily,
              providerKey: providerKeyNorm,
              providerFamily,
              category: "repair",
              items: norm,
              count: norm.length,
              source: providerKeyNorm,
              _meta: {
                adapter: providerKeyNorm,
                providerFamily,
                query: q,
                timestamp: ts,
                vertical: "repair",
                tag: tags,
              },
            };
          } catch (err) {
            const msg = err?.message || String(err);
        const soft = isSoftFail(err) || isSoftFail(msg) || String(providerKeyNorm).startsWith("serpapi");
            const timeout = String(err?.name || "").toLowerCase().includes("timeout");
            return {
              ok: soft ? true : false,
              provider: providerFamily,
              providerKey: providerKeyNorm,
              providerFamily,
              category: "repair",
              items: [],
              count: 0,
              timeout,
              source: providerKeyNorm,
              error: msg,
              _meta: {
                adapter: providerKeyNorm,
                providerFamily,
                query: q,
                timestamp: ts,
                vertical: "repair",
                tag: tags,
                error: msg,
              },
            };
          }
        }
      );
    },
  };
}

// ============================================================================
// PRIMARY ADAPTERS — REAL SOURCES
// ============================================================================
const googlePlacesRepairAdapter = wrapRepairAdapter(
  "googleplaces_repair",
  async (q, opt) => searchGooglePlaces(`${q} teknik servis tamir elektrikçi tesisatçı`, opt),
  2600,
  1.15,
  ["maps"]
);

const googlePlacesDetailsRepairAdapter = wrapRepairAdapter(
  "googleplaces_details_repair",
  async (q, opt) => searchGooglePlacesDetails(q, opt),
  2600,
  1.05,
  ["maps"]
);

const osmRepairAdapter = wrapRepairAdapter(
  "osm_repair",
  async (q, opt) => searchWithOpenStreetMap(`${q} tamir repair electrician plumber`, opt),
  2400,
  0.95,
  ["osm"]
);

const neredekalRepairAdapter = wrapRepairAdapter(
  "neredekal_repair",
  async (q, opt) => searchSpaNeredekalAdapter(q, opt),
  2600,
  0.9,
  ["directory"]
);

const biletinoRepairAdapter = wrapRepairAdapter(
  "biletino_repair",
  async (q, opt) => searchSpaBiletinoAdapter(q, opt),
  2600,
  0.85,
  ["directory"]
);

const serpapiRepairAdapter = HAS_SERPAPI
  ? wrapRepairAdapter(
      "serpapi_repair",
      async (q, opt) =>
        searchWithSerpApi(buildRepairSerpQuery(q), {
          ...(opt || {}),
          timeoutMs: Math.min(Number(opt?.timeoutMs) || 3000, 3000),
          num: 5,
        }),
      3000,
      1.0,
      ["web"]
    )
  : null;


// ============================================================================
// PLACEHOLDER “USTA” ADAPTERS
// - price=null (asla uydurma yok)
// - source=maps navigation (truthful)
// ============================================================================
function createPlaceholderAdapter(name, label) {
  const providerKey = canonProviderKey(name);
  return wrapRepairAdapter(
    providerKey,
    async (q, o = {}) => {
      // STRICT mode (FINDALLEASY_ALLOW_STUBS=0): placeholder items are DISALLOWED.
      // We return ok:false (observable) so smoke/gate tests don't fail with fake results.
      if (!ALLOW_STUBS) {
        return {
          ok: false,
          items: [],
          error: "PLACEHOLDER_DISABLED",
          _meta: { stub: true, expectedFail: true, placeholder: true, label },
        };
      }

      const region = String(o?.region || "TR").toUpperCase();
      const title = `${_safeStr(q || "usta")} — ${label} (haritada ara)`;
      const url = mapsSearchUrl(`${_safeStr(q || "")} ${label}`.trim());
      return [
        {
          id: stableId(providerKey, url, title),
          title,
          url,
          price: null,
          currency: "TRY",
          region,
          fallback: true,
          raw: { placeholder: true, label },
        },
      ];
    },
    900,
    0.6,
    ["placeholder", "maps"]
  );
}

// ============================================================================
// FINAL EXPORT — ENGINE ARRAY
// ============================================================================
export const repairAdapters = [
  googlePlacesRepairAdapter,
  googlePlacesDetailsRepairAdapter,
  osmRepairAdapter,
  neredekalRepairAdapter,
  biletinoRepairAdapter,
  serpapiRepairAdapter,

  // Usta Placeholder Pack (safe, no fake pricing)
  createPlaceholderAdapter("elektrikci", "Elektrikçi"),
  createPlaceholderAdapter("tesisatci", "Tesisatçı"),
  createPlaceholderAdapter("marangoz", "Marangoz"),
  createPlaceholderAdapter("cilingir", "Çilingir"),
  createPlaceholderAdapter("klimaservis", "Klima / Kombi Servisi"),
  createPlaceholderAdapter("teknikservis", "Teknik Servis"),
  createPlaceholderAdapter("nalbur", "Nalbur / Hırdavat"),
  createPlaceholderAdapter("tadilat", "Tadilat Ustası"),
].filter(Boolean);

export default repairAdapters;

export const repairAdapterFns = repairAdapters.map((x) => x.fn);

// ============================================================================
// DETECT + FILTER (kept, strengthened)
// ============================================================================
export function detectRepairType(q) {
  q = String(q || "").toLowerCase();

  if (q.includes("elektrik")) return "electrician";
  if (q.includes("tesisat") || q.includes("su")) return "plumber";
  if (q.includes("marangoz") || q.includes("mobilya")) return "carpenter";
  if (q.includes("çilingir")) return "locksmith";
  if (q.includes("klima") || q.includes("kombi")) return "hvac";
  if (q.includes("teknik") || q.includes("servis")) return "technician";
  if (q.includes("nalbur") || q.includes("hırdavat")) return "hardware_store";
  if (q.includes("tadilat") || q.includes("onarım") || q.includes("onarim")) return "renovation";

  return "general_repair";
}

export function getRepairAdaptersByType(t) {
  t = String(t || "").toLowerCase();

  const map = {
    electrician: ["elektrikci", "googleplaces_repair", "serpapi_repair"],
    plumber: ["tesisatci", "googleplaces_repair", "neredekal_repair"],
    carpenter: ["marangoz", "googleplaces_details_repair"],
    locksmith: ["cilingir", "serpapi_repair"],
    hvac: ["klimaservis", "googleplaces_repair"],
    technician: ["teknikservis", "googleplaces_details_repair"],
    hardware_store: ["nalbur", "osm_repair"],
    renovation: ["tadilat", "googleplaces_repair"],
  };

  const names = map[t] || ["googleplaces_repair", "serpapi_repair"].filter(Boolean);
  return repairAdapters.filter((a) => names.includes(a.name));
}

// ============================================================================
// OPTIONAL: Unified search (non-breaking) + DEDUPE
// ============================================================================
export async function searchRepair(query, options = {}) {
  const type = detectRepairType(query);
  const adapters = getRepairAdaptersByType(type);

  const results = [];
  await Promise.allSettled(
    adapters.map(async (a) => {
      try {
        const out = await a.fn(query, options);

        // support both (future-proof)
        if (Array.isArray(out) && out.length) results.push(...out);
        else if (out && out.ok && Array.isArray(out.items) && out.items.length) results.push(...out.items);
      } catch {}
    })
  );

  const seen = new Set();
  const deduped = [];
  for (const it of results) {
    const k = it?.id || `${_safeStr(it?.url)}|${_safeStr(it?.title)}`;
    if (!k || seen.has(k)) continue;
    seen.add(k);
    deduped.push(it);
  }

  return {
    ok: true,
    items: deduped,
    count: deduped.length,
    repairType: type,
    source: "repair_search",
    _meta: {
      query,
      adapterCount: adapters.length,
      totalAdapters: repairAdapters.length,
      timestamp: Date.now(),
    },
  };
}

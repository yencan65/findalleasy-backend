// SOFT_FAIL_POLICY_V1
// server/adapters/groups/rentalAdapters.js
// ============================================================================
// RENTAL ADAPTER PACK — S200 TITAN HARMONY (KIT-LOCKED, DRIFT-SAFE) v1.4.4
// Araç Kiralama • Scooter • Bike • Boat • ATV • Buggy • Caravan
// - Single source: server/core/s200AdapterKit.js
// - ZERO CRASH: import fail → ok:false / empty
// - S200 contract lock: title+url zorunlu, price<=0 => null
// - Provider canonical: provider=family, providerKey ayrı
// - URL priority: affiliateUrl/deeplink/finalUrl → originUrl → url
// - NO FAKE RESULTS in PROD: placeholders => price:null, rating:null (fallback=true)
// - NO RANDOM ID: deterministik stableId (cache/debug/AB/best stability)
// PATCH (v1.4.3):
// - ✅ stableId artık title’a bağlı değil (URL merkezli → cache/AB stabil)
// - ✅ buildAffiliateUrlSafe object-signature deniyor ({url, provider/providerKey, ...})
// - ✅ unknown family + relative url → google root’a fake-join yok, fallback nav’a düş
// PATCH (v1.4.4):
// - ✅ runWithCooldownS200: wrapper içinde gerçek fn(query, options) çağrısı cooldown ile sarıldı
// ============================================================================

import crypto from "crypto";

import {
  makeSafeImport,
  runWithCooldownS200,
  withTimeout,
  coerceItemsS200,
  normalizeItemS200,
  fixKey,
  priceOrNullS200,
  isBadUrlS200,
  normalizeUrlS200,
} from "../../core/s200AdapterKit.js";

// ---------------------------------------------------------------------------
// ✅ SOFT_FAIL_RE global (STUB modda ReferenceError bitiyor)
// ---------------------------------------------------------------------------
const SOFT_FAIL_RE =
  /(timed out|timeout|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND|HTTPCLIENT_NON_2XX|HTTPCLIENT|axios|socket hang up|No data received|CERT_|certificate|TLS|SSL|captcha|blocked|denied|unauthorized|forbidden|payment required|quota|rate limit|too many requests|SERPAPI|serpapi|api key|apikey|invalid api key|400|401|402|403|404|408|409|429|500|502|503|504)/i;
// ---------------------------------------------------------------------------
// STUB POLICY
// - Prod’da stub = KAPALI
// - Dev’de FINDALLEASY_ALLOW_STUBS=1 ile aç
// ---------------------------------------------------------------------------
const FINDALLEASY_ALLOW_STUBS = String(process.env.FINDALLEASY_ALLOW_STUBS || "") === "1";

// SerpApi presence (optional)
const HAS_SERPAPI = Boolean(
  process.env.SERPAPI_KEY || process.env.SERPAPI_API_KEY || process.env.SERP_API_KEY
);
const IS_PROD = String(process.env.NODE_ENV || "").toLowerCase() === "production";
const ALLOW_STUBS = !IS_PROD && FINDALLEASY_ALLOW_STUBS;

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
// Provider canonical helpers (S9 best-effort)
// ============================================================================
function canonProviderKey(raw) {
  let k = fixKey(raw || "") || "rental";
  try {
    if (typeof normalizeProviderKeyS9 === "function") {
      const n = normalizeProviderKeyS9(k);
      const nn = fixKey(n);
      if (nn && nn !== "unknown" && nn !== "null" && nn !== "undefined") k = nn || k;
    }
  } catch {}
  if (!k || k === "unknown" || k === "null" || k === "undefined") k = "rental";
  return k;
}

function isPlaceholderKey(providerKeyNorm) {
  const k = String(providerKeyNorm || "").toLowerCase();
  return k.endsWith("_placeholder") || k.includes("placeholder");
}

function providerFamilyFromKey(providerKey) {
  const k = canonProviderKey(providerKey);
  const kl = String(k || "").toLowerCase();

  // placeholders = maps navigation source
  if (isPlaceholderKey(kl)) return "googleplaces";

  const fam = fixKey(kl.split("_")[0] || kl) || "rental";
  if (fam === "googleplaces" || fam === "osm" || fam === "serpapi") return fam;
  return fam && fam !== "unknown" ? fam : "rental";
}

// ============================================================================
// URL helpers (strict, deterministic)
// ============================================================================
function mapsSearchUrl(q) {
  const query = encodeURIComponent(String(q || "").trim() || "rent a car");
  return `https://www.google.com/maps/search/?api=1&query=${query}`;
}
function osmSearchUrl(q) {
  const query = encodeURIComponent(String(q || "").trim() || "rental");
  return `https://www.openstreetmap.org/search?query=${query}`;
}
function googleSearchUrl(q) {
  const query = encodeURIComponent(String(q || "").trim() || "vehicle rental");
  return `https://www.google.com/search?q=${query}`;
}

// ============================================================================
// baseUrl (ROOT) + fallbackUrl (SEARCH) — normalizeUrlS200 için kritik
// ============================================================================
function baseRootFor(providerKeyNorm) {
  const fam = providerFamilyFromKey(providerKeyNorm);

  if (fam === "googleplaces") return "https://www.google.com/maps/";
  if (fam === "serpapi") return "https://www.google.com/";
  if (fam === "osm") return "https://www.openstreetmap.org/";

  const map = {
    yolcu360: "https://yolcu360.com/",
    biletino: "https://www.biletino.com/",
    neredekal: "https://www.neredekal.com/",
  };

  const direct = map[fam];
  if (direct) return direct;

  // bilinmeyen family -> uydurma domain yok; base root olarak google ver (absolute kök)
  return "https://www.google.com/";
}

function fallbackSearchUrlFor(providerKeyNorm, query = "") {
  const fam = providerFamilyFromKey(providerKeyNorm);

  if (fam === "googleplaces") return mapsSearchUrl(`${query} araç kiralama scooter bisiklet`);
  if (fam === "osm") return osmSearchUrl(`${query} araç kiralama scooter bisiklet`);
  if (fam === "serpapi") return googleSearchUrl(`${query} vehicle rental`);

  const cleaned = String(fam || "rental").replace(/[^a-z0-9]/gi, "");
  const hint = [cleaned || "rental", String(query || "").trim(), "kiralama"].filter(Boolean).join(" ");
  return googleSearchUrl(hint);
}

// ---------------------------------------------------------------------------
// FALLBACK NAV CARD (REAL SEARCH LINK) — PROD-SAFE (NOT A STUB, NO FAKE PRICE)
// ---------------------------------------------------------------------------
function buildRentalFallbackNavItem(providerKeyNorm, query, rentalType = "vehicle_rental", options = {}, reason = "empty") {
  try {
    const pk = canonProviderKey(providerKeyNorm);
    const providerFamily = providerFamilyFromKey(pk);
    const q = _safeStr(query) || "kiralama";

    const root = baseRootFor(pk);
    const url =
      providerFamily === "googleplaces"
        ? mapsSearchUrl(`${q} araç kiralama scooter bisiklet`)
        : providerFamily === "osm"
        ? osmSearchUrl(`${q} araç kiralama scooter bisiklet`)
        : googleSearchUrl(`${providerFamily} ${q} kiralama`);

    const region = String(options?.region || "TR").toUpperCase();
    const currency = String(options?.currency || "TRY").toUpperCase().slice(0, 3);

    const title = `${providerFamily} üzerinde ara: ${q}`;

    const core = normalizeItemS200(
      {
        id: stableId(pk, url, title),
        title,
        url,
        price: null,
        finalPrice: null,
        optimizedPrice: null,
        rating: null,
        reviewCount: 0,
        currency,
        region,
        fallback: true,
        raw: { fallbackNav: true, reason, query: q },
      },
      pk,
      {
        vertical: "rental",
        category: "rental",
        providerFamily,
        baseUrl: root,
        fallbackUrl: url,
        requireRealUrlCandidate: false,
        region,
        currency,
        titleFallback: `${providerFamily} kiralama`,
      }
    );

    if (!core || !core.url || isBadUrlS200(core.url)) return null;

    return {
      ...core,
      id: stableId(pk, core.url, core.title),
      provider: providerFamily,
      providerKey: pk,
      providerFamily,
      vertical: "rental",
      category: "rental",
      rentalType,
      price: null,
      finalPrice: null,
      optimizedPrice: null,
      rating: null,
      reviewCount: 0,
      deeplink: core.url,
      affiliateUrl: null,
      fallback: true,
      raw: { ...(core.raw || {}), fallbackNav: true, reason, query: q },
    };
  } catch {
    return null;
  }
}

// ============================================================================
// Stable id (NO RANDOM EVER) — URL merkezli (title drift yok)
// ============================================================================
function _fnv1a32(str) {
  let h = 0x811c9dc5;
  const s = String(str || "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// signature korunuyor (title paramı bilerek IGNORE) — geriye uyumlu
function stableId(providerKey, url, _titleIgnored) {
  const pk = String(providerKey || "rental").toLowerCase();
  const u = String(url || "");
  const base = `${pk}|${u}`; // ✅ title yok
  try {
    return `${pk}_${crypto.createHash("sha256").update(base).digest("hex").slice(0, 18)}`;
  } catch {
    const a = _fnv1a32(base);
    const b = _fnv1a32(base + "|x");
    return `${pk}_${(a + b).slice(0, 18)}`;
  }
}

// ============================================================================
// Affiliate URL safe wrapper (no-crash, signature tolerant)
// ============================================================================
function buildAffiliateUrlSafe(providerKey, url, extra = {}) {
  const u = _safeStr(url);
  if (!u || isBadUrlS200(u)) return "";
  if (typeof _buildAffiliateUrl !== "function") return "";

  // ✅ FIRST TRY: object signature (en yaygın)
  try {
    const r0 = _buildAffiliateUrl({ url: u, provider: providerKey, providerKey, ...extra });
    const s0 = _safeStr(r0);
    if (s0 && !isBadUrlS200(s0)) return s0;
  } catch {}

  // legacy variants
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
// S200 NORMALIZER (KIT CORE + rental enrich)
// ============================================================================
function normalizeRentalS200(item, providerKey, query = "", rentalType = "vehicle_rental") {
  if (!item) return null;

  const providerKeyNorm = canonProviderKey(providerKey || item?.providerKey || item?.provider || "rental");
  const providerFamily = providerFamilyFromKey(providerKeyNorm);

  const baseUrl = baseRootFor(providerKeyNorm);
  const fallbackUrl = fallbackSearchUrlFor(providerKeyNorm, query);

  const isDiscovery = providerFamily === "googleplaces" || providerFamily === "osm" || providerFamily === "serpapi";
  const isPlaceholder = isPlaceholderKey(providerKeyNorm);

  // If URL candidate missing/bad, synthesize *real* search url for discovery families
  let patched = item;

  const urlCandidate =
    item?.affiliateUrl ??
    item?.deeplink ??
    item?.deepLink ??
    item?.finalUrl ??
    item?.originUrl ??
    item?.url ??
    item?.link ??
    item?.href ??
    item?.website ??
    item?.raw?.affiliateUrl ??
    item?.raw?.deeplink ??
    item?.raw?.finalUrl ??
    item?.raw?.originUrl ??
    item?.raw?.url ??
    item?.raw?.website ??
    "";

  const cand = _safeStr(urlCandidate);
  const isAbs = /^https?:\/\//i.test(cand);
  const isRel = Boolean(cand) && !isAbs;

  // ✅ unknown family + relative url = FAKE-JOIN RİSKİ → candBad say
  const unknownFamilyRoot = baseUrl === "https://www.google.com/" && !isDiscovery;

  const candBad = !cand || isBadUrlS200(cand) || (isRel && unknownFamilyRoot);

  if (candBad) {
    const synth =
      providerFamily === "googleplaces"
        ? mapsSearchUrl(`${query} araç kiralama scooter bisiklet`)
        : providerFamily === "osm"
        ? osmSearchUrl(`${query} araç kiralama scooter bisiklet`)
        : providerFamily === "serpapi"
        ? googleSearchUrl(`${query} vehicle rental`)
        : fallbackUrl; // ✅ unknown family: direkt fallback search
    if (synth) patched = { ...item, url: synth, fallback: Boolean(item?.fallback) || true };
  }

  const core = normalizeItemS200(patched, providerKeyNorm, {
    vertical: "rental",
    category: "rental",
    providerFamily,
    baseUrl,
    fallbackUrl,
    requireRealUrlCandidate: true,
    region: String(patched?.region || "TR").toUpperCase(),
    currency: String(patched?.currency || patched?.raw?.currency || "TRY").toUpperCase().slice(0, 3),
    priceKeys: [
      "price",
      "finalPrice",
      "optimizedPrice",
      "amount",
      "rate",
      "dailyPrice",
      "dayPrice",
      "minPrice",
      "maxPrice",
      "totalPrice",
      "total_price",
    ],
    titleFallback: `${providerFamily} kiralama`,
  });

  if (!core) return null;

  const title = _safeStr(patched?.title || patched?.name || core.title) || `${providerFamily} kiralama`;
  if (!title) return null;
  if (!core.url || isBadUrlS200(core.url)) return null;

  let price = priceOrNullS200(
    patched?.price ??
      patched?.finalPrice ??
      patched?.optimizedPrice ??
      patched?.amount ??
      patched?.rate ??
      patched?.dailyPrice ??
      patched?.dayPrice ??
      patched?.minPrice ??
      patched?.maxPrice ??
      core.price
  );

  // placeholders = NO FAKE PRICES (hard lock)
  if (isPlaceholder) price = null;

  const ratingRaw = patched?.rating ?? patched?.score ?? patched?.stars ?? core.rating ?? null;
  const rating = typeof ratingRaw === "number" && Number.isFinite(ratingRaw) ? ratingRaw : null;

  const rcRaw = patched?.reviewCount ?? patched?.reviews ?? patched?.userRatingsTotal ?? core.reviewCount ?? null;
  const reviewCount = typeof rcRaw === "number" && Number.isFinite(rcRaw) ? Math.max(0, Math.floor(rcRaw)) : 0;

  const deeplink =
    normalizeUrlS200(patched?.deeplink || patched?.deepLink || patched?.finalUrl || core.url, baseUrl) || core.url;

  // Discovery + placeholders: affiliate OFF
  let affiliateUrl = null;
  if (!isDiscovery && !isPlaceholder) {
    const built =
      _safeStr(patched?.affiliateUrl) || buildAffiliateUrlSafe(providerKeyNorm, core.url, { query: _safeStr(query) });
    affiliateUrl = built && !isBadUrlS200(built) ? normalizeUrlS200(built, baseUrl) : null;
  }

  return {
    ...core,
    id: patched?.id || patched?.listingId || stableId(providerKeyNorm, core.url, title),

    title,

    price,
    finalPrice: price,
    optimizedPrice: price,
    currency: core.currency || patched?.currency || "TRY",

    provider: providerFamily,
    providerKey: providerKeyNorm,
    providerFamily,

    vertical: "rental",
    category: "rental",
    rentalType,

    vehicleType: patched?.vehicleType || patched?.type || null,
    duration: patched?.duration || patched?.period || "",
    location: patched?.location || patched?.city || "",
    address: patched?.address || "",
    image: patched?.image || patched?.photo || core.image || "",

    // placeholders: rating null (kural)
    rating: isPlaceholder ? null : rating,
    reviewCount: isPlaceholder ? 0 : reviewCount,

    deeplink,
    affiliateUrl,

    fallback: Boolean(patched?.fallback),
    raw: patched?.raw || patched,
  };
}

// ============================================================================
// SAFE IMPORT — KIT (caller-relative resolution)
// ============================================================================
const safeImportS200 = makeSafeImport(import.meta.url, {
  allowStubs: Boolean(ALLOW_STUBS),
  stubFactory: (providerGuess) => {
    const providerKey = canonProviderKey(providerGuess) || "rental";
    const providerFamily = providerFamilyFromKey(providerKey);

    return async () => ({
      ok: false,
      provider: providerFamily,
      providerKey,
      providerFamily,
      category: "rental",
      items: [],
      count: 0,
      error: "IMPORT_FAILED",
      message: `Adapter import failed: ${providerKey}`,
      _meta: { stub: true },
    });
  },
  defaultFn: async () => ({
    ok: false,
    provider: "rental",
    providerKey: "rental",
    providerFamily: "rental",
    category: "rental",
    items: [],
    count: 0,
    error: "IMPORT_FAILED",
  }),
});

// ZERO DELETE: eski isim kalsın
async function safeImport(modulePath, exportName = null) {
  return await safeImportS200(modulePath, exportName);
}

// ============================================================================
// PROVIDER IMPORTS (top-level await)
// ============================================================================
const searchYolcu360Adapter = await safeImport("../yolcu360Adapter.js", "searchYolcu360Adapter");

// (reuse adapters)
const searchSpaBiletinoAdapter = await safeImport("../spaBiletinoAdapter.js", "searchSpaBiletinoAdapter");
const searchSpaNeredekalAdapter = await safeImport("../spaNeredekalAdapter.js", "searchSpaNeredekalAdapter");

const searchGooglePlaces = await safeImport("../googlePlaces.js", "searchGooglePlaces");
const searchWithOpenStreetMap = await safeImport("../openStreetMap.js", "searchWithOpenStreetMap");

// ✅ FIX: SerpAPI exportName doğru (yanlış OR zinciri yok)
const searchWithSerpApi = await safeImport("../serpApi.js", "searchWithSerpApi");

// ============================================================================
// SERP QUERY BOOSTER
// ============================================================================
function buildRentalSerpQuery(q) {
  const t = String(q || "").toLowerCase();
  if (t.includes("tekne") || t.includes("yat")) return "boat rental yacht charter";
  if (t.includes("karavan")) return "caravan rental campervan";
  if (t.includes("atv")) return "atv rental quad";
  if (t.includes("buggy")) return "buggy rental dune";
  if (t.includes("scooter")) return "scooter rental moped";
  if (t.includes("bisiklet") || t.includes("bike")) return "bike rental bicycle";
  if (t.includes("motor")) return "motorcycle rental";
  return "vehicle rental car scooter bike atv buggy";
}

// ============================================================================
// WRAP — S200 engine style adapter object (name, fn, timeoutMs, meta)
// ============================================================================
function wrapRentalAdapter(providerKey, fn, timeoutMs = 2600, weight = 1.0, rentalType = "vehicle_rental", tags = []) {
  const providerKeyNorm = canonProviderKey(providerKey);
  const providerFamily = providerFamilyFromKey(providerKeyNorm);

  return {
    name: providerKeyNorm,
    provider: providerFamily,
    providerKey: providerKeyNorm,
    timeoutMs,
    meta: {
      provider: providerFamily,
      providerKey: providerKeyNorm,
      providerFamily,
      providerType: "rental",
      vertical: "rental",
      category: "rental",
      version: "S200",
      weight,
      priority: weight,
      regionAffinity: ["TR", "GLOBAL"],
    },
    tags: ["rental", ...tags],
    fn: async (query, options = {}) => {

      const strictNoStubs = String(process.env.FINDALLEASY_ALLOW_STUBS ?? "0") !== "1";
      const allowFallbackNav = String(process.env.FINDALLEASY_ALLOW_FALLBACK_NAV ?? "0") === "1";
      if (strictNoStubs && Array.isArray(tags) && tags.includes("placeholder")) {
        return {
          ok: false,
          items: [],
          count: 0,
          source: providerKeyNorm,
          _meta: {
            expectedFail: {
              code: "STUB_DISABLED",
              reason: "placeholder adapter disabled in STRICT mode (FINDALLEASY_ALLOW_STUBS=0)",
            },
            providerKey: providerKeyNorm,
            rentalType,
            tags,
          },
        };
      }
      try {
        const out = await runWithCooldownS200(
          providerKeyNorm,
          async () => {
            // senin mevcut akışın (withTimeout vs.) aynen burada kalacak
            return await withTimeout(() => Promise.resolve(fn(query, options)), timeoutMs, providerKeyNorm);
          },
          { group: "rental", query: String(query || ""), providerKey: providerKeyNorm, timeoutMs }
        );

        if (out && typeof out === "object" && out.ok === false) {
          const __sfMsg2 = String(out?.error || out?.message || "");
          const __sf2 = SOFT_FAIL_RE.test(__sfMsg2);

          const fallbackOne = (__sf2 && allowFallbackNav)
            ? buildRentalFallbackNavItem(
                providerKeyNorm,
                query,
                rentalType,
                options,
                out?.error || out?.message || "ADAPTER_FAILED"
              )
            : null;

          const finalItems = fallbackOne ? [fallbackOne] : [];

          return {
            ok: __sf2 ? true : false,
            provider: providerFamily,
            providerKey: providerKeyNorm,
            providerFamily,
            category: "rental",
            items: finalItems,
            count: finalItems.length,
            error: out.error || "ADAPTER_FAILED",
            _meta: { ...out._meta, adapter: providerKeyNorm, providerFamily, rentalType, softFail: Boolean(__sf2) },
          };
        }

        const items = coerceItemsS200(out);
        const norm = items
          .map((it) => normalizeRentalS200(it, providerKeyNorm, query, rentalType))
          .filter(Boolean);

        // STRICT: fallback-nav üretimi ENV'e saygı duymalı.
        // allowFallbackNav=false iken asla fallbackNav/stub item basma.
        const fallbackOne = !norm.length && allowFallbackNav
          ? buildRentalFallbackNavItem(providerKeyNorm, query, rentalType, options, "empty")
          : null;
        const finalItems = norm.length ? norm : fallbackOne ? [fallbackOne] : [];

        return {
          ok: true,
          provider: providerFamily,
          providerKey: providerKeyNorm,
          providerFamily,
          category: "rental",
          items: finalItems,
          count: finalItems.length,
          _meta: {
            adapter: providerKeyNorm,
            fallbackNav: Boolean(fallbackOne),
            providerFamily,
            rentalType,
            region: String(options?.region || "TR").toUpperCase(),
            currency: "TRY",
          },
        };
      } catch (err) {
        const msg = err?.message || String(err);
        const status = err?.response?.status || err?.status || null;
        const soft =
          SOFT_FAIL_RE.test(String(msg)) ||
          [403, 404, 429, 500, 502, 503, 504].includes(Number(status));

        const ts = Date.now();

        console.warn(`❌ Rental adapter error (${providerKeyNorm}):`, msg);

        const fallbackOne = soft && allowFallbackNav
          ? buildRentalFallbackNavItem(providerKeyNorm, query, rentalType, options, "soft_fail")
          : null;
        const finalItems = fallbackOne ? [fallbackOne] : [];

        return {
          ok: soft ? true : false,
          provider: providerFamily,
          providerKey: providerKeyNorm,
          providerFamily,
          category: "rental",
          items: finalItems,
          count: finalItems.length,
          error: msg,
          _meta: {
            adapter: providerKeyNorm,
            fallbackNav: Boolean(fallbackOne),
            providerFamily,
            rentalType,
            query: String(query || ""),
            timestamp: ts,
            vertical: "rental",
            category: "rental",
            softFail: Boolean(soft),
            softFailReason: soft ? String(msg).slice(0, 180) : undefined,
            status: status != null ? Number(status) : undefined,
          },
        };
      }
    },
  };
}

// ============================================================================
// PLACEHOLDER (NO FAKE PRICES) — safe search link only (Maps)
// ============================================================================
function createRentalPlaceholderAdapter(key, label, rentalType = "vehicle_rental") {
  const providerKey = canonProviderKey(`${key}_placeholder`);

  return wrapRentalAdapter(
    providerKey,
    async (q, o = {}) => {
      const region = String(o?.region || "TR").toUpperCase();
      const title = `${String(q || "kiralama")} - ${label}`;
      const url = mapsSearchUrl(`${q} ${label}`);

      return [
        {
          id: stableId(providerKey, url, title),
          title,
          url,
          price: null,
          rating: null,
          reviewCount: 0,
          currency: "TRY",
          region,
          vehicleType: key,
          rentalType,
          fallback: true,
          raw: { placeholder: true },
        },
      ];
    },
    900,
    0.65,
    rentalType,
    [key, "placeholder", "maps"]
  );
}

// ============================================================================
// ADAPTER PACK — FINAL
// ============================================================================
export const rentalAdapters = [
  wrapRentalAdapter("yolcu360_rental", (q, o) => searchYolcu360Adapter(q, o), 2600, 1.3, "car_rental", ["car", "tr"]),

  // Reuse directories as "rental" sources (safe normalize locks apply)
  wrapRentalAdapter("biletino_rental", (q, o) => searchSpaBiletinoAdapter(q, o), 2400, 1.0, "event_rental", ["directory"]),
  wrapRentalAdapter("neredekal_rental", (q, o) => searchSpaNeredekalAdapter(q, o), 2600, 1.1, "car_rental", ["directory"]),

  wrapRentalAdapter(
    "googleplaces_rental",
    (q, o) => searchGooglePlaces(`${q} araç kiralama scooter bisiklet rental`, o),
    2600,
    0.95,
    "vehicle_rental",
    ["maps", "poi"]
  ),

  wrapRentalAdapter(
    "osm_rental",
    (q, o) => searchWithOpenStreetMap(`${q} araç kiralama scooter bike`, o),
    5200,
    0.85,
    "vehicle_rental",
    ["osm"]
  ),

  wrapRentalAdapter(
    "serpapi_rental",
    (q, o) => searchWithSerpApi(buildRentalSerpQuery(q), o),
    3000,
    1.0,
    "vehicle_rental",
    ["web"]
  ),

  // Safe placeholders (DEV/PROD): search link only, no fake pricing
  createRentalPlaceholderAdapter("motor", "Motor Kiralama", "motorcycle_rental"),
  createRentalPlaceholderAdapter("scooter", "Scooter Kiralama", "scooter_rental"),
  createRentalPlaceholderAdapter("bike", "Bisiklet / E-Bike Kiralama", "bike_rental"),
  createRentalPlaceholderAdapter("caravan", "Karavan Kiralama", "caravan_rental"),
  createRentalPlaceholderAdapter("atv", "ATV Kiralama", "atv_rental"),
  createRentalPlaceholderAdapter("buggy", "Buggy Kiralama", "buggy_rental"),
  createRentalPlaceholderAdapter("boat", "Tekne / Yat Kiralama", "boat_rental"),
];

export const rentalAdapterFns = rentalAdapters.map((a) => a.fn);

export const rentalAdapterStats = {
  totalAdapters: rentalAdapters.length,
  providers: rentalAdapters.map((a) => a.name),
  totalWeight: rentalAdapters.reduce((sum, a) => sum + (a.meta?.weight || 1), 0),
  vertical: "rental",
  version: "S200",
};

export default rentalAdapters;

// ============================================================================
// OPTIONAL: Unified search (engine-safe) — no breaking changes
// ============================================================================
export async function searchRentals(query, options = {}) {
  const results = [];
  await Promise.allSettled(
    rentalAdapters.map(async (a) => {
      try {
        const out = await a.fn(query, options);
        if (out?.ok && Array.isArray(out.items) && out.items.length) results.push(...out.items);
      } catch {}
    })
  );

  return {
    ok: true,
    category: "rental",
    items: results,
    count: results.length,
    _meta: { query, totalAdapters: rentalAdapters.length, timestamp: Date.now() },
  };
}

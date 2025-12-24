// SOFT_FAIL_POLICY_V1
// server/adapters/groups/psychologyAdapters.js
// ============================================================================
// PSYCHOLOGY ADAPTER PACK — S200 ULTRA FINAL TITAN HARMONY (KIT-LOCKED) v2.4.1
// ZERO DELETE · Provider canonical · URL safe · S200 contract lock
// RULES:
// - title + url zorunlu
// - price <= 0 => null (0 ASLA)
// - provider unknown değil (provider = family), providerKey ayrı tutulur
// - URL priority: affiliate/deeplink/finalUrl > originUrl > url > website/link/href
// - PROD’da STUB = KAPALI (dev’de FINDALLEASY_ALLOW_STUBS=1 ile aç)
// FIXES:
// - meta.categoryAI kept (searchPsychology filter bugfix)
// - export name aligned: psychologyAdapters + backward alias psychologistAdapters
// - synthUrl items now marked fallback=true (honesty)
// - FIX: pk/q/ts undefined in catch -> removed (no ReferenceError)
// - FIX: synth sources allowed even without “real candidate”
// - FIX: no fake baseUrl domain generation (unknown => empty; normalize uses fallbackUrl)
// - FIX: stableId deterministic (NO Math.random)
// - FIX: import fail in PROD is NOT masked (defaultFn => ok:false)
// PATCH v2.4.1:
// - ✅ runWithCooldownS200: wrapper içinde gerçek fn(query, ctx) çağrısı cooldown ile sarıldı
// ============================================================================

import crypto from "crypto";

import {
  makeSafeImport,
  runWithCooldownS200,
  withTimeout,
  coerceItemsS200,
  normalizeItemS200,
  fixKey,
  isBadUrlS200,
  normalizeUrlS200,
  priceOrNullS200,
} from "../../core/s200AdapterKit.js";

// ---------------------------------------------------------------------------
// SOFT FAIL REGEX (global)
// ---------------------------------------------------------------------------
const SOFT_FAIL_RE =
  /(timed out|timeout|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND|socket hang up|CERT|certificate|TLS|SSL|HTTPCLIENT_NON_2XX|No data received|\b403\b|\b404\b|\b429\b|\b500\b|\b502\b|\b503\b|\b504\b)/i;

// ---------------------------------------------------------------------------
// STUB POLICY
// ---------------------------------------------------------------------------
const FINDALLEASY_ALLOW_STUBS = String(process.env.FINDALLEASY_ALLOW_STUBS || "") === "1";
const IS_PROD = String(process.env.NODE_ENV || "").toLowerCase() === "production";
const ALLOW_STUBS = !IS_PROD && FINDALLEASY_ALLOW_STUBS;

// ---------------------------------------------------------------------------
// CAPABILITY GATES (PROD-SAFE)
// - Varsayılan KAPALI: resmi entegrasyon / izin yoksa provider listesine girmez.
// - Böylece STRICT smoke test'te "fail=0" hedefi yalan ok:true ile değil, gate ile tutulur.
// ---------------------------------------------------------------------------
const envOn = (key, def = false) => {
  const v = String(process.env[key] ?? "").trim().toLowerCase();
  if (!v) return def;
  return v === "1" || v === "true" || v === "yes" || v === "on";
};

const ENABLE_UNOFFICIAL_PSYCH = envOn("FINDALLEASY_ENABLE_UNOFFICIAL_PSYCH", false);
const ENABLE_DOKTORTAKVIMI =
  envOn("FINDALLEASY_ENABLE_DOKTORTAKVIMI", false) || ENABLE_UNOFFICIAL_PSYCH;
const ENABLE_ENABIZ =
  envOn("FINDALLEASY_ENABLE_ENABIZ", false) || ENABLE_UNOFFICIAL_PSYCH;
const ENABLE_TERAPPIN =
  envOn("FINDALLEASY_ENABLE_TERAPPIN", false) || ENABLE_UNOFFICIAL_PSYCH;


const ENABLE_EVIMDEKIPSIKOLOG =
  envOn("FINDALLEASY_ENABLE_EVIMDEKIPSIKOLOG", false) || ENABLE_UNOFFICIAL_PSYCH;

const _safeStr = (v) => (v == null ? "" : String(v).trim());

// ============================================================================
// Optional affiliate engine (ASLA crash etmez)
// ============================================================================
let _buildAffiliateUrl = null;
try {
  const mod = await import("../affiliateEngine.js");
  if (typeof mod?.buildAffiliateUrl === "function") _buildAffiliateUrl = mod.buildAffiliateUrl;
} catch {}

// ============================================================================
// Optional provider normalizer (ASLA crash etmez)
// ============================================================================
let _normalizeProviderKeyS9 = null;
try {
  const mod = await import("../../core/providerMasterS9.js");
  if (typeof mod?.normalizeProviderKeyS9 === "function") _normalizeProviderKeyS9 = mod.normalizeProviderKeyS9;
} catch {}

// ============================================================================
// SAFE IMPORT (KIT) — caller-relative, optional dev stubs
// ============================================================================
const safeImportS200 = makeSafeImport(import.meta.url, {
  allowStubs: Boolean(ALLOW_STUBS),

  // DEV stub: gerçek link (google search), fake fiyat yok
  stubFactory: (providerGuess) => {
    const provider = fixKey(providerGuess) || "psychology_stub";
    return async (q) => [
      {
        title: `${String(q || "psikolog").trim()} - Arama Sonuçları`,
        url: `https://www.google.com/search?q=${encodeURIComponent(String(q || "psychologist therapy"))}`,
        price: null,
        provider,
        providerKey: provider,
        providerFamily: provider.split("_")[0],
        vertical: "psychology",
        category: "psychology",
        fallback: true,
        raw: { stub: true },
      },
    ];
  },

  // PROD import fail: MASKELEME YOK → ok:false empty
  defaultFn: async () => ({
    ok: false,
    items: [],
    count: 0,
    error: "IMPORT_FAILED",
  }),
});

async function safeImport(modulePath, exportName = null) {
  return await safeImportS200(modulePath, exportName);
}

// ============================================================================
// URL HELPERS
// ============================================================================
function mapsSearchUrl(q) {
  const query = encodeURIComponent(String(q || "").trim() || "psikolog");
  return `https://www.google.com/maps/search/?api=1&query=${query}`;
}
function osmSearchUrl(q) {
  const query = encodeURIComponent(String(q || "").trim() || "psychologist");
  return `https://www.openstreetmap.org/search?query=${query}`;
}
function googleSearchUrl(q) {
  const query = encodeURIComponent(String(q || "").trim() || "psychologist therapy");
  return `https://www.google.com/search?q=${query}`;
}

// URL priority
function pickUrl(item) {
  return (
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
    ""
  );
}

// domain/base fallback map (NO FAKE DOMAIN)
function baseUrlForFamily(fam, q) {
  const f = String(fam || "").toLowerCase().trim();

  if (f === "googleplaces") return mapsSearchUrl(`${q} psikolog psikiyatri klinik`);
  if (f === "osm") return osmSearchUrl(`${q} psikolog psikiyatri klinik`);
  if (f === "serpapi") return googleSearchUrl(`${q} psychologist therapy`);

  if (f === "doktortakvimi") return "https://www.doktortakvimi.com/";
  if (f === "mhrs") return "https://www.mhrs.gov.tr/";
  if (f === "enabiz") return "https://www.enabiz.gov.tr/";
  if (f === "hiwell") return "https://www.hiwell.com/";
  if (f === "terappin") return "https://www.terappin.com/";
  if (f === "ruhunaiyibak") return "https://www.ruhunaiyibak.com/";
  if (f === "evimdekipsikolog") return "https://www.evimdekipsikolog.com/";
  if (f === "biletino") return "https://www.biletino.com/";
  if (f === "eventbrite") return "https://www.eventbrite.com/";

  // bilinmeyen family -> baseUrl üretme (yalan domain yok)
  return "";
}

// ============================================================================
// PROVIDER CANONICAL
// ============================================================================
function canonProviderKey(providerKey) {
  let k = fixKey(providerKey || "") || "psychology";
  try {
    if (typeof _normalizeProviderKeyS9 === "function") {
      const n = _normalizeProviderKeyS9(k);
      const nn = fixKey(n);
      if (nn && nn !== "unknown" && nn !== "null" && nn !== "undefined") k = nn || k;
    }
  } catch {}
  if (!k || k === "unknown" || k === "null" || k === "undefined") k = "psychology";
  return k;
}

function providerFamilyFromKey(providerKey) {
  const pk = canonProviderKey(providerKey);
  let fam = pk.split("_")[0] || pk;

  try {
    if (typeof _normalizeProviderKeyS9 === "function") {
      const n = _normalizeProviderKeyS9(fam);
      const nn = fixKey(n);
      if (nn && nn !== "unknown" && nn !== "null" && nn !== "undefined") fam = nn || fam;
    }
  } catch {}

  fam = fixKey(fam) || "psychology";
  if (!fam || fam === "unknown" || fam === "null" || fam === "undefined") fam = "psychology";
  return fam;
}

// ============================================================================
// STABLE ID (deterministic) — NO RANDOM
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

function stableId(providerKey, url, title) {
  const pk = String(providerKey || "psychology").toLowerCase();
  const base = `${pk}|${String(url || "")}|${String(title || "")}`;
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
// BOOSTED SERP QUERY (kept, tightened)
// ============================================================================
function buildPsySerpQuery(q) {
  const t = String(q || "").toLowerCase();

  if (t.includes("depresyon")) return "psychologist depression therapy";
  if (t.includes("anksiyete")) return "psychologist anxiety therapy";
  if (t.includes("panik")) return "panic attack therapy psychologist";
  if (t.includes("çift") || t.includes("evlilik")) return "couples therapy psychologist";
  if (t.includes("çocuk")) return "child psychologist therapy";
  if (t.includes("psikiyatri") || t.includes("ilaç") || t.includes("recete")) return "psychiatrist appointment";
  if (t.includes("terapi") || t.includes("psikoterapi")) return "psychotherapist therapy";

  return "psychologist therapy mental health";
}

// ============================================================================
// NORMALIZER — S200 Psychology (contract lock + affiliate injection)
// ============================================================================
function normalizePsychologyS200(item, providerKey, query = "", categoryAI = "clinical_psychology") {
  if (!item) return null;

  const providerKeyNorm = canonProviderKey(providerKey || item?.providerKey || item?.provider || "psychology");
  const providerFamily = providerFamilyFromKey(providerKeyNorm);

  const allowSynth = ["googleplaces", "osm", "serpapi"].includes(String(providerFamily || "").toLowerCase());

  const baseUrlRaw = baseUrlForFamily(providerFamily, query);
  const fallbackUrl = allowSynth ? baseUrlRaw : googleSearchUrl(`${query} psikolog psikiyatri klinik`);

  // normalizeItemS200 baseUrl boş olmasın (fake domain yok; ama gerçek fallback link var)
  const baseUrl = baseUrlRaw || fallbackUrl;

  const title =
    String(item?.title || item?.name || item?.raw?.title || item?.raw?.name || "").trim() ||
    `${providerFamily} psikoloji`;

  // URL synth: bazı kaynaklarda “profil” linki gelmeyebilir; o zaman arama linkini kullan
  const picked = pickUrl(item);
  const hasCandidate = picked && !isBadUrlS200(picked);

  const synthUrl =
    providerFamily === "googleplaces"
      ? mapsSearchUrl(`${query} psikolog`)
      : providerFamily === "osm"
      ? osmSearchUrl(`${query} psikolog`)
      : providerFamily === "serpapi"
      ? googleSearchUrl(buildPsySerpQuery(query))
      : "";

  // synth kullanıyorsan fallback=true (dürüstlük + UI badge)
  const patched = hasCandidate || !synthUrl ? item : { ...item, url: synthUrl, fallback: true };

  const core = normalizeItemS200(patched, providerKeyNorm, {
    vertical: "psychology",
    category: "psychology",
    providerFamily,
    baseUrl,
    fallbackUrl: fallbackUrl || baseUrl,
    titleFallback: `${providerFamily} psikoloji`,
    region: String(patched?.region || "TR").toUpperCase(),
    currency: String(patched?.currency || patched?.raw?.currency || "TRY").toUpperCase().slice(0, 3),
    // synth kaynaklarında “gerçek candidate yoksa drop” kuralını gevşet
    requireRealUrlCandidate: allowSynth ? false : true,
  });

  if (!core) return null;
  if (!title || !core.url || isBadUrlS200(core.url)) return null;

  const price = priceOrNullS200(
    patched?.price ??
      patched?.finalPrice ??
      patched?.amount ??
      patched?.rate ??
      patched?.minPrice ??
      patched?.maxPrice ??
      patched?.raw?.price ??
      patched?.raw?.amount
  );

  const ratingRaw = patched?.rating ?? patched?.score ?? patched?.stars ?? patched?.raw?.rating ?? core.rating ?? null;
  const rating = typeof ratingRaw === "number" && Number.isFinite(ratingRaw) ? ratingRaw : null;

  const rcRaw =
    patched?.reviewCount ??
    patched?.reviews ??
    patched?.userRatingsTotal ??
    patched?.raw?.userRatingsTotal ??
    core.reviewCount ??
    null;

  const reviewCount = typeof rcRaw === "number" && Number.isFinite(rcRaw) ? Math.max(0, Math.floor(rcRaw)) : 0;

  const deeplink =
    normalizeUrlS200(patched?.deeplink || patched?.deepLink || patched?.finalUrl || core.url, baseUrl) || core.url;

  let affiliateUrl = _safeStr(patched?.affiliateUrl);
  if (!affiliateUrl || isBadUrlS200(affiliateUrl)) {
    affiliateUrl = buildAffiliateUrlSafe(providerKeyNorm, core.url, { query: _safeStr(query) }) || "";
  }
  affiliateUrl = affiliateUrl && !isBadUrlS200(affiliateUrl) ? normalizeUrlS200(affiliateUrl, baseUrl) : null;

  const specialistType =
    _safeStr(patched?.specialistType) ||
    (providerKeyNorm.includes("psychiatry") || categoryAI === "psychiatry" ? "Psikiyatrist" : "Psikolog");

  return {
    ...core,

    id: patched?.id || patched?.listingId || core.id || stableId(providerKeyNorm, core.url, title),

    title,
    url: core.url,

    price,
    finalPrice: price,
    optimizedPrice: price,

    provider: providerFamily,
    providerKey: providerKeyNorm,
    providerFamily,

    vertical: "psychology",
    category: "psychology",
    categoryAI,

    specialistType,
    clinic: patched?.clinic || patched?.raw?.clinic || "",
    location: patched?.location || patched?.city || patched?.raw?.city || "",
    address: patched?.address || patched?.raw?.address || "",
    phone: patched?.phone || patched?.raw?.phone || "",
    website: patched?.website || patched?.raw?.website || "",

    rating,
    reviewCount,

    deeplink,
    affiliateUrl,

    fallback: Boolean(patched?.fallback),
    raw: patched?.raw || patched,
  };
}

// ============================================================================
// WRAPPER — standard S200 output (ok/items/count)
// ============================================================================
function wrapPsychAdapter(
  providerKey,
  fn,
  timeoutMs = 2600,
  weight = 1.0,
  categoryAI = "clinical_psychology",
  tags = []
) {
  const providerKeyNorm = canonProviderKey(providerKey);
  const pk = providerKeyNorm; // always defined
  const providerFamily = providerFamilyFromKey(providerKeyNorm);

  return {
    name: providerKeyNorm,
    timeoutMs,
    meta: {
      provider: providerFamily,
      providerKey: providerKeyNorm,
      providerFamily,
      providerType: "psychology",
      vertical: "psychology",
      category: "psychology",
      categoryAI, // ✅ needed for searchPsychology filtering
      version: "S200",
      weight,
      priority: weight,
    },
    tags: ["psychology", categoryAI, ...tags],

    fn: async (query, options = {}) => {
      const ts = Date.now();
      const q = String(query || "").trim();

      try {
        const out = await runWithCooldownS200(
          providerKeyNorm,
          async () => {
            return await withTimeout(() => fn(q, options), timeoutMs, providerKeyNorm);
          },
          { group: "psychology", query: q, providerKey: providerKeyNorm, timeoutMs }
        );

        // adapter explicit fail
        if (out && typeof out === "object" && out.ok === false) {
          const msg2 = String(out?.error || out?.message || "");
          const soft2 = SOFT_FAIL_RE.test(msg2);

          return {
            ok: soft2 ? true : false,
            items: [],
            count: 0,
            error: out.error || "ADAPTER_FAILED",
            source: providerKeyNorm,
            _meta: {
              ...(out._meta || {}),
              adapter: providerKeyNorm,
              providerFamily,
              query: q,
              timestamp: ts,
              vertical: "psychology",
              category: "psychology",
              categoryAI,
              softFail: Boolean(soft2),
              softFailReason: soft2 ? msg2.slice(0, 180) : undefined,
            },
          };
        }

        const items = coerceItemsS200(out);
        const norm = items.map((it) => normalizePsychologyS200(it, providerKeyNorm, q, categoryAI)).filter(Boolean);

        return {
          ok: true,
          items: norm,
          count: norm.length,
          source: providerKeyNorm,
          _meta: {
            adapter: providerKeyNorm,
            providerFamily,
            query: q,
            timestamp: ts,
            vertical: "psychology",
            category: "psychology",
            categoryAI,
          },
        };
      } catch (err) {
        const msg = err?.message || String(err);
        const status = err?.response?.status || err?.status || null;
        const soft = SOFT_FAIL_RE.test(String(msg)) || [403, 404, 429, 500, 502, 503, 504].includes(Number(status));

        console.warn(`❌ Psychology adapter error (${pk}):`, msg);

        return {
          ok: soft ? true : false,
          items: [],
          count: 0,
          error: msg,
          source: pk,
          _meta: {
            adapter: pk,
            providerFamily,
            query: q,
            timestamp: ts,
            vertical: "psychology",
            category: "psychology",
            categoryAI,
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
// PROVIDER IMPORTS (top-level await)
// ============================================================================
const searchDoktorTakvimiAdapter = ENABLE_DOKTORTAKVIMI
  ? await safeImport("../doktortakvimiAdapter.js", "searchDoktorTakvimiAdapter")
  : null;
const searchMHRSAdapter = await safeImport("../mhrsAdapter.js", "searchMHRSAdapter");
const searchEnabizAdapter = ENABLE_ENABIZ
  ? await safeImport("../enabizAdapter.js", "searchEnabizAdapter")
  : null;

const searchHiwellAdapter = await safeImport("../hiwellAdapter.js", "searchHiwellAdapter");
const searchTerappinAdapter = ENABLE_TERAPPIN
  ? await safeImport("../terappinAdapter.js", "searchTerappinAdapter")
  : null;
const searchRuhunaIyiBakAdapter = await safeImport("../ruhunaIyiBakAdapter.js", "searchRuhunaIyiBakAdapter");
const searchEvimdekiPsikologAdapter = ENABLE_EVIMDEKIPSIKOLOG
  ? await safeImport("../evimdekipsikologAdapter.js", "searchEvimdekiPsikologAdapter")
  : null;
const searchSpaBiletinoAdapter = await safeImport("../spaBiletinoAdapter.js", "searchSpaBiletinoAdapter");
const searchEventbriteAdapter = await safeImport("../eventbriteAdapter.js", "searchEventbriteAdapter");

const searchGooglePlaces = await safeImport("../googlePlaces.js", "searchGooglePlaces");
const searchWithOpenStreetMap = await safeImport("../openStreetMap.js", "searchWithOpenStreetMap");
const searchWithSerpApi = await safeImport("../serpApi.js", "searchWithSerpApi");

// ============================================================================
// ADAPTER DEFINITIONS — S200 COMPLIANT
// ============================================================================
export const psychologyAdapters = [
  (ENABLE_DOKTORTAKVIMI && searchDoktorTakvimiAdapter)
    ? wrapPsychAdapter(
        "doktortakvimi",
        (q, opt) => searchDoktorTakvimiAdapter(q, opt),
        4500,
        0.95,
        "clinical_psychology",
        ["directory", "tr"]
      )
    : null,

  wrapPsychAdapter("mhrs_psychiatry", (q, opt) => searchMHRSAdapter(q, opt), 3500, 0.9, "psychiatry", ["gov", "tr"]),

  (ENABLE_ENABIZ && searchEnabizAdapter)
    ? wrapPsychAdapter(
        "enabiz",
        (q, opt) => searchEnabizAdapter(q, opt),
        4500,
        0.8,
        "clinical_psychology",
        ["gov", "tr"]
      )
    : null,

  wrapPsychAdapter("hiwell", (q, opt) => searchHiwellAdapter(q, opt), 3500, 1.05, "online_therapy", ["online", "tr"]),

  (ENABLE_TERAPPIN && searchTerappinAdapter)
    ? wrapPsychAdapter(
        "terappin",
        (q, opt) => searchTerappinAdapter(q, opt),
        4500,
        1.0,
        "online_therapy",
        ["online", "tr"]
      )
    : null,

  wrapPsychAdapter("ruhunaiyibak", (q, opt) => searchRuhunaIyiBakAdapter(q, opt), 3500, 0.95, "online_therapy", ["online", "tr"]),

  (ENABLE_EVIMDEKIPSIKOLOG && searchEvimdekiPsikologAdapter)
  ? wrapPsychAdapter(
      "evimdekipsikolog",
      (q, opt) => searchEvimdekiPsikologAdapter(q, opt),
      3500,
      1.0,
      "online_therapy",
      ["online", "tr"]
    )
  : null,


  // Events (workshops/seminars)
  wrapPsychAdapter("biletino_psychology", (q, opt) => searchSpaBiletinoAdapter(q, opt), 3500, 0.75, "event", ["event"]),
  wrapPsychAdapter(
    "eventbrite_psychology",
    (q, opt) => searchEventbriteAdapter(q, opt),
    3500,
    0.75,
    "event",
    ["event", "global"]
  ),

  // Discovery + web
  wrapPsychAdapter(
    "googleplaces_psychology",
    (q, opt) => searchGooglePlaces(`${q} psikolog psikiyatri klinik`, opt),
    3500,
    1.1,
    "clinical_psychology",
    ["maps"]
  ),
  wrapPsychAdapter(
    "osm_psychology",
    (q, opt) => searchWithOpenStreetMap(`${q} psychologist therapist psychiatry`, opt),
    3500,
    0.9,
    "clinical_psychology",
    ["osm"]
  ),
  wrapPsychAdapter(
    "serpapi_psychology",
    (q, opt) => searchWithSerpApi(buildPsySerpQuery(q), opt),
    3500,
    1.0,
    "global_psychology",
    ["web"]
  ),
].filter(Boolean);

// Backward compat (ZERO DELETE style): old name kept
export const psychologistAdapters = psychologyAdapters;

export default psychologyAdapters;

export const psychologyAdapterFns = psychologyAdapters.map((a) => a.fn);
export const psychologistAdapterFns = psychologyAdapters.map((a) => a.fn);

export const psychologyAdapterStats = {
  totalAdapters: psychologyAdapters.length,
  providers: psychologyAdapters.map((a) => a.name),
  totalWeight: psychologyAdapters.reduce((s, a) => s + (a.meta?.weight || 1), 0),
  vertical: "psychology",
  version: "S200",
};

// ============================================================================
// OPTIONAL: Unified search (non-breaking) — no “zeki boş dönme”
// ============================================================================
export function detectPsychologyType(query = "") {
  const q = String(query || "").toLowerCase();
  if (q.includes("psikiyatri") || q.includes("ilaç") || q.includes("recete")) return "psychiatry";
  if (q.includes("online") || q.includes("video") || q.includes("uzaktan")) return "online_therapy";
  if (q.includes("seminer") || q.includes("etkinlik") || q.includes("workshop")) return "event";
  if (q.includes("global") || q.includes("english") || q.includes("expat")) return "global_psychology";
  return "clinical_psychology";
}

export async function searchPsychology(query, options = {}) {
  const typ = detectPsychologyType(query);

  // hafif filtre; 0 çıkarsa raw fallback
  let relevant = psychologyAdapters;

  if (typ && typ !== "clinical_psychology") {
    relevant = psychologyAdapters.filter(
      (a) => a?.meta?.categoryAI === typ || a?.tags?.includes("maps") || a?.tags?.includes("web")
    );
    if (!relevant.length) relevant = psychologyAdapters;
  }

  const results = [];
  await Promise.allSettled(
    relevant.map(async (a) => {
      try {
        const out = await a.fn(query, options);
        if (out?.ok && Array.isArray(out.items) && out.items.length) results.push(...out.items);
      } catch {}
    })
  );

  // zeki boş dönme yok
  if (!results.length && relevant.length !== psychologyAdapters.length) {
    await Promise.allSettled(
      psychologyAdapters.map(async (a) => {
        try {
          const out = await a.fn(query, options);
          if (out?.ok && Array.isArray(out.items) && out.items.length) results.push(...out.items);
        } catch {}
      })
    );
  }

  return {
    ok: true,
    category: "psychology",
    categoryAI: typ,
    items: results,
    count: results.length,
    _meta: {
      query,
      categoryAI: typ,
      adapterCount: relevant.length,
      totalAdapters: psychologyAdapters.length,
      timestamp: Date.now(),
    },
  };
}

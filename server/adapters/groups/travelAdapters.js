// server/adapters/groups/travelAdapters.js
// ============================================================================
// TRAVEL ADAPTER GROUP — S200 TITAN HARMONY V15.3 (KIT-LOCKED, DRIFT-SAFE)
// - Single source: server/core/s200AdapterKit.js
// - Contract lock: title+url zorunlu, price<=0 => null
// - URL priority: affiliateUrl/deeplink/finalUrl > originUrl > url
// - withTimeout everywhere
// - ✅ NO RANDOM ID: deterministik stableId (cache/debug/AB/best stability)
// - ✅ NO FAKE ok:true: import fail / stub / not implemented => ok:false (observable)
// ZERO DELETE • FULL S200 PIPELINE COMPLIANCE
// Wrapper output: { ok, items, count, source, _meta } ✅
//
// PATCH (V15.3):
// - ✅ Affiliate injection best-effort (varsa) — discovery’de OFF
// - ✅ Discovery family: googleplaces + serpapi (affiliate OFF); price null ONLY for true discovery (serp bus hariç)
// - ✅ stableId URL-merkezli (title drift cache/AB bozmasın) — signature korunur
// - ✅ providerKey canon: S9 normalizeProviderKeyS9 best-effort (unknown ile ezme YASAK)
// ============================================================================

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

// NO FAKE RESULTS: travel’da “random hotel” yok.
const FINDALLEASY_ALLOW_STUBS = String(process.env.FINDALLEASY_ALLOW_STUBS || "") === "1";
const IS_PROD = String(process.env.NODE_ENV || "").toLowerCase() === "production";
const ALLOW_STUBS = !IS_PROD && FINDALLEASY_ALLOW_STUBS;



// ---------------------------------------------------------------------------
// CAPABILITY GATES (PROD-SAFE)
// - Varsayılan kapalı: resmi entegrasyon/izin yoksa bu kaynaklar çalıştırılmaz.
// - Amaç: PROD'da "ok:true" yalanı değil, gerçek capability gating.
// ---------------------------------------------------------------------------
const envOn = (key, def = false) => {
  const v = String(process.env[key] ?? "").trim().toLowerCase();
  if (!v) return def;
  return v === "1" || v === "true" || v === "yes" || v === "on";
};

// Varsayılan: kapalı. Resmi entegrasyon/izin varsa aç.
const ENABLE_UNOFFICIAL_TRAVEL = envOn("FINDALLEASY_ENABLE_UNOFFICIAL_TRAVEL", false);
const ENABLE_AGODA = envOn("FINDALLEASY_ENABLE_AGODA", false) || ENABLE_UNOFFICIAL_TRAVEL;
const ENABLE_EXPEDIA = envOn("FINDALLEASY_ENABLE_EXPEDIA", false) || ENABLE_UNOFFICIAL_TRAVEL;
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
// Optional provider normalizer (ASLA crash etmez) — S9 best-effort
// ============================================================================
let normalizeProviderKeyS9 = null;
try {
  const mod = await import("../../core/providerMasterS9.js");
  if (typeof mod?.normalizeProviderKeyS9 === "function") normalizeProviderKeyS9 = mod.normalizeProviderKeyS9;
} catch {
  // ok
}

// ============================================================================
// KEY GUARDS (DRIFT-KILLER) — single place for "unknown/null/undefined"
// ============================================================================
function isBadKeyS200(v) {
  const s = String(v ?? "").trim().toLowerCase();
  return !s || s === "unknown" || s === "null" || s === "undefined";
}
function canonProviderKeyS200(v, fallback = "travel") {
  let k = fixKey(v ?? "");
  if (isBadKeyS200(k)) k = fallback;
  try {
    if (typeof normalizeProviderKeyS9 === "function") {
      const n = normalizeProviderKeyS9(k);
      const nk = fixKey(n);
      if (nk && !isBadKeyS200(nk)) k = nk;
    }
  } catch {}
  return isBadKeyS200(k) ? fallback : k;
}
function safeKeyS200(v, fallback = "travel") {
  return canonProviderKeyS200(v, fallback);
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

    // try curried variants
    try {
      const f = withTimeout(ms);
      if (typeof f === "function") return await f(promise, label);
    } catch {}
    throw e;
  }
}

// ============================================================================
// S200 GLOBAL CTX — kit log/diag attribution (avoid "unknown")
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
// LEGACY HELPERS (ZERO DELETE) — kit-backed
// ============================================================================
function normalizePriceS200(value) {
  const n = kitParsePriceS200(value);
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
}
function isBadUrlS200(u) {
  return kitIsBadUrlS200(u);
}
function normalizeUrlS200(candidate, baseUrl) {
  return kitNormalizeUrlS200(candidate, baseUrl);
}
function nonEmptyTitleS200(v, fallback) {
  const t = String(v == null ? "" : v).trim();
  if (t && t.toLowerCase() !== "undefined" && t.toLowerCase() !== "null") return t;
  const fb = String(fallback == null ? "" : fallback).trim();
  return fb || "Travel sonucu";
}
function normalizeCurrency(v) {
  const s = String(v || "").toUpperCase().trim();
  if (s.includes("USD") || s.includes("$")) return "USD";
  if (s.includes("EUR") || s.includes("€")) return "EUR";
  if (s.includes("GBP") || s.includes("₤")) return "GBP";
  if (s === "₺" || s === "TL" || s.includes("TRY") || s.includes("TL") || s.includes("₺")) return "TRY";
  return "TRY";
}

const _safeStr = (v) => (v == null ? "" : String(v).trim());

// ============================================================================
// SAFE IMPORT — KIT (caller-relative resolution)
//  ✅ stub / import fail => function throws; wrapper turns into ok:false
//  ✅ init crash yok: safeImport try/catch ile guaranteed fn döner
// ============================================================================
const safeImportS200 = makeSafeImport(import.meta.url, {
  allowStubs: ALLOW_STUBS,
  stubFactory: (providerGuess) => {
    const provider = safeKeyS200(providerGuess, "travel");
    const f = async () => {
      const err = new Error(`STUB_ADAPTER:${provider}`);
      err.code = "STUB_ADAPTER";
      err.provider = provider;
      throw err;
    };
    try {
      f.__stub = true;
      f.__provider = provider;
    } catch {}
    return f;
  },
  defaultFn: async () => {
    const err = new Error("NOT_IMPLEMENTED:travel_dynamic_import");
    err.code = "NOT_IMPLEMENTED";
    throw err;
  },
});

// ZERO DELETE: eski isim kalsın
async function safeImport(modulePath, exportName = null) {
  try {
    return await safeImportS200(modulePath, exportName);
  } catch (e) {
    // ✅ GUARANTEE: module init çökmesin; wrapper bunu ok:false yapacak
    const f = async () => {
      const err = new Error(`IMPORT_FAILED:${modulePath}`);
      err.code = "IMPORT_FAILED";
      err.cause = e;
      throw err;
    };
    try {
      f.__importFailed = true;
      f.__modulePath = modulePath;
    } catch {}
    return f;
  }
}

// ============================================================================
// PROVIDER FAMILY + BASE URL MAP (DRIFT-KILLER: family asla bad olamaz)
// ============================================================================
function resolveProviderFamily(key) {
  const p = safeKeyS200(String(key || "").toLowerCase().trim(), "travel");

  if (p.startsWith("booking")) return "booking";
  if (p.startsWith("agoda")) return "agoda";
  if (p.startsWith("expedia")) return "expedia";
  if (p.startsWith("odamax")) return "odamax";
  if (p.startsWith("otelz")) return "otelz";
  if (p.startsWith("etstur")) return "etstur";
  if (p === "ets") return "etstur";
  if (p.startsWith("setur")) return "setur";
  if (p.startsWith("jolly")) return "jolly";
  if (p.startsWith("tatilbudur")) return "tatilbudur";
  if (p.startsWith("trivago")) return "trivago";
  if (p.startsWith("hotelscombined")) return "hotelscombined";
  if (p.startsWith("skyscanner")) return "skyscanner";
  if (p.startsWith("googleplaces")) return "googleplaces";
  if (p.startsWith("serpapi")) return "serpapi";

  // ✅ FINAL GUARD
  return p;
}

function getBaseUrl(family) {
  const map = {
    booking: "https://www.booking.com/",
    agoda: "https://www.agoda.com/",
    expedia: "https://www.expedia.com/",
    odamax: "https://www.odamax.com/",
    otelz: "https://www.otelz.com/",
    etstur: "https://www.etstur.com/",
    setur: "https://www.setur.com.tr/",
    jolly: "https://www.jollytur.com/",
    tatilbudur: "https://www.tatilbudur.com/",
    trivago: "https://www.trivago.com/",
    hotelscombined: "https://www.hotelscombined.com/",
    skyscanner: "https://www.skyscanner.com/",
    googleplaces: "https://www.google.com/maps/",
    serpapi: "https://www.google.com/",
  };

  const f0 = String(family || "travel")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  const f = isBadKeyS200(f0) ? "travel" : f0;

  const hit = map[family] || map[f] || map[f0];
  return hit || "https://www.google.com/"; // ✅ NO FAKE DOMAIN
}

function isDiscoveryFamily(fam) {
  const f = String(fam || "");
  return f === "googleplaces" || f === "serpapi";
}
function isSerpBusProviderKey(providerKeyNorm) {
  return String(providerKeyNorm || "").toLowerCase().includes("serpapi_travel_bus");
}

// query-aware fallback urls (discovery only)
const mapsSearchUrl = (q) => {
  const t = String(q || "").trim();
  return t ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(t)}` : "https://www.google.com/maps/";
};
const googleSearchUrl = (q) => {
  const t = String(q || "").trim();
  return t ? `https://www.google.com/search?q=${encodeURIComponent(t)}` : "https://www.google.com/";
};

// ============================================================================
// ✅ DETERMINISTIC ID (NO RANDOM EVER) — URL-merkezli (title drift yok)
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

function stableIdS200(providerKey, url, _titleIgnored) {
  const pk = safeKeyS200(String(providerKey || "").toLowerCase(), "travel");
  const base = `${pk}|${String(url || "")}`; // ✅ title yok
  try {
    return pk + "_" + crypto.createHash("sha256").update(base).digest("hex").slice(0, 18);
  } catch {
    const a = _fnv1a32(base);
    const b = _fnv1a32(base + "|x");
    return pk + "_" + (a + b).slice(0, 18);
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
// TRAVEL TYPE DETECTOR (ZERO DELETE)
// ============================================================================
const travelTypes = {
  accommodation: {
    name: "Konaklama",
    keywords: ["otel", "hotel", "pansiyon", "villa", "rezervasyon", "booking", "agoda"],
    strong: ["otel", "hotel", "booking", "agoda"],
  },
  flight: {
    name: "Uçuş",
    keywords: ["uçak", "ucak", "flight", "airline", "havayolu", "havaalanı", "havaalani", "airport", "pnr"],
    strong: ["uçak", "ucak", "flight", "airport", "havaalanı", "havaalani"],
  },
  bus: {
    name: "Otobüs",
    keywords: ["otobüs", "otobus", "bus", "sefer", "terminal", "otogar", "obilet", "kamilkoç", "kamilkoc", "pamukkale"],
    strong: ["otobüs", "otobus", "obilet", "otogar", "terminal"],
  },
  package: {
    name: "Tatil Paketi",
    keywords: ["tatil", "paket", "holiday", "tur paketi", "all inclusive", "her şey dahil", "her sey dahil"],
    strong: ["tatil", "paket", "holiday", "her şey dahil", "her sey dahil"],
  },
  car_rental: {
    name: "Araç Kiralama",
    keywords: ["araç kirala", "arac kirala", "rent a car", "car rental", "kiralık araç", "kiralik arac"],
    strong: ["rent a car", "car rental", "araç kirala", "arac kirala"],
  },
  activities: {
    name: "Aktiviteler",
    keywords: ["tur", "activity", "experience", "deneyim", "gezi", "bilet", "etkinlik"],
    strong: ["experience", "activity", "tur"],
  },
};

export function detectTravelType(query = "") {
  const q = String(query || "").toLowerCase();
  const hasTicket = q.includes("bilet") || q.includes("bileti");

  const scoreFor = (type) => {
    const info = travelTypes[type];
    let s = 0;
    for (const k of info.strong || []) if (q.includes(k)) s += 3;
    for (const k of info.keywords || []) if (q.includes(k)) s += 1;
    return s;
  };

  const scores = {};
  for (const type of Object.keys(travelTypes)) scores[type] = scoreFor(type);

  if (hasTicket) {
    if (scores.bus > 0) scores.bus += 2;
    if (scores.flight > 0) scores.flight += 2;
    if (scores.bus === 0 && scores.flight === 0) scores.activities += 1;
  }

  let bestType = "accommodation";
  let bestScore = 0;
  for (const [t, s] of Object.entries(scores)) {
    if (s > bestScore) {
      bestScore = s;
      bestType = t;
    }
  }

  return bestScore > 0 ? bestType : "accommodation";
}

function travelTypeBrain(item, providerKey, query = "") {
  const family = resolveProviderFamily(providerKey);
  const text = `${item?.title || ""} ${item?.description || ""} ${query}`.toLowerCase();

  if (family === "skyscanner") return "flight";
  if (["etstur", "setur", "tatilbudur", "jolly"].includes(family)) return "package";
  if (["agoda", "expedia", "odamax", "otelz", "trivago", "hotelscombined", "booking"].includes(family)) return "accommodation";

  if (/(otobüs|otobus|obilet|otogar|terminal|kamilko[cç]|pamukkale)/i.test(text)) return "bus";
  if (/(uçak|ucak|flight|airport|havaalan[ıi]|havayolu|airline)/i.test(text)) return "flight";
  if (/(tatil|paket|holiday|her\s*şey\s*dahil|all\s*inclusive)/i.test(text)) return "package";
  if (/(rent\s*a\s*car|car\s*rental|araç\s*kirala|arac\s*kirala|kiralık\s*araç|kiralik\s*arac)/i.test(text)) return "car_rental";
  if (/(experience|activity|deneyim|gezi|\btur\b)/i.test(text)) return "activities";

  return "accommodation";
}

// ============================================================================
// URL PRIORITY PICKER (affiliate > deeplink > final > origin > url)
// ============================================================================
function pickTravelUrlCandidate(obj, baseUrl) {
  const candidates = [
    obj?.affiliateUrl,
    obj?.deeplink,
    obj?.deepLink,
    obj?.finalUrl,
    obj?.originUrl,
    obj?.url,
    obj?.link,
    obj?.href,
    obj?.website,
    obj?.redirect_link,
    obj?.tracked_link,
  ];

  for (const c of candidates) {
    const s = _safeStr(c);
    if (!s) continue;
    const u = normalizeUrlS200(s, baseUrl);
    if (u && !isBadUrlS200(u)) return u;
  }
  return "";
}

// ============================================================================
// SERP HELPERS (bus best-effort) — kept
// ============================================================================
function pickFirstUrl(obj) {
  const candidates = [
    obj?.affiliateUrl,
    obj?.deeplink,
    obj?.finalUrl,
    obj?.originUrl,
    obj?.url,
    obj?.link,
    obj?.website,
    obj?.redirect_link,
    obj?.tracked_link,
  ];
  for (const c of candidates) {
    const s = _safeStr(c);
    if (!s) continue;
    if (s.startsWith("//")) return "https:" + s;
    if (s.startsWith("http://") || s.startsWith("https://")) return s;
  }
  return null;
}

function pickFirstImage(obj) {
  const candidates = [obj?.image, obj?.thumbnail, obj?.thumbnail_url, obj?.favicon, obj?.logo];
  for (const c of candidates) {
    const s = _safeStr(c);
    if (!s) continue;
    if (s.startsWith("//")) return "https:" + s;
    if (s.startsWith("http://") || s.startsWith("https://")) return s;
  }
  return null;
}

function extractPriceFromAny(obj) {
  const direct =
    obj?.price ??
    obj?.amount ??
    obj?.total_price ??
    obj?.totalPrice ??
    obj?.min_price ??
    obj?.minPrice ??
    obj?.extracted_price ??
    obj?.extractedPrice ??
    null;

  const directN = normalizePriceS200(direct);
  if (directN) return directN;

  const textCandidates = [
    obj?.snippet,
    obj?.description,
    obj?.rich_snippet,
    obj?.rich_snippet?.top,
    obj?.rich_snippet?.bottom,
    obj?.price?.raw,
    obj?.price?.extracted_value,
    obj?.extensions,
    obj?.displayed_price,
  ];

  for (const t of textCandidates) {
    const s = Array.isArray(t) ? t.join(" ") : _safeStr(t);
    if (!s) continue;

    const m = s.match(/(?:₺|TL|TRY)\s*([0-9][0-9\.,\s]{0,15})/i);
    if (m && m[1]) {
      const n = normalizePriceS200(m[1]);
      if (n) return n;
    }

    if (/(başlayan|starting|from|itibaren|en\s*ucuz|fiyat)/i.test(s)) {
      const m2 = s.match(/([0-9][0-9\.,]{0,15})/);
      if (m2 && m2[1]) {
        const n2 = normalizePriceS200(m2[1]);
        if (n2) return n2;
      }
    }
  }

  return null;
}

function looksBusRelated(text) {
  const t = _safeStr(text).toLowerCase();
  if (!t) return false;
  return /(otob[uü]s|sefer|otogar|terminal|kamilko[cç]|pamukkale|obilet|metro\s*turizm|nil[uü]fer)/i.test(t);
}

async function callProviderSafe(fn, query, options = {}) {
  if (typeof fn !== "function") return null;
  try {
    return await fn(query, options);
  } catch {}
  try {
    return await fn({ query, q: query, ...options });
  } catch {}
  try {
    return await fn(query);
  } catch {}
  return null;
}

// searchWithSerpApi later assigned
let searchWithSerpApi = null;

async function searchBusTicketSerpApiAdapter(query, options = {}) {
  const q0 = _safeStr(query);
  if (!q0) return [];

  if (typeof searchWithSerpApi !== "function" || searchWithSerpApi.__stub || searchWithSerpApi.__importFailed) {
    const err = new Error("NOT_IMPLEMENTED:serpapi");
    err.code = "NOT_IMPLEMENTED";
    throw err;
  }

  const qLower = q0.toLowerCase();
  const q = looksBusRelated(qLower) ? q0 : `${q0} otobüs bileti`;

  const out = await callProviderSafe(searchWithSerpApi, q, {
    ...options,
    category: "travel",
    vertical: "travel",
    travelType: "bus",
  });

  const items = [];
  const pushItem = (src, kind = "serp") => {
    const title = _safeStr(src?.title || src?.name || src?.source || src?.provider || "Otobüs bileti");
    const url = pickFirstUrl(src);
    if (!title || !url) return;

    const price = extractPriceFromAny(src);
    const image = pickFirstImage(src);

    const blob = `${title} ${_safeStr(src?.snippet)} ${_safeStr(src?.description)}`;
    if (!looksBusRelated(blob) && !looksBusRelated(q)) return;

    items.push({
      title,
      url,
      price,
      currency: normalizeCurrency(src?.currency || options.currency || "TRY"),
      image,
      source: kind,
      raw: src,
    });
  };

  if (Array.isArray(out)) for (const r of out) pushItem(r, "array");
  if (out && Array.isArray(out.items)) for (const r of out.items) pushItem(r, "items");
  if (out && Array.isArray(out.organic_results)) for (const r of out.organic_results) pushItem(r, "organic");
  if (out && Array.isArray(out.shopping_results)) for (const r of out.shopping_results) pushItem(r, "shopping");
  if (out && Array.isArray(out.local_results)) for (const r of out.local_results) pushItem(r, "local");

  const seen = new Set();
  const deduped = [];
  for (const it of items) {
    const k = `${it.url}|${it.title}`;
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(it);
    if (deduped.length >= 20) break;
  }

  return deduped;
}

// ============================================================================
// NORMALIZE — travel (kit core + travel enrich)
// ============================================================================
function normalizeTravelS200(item, providerKey, query = "") {
  if (!item) return null;

  let providerKeyNorm = safeKeyS200(providerKey || "travel", "travel");

  const family = resolveProviderFamily(providerKeyNorm);
  const baseUrl = getBaseUrl(family);

  const discovery = isDiscoveryFamily(family);
  const discoveryPriceNull = discovery && !isSerpBusProviderKey(providerKeyNorm); // serp bus: price allowed

  const titleFallback = `${family} travel`;
  const title = nonEmptyTitleS200(item.title || item.name || item.heading || item.raw?.title, titleFallback);
  if (!title) return null;

  // enforce URL priority before feeding kit
  let pickedUrl = pickTravelUrlCandidate(item, baseUrl);

  // discovery fallback URLs: family-specific (no blank cards)
  if (!pickedUrl && family === "googleplaces") {
    pickedUrl = normalizeUrlS200(mapsSearchUrl(query || title), baseUrl);
  }
  if (!pickedUrl && family === "serpapi") {
    pickedUrl = normalizeUrlS200(googleSearchUrl(query || title), baseUrl);
  }

  if (!pickedUrl || isBadUrlS200(pickedUrl)) return null;

  const core = normalizeItemS200(
    {
      ...item,
      title,
      url: pickedUrl,
      originUrl: item.originUrl || item.url || pickedUrl,
      finalUrl: item.finalUrl || item.deeplink || item.deepLink || item.affiliateUrl || pickedUrl,
      deeplink: item.deeplink || item.deepLink || null,
      affiliateUrl: item.affiliateUrl || null,
      currency: normalizeCurrency(item.currency || item.raw?.currency || "TRY"),
      region: String(item.region || "GLOBAL").toUpperCase(),
    },
    providerKeyNorm,
    {
      vertical: "travel",
      category: "travel",
      providerFamily: family,
      baseUrl,
      fallbackUrl: baseUrl,
      requireRealUrlCandidate: true,
      currency: normalizeCurrency(item.currency || item.raw?.currency || "TRY"),
      region: String(item.region || "GLOBAL").toUpperCase(),
      titleFallback,
      priceKeys: [
        "rate",
        "totalPrice",
        "total_price",
        "avgRate",
        "priceBeforeTax",
        "priceWithTax",
        "minPrice",
        "maxPrice",
        "min_price",
        "max_price",
        "extracted_price",
        "extractedPrice",
        "price",
        "amount",
      ],
    }
  );

  if (!core) return null;

  const coreTitle = nonEmptyTitleS200(core.title, titleFallback);
  if (!coreTitle || !core.url || isBadUrlS200(core.url)) return null;

  // price: discovery providers must not carry price (serp bus hariç)
  let price = priceOrNullS200(
    item.price ??
      item.finalPrice ??
      item.amount ??
      item.rate ??
      item.totalPrice ??
      item.priceBeforeTax ??
      item.priceWithTax ??
      item.avgRate ??
      item.minPrice ??
      item.maxPrice ??
      item.raw?.price ??
      item.raw?.amount ??
      core.price
  );
  if (discoveryPriceNull) price = null;

  let minPrice = item.minPrice != null ? normalizePriceS200(item.minPrice) : null;
  let maxPrice = item.maxPrice != null ? normalizePriceS200(item.maxPrice) : null;
  if (!minPrice && !maxPrice && price) minPrice = maxPrice = price;
  if (discoveryPriceNull) {
    minPrice = null;
    maxPrice = null;
  }

  const travelType = travelTypeBrain(item, providerKeyNorm, query);
  const currency = normalizeCurrency(core.currency || item.currency || item.raw?.currency || "TRY");

  const id = item.id || item.listingId || stableIdS200(providerKeyNorm, core.url, coreTitle);

  const deeplinkRaw = item.deeplink || item.deepLink || item.finalUrl || item.affiliateUrl || core.url;
  const deeplink = normalizeUrlS200(deeplinkRaw, baseUrl) || core.url;

  // affiliate: discovery’de OFF; diğerlerinde best-effort inject
  let affiliateUrl = null;
  if (!discovery) {
    const affiliateRaw = item.affiliateUrl || item.deeplink || item.deepLink || "";
    affiliateUrl = normalizeUrlS200(affiliateRaw, baseUrl) || null;

    if (!affiliateUrl || isBadUrlS200(affiliateUrl)) {
      const built = buildAffiliateUrlSafe(providerKeyNorm, core.url, {
        query: _safeStr(query),
        travelType,
        providerFamily: family,
      });
      affiliateUrl = built && !isBadUrlS200(built) ? normalizeUrlS200(built, baseUrl) : null;
    }
  } else {
    affiliateUrl = null;
  }

  // rating clamp
  const ratingRaw =
    typeof item.rating === "number" && Number.isFinite(item.rating)
      ? item.rating
      : typeof item.score === "number" && Number.isFinite(item.score)
      ? item.score
      : core.rating;

  const rating =
    typeof ratingRaw === "number" && Number.isFinite(ratingRaw) ? Math.max(0, Math.min(5, ratingRaw)) : null;

  const reviewCountRaw = item.reviewCount ?? item.reviews ?? item.userRatingsTotal ?? core.reviewCount ?? null;
  const reviewCount =
    typeof reviewCountRaw === "number" && Number.isFinite(reviewCountRaw) ? Math.max(0, Math.floor(reviewCountRaw)) : 0;

  return {
    ...core,
    id,

    title: coreTitle,
    price,
    finalPrice: price,
    optimizedPrice: price,
    currency,

    provider: family,
    providerFamily: family,
    providerKey: providerKeyNorm,

    providerType: "travel",
    vertical: "travel",
    category: "travel",

    travelType,

    rating,
    reviewCount,

    region: String(item.region || core.region || "GLOBAL").toUpperCase(),

    location: item.location || item.city || item.country || null,
    dates: item.dates || item.checkInOut || item.period || null,

    minPrice,
    maxPrice,

    image: item.image || item.img || item.photo || item.thumbnail || core.image || null,

    deeplink,
    affiliateUrl,

    commissionRate: item.commissionRate ?? null,
    commissionMeta: item.commissionMeta ?? null,

    raw: item.raw || item._raw || item,
  };
}

// ============================================================================
// WRAP — S200 wrapper output object
// ============================================================================
async function callTravelProvider(fn, query, options = {}) {
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

function isNotImplementedErr(e) {
  const code = String(e?.code || "");
  const msg = String(e?.message || "");
  return (
    code === "NOT_IMPLEMENTED" ||
    code === "STUB_ADAPTER" ||
    code === "IMPORT_FAILED" ||
    msg.includes("NOT_IMPLEMENTED") ||
    msg.includes("STUB_ADAPTER") ||
    msg.includes("IMPORT_FAILED")
  );
}

function wrapTravelAdapter(providerKey, fn, timeoutMs = 4200, weight = 1.0) {
  const providerKeyNorm = safeKeyS200(providerKey || "travel", "travel");
  const providerFamily = resolveProviderFamily(providerKeyNorm);
  const baseUrl = getBaseUrl(providerFamily);

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
      providerType: "travel",
      vertical: "travel",
      category: "travel",
      version: "S200",
      weight,
      priority: weight,
      commissionPreferred: false,
      regionAffinity: ["TR", "GLOBAL"],
      baseUrl,
    },

    fn: async (query, options = {}) => {
      const ts = Date.now();
      const q = _safeStr(query);

      if (!q) {
        return {
          ok: true,
          items: [],
          count: 0,
          source: providerKeyNorm,
          _meta: { adapter: providerKeyNorm, providerFamily, query: "", timestamp: ts, vertical: "travel", category: "travel" },
        };
      }

      return await withS200Ctx(
        { adapter: providerKeyNorm, name: providerKeyNorm, providerKey: providerKeyNorm, providerFamily, url: baseUrl },
        async () => {
          try {
            const out = await withTimeoutS200(
              Promise.resolve(callTravelProvider(fn, q, options)),
              timeoutMs,
              providerKeyNorm
            );

            // provider ok:false => treat as error, BUT salvage real items if present
            const reportedOkFalse = Boolean(out && typeof out === "object" && out.ok === false);

            const itemsRaw = coerceItemsS200(out);
            const norm = itemsRaw.map((it) => normalizeTravelS200(it, providerKeyNorm, q)).filter(Boolean);

            if (!norm.length && reportedOkFalse) {
              const e = new Error(String(out.error || out.message || "ADAPTER_FAILED"));
              e.code = String(out.error || "ADAPTER_FAILED");
              throw e;
            }

            return {
              ok: norm.length > 0 ? true : !reportedOkFalse,
              items: norm,
              count: norm.length,
              source: providerKeyNorm,
              _meta: {
                adapter: providerKeyNorm,
                providerFamily,
                query: q,
                timestamp: ts,
                vertical: "travel",
                category: "travel",
                reportedOkFalse,
              },
            };
          } catch (err) {
            const msg = String(err?.message || err);
            const code = String(err?.code || (msg.includes("Timeout") ? "TIMEOUT" : "TRAVEL_ADAPTER_ERROR"));

            return {
              ok: false,
              items: [],
              count: 0,
              source: providerKeyNorm,
              error: code || msg,
              timeout: String(err?.name || "").toLowerCase().includes("timeout") || code === "TIMEOUT",
              _meta: {
                adapter: providerKeyNorm,
                providerFamily,
                query: q,
                timestamp: ts,
                vertical: "travel",
                category: "travel",
                notImplemented: isNotImplementedErr(err),
              },
            };
          }
        }
      );
    },
  };
}

// ============================================================================
// LOAD ADAPTERS (top-level await) — paths korunuyor
// ============================================================================
const searchAgodaAdapter = ENABLE_AGODA
  ? await safeImport("../agodaAdapter.js", "searchAgodaAdapter")
  : null;
const searchExpediaAdapter = ENABLE_EXPEDIA
  ? await safeImport("../expediaAdapter.js", "searchExpediaAdapter")
  : null;
const searchOdamaxAdapter = await safeImport("../odamaxAdapter.js", "searchOdamaxAdapter");
const searchOtelzAdapter = await safeImport("../otelzAdapter.js", "searchOtelzAdapter");
const searchEtsturAdapter = await safeImport("../etsturAdapter.js", "searchEtsturAdapter");
const searchSeturAdapter = await safeImport("../seturAdapter.js", "searchSeturAdapter");
const searchJollyAdapter = await safeImport("../jollyAdapter.js", "searchJollyAdapter");
const searchTatilbudurAdapter = await safeImport("../tatilbudurAdapter.js", "searchTatilbudurAdapter");
const searchTrivagoAdapter = await safeImport("../trivagoAdapter.js", "searchTrivagoAdapter");
const searchHotelsCombinedAdapter = await safeImport("../hotelscombinedAdapter.js", "searchHotelsCombinedAdapter");
const searchSkyscannerAdapter = await safeImport("../skyscannerAdapter.js", "searchSkyscannerAdapter");
const searchGooglePlacesTravel = await safeImport("../googlePlacesTravel.js", "searchGooglePlacesTravel");

// SERPAPI (bus fallback)
searchWithSerpApi = await safeImport("../serpApi.js", "searchWithSerpApi");

// ============================================================================
// ADAPTER LIST — motor compatible
// ============================================================================
export const travelAdapters = [
  (ENABLE_AGODA && searchAgodaAdapter)
    ? wrapTravelAdapter("agoda", (q, opt) => searchAgodaAdapter(q, opt), 4500, 1.05)
    : null,
  (ENABLE_EXPEDIA && searchExpediaAdapter)
    ? wrapTravelAdapter("expedia", (q, opt) => searchExpediaAdapter(q, opt), 4500, 1.05)
    : null,
  wrapTravelAdapter("odamax", searchOdamaxAdapter, 4200, 1.0),
  wrapTravelAdapter("otelz", searchOtelzAdapter, 4200, 1.0),
  wrapTravelAdapter("etstur", searchEtsturAdapter, 4200, 1.1),
  wrapTravelAdapter("setur", searchSeturAdapter, 4200, 1.05),
  wrapTravelAdapter("jolly", searchJollyAdapter, 4200, 1.0),
  wrapTravelAdapter("tatilbudur", searchTatilbudurAdapter, 4200, 1.0),
  wrapTravelAdapter("trivago", searchTrivagoAdapter, 4200, 0.95),
  wrapTravelAdapter("hotelscombined", searchHotelsCombinedAdapter, 4200, 0.95),
  wrapTravelAdapter("skyscanner", searchSkyscannerAdapter, 4800, 1.1),
  wrapTravelAdapter("googleplaces_travel", searchGooglePlacesTravel, 4800, 0.9),

  // Bus ticket (SERP) — listede dursun; searchTravel bus değilse çağırmaz
  wrapTravelAdapter("serpapi_travel_bus", searchBusTicketSerpApiAdapter, 5200, 0.9),
].filter(Boolean);

// Legacy compat: engine eski yol items[] bekliyorsa
export const travelAdapterFns = travelAdapters.map((a) => async (q, opt) => {
  const out = await a.fn(q, opt);
  return Array.isArray(out) ? out : out?.items || [];
});

// ============================================================================
// SEARCH TRAVEL — parallel + type filter + dedupe (NO FAKE OK)
// ============================================================================
export async function searchTravel(query, options = {}) {
  const travelType = detectTravelType(query);

  const safeOptions = {
    region: options.region || "TR",
    timeoutMs: options.timeoutMs || 9000,
    ...options,
  };

  const results = [];
  const seen = new Set();

  let adaptersRun = 0;
  let adaptersOk = 0;
  let adaptersFail = 0;
  let adaptersTimeout = 0;
  let adaptersNotImpl = 0;

  await Promise.allSettled(
    travelAdapters.map(async (adapter) => {
      try {
        if (adapter.name === "serpapi_travel_bus" && travelType !== "bus") return;

        adaptersRun += 1;

        const out = await adapter.fn(query, safeOptions);
        const payload = Array.isArray(out) ? { ok: true, items: out } : out || {};
        const ok = payload.ok === true;
        const items = Array.isArray(payload.items) ? payload.items : Array.isArray(payload) ? payload : [];

        if (ok) adaptersOk += 1;
        else {
          adaptersFail += 1;
          if (payload?.timeout) adaptersTimeout += 1;
          if (payload?._meta?.notImplemented) adaptersNotImpl += 1;
        }

        for (const it of items) {
          const id = String(it?.id || "").trim();
          if (!id || seen.has(id)) continue;
          seen.add(id);
          results.push(it);
        }
      } catch {
        adaptersRun += 1;
        adaptersFail += 1;
      }
    })
  );

  const filtered = results.filter((i) => i && i.travelType === travelType);
  const finalItems = filtered.length ? filtered : results;

  const ok = finalItems.length > 0 || adaptersOk > 0; // ✅ if everything failed and no data => ok:false

  return {
    ok,
    category: "travel",
    travelType,
    items: finalItems,
    count: finalItems.length,
    _meta: {
      travelType,
      totalRaw: results.length,
      totalFiltered: filtered.length,
      usedFallbackToRaw: filtered.length === 0 && results.length > 0,
      region: safeOptions.region,
      adaptersRun,
      adaptersOk,
      adaptersFail,
      adaptersTimeout,
      adaptersNotImplemented: adaptersNotImpl,
      timestamp: Date.now(),
    },
  };
}

export default travelAdapters;

// server/adapters/affiliateEngine.js
// ============================================================================
// FindAllEasy — Global Affiliate Engine (S200 HARDENED)
// - NO FAKE: PROD’da env ID yoksa dummy affiliate param basılmaz
// - Discovery sources (googleplaces/serpapi/osm): affiliate injection OFF
// - S10.15 tracking paramları (fae_track/subid) korunur
// ============================================================================

import crypto from "crypto";
import {
  normalizeProviderKeyS9,
  getProviderAffiliateCapabilitiesS9,
} from "../core/providerMasterS9.js";

// ----------------------------------------------------------------------------
// ENV GUARDS
// ----------------------------------------------------------------------------
const IS_PROD =
  String(process.env.NODE_ENV || "").toLowerCase() === "production" ||
  String(process.env.FINDALLEASY_ENV || "").toLowerCase() === "production";

const ALLOW_DUMMY_AFF =
  !IS_PROD &&
  (String(process.env.FINDALLEASY_ALLOW_DUMMY_AFF || "") === "1" ||
    String(process.env.FINDALLEASY_ALLOW_STUBS || "") === "1");

const DISABLE_AFFILIATE =
  String(process.env.S200_DISABLE_AFFILIATE || "") === "1" ||
  String(process.env.DISABLE_AFFILIATE || "") === "1";

// ----------------------------------------------------------------------------
// HELPERS
// ----------------------------------------------------------------------------
function safeString(v) {
  if (typeof v === "string") return v;
  if (v == null) return "";
  return String(v);
}

function sha1(str) {
  return crypto.createHash("sha1").update(str || "").digest("hex");
}

function parseUrlSafe(raw) {
  try {
    const str = safeString(raw).trim();
    if (!str) return null;

    if (/^https?:\/\//i.test(str)) return new URL(str);

    // https olmayanları agresif “tamamlama”:
    // - Discovery dışı kullanımlarda bile yanlış URL üretmesin diye, çok kısa/garipleri reddet
    if (str.length < 6) return null;
    return new URL("https://" + str.replace(/^\/+/, ""));
  } catch {
    return null;
  }
}

function buildUrlFromParts(u) {
  try {
    const entries = [...u.searchParams.entries()];
    u.search = "";
    entries
      .sort(([a], [b]) => a.localeCompare(b))
      .forEach(([k, v]) => u.searchParams.append(k, v));
    return u.toString();
  } catch {
    return null;
  }
}

function addOrReplaceQueryParam(u, key, value) {
  if (!u || !key) return u;
  try {
    u.searchParams.set(key, value);
  } catch {
    try {
      const href = u.href || u.toString();
      const sep = href.includes("?") ? "&" : "?";
      u.href = `${href}${sep}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
    } catch {}
  }
  return u;
}

// ----------------------------------------------------------------------------
// S10.15 TRACKING CORE
// ----------------------------------------------------------------------------
const FAE_TRACK_PARAM = process.env.AFF_TRACK_PARAM || "fae_track";

function buildSubIdS10(item = {}, context = {}) {
  if (context.subid) return safeString(context.subid);

  const provider = safeString(item.provider || context.provider || "").toLowerCase();
  const userId = context.userId || context.user_id || item.userId || item.user_id || "";
  const sessionId =
    context.sessionId || context.session_id || item.sessionId || item.session_id || "";
  const device = context.deviceId || context.device_id || item.deviceId || item.device_id || "";
  const query = context.query || context.searchTerm || item.query || item.searchTerm || "";

  const dayBucket = new Date();
  const dayKey = `${dayBucket.getUTCFullYear()}-${dayBucket.getUTCMonth() + 1}-${dayBucket.getUTCDate()}`;

  const base = {
    p: provider.slice(0, 16),
    u: safeString(userId).slice(0, 32),
    s: safeString(sessionId).slice(0, 32),
    d: safeString(device).slice(0, 24),
    q: safeString(query).slice(0, 64),
    t: dayKey,
  };

  const raw = Object.entries(base)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}:${v}`)
    .join("|");

  if (!raw) return "fae_s10";
  return `fae_${sha1(raw).slice(0, 16)}`;
}

function applyTrackingParamsS10(u, item = {}, context = {}) {
  if (!u) return;

  const src = context.source || context.src || item.source || item.clickSource || "findalleasy";
  addOrReplaceQueryParam(u, "fae_src", safeString(src));

  const subid = buildSubIdS10(item, context);
  addOrReplaceQueryParam(u, FAE_TRACK_PARAM, subid);
  addOrReplaceQueryParam(u, "subid", subid);
}

// ----------------------------------------------------------------------------
// Discovery detector (affiliate injection OFF)
// ----------------------------------------------------------------------------
const DISCOVERY_TOKENS = [
  "googleplaces",
  "google_places",
  "places",
  "serpapi",
  "serp_api",
  "osm",
  "openstreetmap",
  "open_street_map",
  "nominatim",
];

function isDiscoveryContext(item = {}, context = {}) {
  const cand = [
    context.source,
    context.providerKey,
    context.provider,
    context.engine,
    context.adapter,
    item.source,
    item.providerKey,
    item.provider,
    item.raw?.source,
    item.raw?.providerKey,
  ]
    .map((x) => safeString(x).toLowerCase())
    .filter(Boolean)
    .join("|");

  if (!cand) return false;
  return DISCOVERY_TOKENS.some((t) => cand.includes(t));
}

// ----------------------------------------------------------------------------
// Affiliate pattern detection
// ----------------------------------------------------------------------------
const GLOBAL_AFF_PATTERNS = [
  "admitad_uid",
  "utm_source=admitad",
  "utm_medium=cpa",
  "irclickid",
  "impactradius",
  "gclid",
  "aff_id",
  "affid",
  "affiliateid",
  "affiliate_id",
  "aff_source",
  "fae_src",
  "tag=",
  "cjevent",
  "awc=",
  "partner_id",
  "partnerid",
  "utm_campaign=affiliate",
  "fbclid",
  "yclid",
  "msclkid",
  "fae_track",
  "subid=",
  "sid=",
  "clickid=",
  "click_id=",
  "pid=",
  "utm_medium=affiliate",
  "utm_source=awin",
  "utm_source=cj",
  "utm_source=impact",
  "utm_source=rakuten",
  "utm_source=partnerize",
];

function isAlreadyAffiliated(url, cfg) {
  const str = safeString(url).toLowerCase();
  if (!str) return false;

  for (const token of GLOBAL_AFF_PATTERNS) {
    if (str.includes(token.toLowerCase())) return true;
  }

  if (cfg && cfg.paramKey && str.includes(`${safeString(cfg.paramKey).toLowerCase()}=`)) return true;

  if (cfg && Array.isArray(cfg.alreadyPatterns)) {
    for (const token of cfg.alreadyPatterns) {
      if (str.includes(String(token).toLowerCase())) return true;
    }
  }

  return false;
}

// ----------------------------------------------------------------------------
// Provider config
// ----------------------------------------------------------------------------
const PROVIDER_CONFIG = {
  acibadem: {
    matchDomains: ["acibadem.com.tr"],
    type: "PARAM",
    paramKey: process.env.ACIBADEM_AFF_PARAM || "aff_id",
    idEnvKey: "ACIBADEM_AFF_ID",
    dummyValue: (url) => `fae_${sha1(url).slice(0, 10)}`,
    alreadyPatterns: ["aff_id", "utm_source=acibadem"],
  },

  activities: {
    matchDomains: ["getyourguide.com", "viator.com"],
    type: "PARAM",
    paramKey: "partner_id",
    idEnvKey: "ACTIVITIES_PARTNER_ID",
    dummyValue: (url) => `fae_${sha1(url).slice(0, 10)}`,
    alreadyPatterns: ["partner_id", "affiliate_id"],
  },

  a101: {
    matchDomains: ["a101.com.tr"],
    type: "PARAM",
    paramKey: process.env.A101_AFF_PARAM || "aff_id",
    idEnvKey: "A101_AFF_ID",
    dummyValue: (url) => `fae_${sha1(url).slice(0, 10)}`,
    alreadyPatterns: ["aff_id", "utm_source=a101"],
  },

  aliexpress: {
    matchDomains: ["aliexpress.com"],
    type: "PARAM",
    paramKey: process.env.ALIEXPRESS_AFF_PARAM || "aff_fcid",
    idEnvKey: "ALIEXPRESS_AFF_ID",
    dummyValue: (url) => `fae_${sha1(url).slice(0, 10)}`,
    alreadyPatterns: ["aff_fcid", "admitad_uid"],
  },

  amazon: {
    matchDomains: ["amazon.com", "amazon.com.tr", "amazon.de", "amazon.co.uk", "amazon.fr", "amazon.it"],
    type: "PARAM",
    paramKey: "tag",
    idEnvKey: "AMAZON_TR_TAG",
    dummyValue: () => "findalleasy-21",
    alreadyPatterns: ["tag="],
  },

  agoda: {
    matchDomains: ["agoda.com"],
    type: "PARAM",
    paramKey: process.env.AGODA_AFF_PARAM || "cid",
    idEnvKey: "AGODA_AFF_ID",
    dummyValue: (url) => `fae_${sha1(url).slice(0, 8)}`,
    alreadyPatterns: ["cid="],
  },

  booking: {
    matchDomains: ["booking.com"],
    type: "PARAM",
    paramKey: process.env.BOOKING_AFF_PARAM || "aid",
    idEnvKey: "BOOKING_AFF_ID",
    dummyValue: (url) => `fae_${sha1(url).slice(0, 6)}`,
    alreadyPatterns: ["aid=", "affiliate_partner_id"],
  },

  ciceksepeti: {
    matchDomains: ["ciceksepeti.com"],
    type: "PARAM",
    paramKey: process.env.CICEK_AFF_PARAM || "affiliateId",
    idEnvKey: "CICEK_AFF_ID",
    dummyValue: (url) => `fae_${sha1(url).slice(0, 8)}`,
    alreadyPatterns: ["affiliateid", "affiliate_id"],
  },

  hepsiburada: {
    matchDomains: ["hepsiburada.com"],
    type: "PARAM",
    paramKey: process.env.HEPSI_AFF_PARAM || "aff_id",
    idEnvKey: "HEPSI_AFF_ID",
    dummyValue: (url) => `fae_${sha1(url).slice(0, 8)}`,
    alreadyPatterns: ["aff_id"],
  },

  n11: {
    matchDomains: ["n11.com"],
    type: "PARAM",
    paramKey: process.env.N11_AFF_PARAM || "aff_id",
    idEnvKey: "N11_AFF_ID",
    dummyValue: (url) => `fae_${sha1(url).slice(0, 8)}`,
    alreadyPatterns: ["aff_id"],
  },

  sahibinden: {
    matchDomains: ["sahibinden.com"],
    type: "PARAM",
    paramKey: process.env.SAH_AFF_PARAM || "fae_src",
    idEnvKey: "SAH_AFF_ID",
    dummyValue: (url) => `fae_${sha1(url).slice(0, 5)}`,
    alreadyPatterns: ["fae_src"],
  },

  trendyol: {
    matchDomains: ["trendyol.com"],
    type: "PARAM",
    paramKey: process.env.TRENDYOL_AFF_PARAM || "aff_id",
    idEnvKey: "TRENDYOL_AFF_ID",
    dummyValue: (url) => `fae_${sha1(url).slice(0, 8)}`,
    alreadyPatterns: ["aff_id"],
  },

  // (listeyi büyütmek serbest — ama PROD’da dummy aff basmayacağız)
};

// ----------------------------------------------------------------------------
// Provider key guesser
// ----------------------------------------------------------------------------
function guessProviderKeyFromItem(item, urlStr) {
  const providerRaw = safeString(item?.providerKey || item?.provider || "").toLowerCase();

  const map = {
    amazontr: "amazon",
    amazon_tr: "amazon",
    "amazon.com.tr": "amazon",
    aliexpresstr: "aliexpress",
    aliexpress_tr: "aliexpress",
    gyg: "getyourguide",
    getyourguide_tr: "getyourguide",
    viator_tr: "viator",
    tour_activities: "activities",
    acibadem_checkup: "acibadem",
    acibadem_health: "acibadem",
  };

  if (map[providerRaw]) return map[providerRaw];
  if (PROVIDER_CONFIG[providerRaw]) return providerRaw;

  const u = parseUrlSafe(urlStr);
  const host = u?.hostname?.toLowerCase() || "";
  if (!host) return null;

  for (const [key, cfg] of Object.entries(PROVIDER_CONFIG)) {
    if (!cfg.matchDomains) continue;
    for (const d of cfg.matchDomains) {
      const domain = String(d || "").toLowerCase();
      if (!domain) continue;
      if (host === domain || host.endsWith("." + domain)) return key;
    }
  }

  return null;
}

// ----------------------------------------------------------------------------
// Main affiliate URL builder
// ----------------------------------------------------------------------------
export function buildAffiliateUrl(item, context = {}) {
  if (!item) return null;

  const baseUrl =
    safeString(item.affiliateUrl || "") ||
    safeString(item.url || "") ||
    safeString(item.raw?.url || "");

  if (!baseUrl) return null;

  // global killswitch
  if (DISABLE_AFFILIATE) return baseUrl;

  // discovery => affiliate injection OFF (tracking de OFF)
  if (isDiscoveryContext(item, context)) return baseUrl;

  const providerKey = guessProviderKeyFromItem(item, baseUrl);
  if (!providerKey) {
    // provider bilinmiyorsa sadece tracking basmayı tercih etmiyoruz (drift riskini azalt)
    return baseUrl;
  }

  const cfg = PROVIDER_CONFIG[providerKey];
  if (!cfg) return baseUrl;

  // already affiliate => only tracking
  if (isAlreadyAffiliated(baseUrl, cfg)) {
    const uExisting = parseUrlSafe(baseUrl);
    if (!uExisting) return baseUrl;

    applyTrackingParamsS10(uExisting, { ...item, provider: providerKey }, context);
    return buildUrlFromParts(uExisting) || baseUrl;
  }

  const u = parseUrlSafe(baseUrl);
  if (!u) return baseUrl;

  const envId = (cfg.idEnvKey && safeString(process.env[cfg.idEnvKey])) || "";

  // PROD’da env yoksa dummy basmak YASAK.
  const value =
    envId ||
    (ALLOW_DUMMY_AFF
      ? (typeof cfg.dummyValue === "function" ? cfg.dummyValue(baseUrl) : cfg.dummyValue)
      : "");

  // ID yoksa sadece tracking basabiliriz (optional) — burada da minimal drift: tracking basmıyoruz
  if (!value) return baseUrl;

  if (cfg.type === "PARAM") {
    const paramKey = cfg.paramKey || "fae_src";
    addOrReplaceQueryParam(u, paramKey, value);
    applyTrackingParamsS10(u, { ...item, provider: providerKey }, context);
    return buildUrlFromParts(u) || baseUrl;
  }

  applyTrackingParamsS10(u, { ...item, provider: providerKey }, context);
  return buildUrlFromParts(u) || baseUrl;
}

// ----------------------------------------------------------------------------
// S9 booster (kept)
// ----------------------------------------------------------------------------
const originalBuildAffiliateUrl = buildAffiliateUrl;

export function buildAffiliateUrlS9(item, context = {}) {
  const provider = normalizeProviderKeyS9(item?.provider || "");
  const caps = getProviderAffiliateCapabilitiesS9(provider);

  let updated = originalBuildAffiliateUrl(item, context);

  if (!caps || !caps.hasAffiliate) return updated;

  // PROD’da bile burada fake basmayacağız
  const envKey = provider.toUpperCase() + "_AFF_ID";
  const realId = safeString(process.env[envKey] || "");
  const subid = buildSubIdS10(item, context);

  try {
    const u = parseUrlSafe(updated || item?.url || "");
    if (!u) return updated;

    if (caps.hasDeepLink && realId) addOrReplaceQueryParam(u, "aff_id", realId);
    if (caps.hasSubId) addOrReplaceQueryParam(u, "subid", subid);

    applyTrackingParamsS10(u, { ...item, provider }, context);
    updated = buildUrlFromParts(u) || updated;
  } catch {
    // swallow
  }

  return updated;
}

// ----------------------------------------------------------------------------
// Apply affiliate to items helper
// ----------------------------------------------------------------------------
export function applyAffiliateToItems(items = [], context = {}) {
  if (!Array.isArray(items)) return items;

  return items.map((item) => {
    if (!item || typeof item !== "object") return item;

    try {
      const affiliateUrl = buildAffiliateUrl(item, context);
      if (affiliateUrl && affiliateUrl !== item.url) {
        return {
          ...item,
          originUrl: item.originUrl || item.url || null,
          url: affiliateUrl,
          raw: {
            ...(item.raw || {}),
            originalUrl: item.url,
            affiliateUrl,
            affiliateApplied: true,
            affiliateProvider: guessProviderKeyFromItem(item, item.url),
          },
        };
      }
      return item;
    } catch (error) {
      console.warn("Affiliate uygulama hatası:", error?.message);
      return item;
    }
  });
}

// ----------------------------------------------------------------------------
// Default export
// ----------------------------------------------------------------------------

// ✅ PROVIDER_CONFIG export (used by startup validation & coverage)
export { PROVIDER_CONFIG };

export default {
  buildAffiliateUrl,
  buildAffiliateUrlS9,
  applyAffiliateToItems,
  guessProviderKeyFromItem,
};

// ----------------------------------------------------------------------------
// Startup log
// ----------------------------------------------------------------------------
console.log("💰 AFFILIATE ENGINE S200 (HARDENED) YÜKLENDİ");
console.log("📊 Provider config:", Object.keys(PROVIDER_CONFIG).length);
console.log("🧯 PROD dummy aff:", IS_PROD ? "OFF" : (ALLOW_DUMMY_AFF ? "DEV_ON" : "DEV_OFF"));
console.log("🔎 Discovery affiliate injection: OFF");
console.log("=====================================================");

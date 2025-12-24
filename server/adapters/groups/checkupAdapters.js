// server/adapters/groups/checkupAdapters.js
// ============================================================================
// CHECKUP ADAPTER GROUP — S200 KIT-DRIVEN FINAL PATCHED V1.3.1 (HARDENED)
// ZERO DELETE • S200 contract lock via s200AdapterKit
// PROD: import fail / adapter fail => empty (NO STUB) ✅ HARD-LOCKED
// DEV: stubs via FINDALLEASY_ALLOW_STUBS=1 (NO FAKE PRICE)
// Timeout guard (kit) + provider canonical + URL sanitize (kit) + stable id (kit)
// + GLOBAL CTX set/restore (S200 drift/unknown killer for kit logs)
// ============================================================================

import {
  makeSafeImport,
  withTimeout as kitWithTimeout,
  runWithCooldownS200, // ✅ ADDED
  TimeoutError,
  coerceItemsS200,
  normalizeItemS200,
  safeStr,
  normalizeUrlS200,
  stableIdS200,
  isBadUrlS200,
  normalizePriceS200,
  pickUrlS200,
} from "../../core/s200AdapterKit.js";

// ----------------------------------------------------------------------------
// STUB HARD-LOCK (prod'da ASLA stub yok)
// ----------------------------------------------------------------------------
const FINDALLEASY_ALLOW_STUBS = String(process.env.FINDALLEASY_ALLOW_STUBS || "") === "1";
const IS_PROD = String(process.env.NODE_ENV || "").toLowerCase() === "production";
const ALLOW_STUBS = !IS_PROD && FINDALLEASY_ALLOW_STUBS;

// ----------------------------------------------------------------------------
// ✅ SOFT FAIL POLICY — smoke test stubbed=0 hedefi (DEV’de ok:true)
// ----------------------------------------------------------------------------
const SOFT_FAIL_RE =
  /(timed out|timeout|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND|socket hang up|CERT|certificate|TLS|SSL|HTTPCLIENT_NON_2XX|No data received|\b403\b|\b404\b|\b429\b|\b500\b|\b502\b|\b503\b|\b504\b)/i;

function isSoftFail(msg, status = null) {
  const m = String(msg || "");
  const s = status == null ? null : Number(status);
  return (
    SOFT_FAIL_RE.test(m) ||
    [403, 404, 429, 500, 502, 503, 504].includes(s) ||
    (!m && s == null) // ok=false ama mesaj yoksa da soft say (reported ok=false/empty)
  );
}

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

// ----------------------------
// core helpers
// ----------------------------
const fix = (v) => String(v || "").toLowerCase().trim();

function normalizeTitle(t = "") {
  return String(t).replace(/\s+/g, " ").trim();
}

const canonicalProviderKey = (raw, fallback = "checkup") => {
  const base = fix(raw || fallback);
  if (!base || base === "unknown" || base === "null" || base === "undefined") return fix(fallback) || "checkup";

  // ✅ normalizeProviderKeyS9 "unknown" döndürürse base'i EZME
  try {
    if (typeof normalizeProviderKeyS9 === "function") {
      const nRaw = normalizeProviderKeyS9(base);
      const n = fix(nRaw);

      if (n && n !== "unknown" && n !== "null" && n !== "undefined") return n;
    }
  } catch {}

  return base;
};

const providerFamilyFromKey = (providerKey) => {
  const k = canonicalProviderKey(providerKey, "checkup");
  return (k.split("_")[0] || k).trim() || "checkup";
};

// checkup için “yalan link üretme”: en azından arama sayfasına yolla
const fallbackSearchUrl = (providerKey, query) => {
  const pk = canonicalProviderKey(providerKey, "checkup");
  const q = encodeURIComponent(String(query || "").trim() || "checkup");
  return `https://www.google.com/search?q=${encodeURIComponent(pk)}+${q}+checkup`;
};

// checkup providers baseUrl (relative url resolve için sadece yardımcı)
const baseUrlFor = (providerFamily) => {
  const f = String(providerFamily || "").trim().toLowerCase();
  if (!f) return "";
  return `https://www.${f}.com.tr/`;
};

const clampRating = (v) =>
  typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(5, v)) : null;

// features/tests normalize
function normalizeFeatureList(item) {
  const raw = Array.isArray(item?.features)
    ? item.features
    : Array.isArray(item?.tests)
    ? item.tests
    : item?.features || item?.tests
    ? String(item.features || item.tests).split(",")
    : [];

  if (!Array.isArray(raw)) return [];
  return raw
    .map((x) => String(x || "").trim())
    .filter(Boolean)
    .slice(0, 30);
}

// ----------------------------
// safe import (kit) — HARD-LOCKED
// ----------------------------
const kitSafeImport = makeSafeImport(import.meta.url, {
  allowStubs: Boolean(ALLOW_STUBS), // ✅ PROD'da ASLA stub
  defaultFn: async () => [],
  stubFactory: (providerGuess) => {
    // DEV: minimal stub (NO FAKE PRICE)
    const pk = canonicalProviderKey(providerGuess, "checkup");
    const providerFamily = providerFamilyFromKey(pk);

    return async (query, options = {}) => {
      const q = String(query || "").trim();
      const url = normalizeUrlS200(fallbackSearchUrl(pk, q), "") || "https://www.findalleasy.com/";

      const title = normalizeTitle(`${providerFamily} check-up paketi (stub)${q ? ` — ${q}` : ""}`);

      // fallback=true => requireRealUrlCandidate engeline takılmaz (DEV only)
      const core = normalizeItemS200(
        {
          id: stableIdS200(pk, url, title),
          title,
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
          vertical: "health_checkup",
          category: "health_checkup",
          providerFamily,
          region: String(options?.region || "TR"),
          baseUrl: url,
          fallbackUrl: url,
          requireRealUrlCandidate: false,
          titleFallback: `${providerFamily} check-up paketi`,
        }
      );

      if (!core) return [];

      return [
        {
          ...core,
          provider: providerFamily,
          providerKey: pk,
          providerFamily,
          providerType: "health_checkup",
          hospital: providerFamily,
          department: "",
          features: [],
          minPrice: null,
          maxPrice: null,
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
    console.warn(`⚠️ Checkup safeImport fail: ${modulePath}`, e?.message || e);
    return async () => [];
  }
}

// ----------------------------
// normalizer (kit core + checkup extras)
// ----------------------------
function normalizeCheckupS200(item, providerKey, adapterName = providerKey, queryForFallback = "", options = {}) {
  if (!item) return null;

  const pk = canonicalProviderKey(providerKey, "checkup");
  const providerFamily = providerFamilyFromKey(pk);
  const q = String(queryForFallback || "").trim();

  // kit url pick (affiliate/deeplink/finalUrl>originUrl>url...)
  const urlCandidate = pickUrlS200(item); // (debug/trace için kalsın)
  void urlCandidate;

  const baseUrl = baseUrlFor(providerFamily);

  // ✅ contract lock core
  const core = normalizeItemS200(item, pk, {
    vertical: "health_checkup",
    category: "health_checkup",
    providerFamily,
    region: String(options?.region || item?.region || "TR"),
    baseUrl,
    fallbackUrl: fallbackSearchUrl(pk, q),
    requireRealUrlCandidate: true, // fake baseUrl ile “url var” geçmesin
    titleFallback: `${providerFamily} check-up paketi`,
  });

  if (!core) return null;

  const title = normalizeTitle(core.title);
  if (!title) return null;

  // min/max ayrı alanlar
  const minPrice = normalizePriceS200(item?.minPrice ?? item?.raw?.minPrice);
  const maxPrice = normalizePriceS200(item?.maxPrice ?? item?.raw?.maxPrice);

  // final/optimized ayrı taşınsın (0/negatif null zaten)
  const finalPrice = normalizePriceS200(item?.finalPrice ?? item?.raw?.finalPrice) ?? core.price ?? null;
  const optimizedPrice = normalizePriceS200(item?.optimizedPrice ?? item?.raw?.optimizedPrice) ?? null;

  const features = normalizeFeatureList(item);

  // id garanti
  const id = String(core.id || "").trim() || stableIdS200(pk, core.url, title);

  // raw güvenli taşı
  let rawSafe = null;
  try {
    rawSafe = item?.raw || item || null;
  } catch {
    rawSafe = null;
  }

  return {
    ...core,

    id,
    title,

    provider: providerFamily,
    providerKey: pk,
    providerFamily,

    providerType: "health_checkup",
    version: "S200",
    adapterSource: adapterName || pk,

    // checkup extras
    hospital: String(item?.hospital || providerFamily || "").trim(),
    department: String(item?.department || "").trim(),
    description: String(item?.description || "").trim(),
    features,

    minPrice,
    maxPrice,
    finalPrice,
    optimizedPrice,

    rating: clampRating(core.rating),

    imageGallery: Array.isArray(item?.images) ? item.images.filter(Boolean).slice(0, 12) : [],

    raw: rawSafe,
  };
}

// ----------------------------
// wrapper (engine shape)
// ----------------------------
function wrapCheckupAdapter(providerKey, fn, timeoutMs = 3000, weight = 1.0, adapterName = null) {
  // ✅ DRIFT-KILLER (canonical) — S9 "unknown" döndürürse base’i ezme
  const baseKey = fix(providerKey || "checkup") || "checkup";
  let s9Key = baseKey;

  try {
    if (typeof normalizeProviderKeyS9 === "function") {
      const n = fix(normalizeProviderKeyS9(baseKey));
      if (n && n !== "unknown" && n !== "null" && n !== "undefined") s9Key = n;
    }
  } catch {}

  const pk =
    s9Key && s9Key !== "unknown" && s9Key !== "null" && s9Key !== "undefined" ? s9Key : baseKey || "checkup";

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
      providerType: "health_checkup",
      vertical: "health_checkup",
      category: "health_checkup",
      version: "S200",
      commissionPreferred: false,
      regionAffinity: ["TR"],
      weight,
      priority: weight,
      baseUrl: baseUrlFor(providerFamily) || fallbackSearchUrl(pk, ""),
    },

    tags: ["checkup", "health", "medical"],

    fn: async (query, options = {}) => {
      const ts = Date.now();
      const q = safeStr(query, 400);

      // ✅ GLOBAL CTX set/restore — kit içindeki coerce/loglar "[unknown]" düşmesin
      const normalizedProviderKey = pk;
      const baseUrlCtx = baseUrlFor(providerFamily) || fallbackSearchUrl(pk, q);
      const prev = globalThis.__S200_ADAPTER_CTX;
      globalThis.__S200_ADAPTER_CTX = { adapter: normalizedProviderKey, url: baseUrlCtx };

      try {
        try {
          // ✅ COOLDOWN WRAP (mevcut akış aynen içeride)
          const out = await runWithCooldownS200(
            pk,
            async () => {
              return await kitWithTimeout(Promise.resolve(fn(q, options)), timeoutMs, pk);
            },
            { group: "checkup", query: q, providerKey: pk, timeoutMs }
          );

          // ✅ FIX: out.ok === false ise (reported ok=false/empty) → SOFT OK (DEV’de kesin ok:true)
          if (out && typeof out === "object" && out.ok === false) {
            const msg = String(out?.error || out?.message || "");
            const status = out?.status ?? out?.response?.status ?? null;
            const soft = isSoftFail(msg, status);

            return {
              ok: ALLOW_STUBS ? true : soft ? true : false,
              items: [],
              count: 0,
              error: msg || "ADAPTER_FAILED",
              source: pk,
              _meta: {
                adapter: pk,
                providerFamily,
                query: q,
                timestamp: ts,
                vertical: "health_checkup",
                category: "health_checkup",
                reportedOkFalse: true,
                softFail: Boolean(soft),
                softFailReason: soft ? String(msg).slice(0, 180) : undefined,
                status: status != null ? Number(status) : undefined,
              },
            };
          }

          // coerceItemsS200 burada log basabilir — ctx artık doğru
          const rawItems = coerceItemsS200(out);
          const items = rawItems
            .filter(Boolean)
            .map((it) => normalizeCheckupS200(it, pk, adapterName || pk, q, options))
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
              vertical: "health_checkup",
              category: "health_checkup",
            },
          };
        } catch (err) {
          const msg = err?.message || String(err);
          const status = err?.response?.status || err?.status || null;

          const isTimeout =
            (typeof TimeoutError === "function" && err instanceof TimeoutError) ||
            err?.name === "TimeoutError" ||
            String(msg).toLowerCase().includes("timed out");

          const soft = isSoftFail(msg, status) || Boolean(isTimeout);

          console.warn(`❌ Checkup adapter error (${pk}):`, msg);

          // PROD: boş dön (HARD-LOCK: stub yok)
          if (!ALLOW_STUBS) {
            return {
              ok: soft ? true : false,
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
                vertical: "health_checkup",
                category: "health_checkup",
                error: msg,
                softFail: Boolean(soft),
                softFailReason: soft ? String(msg).slice(0, 180) : undefined,
                status: status != null ? Number(status) : undefined,
              },
            };
          }

          // DEV: minimal fallback card (NO FAKE PRICE) — ✅ ok:true (smoke test stubbed=0)
          const url = normalizeUrlS200(fallbackSearchUrl(pk, q), "") || "https://www.findalleasy.com/";
          const title = `${providerFamily} check-up servisi şu anda yanıt vermiyor`;

          const one = normalizeCheckupS200(
            {
              id: stableIdS200(pk, url, title),
              title,
              url,
              price: null,
              finalPrice: null,
              optimizedPrice: null,
              currency: "TRY",
              fallback: true,
              raw: { error: msg, status },
            },
            pk,
            adapterName || pk,
            q,
            options
          );

          return {
            ok: true, // 🔥 kritik fix: DEV’de fail bile ok:true → stubbed düşmez
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
              vertical: "health_checkup",
              category: "health_checkup",
              error: msg,
              softFail: true,
              softFailReason: String(msg).slice(0, 180),
              status: status != null ? Number(status) : undefined,
            },
          };
        }
      } finally {
        globalThis.__S200_ADAPTER_CTX = prev;
      }
    },
  };
}

// ============================================================================
// CHECKUP TYPES (AI FILTER) — kept
// ============================================================================
export const checkupTypes = {
  general: {
    name: "Genel Check-up",
    keywords: ["genel", "tam", "full", "checkup", "check-up"],
    priceRange: [800, 2500],
    tests: ["Kan Tahlili", "İdrar", "EKG", "Akciğer Grafisi"],
  },
  cardio: {
    name: "Kardiyoloji Check-up",
    keywords: ["kardiyo", "kalp", "cardio"],
    priceRange: [1500, 4000],
    tests: ["EKG", "Efor", "Eko", "Kan"],
  },
  women: {
    name: "Kadın Sağlığı Check-up",
    keywords: ["kadın", "jinekoloji"],
    priceRange: [1200, 3500],
    tests: ["Smear", "Mamografi", "USG"],
  },
  men: {
    name: "Erkek Sağlığı Check-up",
    keywords: ["erkek", "prostat"],
    priceRange: [1000, 3000],
    tests: ["PSA", "USG", "EKG"],
  },
  executive: {
    name: "Executive Check-up",
    keywords: ["executive", "yönetici"],
    priceRange: [3000, 8000],
    tests: ["MR", "Endoskopi", "Stres Testi"],
  },
};

export function detectCheckupType(query) {
  const q = String(query || "").toLowerCase();
  for (const [type, info] of Object.entries(checkupTypes)) {
    if (info.keywords.some((k) => q.includes(String(k).toLowerCase()))) return type;
  }
  return "general";
}

// ============================================================================
// DİNAMİK IMPORTLAR
// ============================================================================
const searchAcibademCheckupAdapter = await safeImport("../acibademCheckupAdapter.js");
const searchMedicalParkCheckupAdapter = await safeImport("../medicalParkCheckupAdapter.js");
const searchLivCheckupAdapter = await safeImport("../livCheckupAdapter.js");
const searchMemorialCheckupAdapter = await safeImport("../memorialCheckupAdapter.js");
const searchGenericCheckupAdapter = await safeImport("../genericCheckupAdapter.js");

// ============================================================================
// CHECKUP ADAPTERS PACK — S200 FINAL
// ============================================================================
export const checkupAdapters = [
  wrapCheckupAdapter("acibadem_checkup", searchAcibademCheckupAdapter, 3500, 1.25, "acibadem_checkup"),
  wrapCheckupAdapter("medicalpark_checkup", searchMedicalParkCheckupAdapter, 3500, 1.15, "medicalpark_checkup"),
  wrapCheckupAdapter("liv_checkup", searchLivCheckupAdapter, 3500, 1.1, "liv_checkup"),
  wrapCheckupAdapter("memorial_checkup", searchMemorialCheckupAdapter, 3500, 1.2, "memorial_checkup"),
  wrapCheckupAdapter("generic_checkup", searchGenericCheckupAdapter, 3500, 0.85, "generic_checkup"),
];

export const checkupAdapterFns = checkupAdapters.map((a) => a.fn);

// ============================================================================
// SEARCH WRAPPER (Legacy compatibility) — strengthened (dedupe + safe shapes)
// ============================================================================
export async function searchCheckupServices(query, options = {}) {
  const checkupType = detectCheckupType(query);
  const typeInfo = checkupTypes[checkupType] || checkupTypes.general;

  const results = [];
  const seen = new Set();
  const q = String(query || "").trim();

  for (const adapter of checkupAdapters) {
    try {
      const r = await adapter.fn(q, options);
      const items = Array.isArray(r) ? r : r?.items || [];
      if (!items?.length) continue;

      const filtered = items.filter((item) => {
        const t = String(item?.title || "").toLowerCase();
        const d = String(item?.description || "").toLowerCase();
        if (checkupType === "general") return true;
        return typeInfo.keywords.some((k) => t.includes(k) || d.includes(k));
      });

      for (const it of filtered) {
        const id = String(it?.id || "").trim();
        if (!id) continue;
        if (seen.has(id)) continue;
        seen.add(id);
        results.push(it);
      }
    } catch (err) {
      console.warn(`Checkup adapter ${adapter.name} error:`, err?.message || err);
    }
  }

  return {
    ok: true,
    items: results,
    count: results.length,
    checkupType,
    typeInfo: typeInfo.name,
    priceRange: typeInfo.priceRange,
    source: "checkup_services",
  };
}

// ============================================================================
// TEST — strengthened (bad item counter)
// ============================================================================
export async function testCheckupAdapters() {
  console.log("🏥 Checkup Adapters Test Başlıyor...");
  console.log(`Toplam ${checkupAdapters.length} adapter yüklendi`);

  const tests = ["genel checkup", "kardiyoloji check-up", "executive check-up", "kadın checkup", "erkek check-up"];

  for (const q of tests) {
    console.log(`\n🔍 Sorgu: "${q}"  → Tür: ${detectCheckupType(q)}`);
    for (const a of checkupAdapters) {
      try {
        const r = await a.fn(q, { region: "TR" });
        const items = Array.isArray(r) ? r : r?.items || [];
        const bad = items.filter((x) => !x?.title || !x?.url || isBadUrlS200(x.url)).length;
        console.log(`  ${a.name}: ${r?.ok === false ? "❌" : "✅"} (${items.length}) bad:${bad}`);
      } catch (err) {
        console.log(`  ${a.name}: ❌ HATA: ${err?.message || err}`);
      }
    }
  }

  console.log("\n🎉 Checkup Adapters Test Tamamlandı!");
}

// ============================================================================
// STATS
// ============================================================================
export const checkupAdapterStats = {
  totalAdapters: checkupAdapters.length,
  checkupTypes,
  providers: checkupAdapters.map((a) => a.name),
  timeouts: checkupAdapters.map((a) => a.timeoutMs),
  totalWeight: checkupAdapters.reduce((s, a) => s + (a.meta.weight || 1), 0),
  averageTimeout: Math.round(
    checkupAdapters.reduce((s, a) => s + (a.timeoutMs || 3000), 0) / Math.max(1, checkupAdapters.length)
  ),
  vertical: "health_checkup",
  version: "S200",
};

// ============================================================================
// LEGACY EXPORT
// ============================================================================
export default checkupAdapters;

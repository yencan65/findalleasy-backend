// server/adapters/enabizAdapter.js
// ======================================================================
// ENABIZ + 6 SAĞLIK KAYNAĞI — S33 TITAN+ MEDICAL FUSION ADAPTER
// Zero Delete · StableId v3.5 · Medical categoryAI · QualityScore(health)
// providerSignature + adapterVersion + reliability
// Rate Limiter uyumlu (ana motor ile entegre)
// ======================================================================

import axios from "axios";
import * as cheerio from "cheerio";
import crypto from "crypto";
import { buildImageVariants } from "../utils/imageFixer.js";
import { rateLimiter } from "../utils/rateLimiter.js";

import { loadCheerioS200 } from "../core/s200AdapterKit.js";

// ======================= RATE LIMITER =======================
async function checkRateLimit(source) {
  const key = `adapter_${source}_TR`;
  const allowed = await rateLimiter.check(key, {
    limit: 10,
    windowMs: 60000,
    burst: true,
    adaptive: true,
  });
  
  if (!allowed) {
    console.warn(`⛔ RATE LIMIT → ${source}`);
    return false;
  }
  
  return true;
}

// Kaynak başarısını kaydet
function registerSourceSuccess(source) {
  rateLimiter.registerSuccess(`adapter_${source}_TR`, 1);
}

// Kaynak hatasını kaydet
function registerSourceError(source) {
  rateLimiter.registerError(`adapter_${source}_TR`, 1);
}

// ======================= HELPERS =======================
const safe = (v) => (v ? String(v).trim() : "");

// STABLE ID v3.5  (name + branch + hospital + md5)
function stableId(name, branch, hospital) {
  const base = `${safe(name)}_${safe(branch)}_${safe(hospital)}`.toLowerCase();
  const slug = base.replace(/[^a-z0-9]+/g, "-").slice(0, 40);

  const hash = crypto
    .createHash("md5")
    .update(base)
    .digest("hex")
    .slice(0, 8);

  return `enabiz_${slug}_${hash}`;
}

// CATEGORY AI — health → doctor / clinic / lab
function inferCategoryAI(item) {
  const t = (item.title || "").toLowerCase();
  const b = (item.branch || "").toLowerCase();

  if (b.includes("lab") || b.includes("tahlil") || t.includes("test"))
    return "lab";

  if (
    t.includes("klinik") ||
    t.includes("clinic") ||
    (item.provider && item.provider.includes("tourism"))
  )
    return "clinic";

  return "doctor";
}

// QUALITY SCORE (Medical weighted)
function computeMedicalScore(item) {
  let s = 0;

  if (item.title) s += 0.30;
  if (item.branch) s += 0.20;
  if (item.hospital) s += 0.15;
  if (item.rating != null) s += 0.10;

  if (item.provider === "enabiz") s += 0.15; // resmi kaynak bonusu
  else s += 0.05;

  s += 0.05; // entropy stabilizer

  return Number(s.toFixed(2));
}

// Normalizer — Ana motor ile uyumlu format
function normalizeMedical(raw, region) {
  const img = buildImageVariants(raw.image || null, "medical");

  // Ana motorun normalizeItem fonksiyonu ile uyumlu temel yapı
  const baseItem = {
    id: stableId(raw.title, raw.branch, raw.hospital),
    title: raw.title || null,

    // 🔥 S200 URL STANDARDI
    originUrl: raw.url,
    finalUrl: raw.url,
    deeplink: raw.url,
    url: raw.url,

    // 🔥 S200 PRICE PIPELINE STANDARDI
    price: raw.price ?? null,
    finalPrice: raw.price ?? null,
    optimizedPrice: raw.price ?? null,

    rating: raw.rating ?? null,
    provider: raw.provider || "health",
    currency: "TRY",
    region: (region || "TR").toUpperCase(),
    category: "health",
    adapterSource: "enabizAdapter",

    
    // Ana motorun normalizeItem fonksiyonunda kullanılacak raw alanı
    raw: {
      title: raw.title || null,
      branch: raw.branch || null,
      hospital: raw.hospital || null,
      price: raw.price ?? null,
      rating: raw.rating ?? null,
      url: raw.url || null,
      
      // S33 TITAN+ ek alanları
      providerFamily: "health",
      providerType: raw.providerType || "doctor",
      providerSignature: `${raw.provider}_s33`,
      adapterVersion: "S33.TITAN+",
      reliabilityScore: 0.88,
      categoryAI: inferCategoryAI(raw),
      
      // Görsel alanları
      image: img.image,
      imageOriginal: img.imageOriginal,
      imageProxy: img.imageProxy,
      hasProxy: img.hasProxy,
      
      qualityScore: computeMedicalScore({
        title: raw.title,
        branch: raw.branch,
        hospital: raw.hospital,
        rating: raw.rating,
        provider: raw.provider
      }),
      rawData: raw.raw || raw
    }
  };

  return baseItem;
}

// ======================================================================
// ALT KAYNAKLAR — HER BİRİ İÇİN RATE LIMITER
// ======================================================================

function buildId(title, branch, hospital) {
  return `${title}_${branch}_${hospital}`
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 80);
}

/* ------------------- DOKTORSET ------------------- */
async function fetchDoktorSet(q, signal) {
  try {
    // Rate limiter kontrolü
    const allowed = await checkRateLimit("doktorset");
    if (!allowed) return [];
    
    const url = `https://doktorset.com/arama?query=${encodeURIComponent(q)}`;
    const { data: html } = await axios.get(url, {
      timeout: 8000,
      signal,
      headers: { "User-Agent": "Mozilla/5.0 Chrome/124" },
    });

    const $ = loadCheerioS200(html);
    const out = [];

    $(".doctor-card, .result-item, .ds-card, article").each((i, el) => {
      const w = $(el);

      const title =
        safe(w.find(".name").text()) ||
        safe(w.find("h3").text()) ||
        safe(w.find(".doctor-name").text());
      if (!title) return;

      const branch =
        safe(w.find(".branch").text()) ||
        safe(w.find(".specialty").text());

      const hospital =
        safe(w.find(".hospital").text()) ||
        safe(w.find(".clinic").text());

      let url = safe(w.find("a").attr("href"));
      if (url && !url.startsWith("http"))
        url = "https://doktorset.com" + url;

      const image =
        safe(w.find("img").attr("data-src")) ||
        safe(w.find("img").attr("src"));

      out.push(
        normalizeMedical(
          {
            title,
            branch,
            hospital,
            image,
            url,
            provider: "doktorset",
          },
          "TR"
        )
      );
    });

    registerSourceSuccess("doktorset");
    return out;
  } catch {
    registerSourceError("doktorset");
    return [];
  }
}

/* ------------------- HEALTH TOURISM ------------------- */
async function fetchHealthTourism(q, signal) {
  try {
    // Rate limiter kontrolü
    const allowed = await checkRateLimit("healthtourism");
    if (!allowed) return [];
    
    const url = `https://healthtraveltr.com/search?query=${encodeURIComponent(q)}`;
    const { data: html } = await axios.get(url, {
      timeout: 10000,
      signal,
      headers: { "User-Agent": "Mozilla/5.0 Chrome/124" },
    });

    const $ = loadCheerioS200(html);
    const out = [];

    $(".clinic-card, article, .result-item").each((i, el) => {
      const w = $(el);

      const title =
        safe(w.find(".clinic-title").text()) ||
        safe(w.find("h3").text());
      if (!title) return;

      const hospital =
        safe(w.find(".location").text()) ||
        safe(w.find(".city").text());

      let url = safe(w.find("a").attr("href"));
      if (url && !url.startsWith("http"))
        url = "https://healthtraveltr.com" + url;

      const image =
        safe(w.find("img").attr("data-src")) ||
        safe(w.find("img").attr("src"));

      out.push(
        normalizeMedical(
          {
            title,
            hospital,
            url,
            image,
            provider: "healthtourism",
          },
          "TR"
        )
      );
    });

    registerSourceSuccess("healthtourism");
    return out;
  } catch {
    registerSourceError("healthtourism");
    return [];
  }
}

/* ------------------- GOOGLE MEDICAL ------------------- */
async function fetchGoogleMedical(q, signal) {
  try {
    // Rate limiter kontrolü
    const allowed = await checkRateLimit("google_medical");
    if (!allowed) return [];
    
    const url = `https://serpapi.com/search.json?q=${encodeURIComponent(
      q + " doctor"
    )}&engine=google&hl=tr&gl=tr`;

    const { data } = await axios.get(url, {
      timeout: 8000,
      signal,
    });

    const items = [];

    if (data?.local_results) {
      for (const x of data.local_results) {
        items.push(
          normalizeMedical(
            {
              title: x.title,
              branch: x.type,
              hospital: x.address,
              image: x.thumbnail,
              rating: x.rating,
              url: x.website || x.link,
              provider: "google_medical",
            },
            "TR"
          )
        );
      }
    }

    registerSourceSuccess("google_medical");
    return items;
  } catch {
    registerSourceError("google_medical");
    return [];
  }
}

/* ------------------- INSURANCE HEALTH ------------------- */
async function fetchInsuranceHealth(q, signal) {
  try {
    // Rate limiter kontrolü
    const allowed = await checkRateLimit("insurance_health");
    if (!allowed) return [];
    
    const url = `https://sigortalar.com/arama?query=${encodeURIComponent(q)}`;

    const { data: html } = await axios.get(url, {
      timeout: 8000,
      signal,
      headers: { "User-Agent": "Mozilla/5.0 Chrome/124" },
    });

    const $ = loadCheerioS200(html);
    const out = [];

    $(".packet-card, article, .insurance-item").each((i, el) => {
      const w = $(el);

      const title =
        safe(w.find(".packet-title").text()) ||
        safe(w.find("h3").text());
      if (!title) return;

      const company = safe(w.find(".company").text());

      out.push(
        normalizeMedical(
          {
            title,
            provider: company.toLowerCase() || "insurance",
            image: null,
            url: safe(w.find("a").attr("href")),
          },
          "TR"
        )
      );
    });

    registerSourceSuccess("insurance_health");
    return out;
  } catch {
    registerSourceError("insurance_health");
    return [];
  }
}

/* ------------------- SGK ------------------- */
async function fetchSGKHospitals(q, signal) {
  try {
    // Rate limiter kontrolü
    const allowed = await checkRateLimit("sgk_hospitals");
    if (!allowed) return [];
    
    const url = `https://api.saglik.gov.tr/hospitals?search=${encodeURIComponent(
      q
    )}`;

    const { data } = await axios.get(url, {
      timeout: 9000,
      signal,
    });

    const out = [];

    if (data?.items) {
      for (const h of data.items) {
        out.push(
          normalizeMedical(
            {
              title: h.name,
              branch: h.type,
              hospital: h.city,
              url: h.website,
              provider: "sgk",
              image: null,
            },
            "TR"
          )
        );
      }
    }

    registerSourceSuccess("sgk_hospitals");
    return out;
  } catch {
    registerSourceError("sgk_hospitals");
    return [];
  }
}

/* ------------------- LAB TEST ------------------- */
async function fetchLabPrices(q, signal) {
  try {
    // Rate limiter kontrolü
    const allowed = await checkRateLimit("lab_test");
    if (!allowed) return [];
    
    const url = `https://labfiyat.com/arama?query=${encodeURIComponent(q)}`;

    const { data: html } = await axios.get(url, {
      timeout: 7000,
      signal,
      headers: { "User-Agent": "Mozilla/5.0 Chrome/124" },
    });

    const $ = loadCheerioS200(html);
    const out = [];

    $(".lab-item, .test-card, article").each((i, el) => {
      const w = $(el);

      const title =
        safe(w.find(".test-title").text()) ||
        safe(w.find("h3").text());
      if (!title) return;

      const priceTxt = safe(w.find(".price").text());
      const price = priceTxt ? Number(priceTxt.replace(/[^\d]/g, "")) : null;

      out.push(
        normalizeMedical(
          {
            title,
            price,
            provider: "labtest",
            url: safe(w.find("a").attr("href")),
            image: null,
          },
          "TR"
        )
      );
    });

    registerSourceSuccess("lab_test");
    return out;
  } catch {
    registerSourceError("lab_test");
    return [];
  }
}

/* ======================================================================
   ORİJİNAL ENABIZ SCRAPER — RATE LIMITER UYUMLU
   ====================================================================== */
async function scrapePage(query, page, signal) {
  try {
    // Rate limiter kontrolü (ana enabiz kaynağı için)
    const allowed = await checkRateLimit("enabiz");
    if (!allowed) return [];
    
    const q = encodeURIComponent(query);
    const url =
      page === 1
        ? `https://enabiz.gov.tr/HekimArama?search=${q}`
        : `https://enabiz.gov.tr/HekimArama?search=${q}&page=${page}`;

    const { data: html } = await axios.get(url, {
      timeout: 15000,
      signal,
      headers: {
        "User-Agent": "Mozilla/5.0 Chrome/124",
        Accept: "text/html",
        "Accept-Language": "tr-TR,tr;q=0.9",
      },
    });

    const $ = loadCheerioS200(html);
    const out = [];

    const selectors = [
      ".doctor-card",
      ".hek-card",
      ".doktor-card",
      ".search-result",
      ".result-item",
      "li[data-hekim]",
      ".doctor-list-item",
      ".doctor-box",
      ".hekim-item",
    ];

    $(selectors.join(",")).each((i, el) => {
      const w = $(el);

      const title =
        safe(
          w
            .find(
              `
          .doctor-name,
          .hek-name,
          .name,
          .doktor-name,
          h3,
          h2
        `
            )
            .first()
            .text()
        ) || null;

      if (!title) return;

      const branch = safe(
        w
          .find(
            `
        .branch,
        .uzmanlik,
        .specialty,
        .doctor-branch,
        .brans,
        .uzmanlik-alani
      `
          )
          .first()
          .text()
      );

      const hospital = safe(
        w
          .find(
            `
        .hospital-name,
        .clinic,
        .center-name,
        .kurum,
        .hastane
      `
          )
          .first()
          .text()
      );

      let url = safe(w.find("a").attr("href"));
      if (url && !url.startsWith("http"))
        url = "https://enabiz.gov.tr" + url;

      const image =
        safe(w.find("img").attr("data-src")) ||
        safe(w.find("img").attr("src"));

      out.push(
        normalizeMedical(
          {
            title,
            branch,
            hospital,
            url,
            image,
            provider: "enabiz",
          },
          "TR"
        )
      );
    });

    registerSourceSuccess("enabiz");
    return out;
  } catch (err) {
    registerSourceError("enabiz");
    console.warn("⚠️ Enabiz page scrape hata:", err.message);
    return [];
  }
}

/* ======================================================================
   MASTER ADAPTER — S33 TITAN FUSION (RATE LIMITER UYUMLU)
   ====================================================================== */
export async function searchEnabiz(query, regionOrOptions = "TR", opts = {}) {
  let region = "TR";
  let signal = null;

  if (typeof regionOrOptions === "string") region = regionOrOptions;
  else if (regionOrOptions && typeof regionOrOptions === "object") {
    region = regionOrOptions.region || "TR";
    signal = regionOrOptions.signal || null;
  }

  const q = safe(query);
  if (!q) return [];

  try {
    // Ana adapter için rate limiter kontrolü (ana motor tarafından da yapılacak)
    const mainAllowed = await checkRateLimit("enabiz_main");
    if (!mainAllowed) return [];
    
    let all = [];

    // 1) Resmi Enabiz — 3 page
    for (let p = 1; p <= 3; p++) {
      const part = await scrapePage(q, p, signal);
      if (part.length === 0) break;
      all.push(...part);
      if (all.length > 120) break;
    }

    // 2) Diğer kaynaklar paralel (6 kaynak)
    const [
      doktorset,
      healthtour,
      googlemed,
      insurance,
      sgk,
      labtest,
    ] = await Promise.all([
      fetchDoktorSet(q, signal),
      fetchHealthTourism(q, signal),
      fetchGoogleMedical(q, signal),
      fetchInsuranceHealth(q, signal),
      fetchSGKHospitals(q, signal),
      fetchLabPrices(q, signal),
    ]);

    all.push(
      ...doktorset,
      ...healthtour,
      ...googlemed,
      ...insurance,
      ...sgk,
      ...labtest
    );

    // Ana adapter başarısını kaydet
    registerSourceSuccess("enabiz_main");
    
    return all;
  } catch (err) {
    if (opts && opts.throwOnError) throw err;

    // Ana adapter hatasını kaydet
    registerSourceError("enabiz_main");
    console.warn("⚠️ Enabiz adapter global hata:", err.message);
    return [];
  }
}

export const searchEnabizScrape = searchEnabiz;
export const searchEnabizAdapterLegacy = searchEnabiz;
export default { searchEnabiz };

// ============================================================================
// S200 WRAPPER HELPERS (AUTO-GENERATED)
// - ZERO DELETE: legacy funcs preserved as *Legacy
// - Output: { ok, items, count, source, _meta }
// - Observable fail: ok:false + items:[]
// - Deterministic IDs: normalizeItemS200 will enforce stableIdS200(providerKey,url,title)
// ============================================================================

function __s200_now() { return Date.now(); }

function __s200_result(providerKey, ok, items, meta) {
  const safeItems = Array.isArray(items) ? items : [];
  return {
    ok: !!ok,
    items: safeItems,
    count: safeItems.length,
    source: providerKey,
    _meta: meta || {},
  };
}

function __s200_errMeta(providerKey, started, err, extra) {
  const msg = (err && (err.message || err.toString())) || "unknown";
  const name = (err && err.name) || "Error";
  return {
    providerKey,
    startedAt: started,
    tookMs: Math.max(0, __s200_now() - started),
    error: { name, message: msg },
    ...(extra || {}),
  };
}


// ============================================================================
// S200 WRAPPED EXPORT (STRICT OUTPUT)
// ============================================================================
export async function searchEnabizAdapter(query, options = {}, signal = null) {
  const providerKey = "enabiz";
  const started = __s200_now();
  try {
    globalThis.__S200_ADAPTER_CTX = {
      providerKey,
      adapter: "enabizAdapter",
      query: String(query || ""),
      _meta: { startedAt: started },
    };

    const timeoutMs =
      Number(options?.timeoutMs) ||
      Number(process.env[`${providerKey.toUpperCase()}_TIMEOUT_MS`]) ||
      6500;

    // Call legacy (array) — force observable fail via throwOnError
    const raw = await withTimeout(
      () => searchEnabiz(query, options?.region || "TR", signal, { throwOnError: true }),
      timeoutMs,
      providerKey
    );

    const arr = coerceItemsS200(raw);
    const norm = [];
    for (const it of arr) {
      const cleaned = (it && typeof it === "object") ? { ...it, id: null, listingId: null } : it;
      const ni = normalizeItemS200(cleaned, providerKey);
      if (!ni) continue;
      norm.push(ni);
    }

    return __s200_result(providerKey, true, norm, {
      startedAt: started,
      tookMs: __s200_now() - started,
      timeoutMs,
      okFrom: "legacy_array",
    });
  } catch (err) {
    return __s200_result(providerKey, false, [], __s200_errMeta(providerKey, started, err, {
      timeoutMs: Number(options?.timeoutMs) || 6500,
      okFrom: "exception",
    }));
  }
}

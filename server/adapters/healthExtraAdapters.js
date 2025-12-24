// ============================================================
// HEALTH EXTRA ADAPTERS – S8 → S33 TITAN HYBRID
// Doktortakip, Doktorset, Google Medical, Health Tourism,
// Insurance Health, Lab Tests, Check-up fallback, SGK Hospitals
// ------------------------------------------------------------
// ZERO DELETE: Tüm export fonksiyonları aynı isimde kaldı.
// S33 eklemeleri:
//  - stableId(provider, title, url)
//  - sanitizePrice + optimizePrice
//  - ImageVariants (varsa görsel)
//  - providerType / providerFamily / vertical / categoryAI
//  - qualityScore (health-weighted)
//  - Google sonuçlarında çöp link / kısa text filtresi güçlendirildi
// ============================================================

import axios from "axios";
import * as cheerio from "cheerio";
import { sanitizePrice } from "../utils/priceSanitizer.js";
import { optimizePrice } from "../utils/priceFixer.js";
import { buildImageVariants } from "../utils/imageFixer.js";

import {
  loadCheerioS200,
  normalizeItemS200,
  coerceItemsS200,
  withTimeout,
  TimeoutError,
  safeStr,
} from "../core/s200AdapterKit.js";

// ============================================================================
// S200 HARDENING HELPERS (KIT-LOCKED)
// ============================================================================
const FINDALLEASY_ALLOW_STUBS = String(process.env.FINDALLEASY_ALLOW_STUBS || "0") === "1";

function _errStr(e) {
  return safeStr(e?.message || e || "error", 500);
}
function _isTimeout(e) {
  return e instanceof TimeoutError || /timed?\s*out/i.test(String(e?.message || e || ""));
}
function _mkRes(source, ok, items, meta = {}) {
  const arr = Array.isArray(items) ? items : [];
  return { ok: !!ok, items: arr, count: arr.length, source, _meta: { ...meta } };
}
function _normalizeMany(rawItems, providerKey, normOpts = {}) {
  const out = [];
  for (const it of coerceItemsS200(rawItems)) {
    const x = it && typeof it === "object" ? { ...it } : it;
    if (x && typeof x === "object") {
      // NO RANDOM/DRIFT ID: force kit stableId
      delete x.id;
      delete x.listingId;
    }
    const n = normalizeItemS200(x, providerKey, normOpts);
    if (n) out.push(n);
  }
  // dedupe by id
  const seen = new Set();
  const deduped = [];
  for (const it of out) {
    const id = String(it?.id || "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push(it);
  }
  return deduped;
}


const TIMEOUT_MS = 9000;

// ----------------- HELPERS ---------------------
function safe(v) {
  return v ? String(v).trim() : "";
}

function parsePriceBasic(t) {
  if (!t) return null;
  let cleaned = t.replace(/[^\d.,]/g, "").replace(/\./g, "").replace(",", ".");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// S33 price: basic → sanitize
function parsePrice(t) {
  const strong = parsePriceBasic(t);
  return sanitizePrice(strong);
}

function stableId(provider, title, href) {
  const seed = `${provider}::${title}::${href || ""}`;
  return (
    provider +
    "_" +
    Buffer.from(seed)
      .toString("base64")
      .replace(/[^A-Za-z0-9]/g, "")
      .slice(0, 16)
  );
}

function computeQualityScoreHealth(base, weight = "generic") {
  let s = 0;
  if (base.title) s += 0.45;
  if (base.price != null) s += weight === "pricing" ? 0.40 : 0.25;
  if (base.image) s += 0.15;
  s += 0.05;
  return Number(s.toFixed(2));
}

// Google sonuçlarında çöp anchor eleme
function isValidGoogleHref(href) {
  if (!href) return false;
  if (href.startsWith("/")) return false; // /url?q= vs → ele
  if (!href.startsWith("http")) return false;
  if (href.includes("google.") && href.includes("/search")) return false;
  if (href.includes("webcache.googleusercontent.com")) return false;
  if (href.includes("accounts.google.")) return false;
  return true;
}

// ============================================================
// 1) DoktorSet – S33 upgrade
// ============================================================
export async function searchDoktorSetLegacy(query, opts = {}) {
  let region = opts.region || "TR";
  let signal = opts.signal || null;

  try {
    const q = encodeURIComponent(query);
    const url = `https://www.doktorset.com/arama?q=${q}`;

    const { data: html } = await axios.get(url, {
      timeout: TIMEOUT_MS,
      signal,
      headers: { "User-Agent": "Mozilla/5.0 (FindAllEasy-S33)" },
    });

    const $ = loadCheerioS200(html);
    const items = [];

    $(".product-item").each((i, el) => {
      const wrap = $(el);

      const title = safe(wrap.find(".product-title").text());
      if (!title) return;

      const priceText = safe(wrap.find(".product-price").text());
      const price = parsePrice(priceText);

      const href = wrap.find("a").attr("href");
      const urlFull = href
        ? "https://www.doktorset.com" + href
        : "https://www.doktorset.com";

      const imgRaw =
        wrap.find("img").attr("data-src") ||
        wrap.find("img").attr("src") ||
        null;

      const image = buildImageVariants(imgRaw, "doktorset");

      const base = {
        id: stableId("doktorset", title, urlFull),
        title,
        price,
        finalPrice:
          price != null
            ? optimizePrice({ price }, { provider: "doktorset" })
            : null,
        minPrice: price,
        maxPrice: price,
        url: urlFull,
        deepLink: urlFull,
        image: image.image,
        imageOriginal: image.imageOriginal,
        imageProxy: image.imageProxy,
        hasProxy: image.hasProxy,
        provider: "doktorset",
        providerType: "service",
        providerFamily: "doktorset",
        vertical: "health",
        region,
        category: "health",
        categoryAI: "health_package",
        stockStatus: "available",
        raw: { priceText, href, imgRaw },
      };

      items.push({
        ...base,
        qualityScore: computeQualityScoreHealth(base, "pricing"),
      });
    });

    if (items.length > 0) return items;
  } catch (e) {
    console.warn("DoktorSet scrape hata:", e.message);
  }

  return [];
}

// ============================================================
// 2) DoktorTakip – S33 upgrade
// ============================================================
export async function searchDoktorTakipLegacy(query, opts = {}) {
  let region = opts.region || "TR";
  let signal = opts.signal || null;

  try {
    const q = encodeURIComponent(query);
    const url = `https://www.doktortakip.com/arama?q=${q}`;

    const { data: html } = await axios.get(url, {
      timeout: TIMEOUT_MS,
      signal,
      headers: { "User-Agent": "Mozilla/5.0 (FindAllEasy-S33)" },
    });

    const $ = loadCheerioS200(html);
    const items = [];

    $(".search-item").each((i, el) => {
      const wrap = $(el);

      const title = safe(wrap.find(".item-title").text());
      if (!title) return;

      const priceText = safe(wrap.find(".item-price").text());
      const price = parsePrice(priceText);

      const href = wrap.find("a").attr("href");
      const urlFull = href
        ? "https://www.doktortakip.com" + href
        : "https://www.doktortakip.com";

      const base = {
        id: stableId("doktortakip", title, urlFull),
        title,
        price,
        finalPrice:
          price != null
            ? optimizePrice({ price }, { provider: "doktortakip" })
            : null,
        minPrice: price,
        maxPrice: price,
        url: urlFull,
        deepLink: urlFull,
        provider: "doktortakip",
        providerType: "service",
        providerFamily: "doktortakip",
        vertical: "health",
        region,
        category: "health",
        categoryAI: "health_package",
        raw: { priceText, href },
      };

      items.push({
        ...base,
        qualityScore: computeQualityScoreHealth(base, "pricing"),
      });
    });

    if (items.length > 0) return items;
  } catch (e) {
    console.warn("DoktorTakip scrape hata:", e.message);
  }

  return [];
}

// ============================================================
// 3) Google Medical – S33 Hybrid
// ============================================================
export async function searchGoogleMedicalLegacy(query, opts = {}) {
  let region = opts.region || "TR";
  let signal = opts.signal || null;

  try {
    const q = encodeURIComponent(query + " sağlık paketi checkup");
    const url = `https://www.google.com/search?q=${q}`;

    const { data: html } = await axios.get(url, {
      timeout: TIMEOUT_MS,
      signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (FindAllEasy-S33)",
        Accept: "text/html",
      },
    });

    const $ = loadCheerioS200(html);
    const results = [];

    $("a").each((i, el) => {
      const href = safe($(el).attr("href"));
      const text = safe($(el).text());

      if (!isValidGoogleHref(href)) return;
      if (!text || text.length < 20) return;

      const base = {
        id: stableId("google_medical", text, href),
        title: text,
        provider: "google_medical",
        providerType: "aggregator",
        providerFamily: "google",
        vertical: "health",
        price: null,
        finalPrice: null,
        url: href,
        deepLink: href,
        region,
        category: "health",
        categoryAI: "health_info",
        raw: { href, text },
      };

      results.push({
        ...base,
        qualityScore: computeQualityScoreHealth(base, "generic"),
      });
    });

    if (results.length > 0) return results.slice(0, 20);
  } catch (err) {
    console.warn("Google Medical hata:", err.message);
  }

  return [
    {
      id: stableId("google_medical_fallback", query, "https://www.google.com"),
      title: `Google Medical sonuç bulunamadı: ${query}`,
      provider: "google_medical",
      providerType: "aggregator",
      providerFamily: "google",
      vertical: "health",
      price: null,
      finalPrice: null,
      url: "https://www.google.com",
      deepLink: "https://www.google.com",
      region,
      category: "health",
      categoryAI: "health_info",
      fallback: true,
      qualityScore: 0.1,
    },
  ];
}

// ============================================================
// 4) Health Tourism – S33 Hybrid
// ============================================================
export async function searchHealthTourismLegacy(query = "", opts = {}) {
  let region = opts.region || "TR";
  let signal = opts.signal || null;

  try {
    const q = encodeURIComponent(query + " sağlık turizmi özel klinik");
    const url = `https://www.google.com/search?q=${q}`;

    const { data: html } = await axios.get(url, {
      timeout: TIMEOUT_MS,
      signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (FindAllEasy-S33)",
        Accept: "text/html",
      },
    });

    const $ = loadCheerioS200(html);
    const results = [];

    $("a").each((i, el) => {
      const href = safe($(el).attr("href"));
      const text = safe($(el).text());

      if (!isValidGoogleHref(href)) return;
      if (!text || text.length < 20) return;

      const base = {
        id: stableId("health_tourism", text, href),
        title: text,
        provider: "health_tourism",
        providerType: "aggregator",
        providerFamily: "google",
        vertical: "health_tourism",
        url: href,
        deepLink: href,
        price: null,
        finalPrice: null,
        region,
        category: "health_tourism",
        categoryAI: "health_tourism",
        raw: { href, text },
      };

      results.push({
        ...base,
        qualityScore: computeQualityScoreHealth(base, "generic"),
      });
    });

    if (results.length > 0) return results.slice(0, 20);
  } catch (err) {
    console.warn("HealthTourism hata:", err.message);
  }

  return [
    {
      id: stableId("health_tourism_fallback", query, "https://www.google.com"),
      title: `Sağlık turizmi: sonuç bulunamadı (${query})`,
      provider: "health_tourism",
      providerType: "aggregator",
      providerFamily: "google",
      vertical: "health_tourism",
      price: null,
      finalPrice: null,
      url: "https://www.google.com",
      deepLink: "https://www.google.com",
      region,
      category: "health_tourism",
      categoryAI: "health_tourism",
      fallback: true,
      qualityScore: 0.1,
    },
  ];
}

// ============================================================
// 5) Insurance Health – Özel Sağlık Sigortası
// ============================================================
export async function searchInsuranceHealthLegacy(query = "", opts = {}) {
  let region = opts.region || "TR";
  let signal = opts.signal || null;

  try {
    const q = encodeURIComponent(
      query + " özel sağlık sigortası tamamlayıcı poliçe fiyat"
    );
    const url = `https://www.google.com/search?q=${q}`;

    const { data: html } = await axios.get(url, {
      timeout: TIMEOUT_MS,
      signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (FindAllEasy-S33)",
        Accept: "text/html",
      },
    });

    const $ = loadCheerioS200(html);
    const results = [];

    $("a").each((i, el) => {
      const href = safe($(el).attr("href"));
      const text = safe($(el).text());

      if (!isValidGoogleHref(href)) return;
      if (!text || text.length < 18) return;

      const t = text.toLowerCase();
      if (
        t.includes("sigorta") ||
        t.includes("sağlık") ||
        t.includes("poliçe") ||
        t.includes("tamamlayıcı")
      ) {
        const base = {
          id: stableId("insurance_health", text, href),
          title: text,
          provider: "insurance_health",
          providerType: "insurance",
          providerFamily: "insurance",
          vertical: "insurance",
          url: href,
          deepLink: href,
          region,
          category: "insurance",
          categoryAI: "insurance_health",
          price: null,
          finalPrice: null,
          raw: { href, text },
        };

        results.push({
          ...base,
          qualityScore: computeQualityScoreHealth(base, "generic"),
        });
      }
    });

    if (results.length > 0) return results.slice(0, 20);
  } catch (err) {
    console.warn("InsuranceHealth hata:", err.message);
  }

  return [
    {
      id: stableId("insurance_fallback", query, "https://www.google.com"),
      title: `Özel sağlık sigortası bulundu: ${query}`,
      provider: "insurance_health",
      providerType: "insurance",
      providerFamily: "insurance",
      vertical: "insurance",
      url: "https://www.google.com",
      deepLink: "https://www.google.com",
      region,
      category: "insurance",
      categoryAI: "insurance_health",
      price: null,
      finalPrice: null,
      fallback: true,
      qualityScore: 0.1,
    },
  ];
}

// ============================================================
// 6) Lab Tests – S33 Hybrid
// ============================================================
export async function searchLabTestsLegacy(query = "", opts = {}) {
  let region = opts.region || "TR";
  let signal = opts.signal || null;

  try {
    const q = encodeURIComponent(
      query + " laboratuvar test kan tahlili PCR fiyat"
    );
    const url = `https://www.google.com/search?q=${q}`;

    const { data: html } = await axios.get(url, {
      timeout: TIMEOUT_MS,
      signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (FindAllEasy-S33)",
        Accept: "text/html",
      },
    });

    const $ = loadCheerioS200(html);
    const results = [];

    $("a").each((i, el) => {
      const href = safe($(el).attr("href"));
      const text = safe($(el).text());

      if (!isValidGoogleHref(href)) return;
      if (!text || text.length < 15) return;

      const t = text.toLowerCase();
      if (
        t.includes("tahlil") ||
        t.includes("test") ||
        t.includes("laboratuvar") ||
        t.includes("kan") ||
        t.includes("pcr")
      ) {
        const base = {
          id: stableId("lab_tests", text, href),
          title: text,
          provider: "lab_tests",
          providerType: "lab",
          providerFamily: "lab",
          vertical: "health",
          price: null,
          finalPrice: null,
          url: href,
          deepLink: href,
          region,
          category: "lab",
          categoryAI: "lab_tests",
          raw: { href, text },
        };

        results.push({
          ...base,
          qualityScore: computeQualityScoreHealth(base, "generic"),
        });
      }
    });

    if (results.length > 0) return results.slice(0, 20);
  } catch (err) {
    console.warn("LabTests hata:", err.message);
  }

  return [
    {
      id: stableId("lab_tests_fallback", query, "https://www.google.com"),
      title: `Lab testi bulunamadı: ${query}`,
      provider: "lab_tests",
      providerType: "lab",
      providerFamily: "lab",
      vertical: "health",
      url: "https://www.google.com",
      deepLink: "https://www.google.com",
      region,
      category: "lab",
      categoryAI: "lab_tests",
      price: null,
      finalPrice: null,
      fallback: true,
      qualityScore: 0.1,
    },
  ];
}

// ============================================================
// 7) Health / Check-Up Paketleri (Fallback)
// ============================================================
export async function searchHealthFallbackLegacy(query, opts = {}) {
  let region = opts.region || "TR";

  const title = `Sağlık taraması: ${query}`;

  const base = {
    id: stableId("health_fallback", query, "https://www.doktorset.com"),
    title,
    provider: "health_fallback",
    providerType: "generic",
    providerFamily: "health_fallback",
    vertical: "health",
    price: null,
    finalPrice: null,
    category: "health",
    categoryAI: "health_info",
    url: "https://www.doktorset.com",
    deepLink: "https://www.doktorset.com",
    region,
  };

  return [
    {
      ...base,
      fallback: true,
      qualityScore: 0.1,
    },
  ];
}

// ============================================================
// 8) SGK Hastaneleri – S33 Hybrid
// ============================================================
export async function searchSGKHospitalsLegacy(query = "", opts = {}) {
  let region = opts.region || "TR";
  let signal = opts.signal || null;

  try {
    const q = encodeURIComponent(
      query + " SGK devlet hastanesi aile sağlığı merkezi sağlık ocağı"
    );
    const url = `https://www.google.com/search?q=${q}`;

    const { data: html } = await axios.get(url, {
      timeout: TIMEOUT_MS,
      signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (FindAllEasy-S33)",
        Accept: "text/html",
      },
    });

    const $ = loadCheerioS200(html);
    const results = [];

    $("a").each((i, el) => {
      const href = safe($(el).attr("href"));
      const text = safe($(el).text());

      if (!isValidGoogleHref(href)) return;
      if (!text || text.length < 10) return;

      const t = text.toLowerCase();

      if (
        t.includes("devlet") ||
        t.includes("hastane") ||
        t.includes("hastanesi") ||
        t.includes("aile sağlığı") ||
        t.includes("sağlık ocağı") ||
        t.includes("hastane randevu") ||
        t.includes("tıp merkezi")
      ) {
        const base = {
          id: stableId("sgk_hospitals", text, href),
          title: text,
          provider: "sgk_hospitals",
          providerType: "public_health",
          providerFamily: "sgk",
          vertical: "health",
          url: href,
          deepLink: href,
          region,
          category: "sgk",
          categoryAI: "sgk_health",
          price: null,
          finalPrice: null,
          raw: { href, text },
        };

        results.push({
          ...base,
          qualityScore: computeQualityScoreHealth(base, "generic"),
        });
      }
    });

    if (results.length > 0) return results.slice(0, 20);
  } catch (err) {
    console.warn("SGKHospitals hata:", err.message);
  }

  return [
    {
      id: stableId(
        "sgk_fallback",
        query,
        "https://www.turkiye.gov.tr/saglik-hizmetleri"
      ),
      title: `SGK hastaneleri bulunamadı: ${query}`,
      provider: "sgk_hospitals",
      providerType: "public_health",
      providerFamily: "sgk",
      vertical: "health",
      url: "https://www.turkiye.gov.tr/saglik-hizmetleri",
      deepLink: "https://www.turkiye.gov.tr/saglik-hizmetleri",
      region,
      category: "sgk",
      categoryAI: "sgk_health",
      price: null,
      finalPrice: null,
      fallback: true,
      qualityScore: 0.1,
    },
  ];
}

// ============================================================
// DEFAULT EXPORT — S33 FULL UYUMLU
// ============================================================

// ============================================================================
// S200 WRAPPERS — single output format (NO FAKE / OBSERVABLE FAIL)
// ============================================================================
async function _wrapHealthLegacy(fnName, fnLegacy, query, opts = {}, providerKey, source, discovery = false) {
  const region = String(opts?.region || "TR");
  const timeoutMs = Number(opts?.timeoutMs || process.env.S200_PROVIDER_TIMEOUT_MS || 6500);

  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = { adapter: fnName, providerKey, url: "" };

  try {
    const raw = await withTimeout(fnLegacy(query, opts), timeoutMs, providerKey + ".legacy");
    const hasFallback = Array.isArray(raw) && raw.some((x) => x && typeof x === "object" && (x.fallback === true || x.isFallback === true));
    if (hasFallback && !FINDALLEASY_ALLOW_STUBS) {
      return _mkRes(source, false, [], { code: "STUB_BLOCKED", region, timeoutMs });
    }
    const raw2 = discovery && Array.isArray(raw)
      ? raw.map((x) => (x && typeof x === "object" ? { ...x, price: null, finalPrice: null, optimizedPrice: null } : x))
      : raw;
    const items = _normalizeMany(raw2, providerKey, { providerFamily: providerKey, vertical: "health", category: "health", currency: "TRY", region });
    return _mkRes(source, true, items, { code: items.length ? "OK" : "OK_EMPTY", region, timeoutMs, discovery: !!discovery });
  } catch (err) {
    return _mkRes(source, false, [], { code: _isTimeout(err) ? "TIMEOUT" : "ERROR", error: _errStr(err), region, timeoutMs, discovery: !!discovery });
  } finally {
    globalThis.__S200_ADAPTER_CTX = prevCtx;
  }
}

export async function searchDoktorSet(query, opts = {}) {
  return await _wrapHealthLegacy("searchDoktorSet", searchDoktorSetLegacy, query, opts, "doktorset", "doktorset", false);
}
export async function searchDoktorTakip(query, opts = {}) {
  return await _wrapHealthLegacy("searchDoktorTakip", searchDoktorTakipLegacy, query, opts, "doktortakip", "doktortakip", false);
}
export async function searchGoogleMedical(query, opts = {}) {
  // discovery source: price=null forced, affiliate OFF
  return await _wrapHealthLegacy("searchGoogleMedical", searchGoogleMedicalLegacy, query, opts, "google_medical", "google_medical", true);
}
export async function searchHealthTourism(query = "", opts = {}) {
  return await _wrapHealthLegacy("searchHealthTourism", searchHealthTourismLegacy, query, opts, "health_tourism", "health_tourism", true);
}
export async function searchInsuranceHealth(query = "", opts = {}) {
  return await _wrapHealthLegacy("searchInsuranceHealth", searchInsuranceHealthLegacy, query, opts, "insurance_health", "insurance_health", true);
}
export async function searchLabTests(query = "", opts = {}) {
  return await _wrapHealthLegacy("searchLabTests", searchLabTestsLegacy, query, opts, "lab_tests", "lab_tests", true);
}
export async function searchSGKHospitals(query = "", opts = {}) {
  return await _wrapHealthLegacy("searchSGKHospitals", searchSGKHospitalsLegacy, query, opts, "sgk_hospitals", "sgk_hospitals", true);
}
export async function searchHealthFallback(query, opts = {}) {
  // PROD: fallback is basically a stub → block unless explicitly allowed
  if (!FINDALLEASY_ALLOW_STUBS) {
    const region = String(opts?.region || "TR");
    const timeoutMs = Number(opts?.timeoutMs || process.env.S200_PROVIDER_TIMEOUT_MS || 6500);
    return _mkRes("health_fallback", false, [], { code: "STUB_BLOCKED", region, timeoutMs });
  }
  return await _wrapHealthLegacy("searchHealthFallback", searchHealthFallbackLegacy, query, opts, "health_fallback", "health_fallback", true);
}


export default {
  searchDoktorSet,
  searchDoktorTakip,
  searchGoogleMedical,
  searchHealthTourism,
  searchInsuranceHealth,
  searchLabTests,
  searchSGKHospitals, // ZORUNLU
  searchHealthFallback,
};

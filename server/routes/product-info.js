// server/routes/product-info.js
// ======================================================================
//  PRODUCT INFO ENGINE — S22.8 HARDENED (MERCHANT-HUNT + CATALOG-VERIFY + GP OFFERS)
//  ZERO DELETE — Eski davranış korunur, sadece daha sağlam/akıllı hale gelir
//
//  Amaç:
//   - POST body (qr/code/data/text) + rawBody kurtarma (PowerShell/curl kaçışları)
//   - Barcode (8-18) için:
//        1) OpenFoodFacts (food)
//        2) Katalog siteleri (epey/cimri/akakce vb.) üzerinden GTIN doğrulama (HTML kanıt)
//        3) SerpAPI Google Shopping -> ürün kimliği + SerpAPI immersive -> merchant offer linkleri
//        4) Immersive boşsa SerpAPI google_product fallback (offers + GTIN kanıt)
//     ✅ verifiedBarcode: sadece "Google sayfası" değil, GTIN/spec güçlü kanıt ile true olur
//   - force=1 => mongo-cache bypass
//   - diag=1  => _diag adım adım debug
// ======================================================================

import express from "express";
import fetch from "node-fetch";
import rateLimit from "express-rate-limit";
import Product from "../models/Product.js";
import { searchWithSerpApi } from "../adapters/serpApi.js";
import { searchLocalBarcodeEngine } from "../core/localBarcodeEngine.js";
import { getHtml } from "../core/NetClient.js";

const router = express.Router();

// ======================================================================
// RATE LIMIT + micro-burst
// ======================================================================
const limiter = rateLimit({ windowMs: 5000, max: 40 });
router.use(limiter);

const burstMap = new Map();
function burst(ip, qr, ttl = 1500) {
  const key = ip + "::" + qr;
  const now = Date.now();
  const last = burstMap.get(key);
  if (last && now - last < ttl) return false;
  burstMap.set(key, now);
  // mini-prune (best effort)
  if (burstMap.size > 5000) {
    for (const [k, ts] of burstMap.entries()) {
      if (now - ts > 30_000) burstMap.delete(k);
    }
  }
  return true;
}

// ======================================================================
// Sanitization
// ======================================================================
function sanitizeQR(v) {
  if (v == null) return "";
  let s = String(v).trim();
  s = s.replace(/[\0<>]/g, "");
  if (/^(javascript|data|vbscript|file):/i.test(s)) return "";
  return s.length > 500 ? s.slice(0, 500) : s;
}

function safeStr(v, max = 250) {
  if (v == null) return "";
  let s = String(v).trim();
  s = s.replace(/[\0<>]/g, "");
  return s.slice(0, max);
}

function safeJson(res, body, code = 200) {
  try {
    res.status(code).json(body);
  } catch (err) {
    console.error("❌ safeJson ERROR:", err);
    try {
      res.status(500).json({ ok: false, error: "JSON_FAIL" });
    } catch {}
  }
}

function getClientIp(req) {
  return (
    req.headers["x-real-ip"] ||
    req.headers["x-forwarded-for"]?.split(",")[0] ||
    req.connection?.remoteAddress ||
    "unknown"
  );
}

// ======================================================================
// Body picker (robust) — req.body boşsa req.__rawBody'ye düş
//  - ayrıca PowerShell curl kaçışlarında gelen {\"qr\":\"...\"} gibi body'leri kurtarır
// ======================================================================
function _parseMaybeJson(raw) {
  if (!raw) return {};
  let s = String(raw).trim();
  if (!s) return {};

  // BOM temizle
  s = s.replace(/^\uFEFF/, "").trim();

  // bazen body "'{...}'" veya "\"{...}\"" gibi sarılı gelir
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
    const inner = s.slice(1, -1).trim();
    if (inner.startsWith("{") && inner.endsWith("}")) s = inner;
  }

  // 1) normal parse
  try {
    const j = JSON.parse(s);
    return j && typeof j === "object" ? j : {};
  } catch {}

  // 2) PowerShell/curl kaçışı: {\"qr\":\"...\"}
  if (s.includes('\\"')) {
    const s2 = s.replace(/\\"/g, '"');
    try {
      const j2 = JSON.parse(s2);
      return j2 && typeof j2 === "object" ? j2 : {};
    } catch {}
  }

  return {};
}

function pickBody(req) {
  const b = req?.body;

  // normal object body
  if (b && typeof b === "object" && !Buffer.isBuffer(b)) {
    if (Object.keys(b).length) return b;
  }

  // buffer/string body
  if (Buffer.isBuffer(b)) return _parseMaybeJson(b.toString("utf8"));
  if (typeof b === "string") return _parseMaybeJson(b);

  // rawBody fallback (server.js verify yakalamış olmalı)
  const rb = req?.__rawBody;
  if (Buffer.isBuffer(rb)) return _parseMaybeJson(rb.toString("utf8"));
  if (typeof rb === "string") return _parseMaybeJson(rb);

  return {};
}

// ======================================================================
// Locale
// ======================================================================
function pickLocale(req, body) {
  try {
    const raw = String(body?.locale || req?.query?.locale || "").trim().toLowerCase();
    if (!raw) return "tr";
    return raw.split("-")[0] || "tr";
  } catch {
    return "tr";
  }
}

function localePack(localeShort) {
  const l = String(localeShort || "tr").toLowerCase();
  if (l === "tr") return { hl: "tr", gl: "tr", region: "TR" };
  if (l === "fr") return { hl: "fr", gl: "fr", region: "TR" };
  if (l === "ru") return { hl: "ru", gl: "ru", region: "TR" };
  if (l === "ar") return { hl: "ar", gl: "sa", region: "TR" };
  return { hl: "en", gl: "us", region: "TR" };
}

function providerProductWord(localeShort) {
  const l = String(localeShort || "tr").toLowerCase();
  if (l === "en") return "product";
  if (l === "fr") return "produit";
  if (l === "ru") return "товар";
  if (l === "ar") return "منتج";
  return "ürünü";
}

// ======================================================================
// Provider detector + URL title
// ======================================================================
function detectProviderFromUrl(url) {
  const s = String(url).toLowerCase();
  if (s.includes("trendyol")) return "trendyol";
  if (s.includes("hepsiburada")) return "hepsiburada";
  if (s.includes("amazon.")) return "amazon";
  if (s.includes("n11.com")) return "n11";
  if (s.includes("ciceksepeti")) return "ciceksepeti";
  if (s.includes("aliexpress")) return "aliexpress";
  return "unknown";
}

function extractTitleFromUrl(url) {
  try {
    const cleanUrl = url.split("?")[0].split("&")[0];
    const parts = cleanUrl.split("/");
    for (const p of parts) {
      if (p.includes("-")) {
        const t = decodeURIComponent(p)
          .replace(/-/g, " ")
          .replace(/[^\w\sğüşöçıİĞÜŞÖÇ]/gi, "")
          .trim();
        if (t.length > 2) return t;
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ======================================================================
// In-memory cache (barcode)
// ======================================================================
const barcodeCache = new Map(); // key -> {ts, product}
const BARCODE_CACHE_MS = 7 * 24 * 60 * 60 * 1000;

function cacheGetBarcode(key) {
  const hit = barcodeCache.get(key);
  if (!hit) return null;
  const age = Date.now() - (hit.ts || 0);
  if (age > BARCODE_CACHE_MS) return null;
  return hit.product || null;
}

function cacheSetBarcode(key, product) {
  try {
    barcodeCache.set(key, { ts: Date.now(), product });
  } catch {}
}

function cleanTitle(t) {
  const s = safeStr(t, 240);
  if (!s) return "";
  return s.replace(/\s+[\|\-–]\s+.+$/, "").trim();
}

function isGoogleHostedUrl(url) {
  const s = String(url || "").toLowerCase();
  if (!s) return false;
  return (
    s.includes("://www.google.") ||
    s.includes("://google.") ||
    s.includes("://shopping.google.") ||
    s.includes("://www.google.com") ||
    s.includes("gstatic.") ||
    s.includes("googleusercontent.") ||
    s.includes("ggpht.com")
  );
}

function pickDomain(url) {
  try {
    const u = new URL(String(url || ""));
    return (u.hostname || "").toLowerCase();
  } catch {
    return "";
  }
}

// ======================================================================
// Google redirect unwrap (aclk/url) => gerçek merchant url
// ======================================================================
function unwrapGoogleRedirect(u) {
  try {
    const url = new URL(String(u || ""));
    const host = (url.hostname || "").toLowerCase();
    if (!host.includes("google.")) return "";

    const p = (url.pathname || "").toLowerCase();
    if (!(p.includes("/aclk") || p.includes("/url") || p.includes("/shopping") || p.includes("/pagead"))) {
      return "";
    }

    const keys = ["adurl", "url", "q", "u"];
    for (const k of keys) {
      const v = url.searchParams.get(k);
      if (!v) continue;
      let decoded = "";
      try {
        decoded = decodeURIComponent(v);
      } catch {
        decoded = v;
      }
      if (/^https?:\/\//i.test(decoded) && !isGoogleHostedUrl(decoded)) return decoded;
    }
    return "";
  } catch {
    return "";
  }
}

function normalizeOutboundUrl(u) {
  const s = safeStr(u, 2000);
  if (!s) return "";
  const unwrapped = unwrapGoogleRedirect(s);
  return unwrapped || s;
}

// ======================================================================
// Barcode evidence helpers (anti-wrong-product)
//  - Amaç: "alakasız ürün" döndürmemek. Emin değilsek NULL.
// ======================================================================
function hasBarcodeEvidenceInText(text, code) {
  try {
    if (!text || !code) return false;
    const t = String(text);
    if (t.includes(code)) return true;

    const re = new RegExp(
      String.raw`(?:gtin(?:13|14)?|ean(?:13)?|barcode|barkod|upc|product\s*id|product_id)\s*["'\s:=\-]{0,20}` +
        code,
      "i"
    );
    return re.test(t);
  } catch {
    return false;
  }
}

async function probeUrlForBarcode(url, code, diag) {
  const u0 = safeStr(url, 2000);
  if (!u0 || !/^https?:\/\//i.test(u0)) return false;

  const u = normalizeOutboundUrl(u0);
  if (!u || !/^https?:\/\//i.test(u)) return false;

  // Google hosted sayfalarda "evidence" üretmek çoğu zaman sahte güven.
  if (isGoogleHostedUrl(u)) return false;

  try {
    diag?.tries?.push?.({ step: "probe_url", url: safeStr(u, 500) });
    const r = await getHtml(u, { timeoutMs: 9000, maxBytes: 1_500_000, allow3xx: true });
    if (!r?.ok || !r?.html) {
      diag?.tries?.push?.({ step: "probe_url_fail", url: safeStr(u, 500), status: r?.status || null });
      return false;
    }
    const ok = hasBarcodeEvidenceInText(r.html, code);
    diag?.tries?.push?.({ step: ok ? "probe_url_ok" : "probe_url_no_evidence", url: safeStr(u, 500) });
    return ok;
  } catch (e) {
    diag?.tries?.push?.({ step: "probe_url_error", url: safeStr(u, 500), error: String(e?.message || e) });
    return false;
  }
}

// ======================================================================
// Timeout helper
// ======================================================================
function withTimeout(promise, timeoutMs, label = "timeout") {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(label), Math.max(100, timeoutMs || 10_000));
  return {
    signal: ctrl.signal,
    run: (async () => {
      try {
        return await promise(ctrl.signal);
      } finally {
        clearTimeout(id);
      }
    })(),
  };
}

function appendQuery(u, params) {
  try {
    const url = new URL(String(u));
    for (const [k, v] of Object.entries(params || {})) {
      if (v == null || v === "") continue;
      if (!url.searchParams.has(k)) url.searchParams.set(k, String(v));
    }
    return url.toString();
  } catch {
    return String(u || "");
  }
}

function parsePriceAny(v) {
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const s0 = String(v);
  if (!s0) return null;

  let s = s0.replace(/[^\d.,]/g, "");
  if (!s) return null;

  const hasDot = s.includes(".");
  const hasComma = s.includes(",");

  if (hasDot && hasComma) {
    s = s.replace(/\./g, "").replace(/,/g, ".");
  } else if (hasComma && !hasDot) {
    s = s.replace(/,/g, ".");
  }

  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function normalizeMerchant(m) {
  return safeStr(m, 80).toLowerCase().replace(/\s+/g, " ").trim();
}

function merchantRank(domainOrName) {
  const s = String(domainOrName || "").toLowerCase();
  if (s.includes("hepsiburada")) return 100;
  if (s.includes("trendyol")) return 95;
  if (s.includes("n11")) return 80;
  if (s.includes("amazon")) return 75;
  if (s.includes("ciceksepeti")) return 60;
  return 10;
}

function pickBestOffer(offers) {
  const arr = Array.isArray(offers) ? offers : [];
  return arr.length ? arr[0] : null;
}

// ======================================================================
// Evidence collection (strong GTIN paths)
// ======================================================================
function collectEvidenceCodes(obj) {
  const out = [];
  const seen = new Set();

  function walk(x, path, depth) {
    if (!x || depth > 10) return;
    if (Array.isArray(x)) {
      for (let i = 0; i < x.length; i++) walk(x[i], `${path}[${i}]`, depth + 1);
      return;
    }
    if (typeof x !== "object") return;

    for (const [k, v] of Object.entries(x)) {
      const key = String(k);
      const low = key.toLowerCase();
      const p = path ? `${path}.${key}` : key;

      if (low === "gtin" || low === "gtin13" || low === "gtin14" || low === "ean" || low === "ean13" || low === "upc") {
        const s = String(v || "").replace(/[^\d]/g, "");
        if (s && /^\d{8,18}$/.test(s)) {
          const uniq = `${s}|${p}`;
          if (!seen.has(uniq)) {
            seen.add(uniq);
            out.push({ code: s, path: p });
          }
        }
      } else {
        walk(v, p, depth + 1);
      }
    }
  }

  walk(obj, "", 0);
  return out;
}

function isStrongGtinPath(path) {
  const p = String(path || "").toLowerCase();

  // seller/offer/store altından gelen kodlar “kanıt” sayılmasın (çok kirli)
  if (p.includes("stores") || p.includes("sellers") || p.includes("offers")) return false;

  // product_results/specifications/details gibi "ürün gövdesi" alanlarını kabul
  if (p.startsWith("product_results.")) return true;
  if (p.includes(".product_results.")) return true;
  if (p.includes("spec") || p.includes("specification") || p.includes("details") || p.includes("attributes")) return true;

  return false;
}

// ======================================================================
// SerpAPI low-level JSON fetch (google_product fallback için)
// ======================================================================
function getSerpApiKey() {
  return (
    process.env.SERPAPI_KEY ||
    process.env.SERP_API_KEY ||
    process.env.SERPAPI ||
    process.env.SERPAPIKEY ||
    ""
  );
}

async function fetchSerpApiJson(params, diag, stepName = "serpapi_json") {
  const key = getSerpApiKey();
  if (!key) {
    diag?.tries?.push?.({ step: `${stepName}_no_key` });
    return null;
  }

  try {
    const base = "https://serpapi.com/search.json";
    const u = new URL(base);
    for (const [k, v] of Object.entries(params || {})) {
      if (v == null || v === "") continue;
      u.searchParams.set(k, String(v));
    }
    u.searchParams.set("api_key", key);

    diag?.tries?.push?.({
      step: `${stepName}_fetch`,
      engine: safeStr(params?.engine || "", 40),
      hasProductId: Boolean(params?.product_id),
    });

    const { run } = withTimeout(
      async (sig) => {
        const r = await fetch(u.toString(), { method: "GET", signal: sig });
        const txt = await r.text();
        if (!r.ok) throw new Error(`SERPAPI_HTTP_${r.status}`);
        try {
          return JSON.parse(txt);
        } catch {
          throw new Error("SERPAPI_JSON_FAIL");
        }
      },
      12_000,
      `${stepName}_timeout`
    );

    const j = await run;
    diag?.tries?.push?.({ step: `${stepName}_ok` });
    return j;
  } catch (e) {
    diag?.tries?.push?.({ step: `${stepName}_error`, error: String(e?.message || e) });
    return null;
  }
}

// ======================================================================
// Immersive offers extraction
// NOTE: Immersive response'da mağazalar genelde product_results.stores altında gelir.
// ======================================================================
function extractOffersFromImmersive(j) {
  const candidates =
    j?.product_results?.stores ||
    j?.product_results?.online_sellers ||
    j?.product_results?.sellers_results ||
    j?.stores ||
    j?.sellers_results ||
    j?.online_sellers ||
    j?.online_sellers_results ||
    j?.sellers ||
    j?.seller_results ||
    j?.offers ||
    [];

  const arr = Array.isArray(candidates) ? candidates : [];
  const out = [];

  for (const x of arr) {
    const merchant =
      safeStr(x?.name || x?.seller || x?.source || x?.merchant || x?.store_name || "", 120) || "";

    const link0 =
      safeStr(x?.link || x?.url || x?.merchant_link || x?.product_link || x?.store_link || "", 2000) || "";

    const link = normalizeOutboundUrl(link0);

    const price =
      parsePriceAny(x?.extracted_price) ??
      parsePriceAny(x?.price) ??
      parsePriceAny(x?.total_price) ??
      parsePriceAny(x?.price_value) ??
      parsePriceAny(x?.value);

    const delivery = safeStr(x?.delivery || x?.shipping || x?.shipping_cost || x?.shipping_price || "", 120) || "";

    if (!link || isGoogleHostedUrl(link)) continue;

    out.push({
      merchant,
      merchantKey: normalizeMerchant(merchant) || pickDomain(link),
      url: link,
      price: price ?? null,
      delivery,
      domain: pickDomain(link),
      rank: merchantRank(link || merchant),
    });
  }

  out.sort((a, b) => {
    const ap = a.price != null ? a.price : Number.POSITIVE_INFINITY;
    const bp = b.price != null ? b.price : Number.POSITIVE_INFINITY;
    if (ap !== bp) return ap - bp;
    return (b.rank || 0) - (a.rank || 0);
  });

  return out;
}

async function fetchImmersiveOffers(raw, code, diag) {
  const apiUrl = raw?.serpapi_immersive_product_api || raw?.serpapi_product_api || "";
  if (!apiUrl) return { offers: [], gtinMatch: false, gtinsFound: 0 };

  const key = getSerpApiKey();
  if (!key) {
    diag?.tries?.push?.({ step: "immersive_no_key" });
    return { offers: [], gtinMatch: false, gtinsFound: 0 };
  }

  const finalUrl = appendQuery(apiUrl, { api_key: key });

  try {
    diag?.tries?.push?.({ step: "immersive_fetch", url: safeStr(finalUrl, 220) });

    const { run } = withTimeout(
      async (sig) => {
        const r = await fetch(finalUrl, { method: "GET", signal: sig });
        const txt = await r.text();
        if (!r.ok) throw new Error(`IMMERSIVE_HTTP_${r.status}`);
        try {
          return JSON.parse(txt);
        } catch {
          throw new Error("IMMERSIVE_JSON_FAIL");
        }
      },
      12_000,
      "IMMERSIVE_TIMEOUT"
    );

    const j = await run;

    const offers = extractOffersFromImmersive(j);

    // Strong GTIN match
    const ev = collectEvidenceCodes(j);
    const strong = ev.filter((x) => isStrongGtinPath(x.path)).map((x) => x.code);
    const strongSet = new Set(strong);
    const gtinMatch = strongSet.has(String(code || "").trim());
    const gtinsFound = strongSet.size;

    diag?.tries?.push?.({
      step: "immersive_ok",
      offers: offers.length,
      gtinMatch,
      gtinsFound: Math.min(gtinsFound, 5),
    });

    return { offers, gtinMatch, gtinsFound };
  } catch (e) {
    diag?.tries?.push?.({ step: "immersive_error", error: String(e?.message || e) });
    return { offers: [], gtinMatch: false, gtinsFound: 0 };
  }
}

// ======================================================================
// Google Product offers extraction (fallback)
// ======================================================================
function extractOffersFromGoogleProduct(gp) {
  const candidates =
    gp?.product_results?.stores ||
    gp?.product_results?.online_sellers ||
    gp?.product_results?.sellers_results ||
    gp?.stores ||
    gp?.online_sellers ||
    gp?.sellers_results ||
    gp?.offers ||
    [];

  const arr = Array.isArray(candidates) ? candidates : [];
  const out = [];

  for (const x of arr) {
    const merchant =
      safeStr(x?.name || x?.seller || x?.source || x?.merchant || x?.store_name || "", 120) || "";

    const link0 =
      safeStr(x?.link || x?.url || x?.merchant_link || x?.product_link || x?.store_link || "", 2000) || "";

    const link = normalizeOutboundUrl(link0);

    const price =
      parsePriceAny(x?.extracted_price) ??
      parsePriceAny(x?.price) ??
      parsePriceAny(x?.total_price) ??
      parsePriceAny(x?.price_value) ??
      parsePriceAny(x?.value);

    const delivery = safeStr(x?.delivery || x?.shipping || x?.shipping_cost || x?.shipping_price || "", 120) || "";

    if (!link || isGoogleHostedUrl(link)) continue;

    out.push({
      merchant,
      merchantKey: normalizeMerchant(merchant) || pickDomain(link),
      url: link,
      price: price ?? null,
      delivery,
      domain: pickDomain(link),
      rank: merchantRank(link || merchant),
    });
  }

  out.sort((a, b) => {
    const ap = a.price != null ? a.price : Number.POSITIVE_INFINITY;
    const bp = b.price != null ? b.price : Number.POSITIVE_INFINITY;
    if (ap !== bp) return ap - bp;
    return (b.rank || 0) - (a.rank || 0);
  });

  return out;
}

async function fetchGoogleProduct(barcode, picked, localeShort, diag) {
  const productId = picked?.raw?.product_id || picked?.raw?.productId || picked?.raw?.raw?.product_id || "";
  if (!productId) {
    diag?.tries?.push?.({ step: "google_product_skip_no_product_id" });
    return { offers: [], bestOffer: null, merchantUrl: "", verifiedBarcode: false, verifiedBy: "", confidence: "medium" };
  }

  const { hl, gl } = localePack(localeShort);

  // IMPORTANT: google_product engine param set'ini minimal tut (aksi halde 400 yiyebiliyor)
  const gp = await fetchSerpApiJson(
    { engine: "google_product", product_id: productId, hl, gl },
    diag,
    "google_product"
  );

  if (!gp) {
    diag?.tries?.push?.({ step: "google_product_null" });
    return { offers: [], bestOffer: null, merchantUrl: "", verifiedBarcode: false, verifiedBy: "", confidence: "medium" };
  }

  const offers = extractOffersFromGoogleProduct(gp);
  const bestOffer = pickBestOffer(offers);
  const merchantUrl = bestOffer?.url || "";

  // Strong GTIN evidence
  const ev = collectEvidenceCodes(gp);
  const strong = ev.filter((x) => isStrongGtinPath(x.path)).map((x) => x.code);
  const strongSet = new Set(strong);

  const gtinMatch = strongSet.has(String(barcode || "").trim());
  const gtinsFound = strongSet.size;

  diag?.tries?.push?.({ step: "google_product_ok", offers: offers.length, gtinMatch, gtinsFound: Math.min(gtinsFound, 5) });

  let verifiedBarcode = false;
  let verifiedBy = "";
  let confidence = offers.length ? "medium" : "low";

  if (gtinMatch) {
    verifiedBarcode = true;
    verifiedBy = "serpapi:google_product";
    confidence = "high";
  }

  return { offers, bestOffer, merchantUrl, verifiedBarcode, verifiedBy, confidence };
}

// ======================================================================
// Catalog verification (TR) — epey/cimri/akakce vb.
// ======================================================================
function isCatalogDomain(host) {
  const h = String(host || "").toLowerCase();
  return (
    h.includes("epey.com") ||
    h.includes("cimri.com") ||
    h.includes("akakce.com") ||
    h.includes("upcindex.com") ||
    h.includes("barcodelookup.com") ||
    h.includes("opengtindb.org") ||
    h.includes("gtincheck.org") ||
    h.includes("ean-search.org")
  );
}

async function resolveBarcodeViaCatalogSites(barcode, localeShort = "tr", diag) {
  const code = String(barcode || "").trim();
  if (!/^\d{8,18}$/.test(code)) return null;

  const cacheKey = `${localeShort}:catalog:${code}`;
  const cached = cacheGetBarcode(cacheKey);
  if (cached) return cached;

  const { hl, gl, region } = localePack(localeShort);

  const queries = [
    `site:epey.com ${code} barkod`,
    `site:cimri.com ${code}`,
    `site:akakce.com ${code}`,
    `site:upcindex.com ${code}`,
    `site:barcodelookup.com ${code}`,
  ];

  for (const q of queries) {
    try {
      diag?.tries?.push?.({ step: "catalog_search", q });

      const r = await searchWithSerpApi(q, {
        mode: "google",
        region,
        hl,
        gl,
        num: 10,
        timeoutMs: 12000,
        includeRaw: true,
        barcode: true,
        intent: { type: "barcode" },
      });

      const items = Array.isArray(r?.items) ? r.items : [];
      if (!items.length) {
        diag?.tries?.push?.({ step: "catalog_empty", q });
        continue;
      }

      for (const it of items.slice(0, 5)) {
        const title = cleanTitle(it?.title || "");
        const url0 = safeStr(it?.url || it?.deeplink || it?.originUrl || it?.finalUrl || "", 2000);
        const url = normalizeOutboundUrl(url0);
        if (!url) continue;

        const host = pickDomain(url);
        if (!isCatalogDomain(host)) continue;

        const ok = await probeUrlForBarcode(url, code, diag);
        if (!ok) continue;

        const raw = it?.raw || {};
        const desc = safeStr(raw?.snippet || raw?.description || raw?.summary || "", 260) || "";
        const img = safeStr(it?.image || raw?.thumbnail || raw?.image || "", 2000) || "";

        const product = {
          name: title || code,
          title: title || code,
          description: desc,
          image: img,
          brand: safeStr(raw?.brand || raw?.brands || "", 120),
          category: "product",
          region,
          qrCode: code,
          provider: "barcode",
          source: `catalog:${host || "unknown"}`,
          verifiedBarcode: true,
          verifiedBy: host || "catalog",
          verifiedUrl: url,
          offers: [],
          bestOffer: null,
          merchantUrl: url,
          confidence: "high",
          raw: it,
        };

        cacheSetBarcode(cacheKey, product);
        diag?.tries?.push?.({ step: "catalog_pick", q, host, url: safeStr(url, 160) });
        return product;
      }
    } catch (e) {
      diag?.tries?.push?.({ step: "catalog_error", q, error: String(e?.message || e) });
    }
  }

  return null;
}

// ======================================================================
// Local marketplaces resolver (TR) — eskisi korunur
// ======================================================================
async function resolveBarcodeViaLocalMarketplaces(barcode, localeShort = "tr", diag) {
  const code = String(barcode || "").trim();
  if (!/^\d{8,18}$/.test(code)) return null;

  const cacheKey = `${localeShort}:local:${code}`;
  const cached = cacheGetBarcode(cacheKey);
  if (cached) return cached;

  diag?.tries?.push?.({ step: "local_marketplaces_start", barcode: code });

  let hits = [];
  try {
    hits = await searchLocalBarcodeEngine(code, {
      region: "TR",
      maxCandidates: 6,
      maxMatches: 1,
    });
  } catch (e) {
    diag?.tries?.push?.({ step: "local_marketplaces_error", error: String(e?.message || e) });
    hits = [];
  }

  if (Array.isArray(hits) && hits.length > 0) {
    const h = hits[0] || {};
    const name = cleanTitle(h?.title || h?.name || "") || code;
    const url0 = safeStr(h?.url || h?.link || "", 2000) || "";
    const url = normalizeOutboundUrl(url0);

    const product = {
      name,
      title: name,
      description: "",
      image: safeStr(h?.image || "", 2000) || "",
      brand: "",
      category: "product",
      region: "TR",
      qrCode: code,
      provider: "barcode",
      source: "local-marketplace-engine",
      verifiedBarcode: true,
      verifiedBy: pickDomain(url) || "local",
      verifiedUrl: url || "",
      offers: url ? [{ merchant: pickDomain(url) || "local", merchantKey: pickDomain(url), url, price: null, delivery: "", domain: pickDomain(url), rank: merchantRank(url) }] : [],
      bestOffer: url ? { merchant: pickDomain(url) || "local", url, price: null, delivery: "" } : null,
      merchantUrl: url || "",
      confidence: "high",
      raw: h,
    };

    cacheSetBarcode(cacheKey, product);
    diag?.tries?.push?.({ step: "local_marketplaces_pick", url: url ? safeStr(url, 160) : null });
    return product;
  }

  diag?.tries?.push?.({ step: "local_marketplaces_empty" });
  return null;
}

// ======================================================================
// Catalog snippet verify fallback (STRICT MODE)
//  - Snippet tek başına “verified” yapmaz. Sadece URL bulup probe ile kanıt arar.
// ======================================================================
async function verifyViaCatalogSnippet(barcode, diag, titleHint = "") {
  const code = String(barcode || "").trim();
  if (!/^\d{8,18}$/.test(code)) return null;

  const baseQueries = [
    `site:epey.com "${code}"`,
    `site:cimri.com "${code}"`,
    `site:akakce.com "${code}"`,
  ];

  const title = safeStr(titleHint, 120);
  const queries = title ? [...baseQueries, ...baseQueries.map((q) => `${q} "${title}"`)] : baseQueries;

  for (const q of queries) {
    try {
      diag?.tries?.push?.({ step: "catalog_snippet_search", q });

      const r = await searchWithSerpApi(q, {
        mode: "google",
        region: "TR",
        hl: "tr",
        gl: "tr",
        num: 10,
        timeoutMs: 12000,
        includeRaw: true,
        barcode: true,
        intent: { type: "barcode" },
      });

      const items = Array.isArray(r?.items) ? r.items : [];
      if (!items.length) {
        diag?.tries?.push?.({ step: "catalog_snippet_empty", q });
        continue;
      }

      for (const it of items.slice(0, 6)) {
        const url0 = safeStr(it?.url || it?.deeplink || it?.originUrl || it?.finalUrl || "", 2000);
        const url = normalizeOutboundUrl(url0);
        if (!url) continue;

        const host = pickDomain(url);
        if (!isCatalogDomain(host)) continue;

        const raw = it?.raw || {};
        const text = `${it?.title || ""}\n${raw?.snippet || raw?.description || raw?.summary || ""}`;
        if (!hasBarcodeEvidenceInText(text, code)) continue;

        // STRICT: HTML'de kanıt arıyoruz.
        const ok = await probeUrlForBarcode(url, code, diag);
        if (!ok) continue;

        diag?.tries?.push?.({ step: "catalog_snippet_verified", host, url: safeStr(url, 160) });
        return { verifiedBy: host, url };
      }
    } catch (e) {
      diag?.tries?.push?.({ step: "catalog_snippet_error", q, error: String(e?.message || e) });
    }
  }

  return null;
}

// ======================================================================
// SerpAPI Shopping resolver (barcode -> product identity + offers)
// ======================================================================
async function resolveBarcodeViaSerpShopping(barcode, localeShort = "tr", diag) {
  const code = String(barcode || "").trim();
  if (!/^\d{8,18}$/.test(code)) return null;

  const cacheKey = `${localeShort}:shopping:${code}`;
  const cached = cacheGetBarcode(cacheKey);
  if (cached) return cached;

  const { hl, gl, region } = localePack(localeShort);

  const queries = [`"${code}" barkod`, `gtin ${code}`, `ean ${code}`, `${code}`];

  for (const q of queries) {
    try {
      diag?.tries?.push?.({ step: "shopping_serpapi", q });

      const r = await searchWithSerpApi(q, {
        mode: "google_shopping",
        region,
        hl,
        gl,
        num: 10,
        timeoutMs: 12000,
        includeRaw: true,
        barcode: true,
        intent: { type: "barcode" },
      });

      const items = Array.isArray(r?.items) ? r.items : [];
      if (!items.length) {
        diag?.tries?.push?.({ step: "shopping_empty", q });
        continue;
      }

      const scored = [];
      for (const it of items) {
        const title = cleanTitle(it?.title || "");
        if (!title || title.length < 6) continue;

        const raw = it?.raw || {};
        const url0 = safeStr(it?.url || it?.deeplink || raw?.link || raw?.product_link || raw?.product_url || "", 2000);
        const url = normalizeOutboundUrl(url0);

        const snippet = safeStr(raw?.snippet || raw?.description || raw?.summary || raw?.product_description || "", 600);

        let score = 0;
        if (hasBarcodeEvidenceInText(title, code)) score += 4;
        if (hasBarcodeEvidenceInText(snippet, code)) score += 4;
        if (url && url.includes(code)) score += 6;
        if (url && !isGoogleHostedUrl(url)) score += 3;

        const tl = title.toLowerCase();
        if (tl.includes("arama sonuç") || tl.includes("search results")) score -= 5;

        scored.push({ it, title, url, score });
      }

      if (!scored.length) continue;
      scored.sort((a, b) => b.score - a.score);

      for (const cand of scored.slice(0, 2)) {
        const picked = cand.it;
        const raw = picked?.raw || {};

        // DEFAULTS (NEW)
        let offers = [];
        let bestOffer = null;
        let merchantUrl = "";
        let verifiedBarcode = false;
        let verifiedBy = "";
        let confidence = "medium";

        // 1) Immersive offers + strong GTIN evidence
        const imm = await fetchImmersiveOffers(raw, code, diag);
        offers = imm?.offers || [];
        bestOffer = pickBestOffer(offers);
        merchantUrl = bestOffer?.url || "";

        if (imm?.gtinMatch) {
          verifiedBarcode = true;
          verifiedBy = "serpapi:google_immersive_product";
          confidence = "high";
        } else {
          // GTIN yoksa: offers varsa medium, yoksa low'a yakın
          confidence = offers.length ? "medium" : "low";
        }

        // 2) Google Product fallback: (a) offers boşsa, (b) verified yoksa GTIN aramak için
        if (!offers.length || (!verifiedBarcode && raw?.raw?.product_id)) {
          const gp = await fetchGoogleProduct(code, picked, localeShort, diag);
          if (gp?.offers?.length && !offers.length) {
            offers = gp.offers;
            bestOffer = gp.bestOffer;
            if (!merchantUrl) merchantUrl = gp.merchantUrl || "";
          }
          if (!verifiedBarcode && gp?.verifiedBarcode) {
            verifiedBarcode = true;
            verifiedBy = gp.verifiedBy || "serpapi:google_product";
            confidence = "high";
          }
        }

        // 3) MerchantUrl fallback: cand.url (ama google ise unwrap dene)
        if (!merchantUrl) {
          const u = normalizeOutboundUrl(cand.url || "");
          if (u && !isGoogleHostedUrl(u)) merchantUrl = u;
        }

        // 4) STRICT catalog snippet verify fallback (HTML probe ile)
        if (!verifiedBarcode) {
          const v = await verifyViaCatalogSnippet(code, diag, picked?.title || raw?.title || "");
          if (v) {
            verifiedBarcode = true;
            verifiedBy = v.verifiedBy || "catalog";
            confidence = "high";
            if (!merchantUrl && v.url) merchantUrl = v.url;
          }
        }

        // Kabul: GTIN verified ise süper. Verified değilse bile ürün objesi + en az bir sinyal varsa vitrin için döndür.
        const hasIdSignal = Boolean(
          raw?.product_id ||
            raw?.productId ||
            raw?.catalogid ||
            raw?.catalog_id ||
            raw?.gpcid ||
            raw?.gpc_id ||
            raw?.product_link ||
            raw?.product_url ||
            raw?.raw?.product_id
        );
        const hasMerchantSignal = Boolean(raw?.source || raw?.seller || raw?.merchant || (offers && offers.length));

        const accept = verifiedBarcode || (hasIdSignal && hasMerchantSignal) || Boolean(picked?.title);

        if (!accept) {
          diag?.tries?.push?.({ step: "shopping_reject_no_signal", q, title: cand.title, score: cand.score });
          continue;
        }

        const product = {
          name: cand.title,
          title: cand.title,
          description: safeStr(raw?.snippet || raw?.description || raw?.summary || "", 260) || "",
          image: safeStr(picked?.image || raw?.thumbnail || raw?.image || "", 2000) || "",
          brand: safeStr(raw?.brand || raw?.brands || "", 120),
          category: "product",
          region,
          qrCode: code,
          provider: "barcode",
          source: "serpapi-shopping",
          offers: offers?.slice?.(0, 12) || [],
          bestOffer: bestOffer
            ? {
                merchant: bestOffer.merchant,
                url: bestOffer.url,
                price: bestOffer.price ?? null,
                delivery: bestOffer.delivery || "",
              }
            : null,
          merchantUrl: merchantUrl || "",
          verifiedBarcode: Boolean(verifiedBarcode),
          verifiedBy: verifiedBy || "",
          confidence: confidence || "medium",
          raw: picked,
        };

        cacheSetBarcode(cacheKey, product);

        diag?.tries?.push?.({
          step: "shopping_pick",
          q,
          verifiedBarcode: Boolean(verifiedBarcode),
          verifiedBy: verifiedBy || "",
          offers: product.offers.length,
          merchantUrl: product.merchantUrl ? safeStr(product.merchantUrl, 120) : null,
          confidence: product.confidence,
        });

        return product;
      }
    } catch (e) {
      diag?.tries?.push?.({ step: "shopping_error", q, error: String(e?.message || e) });
    }
  }

  return null;
}

// ======================================================================
// OpenFoodFacts (food products)
// ======================================================================
async function fetchOpenFoodFacts(code, diag) {
  const barcode = String(code || "").trim();
  if (!/^\d{8,18}$/.test(barcode)) return null;

  const url = `https://world.openfoodfacts.org/api/v0/product/${barcode}.json`;
  try {
    diag?.tries?.push?.({ step: "openfoodfacts_fetch", url });

    const r = await fetch(url, { method: "GET", headers: { "user-agent": "findalleasy/1.0" } });
    if (!r.ok) {
      diag?.tries?.push?.({ step: "openfoodfacts_http_fail", status: r.status });
      return null;
    }
    const j = await r.json().catch(() => null);
    if (!j || j.status !== 1 || !j.product) {
      diag?.tries?.push?.({ step: "openfoodfacts_no_product", status: j?.status ?? 0 });
      return null;
    }

    const p = j.product || {};
    const name = cleanTitle(p.product_name || p.product_name_tr || p.generic_name || "") || barcode;

    const product = {
      name,
      title: name,
      description: safeStr(p.ingredients_text || p.ingredients_text_tr || "", 260) || "",
      image: safeStr(p.image_url || p.image_front_url || "", 2000) || "",
      brand: safeStr(p.brands || "", 120),
      category: "product",
      region: "TR",
      qrCode: barcode,
      provider: "barcode",
      source: "openfoodfacts",
      verifiedBarcode: true,
      verifiedBy: "openfoodfacts",
      offers: [],
      bestOffer: null,
      merchantUrl: "",
      confidence: "high",
      raw: j,
    };

    return product;
  } catch (e) {
    diag?.tries?.push?.({ step: "openfoodfacts_error", error: String(e?.message || e) });
    return null;
  }
}

// ======================================================================
// Negative cache — sadece "çok kısa / anlamsız" inputlar için
// ======================================================================
const badCache = new Map();
function isBadQR(qr) {
  const ts = badCache.get(qr);
  return ts && Date.now() - ts < 30 * 60 * 1000;
}
function markBad(qr) {
  badCache.set(qr, Date.now());
}

// ======================================================================
// MAIN HANDLER
// ======================================================================
async function handleProduct(req, res) {
  try {
    const body = pickBody(req);

    const force = String(req.query?.force || body?.force || "0") === "1";
    const diagOn = String(req.query?.diag || body?.diag || "0") === "1";

    const raw =
      body?.qr ??
      body?.code ??
      body?.data ??
      body?.text ??
      req.query?.qr ??
      req.query?.code;

    let qr = sanitizeQR(raw);
    const localeShort = pickLocale(req, body);

    const diag = diagOn
      ? {
          force,
          locale: localeShort,
          parseError: req.__jsonParseError ? true : false,
          tries: [],
        }
      : null;

    try {
      res.setHeader("x-product-info-ver", "S22.8");
      res.setHeader("x-json-parse-error", req.__jsonParseError ? "1" : "0");
    } catch {}

    if (!qr) return safeJson(res, { ok: false, error: "Geçersiz QR" }, 400);

    const ip = getClientIp(req);

    if (!burst(ip, qr)) {
      const out = { ok: true, cached: true, product: null, source: "burst-limit" };
      if (diag) out._diag = diag;
      return safeJson(res, out);
    }

    // only for suspicious tiny text
    if (qr.length < 3 && isBadQR(qr)) {
      const out = { ok: false, error: "QR bulunamadı", cached: true };
      if (diag) out._diag = diag;
      return safeJson(res, out);
    }

    // 1) Mongo cache (force=1 ise atla)
    if (!force) {
      try {
        diag?.tries?.push?.({ step: "mongo_cache_lookup" });
        const cached = await Product.findOne({ qrCode: qr }).lean();
        if (cached) {
          const out = { ok: true, product: cached, source: "mongo-cache" };
          if (diag) out._diag = diag;
          return safeJson(res, out);
        }
      } catch (e) {
        diag?.tries?.push?.({ step: "mongo_cache_error", error: String(e?.message || e) });
      }
    } else {
      diag?.tries?.push?.({ step: "mongo_cache_skipped_force" });
    }

    // 2) Barcode (8-18)
    if (/^\d{8,18}$/.test(qr)) {
      // 2.1) OpenFoodFacts (food)
      const off = await fetchOpenFoodFacts(qr, diag);
      if (off) {
        try {
          await Product.create(off);
        } catch {}
        const out = { ok: true, product: off, source: "openfoodfacts" };
        if (diag) out._diag = diag;
        return safeJson(res, out);
      }

      // 2.2) Catalog verification (epey/cimri/akakce)
      const catalog = await resolveBarcodeViaCatalogSites(qr, localeShort, diag);
      if (catalog?.name) {
        try {
          await Product.create(catalog);
        } catch {}
        const out = { ok: true, product: catalog, source: "catalog-verified" };
        if (diag) out._diag = diag;
        return safeJson(res, out);
      }

      // 2.3) Local marketplaces engine (strict evidence)
      const local = await resolveBarcodeViaLocalMarketplaces(qr, localeShort, diag);
      if (local?.name) {
        try {
          await Product.create(local);
        } catch {}
        const out = { ok: true, product: local, source: "local-marketplace-verified" };
        if (diag) out._diag = diag;
        return safeJson(res, out);
      }

      // 2.4) Google Shopping + immersive offers (+ google_product fallback)
      const shopping = await resolveBarcodeViaSerpShopping(qr, localeShort, diag);
      if (shopping?.name) {
        try {
          await Product.create(shopping);
        } catch {}
        const out = { ok: true, product: shopping, source: "serpapi-shopping" };
        if (diag) out._diag = diag;
        return safeJson(res, out);
      }

      // Barcode çözülemedi: fallback dön
      const product = {
        name: qr,
        title: qr,
        qrCode: qr,
        provider: "barcode",
        source: "barcode-unresolved",
        verifiedBarcode: false,
        verifiedBy: "",
        offers: [],
        bestOffer: null,
        merchantUrl: "",
        confidence: "low",
      };
      const out = { ok: true, product, source: "barcode-unresolved" };
      if (diag) out._diag = diag;
      return safeJson(res, out);
    }

    // 3) URL
    if (qr.startsWith("http")) {
      const provider = detectProviderFromUrl(qr);
      const title = extractTitleFromUrl(qr) || `${provider} ${providerProductWord(localeShort)}`;

      const product = {
        name: safeStr(title, 200),
        title: safeStr(title, 200),
        provider,
        qrCode: qr,
        source: "url",
        verifiedBarcode: false,
        verifiedBy: "",
        offers: [],
        bestOffer: null,
        merchantUrl: normalizeOutboundUrl(qr) || "",
        confidence: "medium",
      };

      try {
        await Product.create(product);
      } catch {}

      const out = { ok: true, product, source: `${provider}-link` };
      if (diag) out._diag = diag;
      return safeJson(res, out);
    }

    // 4) RAW TEXT
    if (qr.length < 3) {
      markBad(qr);
      const out = { ok: false, error: "Geçersiz içerik" };
      if (diag) out._diag = diag;
      return safeJson(res, out);
    }

    const product = {
      name: qr,
      title: qr,
      qrCode: qr,
      provider: "text",
      source: "text",
      verifiedBarcode: false,
      verifiedBy: "",
      offers: [],
      bestOffer: null,
      merchantUrl: "",
      confidence: "medium",
    };

    try {
      await Product.create(product);
    } catch {}

    const out = { ok: true, product, source: "raw-text" };
    if (diag) out._diag = diag;
    return safeJson(res, out);
  } catch (err) {
    console.error("🚨 product-info ERROR:", err);
    return safeJson(res, { ok: false, error: "SERVER_ERROR" }, 500);
  }
}

// ======================================================================
// ROUTES (legacy destek)
// ======================================================================
router.post("/product", handleProduct);
router.post("/product-info", handleProduct);
router.get("/product", handleProduct);
router.get("/product-info", handleProduct);

export default router;

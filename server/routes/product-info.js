// server/routes/product-info.js
// ======================================================================
//  PRODUCT INFO ENGINE — S22 GOD-KERNEL FINAL FORM (HARDENED)
//  ZERO DELETE — Eski davranış korunur, sadece daha sağlam input kabulü
//
//  S22.3 Patch:
//   - Google domainleri (google.com/oshop vb) barcode "kanıtı" olarak KESİN yasak
//   - SerpAPI barcode -> title discovery sonrası merchant URL avı (HB/TY/N11/AmazonTR)
//   - Merchant sayfasında barcode kanıtı (html/json-ld) doğrulanırsa verifiedBarcode:true
//   - Aksi halde low-confidence fallback (verifiedBarcode:false) korunur
//
//  Fix:
//   - Body'den qr/code/data/text kabul et
//   - JSON parse fail olursa req.__rawBody üstünden tekrar parse et
//   - curl.exe + PowerShell kaçış hatalarında gelen {\"qr\":...} gibi body'leri kurtar
//   - Barcode regex 8-18 (GTIN/EAN/UPC/SSCC)
//   - sanitizeQR: javascript:/data:/vbscript:/file: gibi şüpheli şemaları kes
//   - force=1 => mongo-cache'i bypass et (fresh resolve)
//   - diag=1 => _diag ile adım adım debug dön
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
  if (!v) return "";
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
// Barcode cache + helpers
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

function uniq(arr) {
  const out = [];
  const seen = new Set();
  for (const x of arr || []) {
    const s = String(x || "").trim();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
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

    // key-based evidence (html içinde barcode geçmeyebilir, ama JSON-LD/structured data keyleri geçer)
    const re = new RegExp(
      String.raw`(?:gtin(?:13|14)?|ean(?:13)?|barcode|barkod|upc|product\s*id|product_id)\s*["'\s:=\-]{0,20}` + code,
      "i"
    );
    return re.test(t);
  } catch {
    return false;
  }
}

// ======================================================================
// Evidence URL filtering (S22.3)
//  - Google/aggregator sayfaları barkod "kanıtı" sayılmaz.
// ======================================================================
function normalizeHostFromUrl(u) {
  try {
    const host = new URL(u).hostname || "";
    return host.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function isDisallowedEvidenceUrl(u) {
  const url = String(u || "");
  if (!/^https?:\/\//i.test(url)) return true;

  const host = normalizeHostFromUrl(url);
  if (!host) return true;

  // Google ekosistemi: asla kanıt değil (ibp=oshop dahil)
  if (
    host === "google.com" ||
    host.endsWith(".google.com") ||
    host.endsWith("googleusercontent.com") ||
    host.endsWith("gstatic.com") ||
    host === "webcache.googleusercontent.com"
  ) {
    return true;
  }

  // SerpApi domaini de kanıt değil
  if (host === "serpapi.com" || host.endsWith(".serpapi.com")) return true;

  // Extra guard: google shopping search URL pattern
  if (/\/\/(www\.)?google\.[^/]+\/search\?/i.test(url) && /ibp=oshop/i.test(url)) return true;

  return false;
}

function extractCandidateUrlsFromSerpItem(it) {
  const raw = it?.raw || {};
  const candidates = [
    it?.affiliateUrl,
    it?.finalUrl,
    it?.originUrl,

    // bazen item seviyesinde url/deeplink olur ama google oshop olabilir
    it?.url,
    it?.deeplink,

    // serpapi raw varyasyonları
    raw?.link,
    raw?.product_link,
    raw?.offers_link,
    raw?.shopping_results_link,
    raw?.merchant_link,
    raw?.merchant_url,
    raw?.source_url,
    raw?.canonical_link,
    raw?.product_page_url,
    raw?.seller_link,
    raw?.seller_url,

    // nested
    raw?.merchant?.link,
    raw?.merchant?.url,
    raw?.seller?.link,
    raw?.seller?.url,
  ]
    .map((x) => safeStr(x, 2000))
    .filter(Boolean)
    .filter((x) => /^https?:\/\//i.test(x));

  return uniq(candidates);
}

function guessPreferredMerchantDomainsFromItem(it) {
  const raw = it?.raw || {};
  const s = String(raw?.source || raw?.merchant || raw?.seller || "").toLowerCase();

  const hints = [];
  if (s.includes("hepsiburada")) hints.push("hepsiburada.com");
  if (s.includes("trendyol")) hints.push("trendyol.com");
  if (/\bn11\b/.test(s) || s.includes("n11")) hints.push("n11.com");
  if (s.includes("amazon")) hints.push("amazon.com.tr", "amazon.com");

  // URL içinden de yakala
  const urls = extractCandidateUrlsFromSerpItem(it);
  for (const u of urls) {
    const h = normalizeHostFromUrl(u);
    if (!h) continue;
    if (h.endsWith("hepsiburada.com")) hints.push("hepsiburada.com");
    if (h.endsWith("trendyol.com")) hints.push("trendyol.com");
    if (h === "n11.com" || h.endsWith(".n11.com")) hints.push("n11.com");
    if (h.endsWith("amazon.com.tr")) hints.push("amazon.com.tr");
  }

  return uniq(hints);
}

function makeTitleKey(title) {
  const t = String(title || "").trim();
  if (!t) return "";
  // 8 kelime yeter: hem çok daraltma hem çöp query yapma
  const words = t
    .replace(/[^\w\sğüşöçıİĞÜŞÖÇ]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8);
  return words.join(" ").trim();
}

// ======================================================================
// URL probe (S22.3)
//  - disallowed evidence URL ise probe atlama
// ======================================================================
async function probeUrlForBarcode(url, code, diag) {
  const u = safeStr(url, 2000);
  if (!u || !/^https?:\/\//i.test(u)) return false;

  if (isDisallowedEvidenceUrl(u)) {
    diag?.tries?.push?.({ step: "probe_url_skip_disallowed", url: u });
    return false;
  }

  try {
    diag?.tries?.push?.({ step: "probe_url", url: u });
    const r = await getHtml(u, { timeoutMs: 9000, maxBytes: 1_500_000, allow3xx: true });
    if (!r?.ok || !r?.html) {
      diag?.tries?.push?.({ step: "probe_url_fail", url: u, status: r?.status || null });
      return false;
    }

    const ok = hasBarcodeEvidenceInText(r.html, code) || (u.includes(code) && hasBarcodeEvidenceInText(r.html, code));
    diag?.tries?.push?.({ step: ok ? "probe_url_ok" : "probe_url_no_evidence", url: u });
    return ok;
  } catch (e) {
    diag?.tries?.push?.({ step: "probe_url_error", url: u, error: String(e?.message || e) });
    return false;
  }
}

// ======================================================================
// Merchant hunt via SerpAPI (S22.3)
//  - title discovery -> site:merchant query -> barcode evidence probe
// ======================================================================
async function huntVerifiedMerchantUrl({ title, code, localeShort, diag, preferredDomains = [] }) {
  const t = cleanTitle(title || "");
  if (!t || !code) return null;

  const { hl, gl, region } = localePack(localeShort);
  const titleKey = makeTitleKey(t);

  // default TR merchants (en değerli)
  const defaults = ["hepsiburada.com", "trendyol.com", "n11.com", "amazon.com.tr"];

  const domains = uniq([...(preferredDomains || []), ...defaults]).slice(0, 4);

  // Query bütçesi: max 6
  const queries = [];
  for (const d of domains) {
    if (titleKey) queries.push(`site:${d} "${code}" "${titleKey}"`);
    queries.push(`site:${d} "${code}"`);
    if (titleKey) queries.push(`site:${d} "${titleKey}"`);
  }

  const finalQueries = uniq(queries).slice(0, 6);

  for (const q of finalQueries) {
    try {
      diag?.tries?.push?.({ step: "merchant_hunt_query", q });

      const r = await searchWithSerpApi(q, {
        mode: "google",
        region,
        hl,
        gl,
        num: 10,
        timeoutMs: 12000,
        includeRaw: true,
        barcode: true,
        intent: { type: "barcode_merchant_hunt" },
      });

      const items = Array.isArray(r?.items) ? r.items : [];
      if (!items.length) {
        diag?.tries?.push?.({ step: "merchant_hunt_empty", q });
        continue;
      }

      // sonuçlardan gerçek merchant link yakala
      for (const it of items.slice(0, 8)) {
        const urls = extractCandidateUrlsFromSerpItem(it);

        // domain q'nun içinden yakala (site:xxx)
        let wantHost = "";
        try {
          const m = String(q).match(/site:([^\s]+)/i);
          wantHost = (m?.[1] || "").toLowerCase().replace(/^www\./, "");
        } catch {}

        for (const u of urls) {
          if (isDisallowedEvidenceUrl(u)) continue;

          const h = normalizeHostFromUrl(u);
          if (wantHost && h && !h.endsWith(wantHost)) continue;

          const ok = await probeUrlForBarcode(u, code, diag);
          if (!ok) continue;

          const pickedTitle = cleanTitle(it?.title || t) || t;

          diag?.tries?.push?.({ step: "merchant_hunt_pick", q, url: u, host: h || null, title: pickedTitle });

          return {
            url: u,
            host: h || null,
            title: pickedTitle,
          };
        }
      }
    } catch (e) {
      diag?.tries?.push?.({ step: "merchant_hunt_error", q, error: String(e?.message || e) });
    }
  }

  return null;
}

// ======================================================================
// OpenFoodFacts (barcode -> product)
// ======================================================================
async function fetchOpenFoodFacts(barcode, diag) {
  const code = String(barcode || "").trim();
  if (!/^\d{8,18}$/.test(code)) return null;

  const url = `https://world.openfoodfacts.org/api/v0/product/${encodeURIComponent(code)}.json`;

  try {
    diag?.tries?.push?.({ step: "openfoodfacts_fetch", url });

    const r = await fetch(url, {
      method: "GET",
      headers: {
        "user-agent": "findalleasy/1.0 (barcode resolver)",
        accept: "application/json",
      },
    });

    if (!r.ok) {
      diag?.tries?.push?.({ step: "openfoodfacts_non_2xx", status: r.status });
      return null;
    }

    const j = await r.json().catch(() => null);
    if (!j || j.status !== 1 || !j.product) {
      diag?.tries?.push?.({ step: "openfoodfacts_no_product", status: j?.status ?? null });
      return null;
    }

    const p = j.product || {};
    const name = cleanTitle(p.product_name || p.product_name_tr || p.generic_name || p.generic_name_tr || "") || "";

    if (!name) {
      diag?.tries?.push?.({ step: "openfoodfacts_empty_name" });
      return null;
    }

    const img = safeStr(p.image_url || p.image_front_url || p.image_small_url || "", 2000) || "";
    const brand = safeStr(p.brands || "", 120) || "";
    const categories = safeStr(p.categories || p.categories_tags?.[0] || "", 180) || "";

    const product = {
      name,
      title: name,
      description: safeStr(p.ingredients_text || p.ingredients_text_tr || "", 500) || "",
      image: img,
      brand,
      category: categories || "product",
      region: "TR",
      qrCode: code,
      provider: "barcode",
      source: "openfoodfacts",
      verifiedBarcode: true,
      raw: p,
    };

    diag?.tries?.push?.({ step: "openfoodfacts_ok", name });
    return product;
  } catch (e) {
    diag?.tries?.push?.({ step: "openfoodfacts_error", error: String(e?.message || e) });
    return null;
  }
}

// ======================================================================
// SerpAPI fallback (barcode -> product title -> merchant verify) — S22.3
// ======================================================================
async function resolveBarcodeViaSerp(barcode, localeShort = "tr", diag) {
  const code = String(barcode || "").trim();
  if (!/^\d{8,18}$/.test(code)) return null;

  const cacheKey = `${localeShort}:${code}`;
  const cached = cacheGetBarcode(cacheKey);
  if (cached) return cached;

  const { hl, gl, region } = localePack(localeShort);

  const tries = [
    { q: `"${code}"`, mode: "google" },
    { q: `"${code}" barkod`, mode: "google" },
    { q: `gtin ${code}`, mode: "google" },
    { q: `ean ${code}`, mode: "google" },

    // TR pazar yerleri / katalog
    { q: `site:trendyol.com "${code}"`, mode: "google" },
    { q: `site:hepsiburada.com "${code}"`, mode: "google" },
    { q: `site:n11.com "${code}"`, mode: "google" },
    { q: `site:cimri.com ${code}`, mode: "google" },
    { q: `site:akakce.com ${code}`, mode: "google" },

    // son çare
    { q: `${code}`, mode: "google" },
  ];

  for (const tr of tries) {
    try {
      diag?.tries?.push?.({ step: "serpapi", q: tr.q, mode: tr.mode });

      const r = await searchWithSerpApi(tr.q, {
        mode: tr.mode,
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
        diag?.tries?.push?.({ step: "serpapi_empty", q: tr.q, mode: tr.mode });
        continue;
      }

      // Skorla: barkod kanıtı + iyi domain + title kalitesi
      const scored = [];
      for (const it of items) {
        const title = cleanTitle(it?.title || "");
        if (!title || title.length < 6) continue;

        const raw = it?.raw || {};
        const snippet = safeStr(raw?.snippet || raw?.description || raw?.summary || raw?.product_description || "", 600);

        // URL'leri topla, kanıt açısından disallowed url'leri AYRI değerlendir
        const urls = extractCandidateUrlsFromSerpItem(it);
        const bestNonDisallowed = urls.find((u) => !isDisallowedEvidenceUrl(u)) || "";

        let score = 0;
        if (hasBarcodeEvidenceInText(title, code)) score += 6;
        if (hasBarcodeEvidenceInText(snippet, code)) score += 6;
        if (bestNonDisallowed && bestNonDisallowed.includes(code)) score += 5;

        const d = bestNonDisallowed ? bestNonDisallowed.toLowerCase() : "";
        if (d.includes("trendyol.com")) score += 3;
        if (d.includes("hepsiburada.com")) score += 3;
        if (d.includes("n11.com")) score += 3;
        if (d.includes("cimri.com")) score += 2;
        if (d.includes("akakce.com")) score += 2;

        // Çöp sinyaller
        const tl = title.toLowerCase();
        if (tl.includes("arama sonuç") || tl.includes("search results")) score -= 5;

        scored.push({ it, title, score });
      }

      if (!scored.length) continue;
      scored.sort((a, b) => b.score - a.score);

      // 1) Top adaylarda önce "merchant doğrulama" dene
      for (const cand of scored.slice(0, 3)) {
        const it = cand.it;
        const title = cand.title;

        const urls = extractCandidateUrlsFromSerpItem(it);
        const preferredDomains = guessPreferredMerchantDomainsFromItem(it);

        // A) Elimizde doğrudan merchant URL varsa probe et
        const directMerchant = urls.find((u) => !isDisallowedEvidenceUrl(u));
        if (directMerchant) {
          const ok = await probeUrlForBarcode(directMerchant, code, diag);
          if (ok) {
            const raw = it?.raw || {};
            const desc =
              safeStr(raw?.snippet || raw?.description || raw?.summary || raw?.product_description || "", 260) || "";
            const img = safeStr(it?.image || raw?.thumbnail || raw?.image || "", 2000) || "";

            const product = {
              name: title,
              title,
              description: desc,
              image: img,
              brand: safeStr(raw?.brand || raw?.brands || "", 120),
              category: "product",
              region,
              qrCode: code,
              provider: "barcode",
              source: "serpapi-merchant",
              verifiedBarcode: true,
              matchUrl: directMerchant,
              raw: it,
            };

            cacheSetBarcode(cacheKey, product);
            diag?.tries?.push?.({ step: "serpapi_pick_merchant_direct", score: cand.score, url: directMerchant });
            return product;
          }
        } else {
          diag?.tries?.push?.({ step: "serpapi_no_direct_merchant_url", score: cand.score });
        }

        // B) Direct yoksa: title discovery -> merchant avı
        const hunted = await huntVerifiedMerchantUrl({
          title,
          code,
          localeShort,
          diag,
          preferredDomains,
        });

        if (hunted?.url) {
          const raw = it?.raw || {};
          const img = safeStr(it?.image || raw?.thumbnail || raw?.image || "", 2000) || "";

          const product = {
            name: hunted.title || title,
            title: hunted.title || title,
            description: "",
            image: img,
            brand: safeStr(raw?.brand || raw?.brands || "", 120),
            category: "product",
            region,
            qrCode: code,
            provider: "barcode",
            source: "serpapi-merchant-hunt",
            verifiedBarcode: true,
            matchUrl: hunted.url,
            matchHost: hunted.host || null,
            raw: {
              discovery: it,
              merchant: { url: hunted.url, host: hunted.host || null },
            },
          };

          cacheSetBarcode(cacheKey, product);
          diag?.tries?.push?.({ step: "serpapi_pick_merchant_hunt", score: cand.score, url: hunted.url });
          return product;
        }
      }

      // 2) Merchant doğrulama yoksa: low confidence fallback (başlık discovery)
      const best = scored[0];
      const bestScore = best?.score ?? 0;
      diag?.tries?.push?.({ step: "serpapi_low_confidence", q: tr.q, bestScore });

      if (best && bestScore >= 2) {
        const it = best.it;
        const raw = it?.raw || {};
        const desc =
          safeStr(raw?.snippet || raw?.description || raw?.summary || raw?.product_description || "", 260) || "";
        const img = safeStr(it?.image || raw?.thumbnail || raw?.image || "", 2000) || "";

        const product = {
          name: best.title,
          title: best.title,
          description: desc,
          image: img,
          brand: safeStr(raw?.brand || raw?.brands || "", 120),
          category: "product",
          region,
          qrCode: code,
          provider: "barcode",
          source: "serpapi",
          confidence: "low",
          confidenceScore: bestScore,
          verifiedBarcode: false,
          // not: matchUrl yok — çünkü elimizde sadece google/aggregator link olabilir ve bunu kanıt saymıyoruz
          raw: it,
        };

        cacheSetBarcode(cacheKey, product);
        diag?.tries?.push?.({ step: "serpapi_pick_loose", q: tr.q, score: bestScore });
        return product;
      }
    } catch (e) {
      diag?.tries?.push?.({ step: "serpapi_error", q: tr.q, mode: tr.mode, error: String(e?.message || e) });
    }
  }

  return null;
}

// ======================================================================
// LOCAL MARKETPLACE RESOLVER (TR)
//  - Trendyol / Hepsiburada / N11 site içi arama
//  - ✅ Barcode string'i ürün sayfasında gerçekten geçiyorsa kabul
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

  if (!Array.isArray(hits) || hits.length === 0) {
    diag?.tries?.push?.({ step: "local_marketplaces_empty" });

    // Domain kısıtlı aday URL bul -> URL içeriğinde barkod kanıtı ara.
    const domainQueries = [
      { provider: "trendyol", q: `site:trendyol.com "${code}"` },
      { provider: "hepsiburada", q: `site:hepsiburada.com "${code}"` },
      { provider: "n11", q: `site:n11.com "${code}"` },
    ];

    for (const dq of domainQueries) {
      try {
        diag?.tries?.push?.({ step: "local_serp_domain", provider: dq.provider, q: dq.q });

        const r = await searchWithSerpApi(dq.q, {
          mode: "google",
          region: "TR",
          hl: "tr",
          gl: "tr",
          num: 8,
          timeoutMs: 12000,
          includeRaw: true,
          barcode: true,
          intent: { type: "barcode" },
        });

        const items = Array.isArray(r?.items) ? r.items : [];
        if (!items.length) continue;

        for (const it of items.slice(0, 6)) {
          const raw = it?.raw || {};
          const url = safeStr(it?.url || it?.deeplink || raw?.link || raw?.product_link || "", 2000);
          if (!url) continue;

          const u = url.toLowerCase();
          if (dq.provider === "trendyol" && !u.includes("trendyol.com")) continue;
          if (dq.provider === "hepsiburada" && !u.includes("hepsiburada.com")) continue;
          if (dq.provider === "n11" && !u.includes("n11.com")) continue;

          const ok = await probeUrlForBarcode(url, code, diag);
          if (!ok) continue;

          const name = cleanTitle(it?.title || "");
          if (!name) continue;

          const product = {
            name,
            title: name,
            description: "",
            image: safeStr(it?.image || raw?.thumbnail || "", 2000) || "",
            brand: "",
            category: "product",
            region: "TR",
            qrCode: code,
            provider: "barcode",
            source: `local-domain-serp:${dq.provider}`,
            verifiedBarcode: true,
            matchUrl: url,
            raw: { matchUrl: url, provider: dq.provider, verifiedBarcode: true },
          };

          cacheSetBarcode(cacheKey, product);
          diag?.tries?.push?.({ step: "local_domain_serp_hit", provider: dq.provider, url, title: name });
          return product;
        }
      } catch (e) {
        diag?.tries?.push?.({ step: "local_serp_domain_error", provider: dq.provider, error: String(e?.message || e) });
      }
    }

    return null;
  }

  // hits var: localBarcodeEngine doğrulamışsa direkt kabul
  const best = hits[0] || null;
  const name = cleanTitle(best?.title || "");
  if (!best?.url || !name) return null;

  const product = {
    name,
    title: name,
    description: "",
    image: safeStr(best?.image || "", 2000) || "",
    brand: "",
    category: "product",
    region: "TR",
    qrCode: code,
    provider: "barcode",
    source: `local-marketplace-engine:${best?.provider || "unknown"}`,
    verifiedBarcode: !!best?.verifiedBarcode,
    matchUrl: best.url,
    raw: {
      matchUrl: best.url,
      provider: best?.provider || null,
      verifiedBarcode: !!best?.verifiedBarcode,
      price: best?.price ?? null,
    },
  };

  cacheSetBarcode(cacheKey, product);
  diag?.tries?.push?.({ step: "local_marketplaces_hit", provider: best?.provider || null, url: best.url, title: name });
  return product;
}

// ======================================================================
// Negative cache
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

    const raw = body?.qr ?? body?.code ?? body?.data ?? body?.text ?? req.query?.qr ?? req.query?.code;

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
      res.setHeader("x-product-info-ver", "S22.3");
      res.setHeader("x-json-parse-error", req.__jsonParseError ? "1" : "0");
    } catch {}

    if (!qr) return safeJson(res, { ok: false, error: "Geçersiz QR" }, 400);

    const ip = getClientIp(req);

    if (!burst(ip, qr)) {
      const out = { ok: true, cached: true, product: null, source: "burst-limit" };
      if (diag) out._diag = diag;
      return safeJson(res, out);
    }

    if (isBadQR(qr)) {
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
      const off = await fetchOpenFoodFacts(qr, diag);
      if (off) {
        try {
          await Product.create(off);
        } catch {}
        const out = { ok: true, product: off, source: "openfoodfacts" };
        if (diag) out._diag = diag;
        return safeJson(res, out);
      }

      // 2.5) TR marketplace resolver (site içi arama + barcode doğrulama)
      const local = await resolveBarcodeViaLocalMarketplaces(qr, localeShort, diag);
      if (local?.name) {
        try {
          await Product.create(local);
        } catch {}
        const out = { ok: true, product: local, source: "local-marketplace-barcode" };
        if (diag) out._diag = diag;
        return safeJson(res, out);
      }

      // 2.6) SerpAPI discovery + merchant doğrulama
      const serp = await resolveBarcodeViaSerp(qr, localeShort, diag);
      if (serp?.name) {
        try {
          await Product.create(serp);
        } catch {}
        const out = { ok: true, product: serp, source: serp?.source || "serpapi-barcode" };
        if (diag) out._diag = diag;
        return safeJson(res, out);
      }

      // Barcode çözülemedi: fallback
      const product = {
        name: qr,
        title: qr,
        qrCode: qr,
        provider: "barcode",
        source: "barcode-unresolved",
        verifiedBarcode: false,
      };
      const out = { ok: true, product, source: "barcode-unresolved" };
      if (diag) out._diag = diag;
      return safeJson(res, out);
    }

    // 3) URL
    if (qr.startsWith("http")) {
      const provider = detectProviderFromUrl(qr);
      const title = extractTitleFromUrl(qr) || `${provider} ${providerProductWord(localeShort)}`;

      const product = { name: safeStr(title, 200), title: safeStr(title, 200), provider, qrCode: qr, source: "url" };

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

    const product = { name: qr, title: qr, qrCode: qr, provider: "text", source: "text" };

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

// server/routes/product-info.js
// ======================================================================
//  PRODUCT INFO ENGINE — S22 GOD-KERNEL FINAL FORM (HARDENED)
//  ZERO DELETE — Eski davranış korunur, sadece daha sağlam input kabulü
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

// ======================================================================
// Barcode evidence helpers (anti-wrong-product)
//  - Amaç: "alakasız ürün" döndürmemek. Emin değilsek NULL.
// ======================================================================
function hasBarcodeEvidenceInText(text, code) {
  try {
    if (!text || !code) return false;
    const t = String(text);
    if (t.includes(code)) return true;
    // key-based evidence (html içinde barcode geçmeyebilir, ama JSON keyleri geçer)
    const re = new RegExp(
      String.raw`(?:gtin(?:13|14)?|ean(?:13)?|barcode|barkod|upc|product\s*id|product_id)\s*["'\s:=\-]{0,20}` + code,
      "i"
    );
    return re.test(t);
  } catch {
    return false;
  }
}

async function probeUrlForBarcode(url, code, diag) {
  const u = safeStr(url, 2000);
  if (!u || !/^https?:\/\//i.test(u)) return false;
  try {
    diag?.tries?.push?.({ step: "probe_url", url: u });
    const r = await getHtml(u, { timeoutMs: 9000, maxBytes: 1_500_000, allow3xx: true });
    if (!r?.ok || !r?.html) {
      diag?.tries?.push?.({ step: "probe_url_fail", url: u, status: r?.status || null });
      return false;
    }
    const ok = hasBarcodeEvidenceInText(r.html, code);
    diag?.tries?.push?.({ step: ok ? "probe_url_ok" : "probe_url_no_evidence", url: u });
    return ok;
  } catch (e) {
    diag?.tries?.push?.({ step: "probe_url_error", url: u, error: String(e?.message || e) });
    return false;
  }
}

// ======================================================================
// SerpAPI fallback (barcode -> product title)
//  - NOT: Bunun tam çalışması için serpApi adapter patch’i şart.
// ======================================================================
async function resolveBarcodeViaSerp(barcode, localeShort = "tr", diag) {
  const code = String(barcode || "").trim();
  if (!/^\d{8,18}$/.test(code)) return null;

  const cacheKey = `${localeShort}:${code}`;
  const cached = cacheGetBarcode(cacheKey);
  if (cached) return cached;

  const { hl, gl, region } = localePack(localeShort);

  // ⚠️ Google Shopping/merchant feed'ler GTIN'i bazen yanlış map'ler.
  // "Alakasız ürün" döndürmek yerine: sadece güçlü kanıt varsa kabul edeceğiz.
  const tries = [
    { q: `"${code}"`, mode: "google" },
    { q: `"${code}" barkod`, mode: "google" },
    { q: `gtin ${code}`, mode: "google" },
    { q: `ean ${code}`, mode: "google" },

    // TR pazar yerleri (snippet içinde barkod geçen sayfalar daha güvenilir)
    { q: `site:trendyol.com "${code}"`, mode: "google" },
    { q: `site:hepsiburada.com "${code}"`, mode: "google" },
    { q: `site:n11.com "${code}"`, mode: "google" },

    // TR fiyat karşılaştırma / katalog siteleri (barkod genelde sayfada yazıyor)
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
        const url = safeStr(it?.url || it?.deeplink || raw?.link || raw?.product_link || "", 2000);
        const snippet = safeStr(raw?.snippet || raw?.description || raw?.summary || raw?.product_description || "", 600);

        let score = 0;
        if (hasBarcodeEvidenceInText(title, code)) score += 6;
        if (hasBarcodeEvidenceInText(snippet, code)) score += 6;
        if (url && url.includes(code)) score += 5;

        const d = url ? url.toLowerCase() : "";
        if (d.includes("trendyol.com")) score += 3;
        if (d.includes("hepsiburada.com")) score += 3;
        if (d.includes("n11.com")) score += 3;
        if (d.includes("cimri.com")) score += 2;
        if (d.includes("akakce.com")) score += 2;

        // Çöp sinyaller
        const tl = title.toLowerCase();
        if (tl.includes("arama sonuç") || tl.includes("search results")) score -= 5;

        scored.push({ it, title, url, score });
      }

      if (!scored.length) continue;
      scored.sort((a, b) => b.score - a.score);

      // 1) Skoru yüksek olanları sırayla "probe" et (sayfada barkod geçiyor mu?)
      for (const cand of scored.slice(0, 4)) {
        // Kanıt yoksa probe bile etmeyelim (rate + blok riski)
        if ((cand.score || 0) < 5) continue;

        if (cand.url) {
          const ok = await probeUrlForBarcode(cand.url, code, diag);
          if (!ok) continue;
        }

        const raw = cand.it?.raw || {};
        const desc =
          safeStr(raw?.snippet || raw?.description || raw?.summary || raw?.product_description || "", 260) || "";
        const img = safeStr(cand.it?.image || raw?.thumbnail || raw?.image || "", 2000) || "";

        const product = {
          name: cand.title,
          title: cand.title,
          description: desc,
          image: img,
          brand: safeStr(raw?.brand || raw?.brands || "", 120),
          category: "product",
          region,
          qrCode: code,
          provider: "barcode",
          source: "serpapi",
          raw: cand.it,
        };

        cacheSetBarcode(cacheKey, product);
        diag?.tries?.push?.({ step: "serpapi_pick", q: tr.q, score: cand.score, url: cand.url || null });
        return product;
      }

      // Skor düşükse: probe ile doğrulayamadık. Yine de "en iyi tahmin" dönelim,
      // ama bunu açıkça işaretleyelim (confidence: low, verifiedBarcode: false).
      const best = scored[0];
      const bestScore = best?.score ?? 0;
      diag?.tries?.push?.({ step: "serpapi_low_confidence", q: tr.q, bestScore });

      if (best && bestScore >= 2) {
        const raw = best.it?.raw || {};
        const desc = safeStr(raw?.snippet || raw?.description || raw?.summary || raw?.product_description || "", 260) || "";
        const img = safeStr(best.it?.image || raw?.thumbnail || raw?.image || "", 2000) || "";

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
          raw: best.it,
        };

        cacheSetBarcode(cacheKey, product);
        diag?.tries?.push?.({ step: "serpapi_pick_loose", q: tr.q, score: bestScore, url: best.url || null });
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
      // search -> candidate -> product page; keep it snappy
      maxCandidates: 6,
      maxMatches: 1,
    });
  } catch (e) {
    diag?.tries?.push?.({ step: "local_marketplaces_error", error: String(e?.message || e) });
    hits = [];
  }

  if (!Array.isArray(hits) || hits.length === 0) {
  diag?.tries?.push?.({ step: "local_marketplaces_empty" });

  // ✅ Ek güvenli katman: SerpAPI ile domain kısıtlı aday URL bul, sonra URL içeriğinde barkod kanıtı ara.
  // (Pazar yerlerinin site-içi araması botlara 403 verebiliyor; bunu bypass eder.)
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
      res.setHeader("x-product-info-ver", "S22.2");
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
      // ✅ Yanlış ürün döndürmektense boş dönmesi daha iyi.
      const local = await resolveBarcodeViaLocalMarketplaces(qr, localeShort, diag);
      if (local?.name) {
        try {
          await Product.create(local);
        } catch {}
        const out = { ok: true, product: local, source: "local-marketplace-barcode" };
        if (diag) out._diag = diag;
        return safeJson(res, out);
      }

      const serp = await resolveBarcodeViaSerp(qr, localeShort, diag);
      if (serp?.name) {
        try {
          await Product.create(serp);
        } catch {}
        const out = { ok: true, product: serp, source: "serpapi-barcode" };
        if (diag) out._diag = diag;
        return safeJson(res, out);
      }

      // Barcode çözülemedi: gene de fallback dön (eski davranış: en azından qr kaybolmasın)
      const product = {
        name: qr,
        title: qr,
        qrCode: qr,
        provider: "barcode",
        source: "barcode-unresolved",
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

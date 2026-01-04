// backend/routes/product-info.js
// ======================================================================
//  PRODUCT INFO ENGINE — S21 GOD-KERNEL FINAL FORM (HARDENED)
//  ZERO DELETE — Eski davranış korunur, sadece daha sağlam input + barcode resolve
//
//  Fix:
//   - Body'den qr/code/data/text kabul et
//   - Barcode regex 8-18 (GTIN/EAN/UPC/SSCC)
//   - sanitizeQR: javascript:/data:/vbscript:/file: gibi şüpheli şemaları kes
//   - force=1 → mongo-cache + bad-cache bypass (re-resolve)
//   - Placeholder cache (text) barkod ise kendini iyileştir (cache'e takılı kalma)
//   - Upsert cache (duplicate birikmesin)
//   - diag=1 → _diag döndür
// ======================================================================

import express from "express";
import fetch from "node-fetch";
import rateLimit from "express-rate-limit";
import Product from "../models/Product.js";
import { searchWithSerpApi } from "../adapters/serpApi.js";

const router = express.Router();

// ======================================================================
// S21 RATE LIMIT (S16 korunur + burst control)
// ======================================================================
const limiter = rateLimit({
  windowMs: 5000,
  max: 40,
});
router.use(limiter);

// Çok kısa aralıkta spam QR gönderimini kesen mikro burst
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
// S21 SANITIZATION + NORMALIZATION
// ======================================================================
function sanitizeQR(v) {
  if (v == null) return "";
  let s = String(v).trim();

  // null byte / angle bracket temizle
  s = s.replace(/[\0<>]/g, "");

  // şüpheli şemaları kes
  if (/^(javascript|data|vbscript|file):/i.test(s)) return "";

  // çok uzunsa kırp
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
// BODY PICKER (robust)
// - Not: server.js JSON parse shield devredeyse req.body {} kalabilir.
// - Browser fetch düzgün JSON gönderdiği için pratikte sorun yok.
// ======================================================================
function pickBody(req) {
  const b = req?.body;
  if (!b) return {};
  if (typeof b === "object" && !Buffer.isBuffer(b)) return b;
  try {
    const s = Buffer.isBuffer(b) ? b.toString("utf8") : String(b);
    const j = JSON.parse(s);
    return j && typeof j === "object" ? j : {};
  } catch {
    return {};
  }
}

// ======================================================================
// S21 — PROVIDER DETECTOR
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

// ======================================================================
// S21 — URL TITLE EXTRACTOR
// ======================================================================
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
// LOCALE
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
// BARCODE → PRODUCT TITLE (SerpAPI fallback)
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

function looksLikeBarcode(s) {
  return /^\d{8,18}$/.test(String(s || "").trim());
}

function isPlaceholderDoc(doc, qr) {
  if (!doc) return false;
  const code = String(qr || "").trim();
  if (!looksLikeBarcode(code)) return false;

  const name = String(doc.name || doc.title || "").trim();
  const provider = String(doc.provider || "").toLowerCase();
  const source = String(doc.source || "").toLowerCase();

  const hasAnyDetails =
    !!String(doc.brand || "").trim() ||
    !!String(doc.image || "").trim() ||
    !!String(doc.description || "").trim();

  // “8690...” gibi numeric şeyi text diye cache'lediyse → placeholder say
  if (!hasAnyDetails && name === code && (provider === "text" || source === "text")) return true;

  // açıkça unresolved işaretlediysek → placeholder say
  if (doc.needsResolve === true) return true;

  return false;
}

async function resolveBarcodeViaSerp(barcode, localeShort = "tr", diagArr = null) {
  const code = String(barcode || "").trim();
  if (!looksLikeBarcode(code)) return null;

  const cacheKey = `${localeShort}:${code}`;
  const cached = cacheGetBarcode(cacheKey);
  if (cached) {
    if (Array.isArray(diagArr)) diagArr.push({ step: "mem-cache", hit: true });
    return cached;
  }

  const { hl, gl, region } = localePack(localeShort);

  // Not: SerpAPI kredi = deneme sayısı. Az ama etkili tutuyoruz.
  const tries = [
    { q: `ean ${code}`, mode: "shopping" },
    { q: `gtin ${code}`, mode: "shopping" },
    { q: `${code}`, mode: "shopping" },
    { q: `"${code}"`, mode: "shopping" },
  ];

  for (const tr of tries) {
    try {
      const r = await searchWithSerpApi(tr.q, {
        mode: tr.mode,     // shopping => google_shopping engine
        region,
        hl,
        gl,
        num: 10,
        timeoutMs: 12000,
        includeRaw: true,
      });

      const items = Array.isArray(r?.items) ? r.items : [];
      if (Array.isArray(diagArr)) {
        diagArr.push({
          q: tr.q,
          mode: tr.mode,
          ok: !!r?.ok,
          n: items.length,
          top: items.slice(0, 3).map((x) => String(x?.title || "").slice(0, 80)),
        });
      }

      if (!items.length) continue;

      let best = null;

      for (const it of items) {
        const title = cleanTitle(it?.title || "");
        if (!title) continue;

        const tl = title.toLowerCase();

        // tamamen sayı ise at
        if (/^\d+$/.test(title.replace(/\s+/g, ""))) continue;

        // çok kısa ise at
        if (title.length < 6) continue;

        // arama çöpü
        if (tl.includes("arama sonuç")) continue;
        if (tl.includes("search results")) continue;

        best = it;
        break;
      }

      if (!best) best = items[0];

      const name = cleanTitle(best?.title || "");
      if (!name) continue;

      const raw = best?.raw || {};
      const desc =
        safeStr(
          raw?.snippet ||
            raw?.description ||
            raw?.summary ||
            raw?.product_description ||
            "",
          260
        ) || "";

      const img = safeStr(best?.image || raw?.thumbnail || raw?.image || "", 2000) || "";

      const product = {
        name,
        title: name,
        description: desc,
        image: img,
        brand: safeStr(raw?.brand || raw?.brands || "", 120),
        category: "product",
        region,
        qrCode: code,
        provider: "barcode",
        source: "serpapi",
        raw: best,
      };

      cacheSetBarcode(cacheKey, product);
      return product;
    } catch (e) {
      if (Array.isArray(diagArr)) diagArr.push({ q: tr.q, mode: tr.mode, error: String(e?.message || e) });
      // next try
    }
  }

  return null;
}

// ======================================================================
// OpenFoodFacts (best effort)
// ======================================================================
async function fetchOpenFoodFacts(barcode) {
  try {
    const r = await fetch(`https://world.openfoodfacts.org/api/v2/product/${barcode}.json`, {
      timeout: 4000, // node-fetch bazı sürümlerde ignore olabilir; best-effort
    });

    if (!r.ok) return null;

    const txt = await r.text();
    let j;
    try {
      j = JSON.parse(txt);
    } catch {
      return null;
    }

    const p = j?.product;
    if (!p?.product_name) return null;

    return {
      name: p.product_name,
      title: p.product_name,
      brand: p.brands || "",
      category: p.categories || "",
      image: p.image_url || "",
      qrCode: barcode,
      provider: "barcode",
      source: "openfoodfacts",
      region: "TR",
      description: "",
    };
  } catch (err) {
    console.warn("OFF error:", err?.message);
  }
  return null;
}

// ======================================================================
// NEGATIVE CACHE
// ======================================================================
const badCache = new Map();
function isBadQR(qr) {
  const ts = badCache.get(qr);
  return ts && Date.now() - ts < 30 * 60 * 1000; // 30 dakika
}
function markBad(qr) {
  badCache.set(qr, Date.now());
}

// ======================================================================
// DB UPSERT (duplicate birikmesin)
// ======================================================================
async function upsertByQr(product) {
  try {
    const qrCode = String(product?.qrCode || "").trim();
    if (!qrCode) return;
    await Product.updateOne({ qrCode }, { $set: product }, { upsert: true });
  } catch {}
}

// ======================================================================
// MAIN HANDLER
// ======================================================================
async function handleProduct(req, res) {
  try {
    const body = pickBody(req);

    const force = String(req.query?.force || body?.force || "0") === "1";
    const diag = String(req.query?.diag || body?.diag || "0") === "1";
    const diagArr = diag ? [] : null;

    // Body + Query accept
    const raw =
      body?.qr ??
      body?.code ??
      body?.data ??
      body?.text ??
      req.query?.qr ??
      req.query?.code;

    const qr = sanitizeQR(raw);
    const localeShort = pickLocale(req, body);

    if (!qr) return safeJson(res, { ok: false, error: "Geçersiz QR" }, 400);

    const ip = getClientIp(req);

    // burst spam blokla (force bile olsa spam'i kesmek mantıklı)
    if (!burst(ip, qr)) {
      return safeJson(res, {
        ok: true,
        cached: true,
        product: null,
        source: "burst-limit",
        ...(diag ? { _diag: diagArr } : {}),
      });
    }

    // BAD-QR cache → force değilse çalışsın
    if (!force && isBadQR(qr)) {
      return safeJson(res, { ok: false, error: "QR bulunamadı", cached: true, ...(diag ? { _diag: diagArr } : {}) });
    }

    const barcode = looksLikeBarcode(qr);

    // 1) Mongo cache (force=1 ise atla) — placeholder barkod ise cache'e takılma
    if (!force) {
      try {
        const cached = await Product.findOne({ qrCode: qr }).lean();
        if (cached && !isPlaceholderDoc(cached, qr)) {
          return safeJson(res, { ok: true, product: cached, source: "mongo-cache", ...(diag ? { _diag: diagArr } : {}) });
        }
        if (cached && isPlaceholderDoc(cached, qr) && Array.isArray(diagArr)) {
          diagArr.push({ step: "mongo-cache", placeholder: true, provider: cached.provider, source: cached.source });
        }
      } catch (e) {
        console.warn("Mongo cache skip:", e?.message);
      }
    }

    // 2) Barcode path
    if (barcode) {
      const off = await fetchOpenFoodFacts(qr);
      if (off) {
        await upsertByQr(off);
        return safeJson(res, { ok: true, product: off, source: "openfoodfacts", ...(diag ? { _diag: diagArr } : {}) });
      }

      // SerpAPI fallback
      const serp = await resolveBarcodeViaSerp(qr, localeShort, diagArr);
      if (serp?.name) {
        await upsertByQr(serp);
        return safeJson(res, { ok: true, product: serp, source: "serpapi-barcode", ...(diag ? { _diag: diagArr } : {}) });
      }

      // Çözülemediyse: text diye cache'leyip kilitleme — barcode-unresolved olarak işaretle
      const unresolved = {
        name: qr,
        title: qr,
        qrCode: qr,
        provider: "barcode",
        source: "barcode-unresolved",
        needsResolve: true,
        region: "TR",
        category: "product",
        brand: "",
        image: "",
        description: "",
      };

      await upsertByQr(unresolved);
      return safeJson(res, { ok: true, product: unresolved, source: "barcode-unresolved", ...(diag ? { _diag: diagArr } : {}) });
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
        source: "link",
        region: "TR",
        category: "product",
      };

      await upsertByQr(product);

      return safeJson(res, { ok: true, product, source: `${provider}-link`, ...(diag ? { _diag: diagArr } : {}) });
    }

    // 4) RAW TEXT
    if (qr.length < 3) {
      markBad(qr);
      return safeJson(res, { ok: false, error: "Geçersiz içerik", ...(diag ? { _diag: diagArr } : {}) });
    }

    const product = {
      name: qr,
      title: qr,
      qrCode: qr,
      provider: "text",
      source: "text",
      region: "TR",
      category: "product",
      brand: "",
      image: "",
      description: "",
    };

    await upsertByQr(product);

    return safeJson(res, { ok: true, product, source: "raw-text", ...(diag ? { _diag: diagArr } : {}) });
  } catch (err) {
    console.error("🚨 product-info ERROR:", err);
    return safeJson(res, { ok: false, error: "SERVER_ERROR" }, 500);
  }
}

// ======================================================================
// ROUTE MAP (legacy support)
// ======================================================================
router.post("/product", handleProduct);
router.post("/product-info", handleProduct);
router.get("/product", handleProduct);
router.get("/product-info", handleProduct);

export default router;

// backend/routes/product-info.js
// ======================================================================
//  PRODUCT INFO ENGINE — S21 GOD-KERNEL FINAL FORM (HARDENED)
//  ZERO DELETE — Eski davranış korunur, sadece daha sağlam input kabulü
//
//  Fix:
//   - Body'den qr/code/data/text kabul et (bazı client'lar qr yerine code gönderiyor)
//   - JSON body parse fail olursa req.__rawBody üstünden tekrar parse et (server.js verify ile yakalanır)
//   - Barcode regex 8-18 (GTIN/EAN/UPC/SSCC) — "Geçersiz QR" saçmalığını bitir
//   - sanitizeQR: javascript:/data:/vbscript:/file: gibi şüpheli şemaları kes
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
//  - req.body boş kalırsa (JSON parse shield vs) req.__rawBody'den tekrar parse eder
// ======================================================================
function _parseMaybeJson(raw) {
  if (!raw) return {};
  let s = String(raw).trim();
  if (!s) return {};

  // BOM temizle
  s = s.replace(/^\uFEFF/, "").trim();

  // bazen body "'{...}'" gibi tek tırnakla sarılı gelebiliyor (proxy/curl karmaşası)
  if (
    (s.startsWith("'") && s.endsWith("'")) ||
    (s.startsWith('"') && s.endsWith('"'))
  ) {
    const inner = s.slice(1, -1).trim();
    if (inner.startsWith("{") && inner.endsWith("}")) s = inner;
  }

  try {
    const j = JSON.parse(s);
    return j && typeof j === "object" ? j : {};
  } catch {
    return {};
  }
}

function pickBody(req) {
  const b = req?.body;

  // normal object body
  if (b && typeof b === "object" && !Buffer.isBuffer(b)) {
    // boş object ise raw'a düşebiliriz
    if (Object.keys(b).length) return b;
  }

  // buffer/string body
  if (Buffer.isBuffer(b)) return _parseMaybeJson(b.toString("utf8"));
  if (typeof b === "string") return _parseMaybeJson(b);

  // rawBody fallback (server.js verify ile yakalanır)
  const rb = req?.__rawBody;
  if (Buffer.isBuffer(rb)) return _parseMaybeJson(rb.toString("utf8"));
  if (typeof rb === "string") return _parseMaybeJson(rb);

  return {};
}

// ======================================================================
// S21 — PROVIDER DETECTOR (güçlendirilmiş)
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
// S21 — URL TITLE EXTRACTOR++
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
// S21 — LOCALE PICKER (client optional)
// ======================================================================
function pickLocale(req, body) {
  try {
    const raw = String(body?.locale || req?.query?.locale || "")
      .trim()
      .toLowerCase();
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
// S21 — BARCODE → PRODUCT TITLE (SerpAPI fallback)
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

async function resolveBarcodeViaSerp(barcode, localeShort = "tr") {
  const code = String(barcode || "").trim();
  // ✅ 8-18 digit (GTIN/EAN/UPC/SSCC)
  if (!/^\d{8,18}$/.test(code)) return null;

  const cacheKey = `${localeShort}:${code}`;
  const cached = cacheGetBarcode(cacheKey);
  if (cached) return cached;

  const { hl, gl, region } = localePack(localeShort);

  const tries = [
    { q: `ean ${code}`, mode: "shopping" },
    { q: `${code} barcode`, mode: "google" },
    { q: `${code}`, mode: "google" },
  ];

  for (const tr of tries) {
    try {
      const r = await searchWithSerpApi(tr.q, {
        mode: tr.mode,
        region,
        hl,
        gl,
        num: 10,
        timeoutMs: 12000,
        includeRaw: true,
      });

      const items = Array.isArray(r?.items) ? r.items : [];
      if (!items.length) continue;

      let best = null;
      for (const it of items) {
        const title = cleanTitle(it?.title || "");
        if (!title) continue;
        if (/^\d+$/.test(title.replace(/\s+/g, ""))) continue;
        if (title.length < 6) continue;
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
    } catch {
      // next try
    }
  }

  return null;
}

// ======================================================================
// S21 — OpenFoodFacts Safe Wrapper (best effort)
// ======================================================================
async function fetchOpenFoodFacts(barcode) {
  try {
    const r = await fetch(
      `https://world.openfoodfacts.org/api/v2/product/${barcode}.json`,
      { timeout: 4000 } // node-fetch bazı sürümlerde ignore olabilir; best-effort
    );

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
      brand: p.brands || "",
      category: p.categories || "",
      image: p.image_url || "",
      qrCode: barcode,
      provider: "barcode",
    };
  } catch (err) {
    console.warn("OFF error:", err?.message);
  }
  return null;
}

// ======================================================================
// S21 — NEGATIVE CACHE (kötü QR tekrar denenmesin)
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
// MAIN HANDLER — S21 GOD MODE (HARDENED INPUT)
// ======================================================================
async function handleProduct(req, res) {
  try {
    // Debug header (istersen bakarsın)
    try {
      res.setHeader("x-product-info-ver", "S21");
      res.setHeader("x-json-parse-error", req.__jsonParseError ? "1" : "0");
    } catch {}

    const body = pickBody(req);
const force = String(req.query?.force || body?.force || "0") === "1";

const raw =
  body?.qr ??
  body?.code ??
  body?.data ??
  body?.text ??
  req.query?.qr ??
  req.query?.code;

let qr = sanitizeQR(raw);
const localeShort = pickLocale(req, body);


    if (!qr) return safeJson(res, { ok: false, error: "Geçersiz QR" }, 400);

    const ip = getClientIp(req);

    // burst spam blokla
    if (!burst(ip, qr)) {
      return safeJson(res, {
        ok: true,
        cached: true,
        product: null,
        source: "burst-limit",
      });
    }

    // BAD-QR cache → direkt geri dön
    if (isBadQR(qr)) {
      return safeJson(res, { ok: false, error: "QR bulunamadı", cached: true });
    }

   // 1) Mongo cache (force=1 ise atla)
if (!force) {
  try {
    const cached = await Product.findOne({ qrCode: qr }).lean();
    if (cached) {
      return safeJson(res, {
        ok: true,
        product: cached,
        source: "mongo-cache",
      });
    }
  } catch (e) {
    console.warn("Mongo cache skip:", e?.message);
  }
}


    // 2) Barcode
    if (/^\d{8,18}$/.test(qr)) {
      const off = await fetchOpenFoodFacts(qr);
      if (off) {
        try {
          await Product.create(off);
        } catch {}
        return safeJson(res, {
          ok: true,
          product: off,
          source: "openfoodfacts",
        });
      }

      // 2B) SerpAPI fallback: barcode -> product title
      const serp = await resolveBarcodeViaSerp(qr, localeShort);
      if (serp?.name) {
        try {
          await Product.create(serp);
        } catch {}
        return safeJson(res, {
          ok: true,
          product: serp,
          source: "serpapi-barcode",
        });
      }
      // barcode çözülmezse yine de text'e düşecek (legacy davranış)
    }

    // 3) URL
    if (qr.startsWith("http")) {
      const provider = detectProviderFromUrl(qr);
      const title = extractTitleFromUrl(qr) || `${provider} ${providerProductWord(localeShort)}`;

      const product = {
        name: safeStr(title, 200),
        provider,
        qrCode: qr,
      };

      try {
        await Product.create(product);
      } catch {}

      return safeJson(res, {
        ok: true,
        product,
        source: `${provider}-link`,
      });
    }

    // 4) RAW TEXT
    if (qr.length < 3) {
      markBad(qr);
      return safeJson(res, { ok: false, error: "Geçersiz içerik" });
    }

    const product = { name: qr, title: qr, qrCode: qr, provider: "text", source: "text" };

    try {
      await Product.create(product);
    } catch {}

    return safeJson(res, {
      ok: true,
      product,
      source: "raw-text",
    });
  } catch (err) {
    console.error("🚨 product-info ERROR:", err);
    return safeJson(res, { ok: false, error: "SERVER_ERROR" }, 500);
  }
}

// ======================================================================
// ROUTE MAP (legacy destek)
// ======================================================================
router.post("/product", handleProduct);
router.post("/product-info", handleProduct);
router.get("/product", handleProduct);
router.get("/product-info", handleProduct);

export default router;

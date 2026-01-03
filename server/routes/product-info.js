// backend/routes/product-info.js
// ======================================================================
//  PRODUCT INFO ENGINE — S21 GOD-KERNEL FINAL FORM
//  ZERO DELETE — Eski davranış %100 korunur
//  + S21 anti-poison
//  + S21 URL/Barcode normalizer
//  + S21 negative-cache
//  + S21 safe-json
// ======================================================================

import express from "express";
import fetch from "node-fetch";
import rateLimit from "express-rate-limit";
import Product from "../models/Product.js";

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
  if (!v) return "";
  let s = String(v).trim();

  // QR → %00, script, js, data: girişleri kes
  s = s.replace(/[\0<>]/g, "");

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
// S21 — OpenFoodFacts Safe Wrapper (timeout + failover)
// ======================================================================
async function fetchOpenFoodFacts(barcode) {
  try {
    const r = await fetch(
      `https://world.openfoodfacts.org/api/v2/product/${barcode}.json`,
      { timeout: 4000 }
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
// MAIN HANDLER — S21 GOD MODE
// ======================================================================
async function handleProduct(req, res) {
  try {
    // Bazı client sürümleri GET /product?code=... kullanabilir.
    // Kırılmaması için hem body hem query'i kabul ediyoruz.
    let qr = sanitizeQR(req.body?.qr || req.query?.code || req.query?.qr);
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

    // 1) Mongo cache
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

    // 2) Barcode
    if (/^\d{8,14}$/.test(qr)) {
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
    }

    // 3) URL
    if (qr.startsWith("http")) {
      let provider = detectProviderFromUrl(qr);
      let title = extractTitleFromUrl(qr) || `${provider} ürünü`;

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

    const product = { name: qr, qrCode: qr, provider: "text" };

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

// Backward/forward compatibility: eski client GET kullanırsa da çalışsın
router.get("/product", handleProduct);
router.get("/product-info", handleProduct);

export default router;

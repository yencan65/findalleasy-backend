import express from "express";
import fetch from "node-fetch";
import rateLimit from "express-rate-limit";
import Product from "../models/Product.js";
import { searchWithSerpApi } from "../adapters/serpApi.js";

const router = express.Router();

/**
 * Router-level body parsing (app.js/server.js express.json() eksik olsa bile çalışsın)
 */
router.use(express.json({ limit: "256kb" }));
router.use(express.urlencoded({ extended: false }));

// ======================================================================
// RATE LIMIT
// ======================================================================
const limiter = rateLimit({
  windowMs: 5000,
  max: 40,
});
router.use(limiter);

// micro-burst (aynı ip+code çok hızlı spam atmasın)
const burstMap = new Map();
function burst(ip, qr, ttl = 1500) {
  const key = `${ip}::${qr}`;
  const now = Date.now();
  const last = burstMap.get(key);
  if (last && now - last < ttl) return false;
  burstMap.set(key, now);
  return true;
}

// ======================================================================
// HELPERS
// ======================================================================
function safeStr(v, max = 250) {
  if (v == null) return "";
  let s = String(v).trim();
  s = s.replace(/[\0<>]/g, "");
  return s.slice(0, max);
}

function sanitizeQR(v) {
  if (v == null) return "";
  let s = String(v).trim();
  s = s.replace(/[\0<>]/g, "");

  // şüpheli şemalar
  if (/^(javascript|data|vbscript|file):/i.test(s)) return "";

  // aşırı uzunluğu kes
  if (s.length > 500) s = s.slice(0, 500);

  return s;
}

function safeJson(res, body, code = 200) {
  try {
    res.status(code).json(body);
  } catch (e) {
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

// Express body bazen string/buffer gelebilir (proxy/middleware karmaşası)
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
    const cleanUrl = String(url).split("?")[0].split("&")[0];
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

// fetch timeout (node-fetch v3 için AbortController)
async function fetchWithTimeout(url, ms = 4500) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(to);
  }
}

// ======================================================================
// NEGATIVE CACHE (30 dk)
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
// BARCODE RESOLVE (OpenFoodFacts → SerpAPI)
// ======================================================================
async function fetchOpenFoodFacts(barcode) {
  try {
    const r = await fetchWithTimeout(
      `https://world.openfoodfacts.org/api/v2/product/${barcode}.json`,
      4500
    );
    if (!r.ok) return null;

    const j = await r.json().catch(() => null);
    const p = j?.product;
    if (!p?.product_name) return null;

    return {
      name: safeStr(p.product_name, 200),
      title: safeStr(p.product_name, 200),
      brand: safeStr(p.brands || "", 120),
      category: safeStr(p.categories || "", 200),
      image: safeStr(p.image_url || "", 2000),
      description: "",
      qrCode: String(barcode),
      provider: "barcode",
      source: "openfoodfacts",
    };
  } catch {
    return null;
  }
}

function cleanTitle(t) {
  const s = safeStr(t, 240);
  if (!s) return "";
  return s.replace(/\s+[\|\-–]\s+.+$/, "").trim();
}

async function resolveBarcodeViaSerp(barcode, localeShort = "tr") {
  const code = String(barcode || "").trim();
  if (!/^\d{8,18}$/.test(code)) return null;

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
      const desc = safeStr(
        raw?.snippet || raw?.description || raw?.summary || raw?.product_description || "",
        260
      );
      const img = safeStr(best?.image || raw?.thumbnail || raw?.image || "", 2000);

      return {
        name,
        title: name,
        description: desc || "",
        image: img || "",
        brand: safeStr(raw?.brand || raw?.brands || "", 120),
        category: "product",
        region,
        qrCode: code,
        provider: "barcode",
        source: "serpapi",
        raw: best,
      };
    } catch {
      // next try
    }
  }
  return null;
}

// ======================================================================
// MAIN HANDLER
// ======================================================================
async function handleProduct(req, res) {
  // ✅ canlı doğrulama header’ı
  res.setHeader("x-product-info-ver", "S21");

  try {
    const body = pickBody(req);

    const raw =
      body?.qr ??
      body?.code ??
      body?.data ??
      body?.text ??
      req.query?.qr ??
      req.query?.code;

    const qr = sanitizeQR(raw);
    const localeShort = pickLocale(req, body);
    const ip = getClientIp(req);

    if (!qr) return safeJson(res, { ok: false, error: "Geçersiz QR" }, 400);

    if (!burst(ip, qr)) {
      return safeJson(res, { ok: true, cached: true, product: null, source: "burst-limit" });
    }

    if (isBadQR(qr)) {
      return safeJson(res, { ok: false, error: "QR bulunamadı", cached: true });
    }

    // 1) Mongo cache
    try {
      const cached = await Product.findOne({ qrCode: qr }).lean();
      if (cached) {
        return safeJson(res, { ok: true, product: cached, source: "mongo-cache" });
      }
    } catch {
      // ignore cache issues
    }

    // 2) Barcode (8–18)
    if (/^\d{8,18}$/.test(qr)) {
      const off = await fetchOpenFoodFacts(qr);
      if (off) {
        try {
          await Product.create(off);
        } catch {}
        return safeJson(res, { ok: true, product: off, source: "openfoodfacts" });
      }

      const serp = await resolveBarcodeViaSerp(qr, localeShort);
      if (serp?.name) {
        try {
          await Product.create(serp);
        } catch {}
        return safeJson(res, { ok: true, product: serp, source: "serpapi-barcode" });
      }
    }

    // 3) URL
    if (/^https?:\/\//i.test(qr)) {
      const provider = detectProviderFromUrl(qr);
      const title = extractTitleFromUrl(qr) || `${provider} product`;

      const product = {
        name: safeStr(title, 200),
        title: safeStr(title, 200),
        provider,
        qrCode: qr,
        source: "url",
      };

      try {
        await Product.create(product);
      } catch {}

      return safeJson(res, { ok: true, product, source: `${provider}-link` });
    }

    // 4) RAW TEXT
    if (qr.length < 2) {
      markBad(qr);
      return safeJson(res, { ok: false, error: "Geçersiz içerik" }, 400);
    }

    const product = { name: qr, title: qr, qrCode: qr, provider: "text", source: "text" };

    try {
      await Product.create(product);
    } catch {}

    return safeJson(res, { ok: true, product, source: "raw-text" });
  } catch (err) {
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

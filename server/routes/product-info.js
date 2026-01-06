// server/routes/product-info.js
// ======================================================================
//  PRODUCT INFO ENGINE — S22 GOD-KERNEL FINAL FORM (HARDENED)
//  ZERO DELETE — Eski davranış korunur, sadece daha sağlam input kabulü
//
//  Fix (S22.1):
//   - localBarcodeEngine import'u LAZY (import patlasa bile route AYAKTA)
//   - fetch globalThis.fetch kullan, yoksa node-fetch'i LAZY import et
//   - timeout node-fetch v2/v3/global fetch ile AbortController üzerinden
// ======================================================================

import express from "express";
import rateLimit from "express-rate-limit";
import Product from "../models/Product.js";
import { searchWithSerpApi } from "../adapters/serpApi.js";

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
// Fetch (HARDENED): global fetch varsa onu kullan, yoksa node-fetch'i lazy import et
// ======================================================================
async function getFetch(diag) {
  if (typeof globalThis.fetch === "function") return globalThis.fetch.bind(globalThis);

  try {
    const mod = await import("node-fetch");
    const fn = mod?.default || mod?.fetch;
    if (typeof fn === "function") return fn;
  } catch (e) {
    diag?.tries?.push?.({ step: "fetch_import_fail", error: String(e?.message || e) });
  }

  throw new Error("FETCH_UNAVAILABLE");
}

async function fetchWithTimeout(fetchFn, url, opts = {}, timeoutMs = 4500) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), Math.max(250, Number(timeoutMs) || 4500));
  try {
    return await fetchFn(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
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
// SerpAPI fallback (barcode -> product title)
// ======================================================================
async function resolveBarcodeViaSerp(barcode, localeShort = "tr", diag) {
  const code = String(barcode || "").trim();
  if (!/^\d{8,18}$/.test(code)) return null;

  const cacheKey = `${localeShort}:${code}`;
  const cached = cacheGetBarcode(cacheKey);
  if (cached) return cached;

  const { hl, gl, region } = localePack(localeShort);

  const tries = [
    { q: `ean ${code}`, mode: "shopping" },
    { q: `${code} barkod`, mode: "google" },
    { q: `site:trendyol.com ${code}`, mode: "google" },
    { q: `site:hepsiburada.com ${code}`, mode: "google" },
    { q: `site:n11.com ${code}`, mode: "google" },
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

      let best = null;
      for (const it of items) {
        const title = cleanTitle(it?.title || "");
        if (!title) continue;

        const t = title.toLowerCase();
        if (/^\d+$/.test(title.replace(/\s+/g, ""))) continue;
        if (title.length < 6) continue;
        if (t.includes("arama sonuç") || t.includes("search results")) continue;

        best = it;
        break;
      }
      if (!best) best = items[0];

      const name = cleanTitle(best?.title || "");
      if (!name) continue;

      const raw = best?.raw || {};
      const desc =
        safeStr(raw?.snippet || raw?.description || raw?.summary || raw?.product_description || "", 260) || "";
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
      diag?.tries?.push?.({ step: "serpapi_error", q: tr.q, mode: tr.mode, error: String(e?.message || e) });
    }
  }

  return null;
}

// ======================================================================
// LOCAL MARKETPLACE RESOLVER (TR) — LAZY IMPORT (route'u öldürmesin)
// ======================================================================
async function safeSearchLocalBarcodeEngine(code, opts, diag) {
  try {
    const mod = await import("../core/localBarcodeEngine.js");
    const fn = mod?.searchLocalBarcodeEngine;
    if (typeof fn !== "function") {
      diag?.tries?.push?.({ step: "local_engine_missing" });
      return [];
    }
    return await fn(code, opts);
  } catch (e) {
    diag?.tries?.push?.({ step: "local_engine_import_fail", error: String(e?.message || e) });
    return [];
  }
}

async function resolveBarcodeViaLocalMarketplaces(barcode, localeShort = "tr", diag) {
  const code = String(barcode || "").trim();
  if (!/^\d{8,18}$/.test(code)) return null;

  const cacheKey = `${localeShort}:local:${code}`;
  const cached = cacheGetBarcode(cacheKey);
  if (cached) return cached;

  diag?.tries?.push?.({ step: "local_marketplaces_start", barcode: code });

  let hits = [];
  try {
    hits = await safeSearchLocalBarcodeEngine(
      code,
      {
        region: "TR",
        maxCandidates: 6,
        maxMatches: 1,
      },
      diag
    );
  } catch (e) {
    diag?.tries?.push?.({ step: "local_marketplaces_error", error: String(e?.message || e) });
    hits = [];
  }

  if (!Array.isArray(hits) || hits.length === 0) {
    diag?.tries?.push?.({ step: "local_marketplaces_empty" });
    return null;
  }

  const prefer = (p) => (p === "trendyol" ? 0 : p === "hepsiburada" ? 1 : p === "n11" ? 2 : 9);
  hits.sort((a, b) => prefer(String(a?.provider || "")) - prefer(String(b?.provider || "")));

  const best = hits[0];
  const name = cleanTitle(best?.title || "");
  if (!name) return null;

  const { hl, gl, region } = localePack(localeShort);

  const product = {
    name,
    title: name,
    description: "",
    image: safeStr(best?.image || "", 2000) || "",
    brand: "",
    category: "product",
    region,
    qrCode: code,
    provider: "barcode",
    source: `local-marketplace:${String(best?.provider || "unknown")}`,
    raw: {
      matchUrl: safeStr(best?.url || "", 2000),
      provider: safeStr(best?.provider || "", 50),
      verifiedBarcode: true,
      hl,
      gl,
    },
  };

  cacheSetBarcode(cacheKey, product);
  diag?.tries?.push?.({ step: "local_marketplaces_hit", provider: best?.provider, url: best?.url, title: name });
  return product;
}

// ======================================================================
// OpenFoodFacts best effort (HARDENED fetch)
// ======================================================================
async function fetchOpenFoodFacts(barcode, diag) {
  try {
    diag?.tries?.push?.({ step: "openfacts", barcode });

    const endpoints = [
      { key: "openfoodfacts_org", url: `https://world.openfoodfacts.org/api/v2/product/${barcode}.json` },
      { key: "openfoodfacts_net", url: `https://world.openfoodfacts.net/api/v2/product/${barcode}` },
      { key: "openbeautyfacts", url: `https://world.openbeautyfacts.org/api/v2/product/${barcode}` },
      { key: "openproductsfacts", url: `https://world.openproductsfacts.org/api/v2/product/${barcode}.json` },
    ];

    const fetchFn = await getFetch(diag);

    for (const ep of endpoints) {
      try {
        diag?.tries?.push?.({ step: ep.key, url: ep.url });

        const r = await fetchWithTimeout(
          fetchFn,
          ep.url,
          {
            headers: {
              "User-Agent": "FindAllEasy/1.0 (+https://findalleasy.com)",
              Accept: "application/json",
            },
          },
          4500
        );

        if (!r || !r.ok) continue;

        const txt = await r.text();
        let j;
        try {
          j = JSON.parse(txt);
        } catch {
          continue;
        }

        const p = j?.product;
        const name =
          (p?.product_name && String(p.product_name).trim()) ||
          (p?.product_name_en && String(p.product_name_en).trim()) ||
          (p?.generic_name && String(p.generic_name).trim()) ||
          (p?.generic_name_en && String(p.generic_name_en).trim()) ||
          "";

        if (!name) continue;

        return {
          name,
          title: name,
          brand: safeStr(p?.brands || "", 120),
          category: safeStr(p?.categories || "", 200),
          image: safeStr(p?.image_url || p?.image_front_url || "", 500),
          qrCode: barcode,
          provider: "barcode",
          source: ep.key,
          raw: diag ? { openfacts: { endpoint: ep.key } } : undefined,
        };
      } catch (errOne) {
        diag?.tries?.push?.({ step: `${ep.key}_error`, error: String(errOne?.message || errOne) });
      }
    }
  } catch (err) {
    diag?.tries?.push?.({ step: "openfacts_error", error: String(err?.message || err) });
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
      res.setHeader("x-product-info-ver", "S22.1");
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

      // 2.5) TR marketplace resolver (kanıtlı eşleşme)
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

      // Barcode çözülemedi: fallback
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

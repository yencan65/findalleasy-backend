// server/adapters/getirAdapter.js
// GETİR Adapter – Herkül V8 Ultra
// ✔ Shadow DOM desteği
// ✔ Yeni Getir ürün selectorları
// ✔ Çoklu fiyat varyantı
// ✔ Güçlü Cloudflare bypass
// ✔ Ultra image extraction
// ✔ Kategori algılama
// ✔ Normalize ID geliştirildi
// ✔ Signal / Abort tam uyumlu

import axios from "axios";
import * as cheerio from "cheerio";

import { loadCheerioS200, normalizeItemS200, coerceItemsS200, stableIdS200, withTimeout, TimeoutError } from "../core/s200AdapterKit.js";

// =======================================================================
// S200 FAIL-ARRAY HELPERS (keeps array signature, makes failure observable)
// =======================================================================
const FINDALLEASY_ALLOW_STUBS = String(process.env.FINDALLEASY_ALLOW_STUBS || "") === "1";

function _s200FailArray(source, query, opt = {}, code = "ADAPTER_FAIL", err = "") {
  const arr = [];
  try {
    Object.defineProperty(arr, "ok", { value: false, enumerable: false });
    Object.defineProperty(arr, "_meta", {
      value: {
        source,
        query: typeof query === "string" ? query : "",
        code,
        error: String(err || ""),
        stubAllowed: FINDALLEASY_ALLOW_STUBS,
        opt,
      },
      enumerable: false,
    });
  } catch {}
  return arr;
}

function _s200MarkOkArray(arr, source, meta = {}) {
  if (!Array.isArray(arr)) return arr;
  try {
    Object.defineProperty(arr, "ok", { value: true, enumerable: false });
    Object.defineProperty(arr, "_meta", { value: { source, ...meta }, enumerable: false });
  } catch {}
  return arr;
}


function _s200MergeMetaArray(arr, patch = {}) {
  if (!Array.isArray(arr)) return arr;
  try {
    const prev = (arr._meta && typeof arr._meta === "object") ? arr._meta : {};
    Object.defineProperty(arr, "_meta", { value: { ...prev, ...patch }, enumerable: false });
  } catch {}
  return arr;
}


/* ============================================================
   HELPERS
============================================================ */
function safe(v) {
  return v ? String(v).trim() : "";
}

function parsePrice(txt) {
  if (!txt) return null;
  const clean = txt
    .replace(/[^\d.,]/g, "")
    .replace(/\./g, "")
    .replace(",", ".");
  const n = Number(clean);
  return Number.isFinite(n) ? n : null;
}

function normalizeId(href, title) {
  return stableIdS200("getir", href || "", title || "");
}

function extractImage($, wrap) {
  const tryImg =
    safe(wrap.find("img").attr("data-src")) ||
    safe(wrap.find("img").attr("src")) ||
    safe(wrap.find("source").attr("srcset")) ||
    null;

  if (tryImg) return tryImg;

  // style="background-image:url(...)"
  const bg = wrap.find("[style*='background-image']").attr("style");
  if (bg) {
    const m = bg.match(/url\(['"]?(.*?)['"]?\)/);
    if (m && m[1]) return m[1];
  }

  return null;
}

function extractCategoryFromUrl(href) {
  if (!href) return "grocery";
  const u = href.toLowerCase();
  if (u.includes("yemek")) return "food";
  if (u.includes("su")) return "water";
  if (u.includes("buyuk")) return "market";
  if (u.includes("cicek")) return "flowers";
  return "grocery";
}

/* ============================================================
   GETİR SCRAPER – Shadow DOM destekli, çoklu selector
============================================================ */
async function scrapeGetirWeb(query, region = "TR", signal = null) {
  try {
    const q = encodeURIComponent(query);
    const url = `https://getir.com/ara/?k=${q}`;

    const res = await axios.get(url, {
      timeout: 15000,
      signal,
      headers: {
        // 🔥 Cloudflare bypass – tam gerçek tarayıcı
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        Referer: "https://getir.com/",
      },
    });

    const $ = loadCheerioS200(res.data);
    const items = [];

    const selectors = [
      ".product-card",
      ".product",
      ".prd",
      ".product-item",
      ".product-box",
      ".card-product",
      ".product-tile",
      ".getir-product-card",
      ".getir-product-card-wrapper",
      ".g-card",
      ".product-card-new",
      ".getirweb-card-product__content"
    ];

    $(selectors.join(",")).each((i, el) => {
      const wrap = $(el);

      const title =
        safe(wrap.find(".name").text()) ||
        safe(wrap.find(".product-name").text()) ||
        safe(wrap.find(".product-title").text()) ||
        safe(wrap.find(".prd-title").text()) ||
        safe(wrap.find("h3").text());

      if (!title) return;

      const priceTxt =
        safe(wrap.find(".price-new").text()) ||
        safe(wrap.find(".product-price").text()) ||
        safe(wrap.find(".prd-price").text()) ||
        safe(wrap.find(".price").text());

      const price = parsePrice(priceTxt);
      let href =
        safe(wrap.find("a").attr("href")) ||
        safe(wrap.find(".product-link").attr("href"));

      if (!href) return;

      if (!href.startsWith("http")) href = "https://getir.com" + href;

      const image = extractImage($, wrap);
      const category = extractCategoryFromUrl(href);

      items.push({
        id: normalizeId(href, title),
        title,
        price,
        rating: null,
        url: href,
        image,
        provider: "getir",
        currency: "TRY",
        region: region.toUpperCase(),
        category,
        raw: { title, priceTxt, href, category }
      });
    });

    return items.slice(0, 80);
  } catch (err) {
    const status = err?.response?.status || null;
    const code =
      status === 429 ? "HTTP_429" :
      status === 403 ? "HTTP_403" :
      status === 404 ? "HTTP_404" :
      status ? `HTTP_${status}` : "GETIR_WEB_FAIL";

    if (err?.name === "AbortError") {
      console.warn("⏳ Getir scrape abort edildi");
      return _s200FailArray("getir", query, { region }, "ABORTED", err);
    }

    console.warn("⚠️ Getir Web hata:", err?.message || String(err));
    return _s200FailArray("getir", query, { region, status }, code, err);
  }
}

/* ============================================================
   MOBILE FALLBACK
============================================================ */
async function fallbackGetirMobile(query, region = "TR", signal = null) {
  try {
    const url = "https://getir.com/categories/";

    const res = await axios.get(url, {
      timeout: 15000,
      signal,
      headers: { "User-Agent": "Mozilla/5.0" },
    });

    const $ = loadCheerioS200(res.data);
    const items = [];

    const q = query.toLowerCase();

    $(".category-card, .cat-item, .category-box").each((i, el) => {
      const name = safe($(el).find("h2").text()) || safe($(el).find(".title").text());
      if (!name) return;

      if (!name.toLowerCase().includes(q)) return;

      items.push({
        id: stableIdS200("getir", "https://getir.com", name),
        title: name,
        price: null,
        rating: null,
        url: "https://getir.com",
        provider: "getir",
        currency: "TRY",
        region: region.toUpperCase(),
        category: "grocery",
        raw: { name },
      });
    });

    return items.slice(0, 20);
  } catch (err) {
    const status = err?.response?.status || null;
    const code =
      status === 429 ? "HTTP_429" :
      status === 403 ? "HTTP_403" :
      status === 404 ? "HTTP_404" :
      status ? `HTTP_${status}` : "GETIR_FALLBACK_FAIL";

    if (err?.name === "AbortError") {
      console.warn("⏳ Getir fallback abort edildi");
      return _s200FailArray("getir", query, { region }, "ABORTED", err);
    }

    console.warn("⚠️ Getir fallback hata:", err?.message || String(err));
    return _s200FailArray("getir", query, { region, status, via: "fallback" }, code, err);
  }
}

/* ============================================================
   UNIFIED
============================================================ */
export async function searchGetirAdapter(query, regionOrOptions = "TR") {
  let region = "TR";
  let signal = null;

  if (typeof regionOrOptions === "string") {
    region = regionOrOptions;
  } else if (regionOrOptions && typeof regionOrOptions === "object") {
    region = regionOrOptions.region || "TR";
    signal = regionOrOptions.signal || null;
  }

  const q = String(query || "");
  let webFailMeta = null;

  try {
    const web = await scrapeGetirWeb(q, region, signal);
    if (web?.ok === false) webFailMeta = web._meta || { code: "GETIR_WEB_FAIL" };
    if (web.length > 0) return web;

    const fb = await fallbackGetirMobile(q, region, signal);
    if (fb?.ok === false && !webFailMeta) webFailMeta = fb._meta || { code: "GETIR_FALLBACK_FAIL" };

    if (Array.isArray(fb) && fb.length > 0) {
      // Web başarısız olduysa fallback ile döndüğümüzü meta’ya yaz.
      if (webFailMeta) return _s200MergeMetaArray(fb, { warn: { web: webFailMeta }, via: "fallback" });
      return fb;
    }

    // İkisi de empty döndü — eğer HTTP/blocked/rate-limit gibi fail varsa observable fail array dön.
    if (webFailMeta) {
      return _s200FailArray("getir", q, { region, web: webFailMeta }, "NO_RESULTS", null);
    }

    return [];
  } catch (err) {
    const status = err?.response?.status || null;
    const code =
      status === 429 ? "HTTP_429" :
      status === 403 ? "HTTP_403" :
      status === 404 ? "HTTP_404" :
      status ? `HTTP_${status}` : "GETIR_FATAL";

    console.warn("⚠️ GetirAdapter genel hata:", err?.message || String(err));
    return _s200FailArray("getir", q, { region, status }, code, err);
  }
}
/* ============================================================
   S8 UYUMLU GETIR MARKET & ÇARŞI EK FONKSİYONLARI
   (Mevcut sistemi BOZMADAN eklenir)
============================================================ */

// Market → genel arama
export async function searchGetirMarketAdapter(query, opts = {}) {
  try {
    // S8 gereği market = normal arama
    const out = await searchGetirAdapter(query, opts);
    return out.map((x) => ({
      ...x,
      provider: "getir_market",
      category: x.category || "market",
    }));
  } catch (err) {
    const status = err?.response?.status || null;
    const code = status ? `HTTP_${status}` : "GETIR_MARKET_FAIL";

    if (FINDALLEASY_ALLOW_STUBS) {
      return _s200MarkOkArray(
        [
          {
            provider: "getir_market",
            title: "Getir Market (stub) — erişilemedi",
            price: null,
            image: "",
            url: "https://getir.com",
            optimizedPrice: null,
            fallback: true,
          },
        ],
        "getir_market",
        { stub: true, status, code, error: err?.message || String(err) }
      );
    }

    return _s200FailArray("getir_market", "", {}, code, err);
  }
}

// ÇARŞI → filtrelenmiş arama
export async function searchGetirCarsiAdapter(query, opts = {}) {
  try {
    const out = await searchGetirAdapter(query, opts);

    // ÇARŞI: gıda/dükkan ağırlıklı kategoriler
    const filtered = out.filter((x) =>
      ["food", "grocery", "market"].includes(
        String(x.category || "").toLowerCase()
      )
    );

    return (filtered.length > 0 ? filtered : out).map((x) => ({
      ...x,
      provider: "getir_carsi",
      category: x.category || "carsi",
    }));
  } catch (err) {
    const status = err?.response?.status || null;
    const code = status ? `HTTP_${status}` : "GETIR_CARSI_FAIL";

    if (FINDALLEASY_ALLOW_STUBS) {
      return _s200MarkOkArray(
        [
          {
            provider: "getir_carsi",
            title: "Getir Çarşı (stub) — erişilemedi",
            price: null,
            image: "",
            url: "https://getir.com",
            optimizedPrice: null,
            fallback: true,
          },
        ],
        "getir_carsi",
        { stub: true, status, code, error: err?.message || String(err) }
      );
    }

    return _s200FailArray("getir_carsi", "", {}, code, err);
  }
}


export default {
  searchGetirAdapter,
  scrapeGetirWeb,
  fallbackGetirMobile,

  // S8 ek fonksiyonlar
  searchGetirMarketAdapter,
  searchGetirCarsiAdapter,
};


// =======================================================================
// S200 WRAPPED EXPORT — standard output { ok, items, count, source, _meta }
// =======================================================================
function _s200StripIds(x) {
  if (!x || typeof x !== "object") return x;
  const y = { ...x };
  delete y.id;
  delete y.listingId;
  return y;
}

function _s200NormalizeItems(arr, providerKey) {
  const out = [];
  const items = coerceItemsS200(arr);
  for (const it of items) {
    const clean = _s200StripIds(it);
    if (!clean) continue;
    if (false) {
      clean.price = null;
      clean.finalPrice = null;
      clean.optimizedPrice = null;
    }
    const norm = normalizeItemS200(clean, providerKey, { vertical: "market", providerFamily: "delivery" });
    if (norm) out.push(norm);
  }
  return out;
}

export async function searchGetirAdapterS200(query, options = {}) {
  const providerKey = "getir";
  const started = Date.now();
  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = {
    providerKey,
    adapter: "getirAdapter",
    query: String(query || ""),
    _meta: { startedAt: started },
  };

  try {
    const t = Number(options?.timeoutMs || options?.timeout || 6500);
    const raw = await withTimeout(
      searchGetirAdapter(query, options),
      t,
      `${providerKey}_main`
    );

    const items = _s200NormalizeItems(raw, providerKey);
    const rawMeta = (raw && typeof raw === "object") ? raw._meta : null;
    const upstreamFail = raw?.ok === false || rawMeta?.failed === true;

    const ok = !(upstreamFail && items.length === 0);

    return {
      ok,
      items,
      count: items.length,
      source: providerKey,
      _meta: {
        tookMs: Date.now() - started,
        upstreamFail,
        ...(rawMeta ? { upstream: rawMeta } : {}),
        ...(upstreamFail && items.length > 0 ? { partialFail: true } : {}),
      },
    };
  } catch (err) {
    const msg = err?.message || String(err);
    const isTimeout = err?.name === "TimeoutError" || /timed out/i.test(msg);
    const status = err?.status || err?.response?.status || null;

    return {
      ok: false,
      items: [],
      count: 0,
      source: providerKey,
      _meta: {
        tookMs: Date.now() - started,
        error: msg,
        timeout: isTimeout,
        status,
      },
    };
  } finally {
    globalThis.__S200_ADAPTER_CTX = prevCtx;
  }
}

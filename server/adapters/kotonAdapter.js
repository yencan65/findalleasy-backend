// server/adapters/kotonAdapter.js
// ============================================================================
//  KOTON — S5 → S33 ULTRA TITAN FASHION ADAPTER (FINAL)
//  ZERO DELETE — tüm orijinal davranışlar korunur, sadece güçlendirilir.
//  ✔ proxyFetchHTML + axios fallback + anti-bot + anti-hijack
//  ✔ Titan stableId (param-free deterministic)
//  ✔ sanitizePrice → optimizePrice → priceConfidence
//  ✔ ImageVariants S33
//  ✔ fashion vertical sabit sinyal
//  ✔ multi-selector + multi-page S33
//  ✔ qualityScore (fashion-weighted) improved
// ============================================================================

import axios from "axios";
import * as cheerio from "cheerio";

import { proxyFetchHTML } from "../core/proxyEngine.js";
import { sanitizePrice } from "../utils/priceSanitizer.js";
import { optimizePrice } from "../utils/priceFixer.js";
import { buildImageVariants } from "../utils/imageFixer.js";

import {
  loadCheerioS200,
  withTimeout,
  TimeoutError,
  coerceItemsS200,
  normalizeItemS200,
  safeStr,
} from "../core/s200AdapterKit.js";

// ------------------------------------------------------------
// SAFE HELPERS
// ------------------------------------------------------------
function safe(v) {
  return v == null ? "" : String(v).trim();
}

function cleanBotTraps(html) {
  return String(html || "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/cf-browser-verification/gi, "")
    .replace(/cf-error-details/gi, "");
}

// STRONG PRICE PARSER — Titan-safe
function parsePriceStrong(txt) {
  if (!txt) return null;
  try {
    let clean = txt
      .replace(/TL|tl|₺|TRY|KDV|’den|den|başlayan/gi, "")
      .replace(/[^\d.,\-]/g, "")
      .trim();

    if (clean.includes("-")) clean = clean.split("-")[0].trim();

    clean = clean.replace(/\.(?=\d{3})/g, "").replace(",", ".");
    const n = Number(clean);

    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// TITAN deterministic ID
function stableId(provider, title, href) {
  const seed = `${provider}::${safe(title)}::${safe(href)}`;
  return (
    "koton_" +
    Buffer.from(seed)
      .toString("base64")
      .replace(/[^a-zA-Z0-9]/g, "")
      .slice(0, 18)
  );
}

function extractImageStrong($, el) {
  return (
    safe($(el).find("img").attr("data-src")) ||
    safe($(el).find("img").attr("data-original")) ||
    safe($(el).find("img").attr("src")) ||
    safe($(el).find("picture img").attr("src")) ||
    null
  );
}

function detectKotonCategory(title = "") {
  const t = title.toLowerCase();
  if (
    t.includes("kadın") ||
    t.includes("erkek") ||
    t.includes("çocuk") ||
    t.includes("tshirt") ||
    t.includes("t-shirt") ||
    t.includes("pantolon") ||
    t.includes("jean") ||
    t.includes("elbise") ||
    t.includes("dress") ||
    t.includes("çanta") ||
    t.includes("ayakkabı")
  )
    return "fashion";
  return "fashion";
}

function computeQualityScore(item) {
  let s = 0;
  if (item.title) s += 0.45;
  if (item.image) s += 0.35;
  if (item.price != null) s += 0.15;
  s += 0.05;
  return Number(s.toFixed(3));
}

// Normalize URL → Titan param drift önleyici
function normalizeUrl(u) {
  try {
    const url = new URL(u);
    url.search = "";
    return url.toString();
  } catch {
    return u;
  }
}

// Anti-hijack fallback
function safeUrl(u) {
  if (!u) return null;
  try {
    const test = new URL(u);
    if (!test.protocol.startsWith("http")) return null;
    return u;
  } catch {
    return null;
  }
}

const MAX_PAGES = 3;

// ------------------------------------------------------------
// FETCH WRAPPER (S33 grade)
// ------------------------------------------------------------
async function fetchHTML(url, signal) {
  try {
    return await proxyFetchHTML(url, { cache: false });
  } catch {
    try {
      const cfg = {
        timeout: 15000,
        headers: {
          "User-Agent": "Mozilla/5.0 (FindAllEasyBot/33.0)",
        },
      };
      if (signal) cfg.signal = signal;
      const { data } = await axios.get(url, cfg);
      return data;
    } catch {
      return null;
    }
  }
}

// ------------------------------------------------------------
// PAGE SCRAPER — S33 ULTRA TITAN
// ------------------------------------------------------------
async function scrapeKotonPage(query, page = 1, signal = null) {
  try {
    const q = encodeURIComponent(query);
    const url = `https://www.koton.com/search?q=${q}&page=${page}`;

    const html = await fetchHTML(url, signal);
    if (!html) return [];

    const $ = loadCheerioS200(cleanBotTraps(html));
    const items = [];

    const selectors = [
      ".product-card",
      ".product-item",
      ".product",
      ".prd-card",
      ".productCard",
      ".product-box",
      "div[data-product-id]",
    ];

    let found = 0;

    $(selectors.join(", ")).each((i, el) => {
      found++;

      const title =
        safe($(el).find(".product-card__title").text()) ||
        safe($(el).find(".product-name").text()) ||
        safe($(el).find(".product__name").text()) ||
        safe($(el).find(".name").text()) ||
        safe($(el).find("h3").text());

      if (!title) return;

      const priceTxt =
        safe($(el).find(".product-card__price--new").text()) ||
        safe($(el).find(".product-card__price").text()) ||
        safe($(el).find(".product__price").text()) ||
        safe($(el).find(".price").text());

      const parsed = parsePriceStrong(priceTxt);
      const price = sanitizePrice(parsed);

      let href =
        safe($(el).find("a.product-card__link").attr("href")) ||
        safe($(el).find("a").attr("href"));

      if (!href) return;

      if (!href.startsWith("http")) href = "https://www.koton.com" + href;

      href = normalizeUrl(href);
      const finalUrl = safeUrl(href);
      if (!finalUrl) return;

      const imgRaw = extractImageStrong($, el);
      const image = buildImageVariants(imgRaw);

      const category = detectKotonCategory(title);
      const id = stableId("koton", title, finalUrl);

      const base = {
        id,
        title,
        price,
        optimizedPrice:
          price != null ? optimizePrice({ price }, { provider: "koton" }) : null,
        priceConfidence: price != null ? 0.85 : 0.28,

        provider: "koton",
        providerType: "retailer",
        providerFamily: "koton",
        vertical: "fashion",

        rating: null,
        currency: "TRY",
        region: "TR",

        url: finalUrl,
        deeplink: finalUrl,

        image: image.image,
        imageOriginal: image.imageOriginal,
        imageProxy: image.imageProxy,
        hasProxy: image.hasProxy,

        category,
        categoryAI: "fashion",

        raw: { title, priceTxt, href, imgRaw },
      };

      items.push({
        ...base,
        qualityScore: computeQualityScore(base),
      });
    });

    // Titan: Eğer sayfa boş döndüyse kalan sayfaları tarama.
    if (found === 0) return [];

    return items;
  } catch (err) {
    if (err.name === "AbortError") return [];
    return [];
  }
}

// ------------------------------------------------------------
// MAIN ADAPTER — S33 TITAN FINAL
// ------------------------------------------------------------
export async function searchKoton(query, { region = "TR", signal } = {}) {
  try {
    const q = safe(query);
    if (!q) {
      return {
        ok: false,
        adapterName: "koton",
        items: [],
        count: 0,
      };
    }

    let all = [];

    for (let page = 1; page <= MAX_PAGES; page++) {
      const part = await scrapeKotonPage(q, page, signal);
      if (part.length === 0) break;
      all = all.concat(part);
    }

    return {
      ok: true,
      adapterName: "koton",
      items: all,
      count: all.length,
      region,
    };
  } catch (err) {
    if (err.name === "AbortError") {
      return { ok: false, adapterName: "koton", timeout: true, items: [], count: 0 };
    }

    return {
      ok: false,
      adapterName: "koton",
      error: err?.message || "unknown",
      items: [],
      count: 0,
    };
  }
}

// ============================================================================
// S200 WRAPPER — koton (KIT-LOCKED, DRIFT-SAFE)
// Output: { ok, items, count, source, _meta }
// ============================================================================
const S200_PROVIDER_KEY = "koton";
const S200_PROVIDER_FAMILY = "koton";
const S200_VERTICAL = "fashion";
const S200_CATEGORY = "fashion";
const S200_TIMEOUT_MS = (() => {
  const n = Number(process.env.KOTON_TIMEOUT_MS || 5200);
  return Number.isFinite(n) ? Math.max(1500, Math.min(20000, n)) : 5200;
})();

function setS200Ctx(query, url = "") {
  try {
    globalThis.__S200_ADAPTER_CTX = {
      adapter: S200_PROVIDER_KEY,
      providerKey: S200_PROVIDER_KEY,
      query: safeStr(query, 220),
      url: safeStr(url, 900),
    };
  } catch {}
}

async function __koton_S200(query, regionOrOptions = "TR") {
  const opts = typeof regionOrOptions === "object" ? (regionOrOptions || {}) : { region: regionOrOptions };
  const region = (opts.region || "TR").toString();
  const signal = opts.signal;

  const q = safeStr(query, 240);
  setS200Ctx(q);

  if (!q) {
    return {
      ok: true,
      items: [],
      count: 0,
      source: S200_PROVIDER_KEY,
      _meta: { providerKey: S200_PROVIDER_KEY, emptyQuery: true, region },
    };
  }

  try {
    const raw = await withTimeout(Promise.resolve().then(() => searchKoton(q, { region, signal })), S200_TIMEOUT_MS, S200_PROVIDER_KEY);

    // If legacy already signaled an error, keep it observable
    if (raw && typeof raw === "object" && raw.ok === false) {
      return {
        ok: false,
        items: [],
        count: 0,
        source: S200_PROVIDER_KEY,
        _meta: {
          providerKey: S200_PROVIDER_KEY,
          region,
          timeout: !!raw.timeout,
          error: raw.error || raw.message || "legacy_fail",
        },
      };
    }

    const rawItems = coerceItemsS200(raw);
    let dropped = 0;
    const items = [];

    for (const it of rawItems) {
      if (!it) { dropped++; continue; }

      // NO RANDOM ID: always recompute deterministic stableIdS200(providerKey,url,title)
      const clean = { ...it };
      delete clean.id;
      delete clean.listingId;

      // Discovery sources rule compatibility: allow adapter to pass null price; we also sanitize <=0 in kit.
      if (clean.price != null && Number(clean.price) <= 0) clean.price = null;
      if (clean.finalPrice != null && Number(clean.finalPrice) <= 0) clean.finalPrice = null;
      if (clean.optimizedPrice != null && Number(clean.optimizedPrice) <= 0) clean.optimizedPrice = null;

      const norm = normalizeItemS200(
        {
          ...clean,
          providerKey: S200_PROVIDER_KEY,
          providerFamily: S200_PROVIDER_FAMILY,
          vertical: clean.vertical || S200_VERTICAL,
          category: clean.category || S200_CATEGORY,
          region: clean.region || region,
          currency: clean.currency || "TRY",
        },
        S200_PROVIDER_KEY,
        {
          vertical: clean.vertical || S200_VERTICAL,
          category: clean.category || S200_CATEGORY,
          providerFamily: S200_PROVIDER_FAMILY,
          region,
          currency: clean.currency || "TRY",
          titleFallback: "Koton ürünü",
        }
      );

      if (!norm) { dropped++; continue; }
      items.push(norm);
    }

    return {
      ok: true,
      items,
      count: items.length,
      source: S200_PROVIDER_KEY,
      _meta: {
        providerKey: S200_PROVIDER_KEY,
        region,
        rawCount: rawItems.length,
        dropped,
      },
    };
  } catch (e) {
    const timeout = e instanceof TimeoutError || e?.name === "AbortError" || signal?.aborted;
    return {
      ok: false,
      items: [],
      count: 0,
      source: S200_PROVIDER_KEY,
      _meta: {
        providerKey: S200_PROVIDER_KEY,
        region,
        timeout,
        error: e?.message || String(e),
      },
    };
  }
}


export const searchKotonScrape = searchKoton;
export const searchKotonAdapter = __koton_S200;

export default { searchKoton };

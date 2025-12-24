// server/adapters/kigiliAdapter.js
// ============================================================================
//  Kiğılı — S22 → S33 TITAN FINAL ADAPTER
// ----------------------------------------------------------------------------
//  ZERO DELETE — Eski davranış korunur, sadece TITAN modülleri eklendi.
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

// ============================================================================
// HELPERS — S33 LEVEL
// ============================================================================
function safe(v) {
  return v == null ? "" : String(v).trim();
}

// TITAN 2.0 stableId — deterministik, provider-family-safe
function stableId(provider, title, href) {
  const seed = `${provider}::${title}::${href}`;
  return (
    "kigili_" +
    Buffer.from(seed)
      .toString("base64")
      .replace(/[^a-zA-Z0-9]/g, "")
      .slice(0, 16)
  );
}

// Çok güçlü fiyat parser
function parsePriceStrong(txt) {
  if (!txt) return null;

  try {
    let clean = txt
      .replace(/TL|₺|TRY|tl|’den|den|başlayan|Başlayan/gi, "")
      .replace(/[^\d.,\-]/g, "")
      .trim();

    // aralık fiyat → en düşük alınır
    if (clean.includes("-")) clean = clean.split("-")[0].trim();

    clean = clean.replace(/\.(?=\d{3})/g, "").replace(",", ".");
    const n = Number(clean);

    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// TITAN bot-trap cleaner
function cleanBotTraps(html) {
  return String(html || "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<noscript>[\s\S]*?<\/noscript>/gi, "");
}

// Güçlü görsel bulucu
function extractImageStrong($, el) {
  const raw =
    safe($(el).find("img").attr("data-src")) ||
    safe($(el).find("img").attr("data-original")) ||
    safe($(el).find("img").attr("src")) ||
    safe($(el).find("picture img").attr("src"));
  return raw || null;
}

// Kategori — TITAN fashion enforcement
function detectCategory(title = "") {
  return "fashion"; // TITAN: Kiğılı = %100 fashion vertical
}

// TITAN S33 Fashion Quality Score
function computeQualityScore(item) {
  let s = 0;
  if (item.title) s += 0.55;
  if (item.price != null) s += 0.25;
  if (item.image) s += 0.15;
  s += 0.05; // provider bonus
  return Number(s.toFixed(2));
}

// HTML Fetch Wrapper (proxy → axios)
async function fetchHTML(url, signal) {
  try {
    return await proxyFetchHTML(url);
  } catch {
    try {
      const cfg = {
        timeout: 16000,
        headers: { "User-Agent": "Mozilla/5.0 (FindAllEasyBot)" },
      };
      if (signal) cfg.signal = signal;

      const { data } = await axios.get(url, cfg);
      return data;
    } catch {
      return null;
    }
  }
}

const MAX_PAGES = 3;

// ============================================================================
// PAGE SCRAPER — S33 TITAN FINAL
// ============================================================================
async function scrapeKigiliPage(query, page = 1, signal = null) {
  try {
    const q = encodeURIComponent(query);
    const url = `https://www.kigili.com/search?q=${q}&page=${page}`;

    const html = await fetchHTML(url, signal);
    if (!html) return [];

    const $ = loadCheerioS200(cleanBotTraps(html));
    const items = [];

    const selectors = [
      ".product-item",
      ".product-card",
      ".col-6",
      ".col-4",
      ".col-3",
      ".product-list-item",
      ".productItem",
      "div[data-product-id]",
    ];

    $(selectors.join(",")).each((i, el) => {
      const title =
        safe($(el).find(".product-name").text()) ||
        safe($(el).find(".name").text()) ||
        safe($(el).find(".title").text()) ||
        safe($(el).find("h3").text());

      if (!title) return;

      const priceTxt =
        safe($(el).find(".current-price").text()) ||
        safe($(el).find(".product-price").text()) ||
        safe($(el).find(".price").text());

      const strong = parsePriceStrong(priceTxt);
      const price = sanitizePrice(strong);

      let href =
        safe($(el).find("a").attr("href")) ||
        safe($(el).find(".product-link").attr("href"));

      if (!href) return;

      if (!href.startsWith("http")) href = "https://www.kigili.com" + href;

      const imgRaw = extractImageStrong($, el);
      const image = buildImageVariants(imgRaw);

      const id = stableId("kigili", title, href);

      const base = {
        id,
        title,
        price,
        rating: null,

        provider: "kigili",
        providerType: "retailer",
        providerFamily: "kigili",
        vertical: "fashion",

        currency: "TRY",
        region: "TR",

        url: href,
        deeplink: href,

        image: image.image,
        imageOriginal: image.imageOriginal,
        imageProxy: image.imageProxy,
        hasProxy: image.hasProxy,

        category: "fashion",
        categoryAI: "fashion",

        raw: { title, priceTxt, href, imgRaw },
      };

      items.push({
        ...base,
        optimizedPrice:
          price != null
            ? optimizePrice({ price }, { provider: "kigili" })
            : null,
        qualityScore: computeQualityScore(base),
      });
    });

    return items;
  } catch (err) {
    if (err.name === "AbortError") return [];
    return [];
  }
}

// ============================================================================
// MAIN ADAPTER — S33 TITAN FINAL
// ============================================================================
export async function searchKigili(query, { region = "TR", signal } = {}) {
  try {
    const q = safe(query);
    if (!q) {
      return { ok: false, adapterName: "kigili", items: [], count: 0 };
    }

    let all = [];

    for (let page = 1; page <= MAX_PAGES; page++) {
      const part = await scrapeKigiliPage(q, page, signal);
      all = all.concat(part);
    }

    return {
      ok: true,
      adapterName: "kigili",
      items: all,
      count: all.length,
      region,
    };
  } catch (err) {
    if (err.name === "AbortError") {
      return {
        ok: false,
        adapterName: "kigili",
        timeout: true,
        items: [],
        count: 0,
      };
    }

    return {
      ok: false,
      adapterName: "kigili",
      error: err?.message || String(err),
      items: [],
      count: 0,
    };
  }
}

// ============================================================================
// S200 WRAPPER — kigili (KIT-LOCKED, DRIFT-SAFE)
// Output: { ok, items, count, source, _meta }
// ============================================================================
const S200_PROVIDER_KEY = "kigili";
const S200_PROVIDER_FAMILY = "kigili";
const S200_VERTICAL = "fashion";
const S200_CATEGORY = "fashion";
const S200_TIMEOUT_MS = (() => {
  const n = Number(process.env.KIGILI_TIMEOUT_MS || 5200);
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

async function __kigili_S200(query, regionOrOptions = "TR") {
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
    const raw = await withTimeout(Promise.resolve().then(() => searchKigili(q, { region, signal })), S200_TIMEOUT_MS, S200_PROVIDER_KEY);

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
          titleFallback: "Kiğılı ürünü",
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


// Legacy alias — ZERO DELETE
export const searchKigiliScrape = searchKigili;
export const searchKigiliAdapter = __kigili_S200;

export default { searchKigili };

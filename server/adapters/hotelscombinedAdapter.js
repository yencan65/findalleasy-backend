// server/adapters/hotelscombinedAdapter.js
// ============================================================================
//  HotelsCombined — S8 → S33 TITAN FINAL
// ----------------------------------------------------------------------------
//  ZERO DELETE — eski davranış korunur, sadece güçlendirme yapılır
//  ✔ stableId TITAN 2.0
//  ✔ parsePriceStrong → sanitizePrice → optimizePrice
//  ✔ ImageVariants S33
//  ✔ provider meta + categoryAI = "hotel"
//  ✔ vertical = "hotel"
//  ✔ qualityScore (Hotel Model)
//  ✔ signal + timeout tam uyum
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
function safe(t) {
  return t ? String(t).trim() : "";
}

function parsePriceStrong(v) {
  if (!v) return null;
  try {
    let clean = v
      .replace(/TL|₺|TRY|tl|USD|EUR/gi, "")
      .replace(/[^\d.,-]/g, "")
      .trim();

    if (clean.includes("-")) clean = clean.split("-")[0];

    clean = clean.replace(/\.(?=\d{3})/g, "").replace(",", ".");
    const n = Number(clean);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// TITAN stableId 2.0
function stableId(provider, title, href) {
  const seed = `${provider}::${title}::${href}`;
  return (
    "hcomb_" +
    Buffer.from(seed)
      .toString("base64")
      .replace(/[^A-Za-z0-9]/g, "")
      .slice(0, 16)
  );
}

// BotTrap cleaner
function cleanBotTraps(html) {
  return String(html || "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<noscript>[\s\S]*?<\/noscript>/gi, "");
}

// TITAN hotel quality score
function computeQualityScore(item) {
  let s = 0;
  if (item.title) s += 0.55;
  if (item.price != null) s += 0.25;
  if (item.image) s += 0.15;
  s += 0.05; // provider bonus
  return Number(s.toFixed(2));
}

// Fetch wrapper (proxy → axios)
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

// ============================================================================
// MAIN SCRAPER — S33 TITAN FINAL
// ============================================================================
export async function searchHotelsCombined(query, opts = "TR") {
  let region = typeof opts === "string" ? opts : opts.region || "TR";
  const signal = typeof opts === "object" ? opts.signal : null;

  try {
    const url =
      "https://www.hotelscombined.com/Hotel/Search?query=" +
      encodeURIComponent(query);

    const html = await fetchHTML(url, signal);
    if (!html) return [];

    const $ = loadCheerioS200(cleanBotTraps(html));
    const items = [];

    const selectors = [
      ".result-item",
      ".hotel-card",
      ".hotel", 
      "div[data-hotel-id]",
    ];

    $(selectors.join(",")).each((_, el) => {
      const w = $(el);

      const title =
        safe(w.find(".name").text()) ||
        safe(w.find("h3").text()) ||
        safe(w.find(".hotel-name").text());

      if (!title) return;

      const priceTxt =
        safe(w.find(".price").text()) ||
        safe(w.find(".value").text()) ||
        safe(w.find(".hotel-price").text());

      const strong = parsePriceStrong(priceTxt);
      const price = sanitizePrice(strong);

      let href = safe(w.find("a").attr("href"));
      if (!href) return;
      if (!href.startsWith("http"))
        href = "https://www.hotelscombined.com" + href;

      // image
      const imgRaw =
        safe(w.find("img").attr("data-src")) ||
        safe(w.find("img").attr("src")) ||
        null;

      const image = buildImageVariants(imgRaw);

      // stableId
      const id = stableId("hotelscombined", title, href);

      const base = {
        id,
        title,
        price,

        optimizedPrice:
          price != null
            ? optimizePrice({ price }, { provider: "hotelscombined" })
            : null,

        rating: null,

        provider: "hotelscombined",
        providerType: "hotel",
        providerFamily: "hotelscombined",
        vertical: "hotel",

        currency: "TRY",
        region,

        url: href,
        deeplink: href,

        image: image.image,
        imageOriginal: image.imageOriginal,
        imageProxy: image.imageProxy,
        hasProxy: image.hasProxy,

        category: "hotel",
        categoryAI: "hotel",

        raw: { title, href, priceTxt, imgRaw },
      };

      items.push({
        ...base,
        qualityScore: computeQualityScore(base),
      });
    });

    return items;
  } catch (err) {
    if (err.name === "AbortError") return [];
    console.warn("HotelsCombined error:", err.message);
    return [];
  }
}


async function __hotelscombinedRaw(query, opts = "TR") {
  let region = typeof opts === "string" ? opts : opts.region || "TR";
  const signal = typeof opts === "object" ? opts.signal : null;

  try {
    const url =
      "https://www.hotelscombined.com/Hotel/Search?query=" +
      encodeURIComponent(query);

    const html = await fetchHTML(url, signal);
    if (!html) throw new Error("no_html");

    const $ = loadCheerioS200(cleanBotTraps(html));
    const items = [];

    const selectors = [
      ".result-item",
      ".hotel-card",
      ".hotel", 
      "div[data-hotel-id]",
    ];

    $(selectors.join(",")).each((_, el) => {
      const w = $(el);

      const title =
        safe(w.find(".name").text()) ||
        safe(w.find("h3").text()) ||
        safe(w.find(".hotel-name").text());

      if (!title) return;

      const priceTxt =
        safe(w.find(".price").text()) ||
        safe(w.find(".value").text()) ||
        safe(w.find(".hotel-price").text());

      const strong = parsePriceStrong(priceTxt);
      const price = sanitizePrice(strong);

      let href = safe(w.find("a").attr("href"));
      if (!href) return;
      if (!href.startsWith("http"))
        href = "https://www.hotelscombined.com" + href;

      // image
      const imgRaw =
        safe(w.find("img").attr("data-src")) ||
        safe(w.find("img").attr("src")) ||
        null;

      const image = buildImageVariants(imgRaw);

      // stableId
      const id = stableId("hotelscombined", title, href);

      const base = {
        id,
        title,
        price,

        optimizedPrice:
          price != null
            ? optimizePrice({ price }, { provider: "hotelscombined" })
            : null,

        rating: null,

        provider: "hotelscombined",
        providerType: "hotel",
        providerFamily: "hotelscombined",
        vertical: "hotel",

        currency: "TRY",
        region,

        url: href,
        deeplink: href,

        image: image.image,
        imageOriginal: image.imageOriginal,
        imageProxy: image.imageProxy,
        hasProxy: image.hasProxy,

        category: "hotel",
        categoryAI: "hotel",

        raw: { title, href, priceTxt, imgRaw },
      };

      items.push({
        ...base,
        qualityScore: computeQualityScore(base),
      });
    });

    return items;
  } catch (err) { throw err; }
}

// ============================================================================
// S200 WRAPPER — hotelscombined (KIT-LOCKED, DRIFT-SAFE)
// Output: { ok, items, count, source, _meta }
// ============================================================================
const S200_PROVIDER_KEY = "hotelscombined";
const S200_PROVIDER_FAMILY = "hotelscombined";
const S200_VERTICAL = "travel";
const S200_CATEGORY = "hotel";
const S200_TIMEOUT_MS = (() => {
  const n = Number(process.env.HOTELSCOMBINED_TIMEOUT_MS || 6500);
  return Number.isFinite(n) ? Math.max(1500, Math.min(20000, n)) : 6500;
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

async function __hotelscombined_S200(query, regionOrOptions = "TR") {
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
    const raw = await withTimeout(Promise.resolve().then(() => __hotelscombinedRaw(q, { region, signal })), S200_TIMEOUT_MS, S200_PROVIDER_KEY);

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
          titleFallback: "HotelsCombined sonucu",
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


// Legacy aliases — ZERO DELETE
export const searchHotelsCombinedScrape = searchHotelsCombined;
export const searchHotelsCombinedAdapter = __hotelscombined_S200;

export default {
  searchHotelsCombined,
  searchHotelsCombinedScrape,
  searchHotelsCombinedAdapter,
};

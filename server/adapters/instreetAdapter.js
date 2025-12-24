// server/adapters/instreetAdapter.js
// ============================================================================
//  INSTREET — S8 → S33 TITAN FASHION ADAPTER (FINAL)
// ----------------------------------------------------------------------------
//  ZERO DELETE — eski davranış bozulmaz, S33 katmanları eklenir
//
//  ✔ proxyFetchHTML fallback + anti-bot + delay jitter
//  ✔ Titan stableId (param-free deterministic)
//  ✔ strongPrice → sanitizePrice → optimizePrice → priceConfidence
//  ✔ ImageVariants S33 (image, imageOriginal, imageProxy, hasProxy)
//  ✔ providerType / providerFamily / vertical = "fashion"
//  ✔ categoryAI = "fashion"
//  ✔ strong selectors + multi-selector fallback
//  ✔ Titan item format (ok, items[], count)
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
// HELPERS
// ------------------------------------------------------------
const wait = (ms) => new Promise((res) => setTimeout(res, ms));

function clean(v) {
  return String(v || "").replace(/\s+/g, " ").trim();
}

function parsePriceStrong(txt) {
  if (!txt) return null;

  try {
    let c = txt
      .replace(/TL|tl|₺|TRY/gi, "")
      .replace(/[^\d.,\-]/g, "")
      .trim();

    if (c.includes("-")) c = c.split("-")[0].trim();

    c = c.replace(/\.(?=\d{3})/g, "").replace(",", ".");
    const n = Number(c);

    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// TITAN deterministic stableId
function stableId(provider, title, url) {
  const seed = `${provider}::${clean(title)}::${clean(url)}`;
  return (
    "instreet_" +
    Buffer.from(seed)
      .toString("base64")
      .replace(/[^a-zA-Z0-9]/g, "")
      .slice(0, 18)
  );
}

// anti-bot HTML temizliği
function cleanBot(html) {
  return String(html || "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/cf-browser-verification/gi, "");
}

// URL safety
function safeUrl(u) {
  if (!u) return null;
  try {
    const x = new URL(u);
    if (!x.protocol.startsWith("http")) return null;
    return u;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------
// FETCH WRAPPER — S33 (proxy → axios fallback)
// ------------------------------------------------------------
async function fetchHTML(url, signal) {
  try {
    return await proxyFetchHTML(url, { cache: false });
  } catch {
    try {
      const { data } = await axios.get(url, {
        timeout: 15000,
        signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (FindAllEasyBot/33.0)",
          "Accept-Language": "tr-TR,tr;q=0.9",
        },
      });
      return data;
    } catch {
      return null;
    }
  }
}

// ------------------------------------------------------------
// MAIN S33 SCRAPER
// ------------------------------------------------------------
export async function searchInStreetLegacy(
  query,
  regionOrOptions = "TR",
  signal = null
) {
  let region = "TR";

  if (typeof regionOrOptions === "object") {
    region = regionOrOptions.region || "TR";
    if (!signal && regionOrOptions.signal) signal = regionOrOptions.signal;
  } else if (typeof regionOrOptions === "string") {
    region = regionOrOptions;
  }

  const q = encodeURIComponent(query);
  const url = `https://www.instreet.com.tr/arama?q=${q}`;

  try {
    await wait(160);

    const html = await fetchHTML(url, signal);
    if (!html) {
      return {
        ok: false,
        adapterName: "instreet",
        items: [],
        count: 0,
        error: "no-html",
      };
    }

    const $ = loadCheerioS200(cleanBot(html));
    const items = [];

    const selectors = [
      ".productItem",
      ".product-item",
      ".product-card",
      "li.product",
      "div[data-product-id]",
      ".prd",
      ".prd-card",
    ];

    $(selectors.join(", ")).each((i, el) => {
      const root = $(el);

      const title =
        clean(
          root.find(".productName, .name, .product-name").first().text()
        ) || null;

      if (!title) return;

      const priceTxt =
        clean(
          root
            .find(
              ".productPrice, .price, .discountedPrice, .current-price, .prd-price"
            )
            .first()
            .text()
        ) || null;

      const strong = parsePriceStrong(priceTxt);
      const price = sanitizePrice(strong);

      let href =
        root.find("a").attr("href") ||
        root.find("a.product-link").attr("href") ||
        null;

      if (!href) return;

      if (!href.startsWith("http"))
        href = `https://www.instreet.com.tr${href}`;

      href = safeUrl(href);
      if (!href) return;

      const imgRaw =
        root.find("img").attr("src") ||
        root.find("img").attr("data-src") ||
        null;

      const image = buildImageVariants(imgRaw);

      const id = stableId("instreet", title, href);

      const base = {
        id,
        title,
        price,
        optimizedPrice:
          price != null
            ? optimizePrice({ price }, { provider: "instreet" })
            : null,

        priceConfidence: price != null ? 0.85 : 0.25,

        provider: "instreet",
        providerType: "retailer",
        providerFamily: "instreet",
        vertical: "fashion",

        rating: null,
        currency: "TRY",
        region,

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
        qualityScore:
          (title ? 0.45 : 0) +
          (image.image ? 0.35 : 0) +
          (price != null ? 0.15 : 0) +
          0.05,
      });
    });

    return {
      ok: true,
      adapterName: "instreet",
      items,
      count: items.length,
    };
  } catch (err) {
    if (signal?.aborted) {
      return {
        ok: false,
        adapterName: "instreet",
        timeout: true,
        items: [],
        count: 0,
      };
    }

    return {
      ok: false,
      adapterName: "instreet",
      error: err?.message || "unknown",
      items: [],
      count: 0,
    };
  }
}

// ============================================================================
// S200 WRAPPER — instreet (KIT-LOCKED, DRIFT-SAFE)
// Output: { ok, items, count, source, _meta }
// ============================================================================
const S200_PROVIDER_KEY = "instreet";
const S200_PROVIDER_FAMILY = "instreet";
const S200_VERTICAL = "fashion";
const S200_CATEGORY = "fashion";
const S200_TIMEOUT_MS = (() => {
  const n = Number(process.env.INSTREET_TIMEOUT_MS || 5500);
  return Number.isFinite(n) ? Math.max(1500, Math.min(20000, n)) : 5500;
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

async function __instreet_S200(query, regionOrOptions = "TR") {
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
    const raw = await withTimeout(Promise.resolve().then(() => searchInStreetLegacy(q, { region, signal })), S200_TIMEOUT_MS, S200_PROVIDER_KEY);

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
          titleFallback: "InStreet ürünü",
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

export async function searchInStreetAdapter(query, regionOrOptions = "TR", signal = null) {
  const opts = typeof regionOrOptions === "object" ? (regionOrOptions || {}) : { region: regionOrOptions };
  if (!opts.signal && signal) opts.signal = signal;
  return __instreet_S200(query, opts);
}



export const searchInStreetScrape = searchInStreetLegacy;

export const searchInStreet = searchInStreetAdapter;
export default { searchInStreetAdapter };

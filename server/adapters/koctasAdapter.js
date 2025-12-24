// server/adapters/koctasAdapter.js
// ============================================================================
//  Koçtaş Adapter — S5 → S22 ULTRA TITAN
// ----------------------------------------------------------------------------
//  ZERO DELETE: Eski işlevler duruyor ama Titan güçlendirmeleri eklendi
//  ✔ proxyFetchHTML + axios fallback + botTrap cleaner
//  ✔ deterministic stableId (Titan Merge uyumlu)
//  ✔ parsePriceStrong → sanitizePrice → optimizePrice
//  ✔ ImageVariants S22
//  ✔ provider meta + categoryAI
//  ✔ qualityScore
//  ✔ multi-selector + multi-page
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
function safe(v) {
  return v == null ? "" : String(v).trim();
}

function parsePriceStrong(txt) {
  if (!txt) return null;
  try {
    let clean = txt
      .replace(/TL|tl|₺|TRY|’den|den|başlayan|Başlayan/gi, "")
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

function cleanBotTraps(html) {
  return String(html || "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
}

// stableId — Titan Merge
function stableId(provider, title, href) {
  const seed = `${provider}::${title}::${href}`;
  return "koctas_" + Buffer.from(seed).toString("base64").slice(0, 14);
}

function extractImageStrong($, el) {
  const raw =
    safe($(el).find("img").attr("data-src")) ||
    safe($(el).find("img").attr("data-original")) ||
    safe($(el).find("img").attr("src")) ||
    safe($(el).find("picture img").attr("src"));
  return raw || null;
}

function detectCategory(title = "") {
  const t = title.toLowerCase();

  if (
    t.includes("vida") ||
    t.includes("matkap") ||
    t.includes("şarjlı") ||
    t.includes("tornavida") ||
    t.includes("alet") ||
    t.includes("hırdavat") ||
    t.includes("çekiç") ||
    t.includes("tester")
  )
    return "repair";

  if (
    t.includes("dolap") ||
    t.includes("raf") ||
    t.includes("masa") ||
    t.includes("koltuk") ||
    t.includes("mobilya")
  )
    return "home";

  return "product";
}

function computeQualityScore(item) {
  let s = 0;
  if (item.title) s += 0.4;
  if (item.price != null) s += 0.35;
  if (item.image) s += 0.15;
  if (item.provider) s += 0.1;
  return Number(s.toFixed(2));
}

async function fetchHTML(url, signal) {
  try {
    return await proxyFetchHTML(url);
  } catch {
    try {
      const cfg = {
        timeout: 5200,
        headers: { "User-Agent": "Mozilla/5.0" },
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

// ------------------------------------------------------------
// PAGE SCRAPER — S22 TITAN
// ------------------------------------------------------------
async function scrapeKoctasPage(query, page = 1, signal = null) {
  try {
    const q = encodeURIComponent(query);
    const url = `https://www.koctas.com.tr/search?q=${q}&page=${page}`;

    const html = await fetchHTML(url, signal);
    if (!html) return [];

    const $ = loadCheerioS200(cleanBotTraps(html));
    const items = [];

    const selectors = [
      ".productListing__item",
      ".product-card",
      ".productItem",
      "div[data-product-id]",
      "li.productListing__item",
      "div.productListing__item",
      ".product-box",
    ];

    $(selectors.join(", ")).each((i, el) => {
      const title =
        safe($(el).find(".productListing__productName").text()) ||
        safe($(el).find(".product-name").text()) ||
        safe($(el).find(".name").text()) ||
        safe($(el).find("h3").text());

      if (!title) return;

      const priceTxt =
        safe($(el).find(".productListing__price--new").text()) ||
        safe($(el).find(".productListing__price").text()) ||
        safe($(el).find(".price").text());

      const strong = parsePriceStrong(priceTxt);
      const price = sanitizePrice(strong);

      let href =
        safe($(el).find("a.productListing__itemLink").attr("href")) ||
        safe($(el).find("a").attr("href"));

      if (!href) return;
      if (!href.startsWith("http"))
        href = "https://www.koctas.com.tr" + href;

      const imgRaw = extractImageStrong($, el);
      const image = buildImageVariants(imgRaw);

      const id = stableId("koctas", title, href);
      const category = detectCategory(title);

      const base = {
        id,
        title,
        price,
        rating: null,

        provider: "koctas",
        providerType: "retailer",
        providerFamily: "koctas",
        vertical: "home_improvement",

        currency: "TRY",
        region: "TR",

        url: href,
        deeplink: href,

        image: image.image,
        imageOriginal: image.imageOriginal,
        imageProxy: image.imageProxy,
        hasProxy: image.hasProxy,

        category,
        categoryAI:
          category === "repair"
            ? "repair"
            : category === "home"
            ? "home_improvement"
            : "product",

        raw: { title, priceTxt, href, imgRaw },
      };

      items.push({
        ...base,
        optimizedPrice:
          price != null ? optimizePrice({ price }, { provider: "koctas" }) : null,
        qualityScore: computeQualityScore(base),
      });
    });

    return items;
  } catch (err) {
    if (err.name === "AbortError") {
      console.warn("⛔ Koçtaş → Abort edildi (signal)");
      return [];
    }
    console.warn("Koçtaş scrape hata:", err.message);
    return [];
  }
}

// ------------------------------------------------------------
// MAIN ADAPTER — S22 UYUMLU
// ------------------------------------------------------------
export async function searchKoctas(query, { region = "TR", signal } = {}) {
  try {
    const q = safe(query);
    if (!q) {
      return { ok: false, adapterName: "koctas", items: [], count: 0 };
    }

    let all = [];

    for (let p = 1; p <= MAX_PAGES; p++) {
      const part = await scrapeKoctasPage(q, p, signal);
      all = all.concat(part);
    }

    return {
      ok: true,
      adapterName: "koctas",
      items: all,
      count: all.length,
      region,
    };
  } catch (err) {
    if (err.name === "AbortError") {
      return {
        ok: false,
        adapterName: "koctas",
        timeout: true,
        items: [],
        count: 0,
      };
    }

    console.warn("searchKoctas hata:", err.message);

    return {
      ok: false,
      adapterName: "koctas",
      error: err?.message || "unknown",
      items: [],
      count: 0,
    };
  }
}

// ============================================================================
// S200 WRAPPER — koctas (KIT-LOCKED, DRIFT-SAFE)
// Output: { ok, items, count, source, _meta }
// ============================================================================
const S200_PROVIDER_KEY = "koctas";
const S200_PROVIDER_FAMILY = "koctas";
const S200_VERTICAL = "home_improvement";
const S200_CATEGORY = "home_improvement";
const S200_TIMEOUT_MS = (() => {
  const n = Number(process.env.KOCTAS_TIMEOUT_MS || 6000);
  return Number.isFinite(n) ? Math.max(1500, Math.min(20000, n)) : 6000;
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

async function __koctas_S200(query, regionOrOptions = "TR") {
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
    const raw = await withTimeout(Promise.resolve().then(() => searchKoctas(q, { region, signal })), S200_TIMEOUT_MS, S200_PROVIDER_KEY);

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
          titleFallback: "Koçtaş ürünü",
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


export const searchKoctasScrape = searchKoctas;
export const searchKoctasAdapter = __koctas_S200;

export default { searchKoctas };

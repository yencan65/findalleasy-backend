// ============================================================================
//  LETGO CAR — S22 ULTRA TITAN ADAPTER (FINAL VERSION)
// ----------------------------------------------------------------------------
//  ZERO DELETE — Eski S5 fonksiyonları korunur, üstüne Titan Mimari eklenir
// ----------------------------------------------------------------------------
//  • proxyFetchHTML anti-bot bypass + script cleaner
//  • stableId (Titan Merge Engine uyumlu)
//  • strongPriceParser + sanitizePrice + optimizePrice
//  • ImageVariants S22 (image,imageOriginal,imageProxy,hasProxy)
//  • categoryAI("car_rental") + provider meta
//  • geoSignal → BEST kart + Vitrin öğrenmesi
//  • qualityScore (görsel + fiyat + başlık ağırlıklı)
//  • multi-page + multi-selector (yeni Letgo DOM destekli)
// ============================================================================

import axios from "axios";
import * as cheerio from "cheerio";

import { proxyFetchHTML } from "../core/proxyEngine.js";
import { sanitizePrice } from "../utils/priceSanitizer.js";
import { optimizePrice } from "../utils/priceFixer.js";
import { buildImageVariants } from "../utils/imageFixer.js";

import { coerceItemsS200, fixKey, loadCheerioS200, normalizeItemS200, withTimeout } from "../core/s200AdapterKit.js";

// ---------------------------------------------------------------------------
// STUB POLICY (HARD)
// - PROD: stubs/mocks/fallback listings are BLOCKED (NO FAKE RESULTS)
// - DEV: allow via FINDALLEASY_ALLOW_STUBS=1
// ---------------------------------------------------------------------------
const FINDALLEASY_ALLOW_STUBS = String(process.env.FINDALLEASY_ALLOW_STUBS || "") === "1";


// ------------------------------------------------------------
// HELPERS
// ------------------------------------------------------------
const safe = (v) => (v == null ? "" : String(v).trim());

// Titan Merge uyumlu stableId
function stableId(provider, url, i = 0) {
  const seed = `${provider}::${url}::${i}`;
  return "letgo_car_" + Buffer.from(seed).toString("base64").slice(0, 14);
}

// Eski raw parser (ZERO DELETE için korunuyor)
function parsePriceRaw(txt) {
  if (!txt) return null;
  return Number(txt.replace(/[^\d]/g, "")) || null;
}

// S22 – Strong price parser (TR format + aralıklar)
function parsePriceStrong(txt) {
  if (!txt) return null;
  try {
    let clean = String(txt)
      .replace(/TL|tl|₺|’den|den|başlayan|baslayan|₺/gi, "")
      .replace(/[^\d.,\-]/g, "")
      .trim();

    // Aralık ise ilk değeri al
    if (clean.includes("-")) {
      clean = clean.split("-")[0].trim();
    }

    clean = clean
      .replace(/\.(?=\d{3})/g, "") // 1.250.000 → 1250000
      .replace(",", ".");

    const n = Number(clean);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// Anti-bot / trap script temizleyici
function cleanBotTraps(html) {
  if (!html) return "";
  return String(html)
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
}

// GEO sinyal (BEST kart & vitrin öğrenmesi için)
function extractGeoSignal(title = "") {
  const t = title.toLowerCase();
  const cities = [
    "istanbul",
    "ankara",
    "izmir",
    "antalya",
    "bursa",
    "adana",
    "gaziantep",
    "konya",
    "mersin",
    "kayseri",
    "eskişehir",
    "eskisehir",
    "trabzon",
    "samsun",
    "muğla",
    "mugla",
    "bodrum",
    "diyarbakır",
    "diyarbakir",
  ];
  return cities.find((c) => t.includes(c)) || null;
}

// QualityScore — başlık + fiyat + görsel ağırlıklı
function computeQualityScore(item) {
  let s = 0;
  if (item.title && item.title.length > 5) s += 0.35;
  if (item.price != null) s += 0.35;
  if (item.image) s += 0.30;
  return Number(s.toFixed(2));
}

// Görsel çıkarma (src, data-src, srcset, data-srcset)
function extractImageUrl(wrap) {
  const img = wrap.find("img").first();
  if (!img || !img.length) return null;

  const direct =
    img.attr("src") ||
    img.attr("data-src") ||
    img.attr("data-original") ||
    img.attr("data-image");

  let srcset = img.attr("srcset") || img.attr("data-srcset") || "";
  if (srcset) {
    // "url1 320w, url2 640w" → son url
    const parts = srcset.split(",").map((p) => p.trim());
    const last = parts[parts.length - 1] || "";
    const url = last.split(" ")[0];
    if (url) return url;
  }

  return direct || null;
}

// ------------------------------------------------------------
// SELECTORS — Letgo DOM sık değişir (eski + yeni)
// ------------------------------------------------------------
const SELECTORS = [
  ".ListingCard__Card-sc-__sc-1xf18x6-1",
  ".AdCardstyled__Container-sc-1h260jj-0",
  ".card",
  ".listing-card",
  "[data-testid='ad-card']",
  "[data-test-id='tile']",
  "[data-test-id='listing-feed-item']",
];

const MAX_PAGES = 2;

// ------------------------------------------------------------
// TITAN SCRAPER — proxy + cheerio + multi-selector
// ------------------------------------------------------------
async function titanScrapeLetgoCars(query, region, signal) {
  const all = [];
  const q = encodeURIComponent(query);

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `https://www.letgo.com/tr-tr/ads?q=${q}&page=${page}`;
    let html = null;

    // 1) Proxy anti-bot bypass
    try {
      html = await proxyFetchHTML(url);
    } catch {
      // Proxy fail → doğrudan istek
      try {
        const axiosConfig = {
          timeout: 17000,
          headers: {
            "User-Agent": "Mozilla/5.0 (FindAllEasy-S22)",
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
            "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.8",
          },
        };
        if (signal) axiosConfig.signal = signal;

        const { data } = await axios.get(url, axiosConfig);
        html = data;
      } catch {
        // Proxy de axios da çökerse — tek fallback kart
        return [
          {
            provider: "letgo_car",
            providerType: "marketplace",
            providerFamily: "letgo",
            vertical: "car",

            title: "Letgo araç sonuçlarına erişilemedi",
            price: null,
            optimizedPrice: null,
            category: "car_rental",
            categoryAI: "car_rental",
            region,
            currency: "TRY",

            geoSignal: null,
            qualityScore: 0,
            fallback: true,
          },
        ];
      }
    }

    // Anti-bot script temizliği
    html = cleanBotTraps(html);
    const $ = loadCheerioS200(html);

    $(SELECTORS.join(",")).each((i, el) => {
      const wrap = $(el);

      const title =
        safe(wrap.find("h2").text()) ||
        safe(wrap.find(".title").text()) ||
        safe(wrap.find(".ListingCard__Title").text()) ||
        safe(wrap.attr("title"));

      if (!title) return;

      const priceTxt =
        safe(wrap.find(".price").text()) ||
        safe(wrap.find(".ListingCard__Price").text()) ||
        safe(wrap.find("[data-test-id='price']").text());

      const strongParsed = parsePriceStrong(priceTxt);
      const rawParsed = parsePriceRaw(priceTxt);

      const priceSanitized = sanitizePrice(
        strongParsed != null ? strongParsed : rawParsed
      );

      const price =
        priceSanitized != null
          ? priceSanitized
          : strongParsed != null
          ? strongParsed
          : rawParsed;

      const optimizedPrice = optimizePrice(
        { price },
        { provider: "letgo_car" }
      );

      // URL
      let href =
        wrap.find("a").attr("href") ||
        wrap.find(".ListingCard__Link").attr("href") ||
        wrap.attr("href");

      if (!href) return;
      if (!href.startsWith("http")) {
        href = "https://www.letgo.com" + href;
      }

      // Görsel
      const imgRaw = extractImageUrl(wrap);
      const image = buildImageVariants(imgRaw);

      const id = stableId("letgo_car", href, all.length);
      const geoSignal = extractGeoSignal(title);

      const itemBase = {
        id,
        provider: "letgo_car",
        providerType: "marketplace",
        providerFamily: "letgo",
        vertical: "car",

        source: "letgo",
        title,

        price,
        optimizedPrice,

        category: "car_rental",
        categoryAI: "car_rental",
        geoSignal,

        rating: null,
        currency: "TRY",
        region,

        url: href,
        deeplink: href,

        image: image.image,
        imageOriginal: image.imageOriginal,
        imageProxy: image.imageProxy,
        hasProxy: image.hasProxy,

        fallback: false,

        raw: { title, priceTxt, href, imgRaw },
      };

      const qualityScore = computeQualityScore({
        title: itemBase.title,
        price: itemBase.price,
        image: itemBase.image,
      });

      all.push({
        ...itemBase,
        qualityScore,
      });
    });
  }

  // Titan guard — hiçbir ürün yoksa tek fallback kart
  if (all.length === 0) {
    return [
      {
        provider: "letgo_car",
        providerType: "marketplace",
        providerFamily: "letgo",
        vertical: "car",

        title: `Letgo araç sonuç bulunamadı (${query})`,
        price: null,
        optimizedPrice: null,
        category: "car_rental",
        categoryAI: "car_rental",
        region,
        currency: "TRY",

        geoSignal: null,
        qualityScore: 0,
        fallback: true,
      },
    ];
  }

  return all;
}

// ------------------------------------------------------------
// PUBLIC ADAPTER — S22 FORMAT
// ------------------------------------------------------------
async function searchLetgoCarAdapterLegacy(query, regionOrOptions = "TR") {
  const region =
    typeof regionOrOptions === "string"
      ? regionOrOptions
      : regionOrOptions.region || "TR";

  const signal =
    typeof regionOrOptions === "object" ? regionOrOptions.signal : null;

  try {
    const items = await titanScrapeLetgoCars(
      query,
      region.toUpperCase(),
      signal
    );

    return {
      ok: true,
      adapterName: "letgo_car",
      items,
      count: items.length,
    };
  } catch (err) {
    return {
      ok: false,
      adapterName: "letgo_car",
      items: [],
      count: 0,
      error: err?.message || "unknown",
    };
  }
}

// Eski export uyumları (silinmeden)

// ============================================================================
// S200 WRAPPER — FINAL (KIT-LOCKED, DRIFT-SAFE)
// Output: { ok, items, count, source, _meta }
// ============================================================================

function _s200ResolveRegionSignal(regionOrOptions, fallbackRegion = "TR") {
  let region = fallbackRegion;
  let signal = null;

  if (typeof regionOrOptions === "string") {
    region = regionOrOptions || fallbackRegion;
  } else if (regionOrOptions && typeof regionOrOptions === "object") {
    region = regionOrOptions.region || regionOrOptions.locale || fallbackRegion;
    signal = regionOrOptions.signal || null;
  }

  return { region: String(region || fallbackRegion).toUpperCase(), signal };
}

function _s200IsTimeout(e) {
  const n = String(e?.name || "").toLowerCase();
  const m = String(e?.message || "").toLowerCase();
  return n.includes("timeout") || m.includes("timed out");
}

function _s200IsFake(it) {
  if (!it || typeof it !== "object") return false;
  if (it.fallback === true || it.mock === true) return true;

  const u = String(it.affiliateUrl || it.deeplink || it.finalUrl || it.originUrl || it.url || "");
  if (!u) return false;

  if (u.includes("findalleasy.com/mock")) return true;
  return false;
}

// --------------------------------------------------------------------------------
// S200 WRAPPER — NO FAKE / NO CRASH / NO DRIFT
// --------------------------------------------------------------------------------
export async function searchLetgoCarAdapter(q, opts = {}) {
  const startedAt = Date.now();
  const query = String(q ?? "").trim();
  const region = String(opts?.region ?? "TR");

  // empty/too-short query: return empty-state (NOT an error)
  if (!query || query.length < 2) {
    return {
      ok: true,
      items: [],
      count: 0,
      source: "letgo_car",
      _meta: { emptyQuery: true, providerKey: "letgo_car", region, tookMs: Date.now() - startedAt }
    };
  }

  try {
    // global context (some scrapers look at this; harmless otherwise)
    globalThis.__S200_ADAPTER_CTX = {
      adapter: "letgo_car",
      providerKey: "letgo_car",
      source: "letgo_car",
      region,
    };

    const raw = await withTimeout(
      () => searchLetgoCar(query, opts),
      Number(opts?.timeoutMs ?? 6500),
      "letgo_car"
    );

    const arr = coerceItemsS200(raw);
    const items = [];
    for (const it of arr) {
      const norm = normalizeItemS200(it, { providerKey: "letgo_car", region });
      if (!norm?.title || !norm?.url) continue;

      if (!norm.id) norm.id = stableId("letgo_car", norm.url, norm.title);
      norm.providerKey = fixKey(norm.providerKey || "letgo_car");

      items.push(norm);
    }

    return {
      ok: true,
      items,
      count: items.length,
      source: "letgo_car",
      _meta: {
        providerKey: "letgo_car",
        region,
        tookMs: Date.now() - startedAt
      }
    };
  } catch (e) {
    const msg = String(e?.message || e || "Unknown error");
    const timeout = e?.name === "TimeoutError" || /timeout/i.test(msg);

    return {
      ok: false,
      items: [],
      count: 0,
      source: "letgo_car",
      _meta: {
        providerKey: "letgo_car",
        region,
        timeout,
        error: msg,
        name: e?.name,
        tookMs: Date.now() - startedAt
      }
    };
  }
}


export default {
  searchLetgoCarAdapter,
  searchLetgoCarAdapterLegacy
};

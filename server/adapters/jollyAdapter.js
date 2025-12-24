// server/adapters/jollyAdapter.js
// ============================================================================
//  JOLLY TUR — S5 → S33 TITAN FINAL ADAPTER
// ----------------------------------------------------------------------------
//  ZERO DELETE — tüm eski fonksiyonlar korunur
//  ✔ proxyFetchHTML fallback (anti bot-trap + region-safe fetch)
//  ✔ Titan deterministic stableId
//  ✔ S33 ImageVariants
//  ✔ Ultra selectors (9 katman + hijack koruması)
//  ✔ Affiliate V8.2 (tam güvenli injection)
//  ✔ Travel vertical sabit sinyal + categoryAI
//  ✔ S33 qualityScore
// ============================================================================

import axios from "axios";
import * as cheerio from "cheerio";
import { proxyFetchHTML } from "../core/proxyEngine.js";
import { buildImageVariants } from "../utils/imageFixer.js";

import {
  loadCheerioS200,
  withTimeout,
  TimeoutError,
  coerceItemsS200,
  normalizeItemS200,
  safeStr,
} from "../core/s200AdapterKit.js";

// ===================================================================
// HELPERS
// ===================================================================
function safe(v) {
  return v == null ? "" : String(v).trim();
}

function parsePrice(txt) {
  if (!txt) return null;
  try {
    const cleaned = txt
      .replace(/[^\d.,]/g, "")
      .replace(/\.(?=\d{3})/g, "")
      .replace(",", ".");
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function detectCategory(title = "") {
  const t = title.toLowerCase();
  if (t.includes("otel") || t.includes("hotel") || t.includes("resort"))
    return "hotel";
  if (t.includes("tur") || t.includes("tour") || t.includes("paket"))
    return "tour";
  return "travel";
}

// CategoryAI = aynı sinyal (Titan)
function detectCategoryAI(title = "") {
  return detectCategory(title);
}

// TITAN-STABLE ID (daha deterministik)
function stableIdJolly(url, title) {
  const seed = `${safe(url)}::${safe(title)}`;
  return (
    "jolly_" +
    Buffer.from(seed)
      .toString("base64")
      .replace(/[^a-zA-Z0-9]/g, "")
      .slice(0, 18)
  );
}

function computeQualityScore(item) {
  let s = 0;
  if (item.title) s += 0.40;
  if (item.image) s += 0.30;
  if (item.price != null) s += 0.20;
  s += 0.10; // travel provider bonus
  return Number(s.toFixed(3));
}

// ===================================================================
// ENV (Affiliate)
// ===================================================================
const AFF_ID = process.env.JOLLY_AFFILIATE_ID || "";
const CAMP_ID = process.env.JOLLY_CAMPAIGN_ID || "";
const SUBKEY = process.env.JOLLY_SUBID_KEY || "subid";

const BASE = process.env.JOLLY_BASE_URL || "https://www.jollytur.com";
const REDIRECT = process.env.JOLLY_AFFILIATE_REDIRECT || "";

// ===================================================================
// AFFILIATE BUILDER — V8.2
// ===================================================================
function buildAffiliateUrl(url) {
  if (!url) return url;

  try {
    if (REDIRECT) {
      return `${REDIRECT}${encodeURIComponent(url)}&${SUBKEY}=${AFF_ID}`;
    }
    const u = new URL(url);
    if (AFF_ID) u.searchParams.set(SUBKEY, AFF_ID);
    if (CAMP_ID) u.searchParams.set("cid", CAMP_ID);
    return u.toString();
  } catch {
    return url;
  }
}

// ===================================================================
// S5 NORMALIZER (zero delete)
// ===================================================================
function normalizeAdapterItem(raw = {}) {
  return {
    id: raw.id || raw.url || null,
    title: raw.title || "",
    price: raw.price != null ? Number(raw.price) : null,
    rating: raw.rating ?? null,
    provider: "jolly",
    currency: "TRY",
    region: raw.region || "TR",
    category: raw.category || "travel",
    url: raw.url || null,
    image: raw.image || null,
    adapterSource: "jollytur",
    raw,
  };
}

// ===================================================================
// FETCH WRAPPER — Proxy → Axios fallback
// ===================================================================
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
          Referer: BASE,
        },
      });
      return data;
    } catch {
      return null;
    }
  }
}

// ===================================================================
// MAIN SCRAPER — S33 TITAN
// ===================================================================
export async function searchJollyTur(query, { region = "TR", signal } = {}) {
  try {
    const q = encodeURIComponent(query);
    const url = `${BASE}/arama?q=${q}`;

    const html = await fetchHTML(url, signal);
    if (!html) {
      return { ok: true, adapterName: "jollytur", items: [], count: 0 };
    }

    const $ = loadCheerioS200(html);
    const items = [];

    // Ultra selector set — kırılması zor 9 seviye
    const selectors = [
      ".hotel-item",
      ".tour-box",
      ".package-item",
      ".result-item",
      "[data-hotel-id]",
      "[class*='tour']",
      ".product-card",
      ".search-result-item",
      ".box, .item",
    ];

    $(selectors.join(",")).each((i, el) => {
      try {
        const wrap = $(el);

        const title =
          safe(wrap.find(".hotel-name").text()) ||
          safe(wrap.find(".tour-name").text()) ||
          safe(wrap.find(".package-name").text()) ||
          safe(wrap.find(".title").text());

        if (!title) return;

        const priceTxt =
          safe(wrap.find(".price").text()) ||
          safe(wrap.find(".amount").text()) ||
          safe(wrap.find(".price-info").text());

        const price = parsePrice(priceTxt);

        let href = safe(wrap.find("a").attr("href"));
        if (!href) return;
        if (!href.startsWith("http")) href = BASE + href;

        const idSeedUrl = href;
        const finalUrl = buildAffiliateUrl(href);

        const imgRaw =
          wrap.find("img").attr("data-src") ||
          wrap.find("img").attr("src") ||
          wrap.find("img").attr("data-original") ||
          wrap.find("source").attr("srcset") ||
          null;

        const image = buildImageVariants(imgRaw);

        const category = detectCategory(title);
        const categoryAI = detectCategoryAI(title);

        const base = {
          id: stableIdJolly(idSeedUrl, title),
          title,
          price,
          optimizedPrice: price ?? null,
          priceConfidence: price != null ? 0.9 : 0.4,

          rating: null,

          provider: "jolly",
          providerType: "travel",
          providerFamily: "jollytur",
          vertical: "travel",

          currency: "TRY",
          region,

          category,
          categoryAI,

          url: finalUrl,
          deeplink: finalUrl,

          image: image.image,
          imageOriginal: image.imageOriginal,
          imageProxy: image.imageProxy,
          hasProxy: image.hasProxy,

          adapterSource: "jollytur",
          raw: { title, priceTxt, href: idSeedUrl, imgRaw },
        };

        items.push({
          ...base,
          qualityScore: computeQualityScore(base),
        });
      } catch (blockErr) {
        console.warn("⚠️ Jolly block error:", blockErr?.message);
      }
    });

    return {
      ok: true,
      adapterName: "jollytur",
      items,
      count: items.length,
    };
  } catch (err) {
    if (err.name === "AbortError") {
      return {
        ok: false,
        adapterName: "jollytur",
        timeout: true,
        items: [],
        count: 0,
      };
    }

    console.warn("⚠️ JollyTur error:", err?.message || err);

    return {
      ok: false,
      adapterName: "jollytur",
      error: err?.message || "unknown",
      items: [],
      count: 0,
    };
  }
}

// ============================================================================
// S200 WRAPPER — jollytur (KIT-LOCKED, DRIFT-SAFE)
// Output: { ok, items, count, source, _meta }
// ============================================================================
const S200_PROVIDER_KEY = "jollytur";
const S200_PROVIDER_FAMILY = "jollytur";
const S200_VERTICAL = "travel";
const S200_CATEGORY = "travel";
const S200_TIMEOUT_MS = (() => {
  const n = Number(process.env.JOLLY_TIMEOUT_MS || 6200);
  return Number.isFinite(n) ? Math.max(1500, Math.min(20000, n)) : 6200;
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

async function __jollytur_S200(query, regionOrOptions = "TR") {
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
    const raw = await withTimeout(Promise.resolve().then(() => searchJollyTur(q, { region, signal })), S200_TIMEOUT_MS, S200_PROVIDER_KEY);

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
          titleFallback: "JollyTur sonucu",
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


// ===================================================================
// Backward compatibility (zero delete)
// ===================================================================
export const searchJollyTurAdapter = __jollytur_S200;
export const searchJollyTurScrape = searchJollyTur;

export default { searchJollyTur };

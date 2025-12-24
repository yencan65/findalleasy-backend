// server/adapters/kapadokyaAdapter.js
// ============================================================================
// Kapadokya Balon + ATV + Jeep Safari Adapter — S8 → S22 ULTRA TITAN TRAVEL
// ----------------------------------------------------------------------------
// ZERO DELETE — Eski işlevler korunur, yalnızca güçlendirilir
// ✔ proxyFetchHTML + axios fallback
// ✔ stableId (Titan MergeEngine uyumlu)
// ✔ ImageVariants S22 (image, imageOriginal, imageProxy, hasProxy)
// ✔ travel vertical sinyali
// ✔ price normalized + priceConfidence
// ✔ categoryAI = "tour"
// ✔ qualityScore
// ✔ anti-bot (script/style cleaner)
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

// ---------------------------------------------
// HELPERS
// ---------------------------------------------
function safe(v) {
  return v ? String(v).trim() : "";
}

function cleanBotTraps(html) {
  return String(html || "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
}

function parsePrice(t) {
  if (!t) return null;
  const cleaned = t.replace(/[^\d.,]/g, "").replace(",", ".");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function stableId(provider, title, href) {
  const seed = `${provider}::${title}::${href}`;
  return (
    provider +
    "_" +
    Buffer.from(seed).toString("base64").replace(/=/g, "").slice(0, 14)
  );
}

function computeQualityScore(item) {
  let s = 0;
  if (item.title) s += 0.35;
  if (item.image) s += 0.35;
  if (item.price != null) s += 0.15;
  if (item.category === "tour") s += 0.15;
  return Number(s.toFixed(2));
}

async function fetchHTML(url, signal) {
  try {
    return await proxyFetchHTML(url);
  } catch {
    try {
      const cfg = {
        timeout: 15000,
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

// ----------------------------------------------------------------------------
// MAIN ADAPTER
// ----------------------------------------------------------------------------
const BASE = process.env.KAPA_BASE_URL || "https://www.kapadokyabalon.com";

export async function searchKapadokya(query, regionOrOptions = "TR") {
  let region = "TR";
  let signal;

  if (typeof regionOrOptions === "string") {
    region = regionOrOptions;
  } else if (regionOrOptions) {
    region = regionOrOptions.region || "TR";
    signal = regionOrOptions.signal;
  }

  try {
    const q = encodeURIComponent(query);
    const url = `${BASE}/arama?q=${q}`;

    const html = await fetchHTML(url, signal);
    if (!html) return [];

    const $ = loadCheerioS200(cleanBotTraps(html));
    const items = [];

    const selectors = [".activity-card", ".tour-item", ".balloon-card"];

    $(selectors.join(",")).each((_, el) => {
      const w = $(el);

      const title =
        safe(w.find(".title").text()) || safe(w.find("h3").text());
      if (!title) return;

      const priceTxt =
        safe(w.find(".price").text()) ||
        safe(w.find(".amount").text());

      const price = parsePrice(priceTxt);

      let href = safe(w.find("a").attr("href"));
      if (!href) return;
      if (!href.startsWith("http")) href = BASE + href;

      const imgRaw =
        safe(w.find("img").attr("data-src")) ||
        safe(w.find("img").attr("src")) ||
        null;

      const image = buildImageVariants(imgRaw);
      const id = stableId("kapadokya", title, href);

      const base = {
        id,
        title,
        price,
        optimizedPrice: price,
        priceConfidence: price != null ? 0.85 : 0.3,

        rating: null,

        provider: "kapadokya",
        providerType: "travel",
        providerFamily: "kapadokya",
        vertical: "travel",

        currency: "TRY",
        region,

        url: href,
        deeplink: href,

        image: image.image,
        imageOriginal: image.imageOriginal,
        imageProxy: image.imageProxy,
        hasProxy: image.hasProxy,

        category: "tour",
        categoryAI: "tour",

        raw: { title, priceTxt, href, imgRaw },
      };

      items.push({
        ...base,
        qualityScore: computeQualityScore(base),
      });
    });

    return items;
  } catch (err) {
    console.warn("⚠️ kapadokyaAdapter hata:", err?.message || err);
    return [];
  }
}


async function __kapadokyaRaw(query, regionOrOptions = "TR") {
  let region = "TR";
  let signal;

  if (typeof regionOrOptions === "string") {
    region = regionOrOptions;
  } else if (regionOrOptions) {
    region = regionOrOptions.region || "TR";
    signal = regionOrOptions.signal;
  }

  try {
    const q = encodeURIComponent(query);
    const url = `${BASE}/arama?q=${q}`;

    const html = await fetchHTML(url, signal);
    if (!html) throw new Error("no_html");

    const $ = loadCheerioS200(cleanBotTraps(html));
    const items = [];

    const selectors = [".activity-card", ".tour-item", ".balloon-card"];

    $(selectors.join(",")).each((_, el) => {
      const w = $(el);

      const title =
        safe(w.find(".title").text()) || safe(w.find("h3").text());
      if (!title) return;

      const priceTxt =
        safe(w.find(".price").text()) ||
        safe(w.find(".amount").text());

      const price = parsePrice(priceTxt);

      let href = safe(w.find("a").attr("href"));
      if (!href) return;
      if (!href.startsWith("http")) href = BASE + href;

      const imgRaw =
        safe(w.find("img").attr("data-src")) ||
        safe(w.find("img").attr("src")) ||
        null;

      const image = buildImageVariants(imgRaw);
      const id = stableId("kapadokya", title, href);

      const base = {
        id,
        title,
        price,
        optimizedPrice: price,
        priceConfidence: price != null ? 0.85 : 0.3,

        rating: null,

        provider: "kapadokya",
        providerType: "travel",
        providerFamily: "kapadokya",
        vertical: "travel",

        currency: "TRY",
        region,

        url: href,
        deeplink: href,

        image: image.image,
        imageOriginal: image.imageOriginal,
        imageProxy: image.imageProxy,
        hasProxy: image.hasProxy,

        category: "tour",
        categoryAI: "tour",

        raw: { title, priceTxt, href, imgRaw },
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
// S200 WRAPPER — kapadokya (KIT-LOCKED, DRIFT-SAFE)
// Output: { ok, items, count, source, _meta }
// ============================================================================
const S200_PROVIDER_KEY = "kapadokya";
const S200_PROVIDER_FAMILY = "kapadokya";
const S200_VERTICAL = "travel";
const S200_CATEGORY = "tour";
const S200_TIMEOUT_MS = (() => {
  const n = Number(process.env.KAPADOKYA_TIMEOUT_MS || 6500);
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

async function __kapadokya_S200(query, regionOrOptions = "TR") {
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
    const raw = await withTimeout(Promise.resolve().then(() => __kapadokyaRaw(q, { region, signal })), S200_TIMEOUT_MS, S200_PROVIDER_KEY);

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
          titleFallback: "Kapadokya turu",
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


// Legacy
export const searchKapadokyaScrape = searchKapadokya;
export const searchKapadokyaAdapter = __kapadokya_S200;

export default {
  searchKapadokya,
  searchKapadokyaScrape,
  searchKapadokyaAdapter,
};

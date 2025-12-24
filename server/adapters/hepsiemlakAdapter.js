// server/adapters/hepsiemlakAdapter.js
// ============================================================================
//  Hepsiemlak — S8 → S33 TITAN FINAL
// ----------------------------------------------------------------------------
//  ZERO DELETE: Eski output davranışı korunur, TITAN modülleri eklenir.
//  ✔ stableId 2.0 (TITAN Merge ile %100 uyumlu)
//  ✔ ImageVariants S33
//  ✔ providerType/providerFamily/vertical = "estate"
//  ✔ categoryAI = "estate"
//  ✔ qualityScore (estate-weighted)
//  ✔ optimizePrice + sanitizePrice opsiyonel
//  ✔ multi-selector + multi-page (tasarım değişse bile dayanıklı)
//  ✔ signal destekli
// ============================================================================

import fetch from "node-fetch";
import * as cheerio from "cheerio";
import { buildImageVariants } from "../utils/imageFixer.js";
import { sanitizePrice } from "../utils/priceSanitizer.js";
import { optimizePrice } from "../utils/priceFixer.js";

import {
  loadCheerioS200,
  normalizeItemS200,
  coerceItemsS200,
  withTimeout,
  TimeoutError,
  safeStr,
} from "../core/s200AdapterKit.js";

// ============================================================================
// S200 HARDENING HELPERS (KIT-LOCKED)
// ============================================================================
const FINDALLEASY_ALLOW_STUBS = String(process.env.FINDALLEASY_ALLOW_STUBS || "0") === "1";

function _errStr(e) {
  return safeStr(e?.message || e || "error", 500);
}
function _isTimeout(e) {
  return e instanceof TimeoutError || /timed?\s*out/i.test(String(e?.message || e || ""));
}
function _mkRes(source, ok, items, meta = {}) {
  const arr = Array.isArray(items) ? items : [];
  return { ok: !!ok, items: arr, count: arr.length, source, _meta: { ...meta } };
}
function _normalizeMany(rawItems, providerKey, normOpts = {}) {
  const out = [];
  for (const it of coerceItemsS200(rawItems)) {
    const x = it && typeof it === "object" ? { ...it } : it;
    if (x && typeof x === "object") {
      // NO RANDOM/DRIFT ID: force kit stableId
      delete x.id;
      delete x.listingId;
    }
    const n = normalizeItemS200(x, providerKey, normOpts);
    if (n) out.push(n);
  }
  // dedupe by id
  const seen = new Set();
  const deduped = [];
  for (const it of out) {
    const id = String(it?.id || "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push(it);
  }
  return deduped;
}


// ------------------------------------------------------------
// HELPERS — S33
// ------------------------------------------------------------
function safe(v) {
  return v == null ? "" : String(v).trim();
}

function pick(...vals) {
  for (const v of vals) {
    if (v && String(v).trim().length > 1) return String(v).trim();
  }
  return "";
}

function parsePriceStrong(txt) {
  if (!txt) return null;
  try {
    let clean = txt
      .replace(/[^\d.,]/g, "")
      .replace(/\.(?=\d{3})/g, "")
      .replace(",", ".");
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
    "hepsiemlak_" +
    Buffer.from(seed)
      .toString("base64")
      .replace(/[^A-Za-z0-9]/g, "")
      .slice(0, 16)
  );
}

// Estate model için kalite skoru
function computeQualityScore(item) {
  let s = 0;
  if (item.title) s += 0.55;
  if (item.price != null) s += 0.25;
  if (item.image) s += 0.15;
  s += 0.05; // provider credibility
  return Number(s.toFixed(2));
}

const BASE = "https://www.hepsiemlak.com";

const LISTING_SELECTORS = [
  "div.listing-item",
  "li.listing-item",
  "div[class*='listing-item']",
  "div[data-listing-id]",
  "[data-testid='listing-item']",
];

// ------------------------------------------------------------
// PAGE SCRAPER — S33
// ------------------------------------------------------------
async function scrapePage(query, page = 1, region = "TR", signal = null) {
  const url =
    `${BASE}/arama?searchText=${encodeURIComponent(query)}&page=${page}`;

  try {
    const res = await fetch(url, {
      method: "GET",
      signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (FindAllEasyBot)",
        "Accept-Language": "tr-TR,tr;q=0.9",
      },
      timeout: 15000,
    });

    if (!res.ok) return [];

    const html = await res.text();
    const $ = loadCheerioS200(html);
    const results = [];

    $(LISTING_SELECTORS.join(", ")).each((i, el) => {
      const w = $(el);

      const title = pick(
        safe(w.find(".listing-title").text()),
        safe(w.find(".title").text()),
        safe(w.find("[data-testid='listing-title']").text()),
        safe(w.find("a").text())
      );
      if (!title) return;

      const priceTxt = pick(
        safe(w.find(".price").text()),
        safe(w.find(".listing-price").text()),
        safe(w.find("[data-testid='price']").text()),
        safe(w.find(".list-view-price").text())
      );
      const strong = parsePriceStrong(priceTxt);
      const price = sanitizePrice(strong);

      let href = pick(
        safe(w.find("a").attr("href")),
        safe(w.find("[data-testid='listing-link']").attr("href"))
      );
      if (!href) return;
      if (!href.startsWith("http")) href = BASE + href;

      // Görsel almaya çalışalım
      const imgRaw =
        safe(w.find("img").attr("data-src")) ||
        safe(w.find("img").attr("src")) ||
        null;
      const image = buildImageVariants(imgRaw);

      const id = stableId("hepsiemlak", title, href);

      const base = {
        id,
        title,
        price,
        optimizedPrice:
          price != null ? optimizePrice({ price }, { provider: "hepsiemlak" }) : null,

        provider: "hepsiemlak",
        providerType: "estate",
        providerFamily: "hepsiemlak",
        vertical: "estate",

        currency: "TRY",
        region,

        url: href,
        deeplink: href,

        image: image.image,
        imageOriginal: image.imageOriginal,
        imageProxy: image.imageProxy,
        hasProxy: image.hasProxy,

        category: "estate",
        categoryAI: "estate",

        raw: { title, priceTxt, href, imgRaw },
      };

      results.push({
        ...base,
        qualityScore: computeQualityScore(base),
      });
    });

    return results;
  } catch (err) {
    if (err.name === "AbortError") return [];
    return [];
  }
}

// ------------------------------------------------------------
// MAIN TITAN ADAPTER — S33 FINAL
// ------------------------------------------------------------
export async function searchHepsiemlak(query, regionOrOptions = "TR", signal) {
  let region = "TR";

  if (typeof regionOrOptions === "string") {
    region = regionOrOptions;
  } else if (typeof regionOrOptions === "object") {
    region = regionOrOptions.region || "TR";
    signal = regionOrOptions.signal;
  }

  const q = safe(query);
  if (!q) return [];

  const MAX_PAGES = 2;
  let all = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const part = await scrapePage(q, page, region, signal);
    all = all.concat(part);
  }

  return all.slice(0, 40);
}

// ------------------------------------------------------------
// UNIFIED ADAPTER (AdapterEngine-friendly)
// ------------------------------------------------------------
export async function searchHepsiemlakAdapter(query, regionOrOptions = "TR") {
  let region = "TR";
  let options = {};
  if (typeof regionOrOptions === "string") {
    region = regionOrOptions || "TR";
  } else if (regionOrOptions && typeof regionOrOptions === "object") {
    region = regionOrOptions.region || "TR";
    options = regionOrOptions;
  }
  const signal = options.signal;
  const timeoutMs = Number(options.timeoutMs || process.env.S200_PROVIDER_TIMEOUT_MS || 6500);

  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = { adapter: "hepsiemlakAdapter", providerKey: "hepsiemlak", url: "" };

  try {
    const raw = await withTimeout(searchHepsiemlak(query, { region, signal }), timeoutMs, "hepsiemlak.search");
    const items = _normalizeMany(raw, "hepsiemlak", { providerFamily: "hepsiemlak", vertical: "estate", category: "estate", currency: "TRY", region, baseUrl: "https://www.hepsiemlak.com" });
    return _mkRes("hepsiemlak", true, items, { code: items.length ? "OK" : "OK_EMPTY", region, timeoutMs });
  } catch (err) {
    return _mkRes("hepsiemlak", false, [], { code: _isTimeout(err) ? "TIMEOUT" : "ERROR", error: _errStr(err), region, timeoutMs });
  } finally {
    globalThis.__S200_ADAPTER_CTX = prevCtx;
  }
}


export default {
  searchHepsiemlak,
  searchHepsiemlakScrape: searchHepsiemlak,
  searchHepsiemlakAdapter,
};


// Scrape modu → gerçek scrape function yoksa bile SCRAPE olarak export edilir
export const searchHepsiemlakScrape = searchHepsiemlak;


// S200: legacy raw array access (ZERO DELETE)
export async function searchHepsiemlakLegacy(query, regionOrOptions = "TR", signal) {
  return await searchHepsiemlak(query, regionOrOptions, signal);
}

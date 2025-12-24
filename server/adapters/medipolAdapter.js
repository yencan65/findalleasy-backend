// ============================================================================
//  MEDIPOL — S200 HARDENED (KIT-LOCKED, DRIFT-SAFE)  20251218_085129
// ----------------------------------------------------------------------------
//  ZERO DELETE: searchMedipol export'u korunur; üstüne S200 wrapper eklenir.
//  Output (S200): { ok, items, count, source, _meta }
//  NO RANDOM ID: stableIdS200(providerKey,url,title)
//  NO FAKE RESULTS: fail/empty placeholder item yok.
//  NOTE: Önceki sürümde memorial.com.tr URL'i vardı (copy/paste bug) → medipol'e döndürüldü.
// ============================================================================

import axios from "axios";
import * as cheerio from "cheerio"; // kept

import { proxyFetchHTML } from "../core/proxyEngine.js";
import { sanitizePrice } from "../utils/priceSanitizer.js";
import { optimizePrice } from "../utils/priceFixer.js";
import { buildImageVariants } from "../utils/imageFixer.js";

import {
  loadCheerioS200,
  withTimeout,
  TimeoutError,
  normalizeItemS200,
  stableIdS200,
  safeStr,
} from "../core/s200AdapterKit.js";

const PROVIDER_KEY = "medipol";
const PROVIDER_FAMILY = "medipol";
const BASE = process.env.MEDIPOL_BASE_URL || "https://medipol.com.tr";
const SEARCH_PATH = process.env.MEDIPOL_SEARCH_PATH || "/arama?search=";
const UA = process.env.FINDAE_UA || "Mozilla/5.0 (FindAllEasy-S200)";

const safe = (v) => (v == null ? "" : String(v).trim());

function parsePrice(txt) {
  if (!txt) return null;
  try {
    const cleaned = String(txt).replace(/[^\d.,]/g, "").replace(/\./g, "").replace(",", ".");
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function stableId(urlOrTitle, title) {
  return stableIdS200(PROVIDER_KEY, safeStr(urlOrTitle), safeStr(title));
}

function detectCategoryAI(title = "", wrapHtml = "") {
  const t = String(title || "").toLowerCase();
  const h = String(wrapHtml || "").toLowerCase();
  if (/doktor|doctor|uzman|prof|dr/.test(t) || /doktor/.test(h)) return "health_doctor";
  if (/check\s*-?up|paket|package|tedavi|treatment/.test(t) || /treatment/.test(h)) return "health_treatment";
  return "health";
}

function extractCitySignal(title = "") {
  const cities = ["istanbul", "ankara", "izmir", "antalya", "bursa", "adana"];
  const t = String(title || "").toLowerCase();
  return cities.find((c) => t.includes(c)) || null;
}

function computeQualityScore({ title, image }) {
  let s = 0;
  if (title && title.length > 3) s += 0.3;
  if (image) s += 0.5;
  return Number(s.toFixed(2));
}

async function fetchHtmlS200(url, { signal, timeoutMs = 9500 } = {}) {
  let lastErr = null;
  try {
    const html = await withTimeout(proxyFetchHTML(url), timeoutMs, `${PROVIDER_KEY}:proxyFetchHTML`);
    if (html && typeof html === "string") return html;
    lastErr = new Error("proxy_html_not_string");
  } catch (e) {
    lastErr = e;
  }

  try {
    const req = axios.get(url, {
      timeout: Math.max(1500, Math.min(20000, timeoutMs + 4500)),
      signal,
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
    });
    const res = await withTimeout(req, timeoutMs, `${PROVIDER_KEY}:axios`);
    return res?.data;
  } catch (e) {
    throw lastErr || e;
  }
}

export async function searchMedipol(query, regionOrOptions = "TR", signal) {
  let region = "TR";
  if (typeof regionOrOptions === "object" && regionOrOptions) {
    region = regionOrOptions.region || "TR";
    signal = regionOrOptions.signal || null;
  } else {
    region = regionOrOptions || "TR";
  }

  const q = encodeURIComponent(safeStr(query));
  const url = `${BASE}${SEARCH_PATH}${q}`;

  const html = await fetchHtmlS200(url, { signal });
  const $ = loadCheerioS200(html);

  const out = [];
  const selectors = [
    ".doctor-card",
    ".doctor-item",
    ".arama-doktor",
    ".package-card",
    ".checkup-card",
    ".treatment-card",
    ".item",
    ".search-item",
    ".result-item",
    ".list-item",
  ];

  $(selectors.join(",")).each((i, el) => {
    const root = $(el);
    const rawHtml = root.html() || "";

    const title =
      safe(root.find(".title, .doctor-name, .item-title, h3, h2, .search-title").first().text()) || null;
    if (!title) return;

    const description = safe(root.find(".desc, .summary, .text, p").first().text()) || null;

    const priceRaw = parsePrice(
      safe(root.find(".price, .fee, .value, .amount, .package-price").first().text())
    );

    const price = sanitizePrice(priceRaw);
    const optimizedPrice = optimizePrice({ price }, { provider: PROVIDER_FAMILY });

    let href = safe(root.find("a").attr("href") || "");
    if (href && !href.startsWith("http")) href = `${BASE}${href}`;

    const imageRaw =
      safe(root.find("img").attr("data-src")) ||
      safe(root.find("img").attr("data-original")) ||
      safe(root.find("img").attr("src")) ||
      safe(root.find("picture img").attr("src")) ||
      null;

    const img = buildImageVariants(imageRaw);
    const categoryAI = detectCategoryAI(title, rawHtml);
    const geoSignal = extractCitySignal(title);
    const qualityScore = computeQualityScore({ title, image: imageRaw });

    out.push({
      id: stableId(href || title, title),
      title,
      description,
      price,
      optimizedPrice,
      provider: PROVIDER_FAMILY,
      providerKey: PROVIDER_KEY,
      source: PROVIDER_FAMILY,
      url: href,
      deeplink: href,
      image: img.image || imageRaw || null,
      imageOriginal: img.imageOriginal,
      imageProxy: img.imageProxy,
      hasProxy: img.hasProxy,
      category: "health",
      categoryAI,
      geoSignal,
      qualityScore,
      currency: "TRY",
      region: String(region || "TR").toUpperCase(),
      fallback: false,
      raw: { title, description, priceRaw, href, imageRaw },
    });
  });

  return out;
}

export async function searchMedipolAdapter(query, regionOrOptions = "TR") {
  const t0 = Date.now();
  const region =
    typeof regionOrOptions === "object" && regionOrOptions
      ? (regionOrOptions.region || "TR")
      : (regionOrOptions || "TR");

  globalThis.__S200_ADAPTER_CTX = {
    providerKey: PROVIDER_KEY,
    source: PROVIDER_KEY,
    group: "health",
    url: BASE,
    query: safeStr(query).slice(0, 160),
    region: String(region || "TR").toUpperCase(),
  };

  try {
    const rawItems = await withTimeout(searchMedipol(query, regionOrOptions), 12000, `${PROVIDER_KEY}:outer`);

    const normalized = (Array.isArray(rawItems) ? rawItems : [])
      .map((it) =>
        normalizeItemS200(it, PROVIDER_KEY, {
          providerFamily: PROVIDER_FAMILY,
          currency: "TRY",
          region,
          vertical: "health",
          category: "health",
          baseUrl: BASE,
        })
      )
      .filter(Boolean);

    return {
      ok: true,
      items: normalized,
      count: normalized.length,
      source: PROVIDER_KEY,
      _meta: {
        providerKey: PROVIDER_KEY,
        provider: PROVIDER_FAMILY,
        query: safeStr(query).slice(0, 160),
        region: String(region || "TR").toUpperCase(),
        rawCount: Array.isArray(rawItems) ? rawItems.length : 0,
        ms: Date.now() - t0,
      },
    };
  } catch (err) {
    const code = err instanceof TimeoutError ? "timeout" : "error";
    return {
      ok: false,
      items: [],
      count: 0,
      source: PROVIDER_KEY,
      _meta: {
        providerKey: PROVIDER_KEY,
        provider: PROVIDER_FAMILY,
        code,
        error: safeStr(err?.message || err),
        ms: Date.now() - t0,
      },
    };
  }
}

export const searchMedipolScrape = searchMedipol;

export default {
  searchMedipol,
  searchMedipolAdapter,
  searchMedipolScrape,
};

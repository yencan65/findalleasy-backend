// ============================================================================
//  MEDICANA CHECK-UP — S200 HARDENED (KIT-LOCKED, DRIFT-SAFE)  20251218_085129
// ----------------------------------------------------------------------------
//  ZERO DELETE: Export isimleri korunur, S200 output kilitlenir.
//  Output (S200): { ok, items, count, source, _meta }
//  NO RANDOM ID: stableIdS200(providerKey,url,title)
//  NO FAKE RESULTS: fail/empty placeholder item yok.
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

const PROVIDER_KEY = "medicana_checkup";
const PROVIDER_FAMILY = "medicana";
const BASE = process.env.MEDICANA_BASE_URL || "https://www.medicana.com.tr";
const UA = process.env.FINDAE_UA || "Mozilla/5.0 (FindAllEasy-S200)";

const safe = (x) => (x == null ? "" : String(x).trim());

function parsePrice(t) {
  if (!t) return null;
  try {
    const cleaned = String(t).replace(/[^\d.,]/g, "").replace(/\./g, "").replace(",", ".");
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function stableId(urlOrTitle, title) {
  return stableIdS200(PROVIDER_KEY, safeStr(urlOrTitle), safeStr(title));
}

function detectCategoryAI() {
  return "health_checkup";
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

export async function searchMedicanaCheckup(query, regionOrOptions = "TR", signal) {
  let region = "TR";
  if (typeof regionOrOptions === "object" && regionOrOptions) {
    region = regionOrOptions.region || "TR";
    signal = regionOrOptions.signal || null;
  } else {
    region = regionOrOptions || "TR";
  }

  const q = encodeURIComponent(safeStr(query));
  const url = `${BASE}/check-up?search=${q}`;

  const html = await fetchHtmlS200(url, { signal });
  const $ = loadCheerioS200(html);

  const out = [];
  const selectors = [".package-card", ".checkup-item", ".campaign-box", ".treatment-card", ".checkup-card", ".package"];

  $(selectors.join(",")).each((i, el) => {
    const wrap = $(el);
    const title = safe(wrap.find(".title").text()) || safe(wrap.find(".package-title").text()) || safe(wrap.find("h3").text());
    if (!title) return;

    const priceRaw = parsePrice(
      safe(wrap.find(".price").text()) || safe(wrap.find(".campaign-price").text()) || safe(wrap.find(".package-price").text())
    );

    const price = sanitizePrice(priceRaw);
    const optimizedPrice = optimizePrice({ price }, { provider: PROVIDER_FAMILY });

    let href = safe(wrap.find("a").attr("href")) || safe(wrap.find(".card-link").attr("href"));
    if (!href) return;
    if (!href.startsWith("http")) href = `${BASE}${href}`;

    const imgRaw =
      safe(wrap.find("img").attr("data-src")) ||
      safe(wrap.find("img").attr("data-original")) ||
      safe(wrap.find("img").attr("src")) ||
      safe(wrap.find("picture img").attr("src")) ||
      null;

    const img = buildImageVariants(imgRaw);
    const geoSignal = extractCitySignal(title);
    const qualityScore = computeQualityScore({ title, image: imgRaw });

    out.push({
      id: stableId(href || title, title),
      title,
      price,
      optimizedPrice,
      provider: PROVIDER_FAMILY,
      providerKey: PROVIDER_KEY,
      source: PROVIDER_FAMILY,
      url: href,
      deeplink: href,
      image: img.image || imgRaw || null,
      imageOriginal: img.imageOriginal,
      imageProxy: img.imageProxy,
      hasProxy: img.hasProxy,
      category: "health_checkup",
      categoryAI: detectCategoryAI(),
      geoSignal,
      qualityScore,
      currency: "TRY",
      region: String(region || "TR").toUpperCase(),
      fallback: false,
      raw: { title, priceRaw, href, imgRaw },
    });
  });

  return out;
}

export async function searchMedicanaCheckupAdapter(query, regionOrOptions = "TR") {
  const t0 = Date.now();
  const region =
    typeof regionOrOptions === "object" && regionOrOptions
      ? (regionOrOptions.region || "TR")
      : (regionOrOptions || "TR");

  globalThis.__S200_ADAPTER_CTX = {
    providerKey: PROVIDER_KEY,
    source: PROVIDER_KEY,
    group: "health_checkup",
    url: BASE,
    query: safeStr(query).slice(0, 160),
    region: String(region || "TR").toUpperCase(),
  };

  try {
    const rawItems = await withTimeout(searchMedicanaCheckup(query, regionOrOptions), 12000, `${PROVIDER_KEY}:outer`);

    const normalized = (Array.isArray(rawItems) ? rawItems : [])
      .map((it) =>
        normalizeItemS200(it, PROVIDER_KEY, {
          providerFamily: PROVIDER_FAMILY,
          currency: "TRY",
          region,
          vertical: "health",
          category: "health_checkup",
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

export const searchMedicanaCheckupScrape = searchMedicanaCheckup;

export default {
  searchMedicanaCheckup,
  searchMedicanaCheckupAdapter,
  searchMedicanaCheckupScrape,
};

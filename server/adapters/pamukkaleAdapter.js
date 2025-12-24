// server/adapters/pamukkaleAdapter.js
// ============================================================================
// PAMUKKALE TOURS — S200 HARDENED (v20251218_025640)
// ZERO DELETE: mevcut fonksiyonlar korunur, sadece güçlendirilir.
// S200 Standard:
// - Output: { ok, items, count, source, _meta } (legacy: Array return + props)
// - Contract lock: title + url zorunlu; price<=0 => null (normalizeItemS200)
// - NO FAKE RESULTS (PROD): stub/mock yok
// - Observable fail: timeout/import/fetch/parsing => ok:false + items:[]
// - NO RANDOM ID: stableIdS200 (Math.random yasak)
// - URL priority: affiliate/deeplink/finalUrl > originUrl > url (pickUrlS200)
// - withTimeout: her network call
// ============================================================================

import axios from "axios";
import * as cheerio from "cheerio";

import { proxyFetchHTML } from "../core/proxyEngine.js";
import { sanitizePrice } from "../utils/priceSanitizer.js";
import { optimizePrice } from "../utils/priceFixer.js";
import { buildImageVariants } from "../utils/imageFixer.js";

import {
  withTimeout,
  loadCheerioS200,
  coerceItemsS200,
  normalizeItemS200,
  stableIdS200,
  pickUrlS200,
} from "../core/s200AdapterKit.js";

// -------------------------------------------------------
// HELPERS
// -------------------------------------------------------
const safe = (v) => String(v ?? "").trim();

function asS200ArrayResult(items, { ok, source, _meta } = {}) {
  const arr = Array.isArray(items) ? items.filter(Boolean) : [];
  const out = arr.slice(); // returned array
  out.ok = !!ok;
  out.items = arr.slice(); // NON-circular copy (JSON safe)
  out.count = out.items.length;
  out.source = source || "pamukkale";
  out._meta = _meta || {};
  return out;
}

function stableId(url, title) {
  // ZERO DELETE: isim korunur. İçerik S200 deterministic'e taşındı (NO RANDOM).
  return stableIdS200("pamukkale", url, title);
}

function parsePriceS22(text) {
  const n = sanitizePrice(text, { provider: "pamukkale" });
  return Number.isFinite(n) ? n : null;
}

// -------------------------------------------------------
// AI CATEGORY (tour subtypes)
// -------------------------------------------------------
function detectTourCategory(title) {
  const t = (title || "").toLowerCase();
  if (/kapadokya|cappadocia|balon|balloon/.test(t)) return "tour_special";
  if (/pamukkale|traverten|thermal|kaplıca/.test(t)) return "tour_nature";
  if (/hierapolis|antik|arkeoloji|museum|müze/.test(t)) return "tour_history";
  if (/daily|günlük|activity|aktivite/.test(t)) return "tour_daily";
  return "tour";
}

// -------------------------------------------------------
// EXTRACT IMAGE (variants)
// -------------------------------------------------------
function extractImageS22($, el) {
  const raw =
    safe($(el).find("img").attr("data-src")) ||
    safe($(el).find("img").attr("src")) ||
    safe($(el).attr("data-src")) ||
    safe($(el).attr("src")) ||
    "";
  if (!raw) return buildImageVariants(null);
  return buildImageVariants(raw);
}

const BASE = process.env.PAMUK_BASE_URL || "https://www.pamukkaletours.com";
const TIMEOUT_MS = Number(process.env.S200_PROVIDER_TIMEOUT_MS || 6500);

// ============================================================================
export async function searchPamukkale(query, opts = "TR") {
  const region = typeof opts === "string" ? opts : (opts?.region || "TR");
  const options = typeof opts === "object" ? (opts || {}) : {};

  const q = safe(query);
  if (!q) return asS200ArrayResult([], {
    ok: true,
    source: "pamukkale",
    _meta: { emptyQuery: true },
  });

  const url = `${BASE}/search?q=${encodeURIComponent(q)}`;

  // global ctx (kit logları "unknown" diye ağlamasın)
  try {
    globalThis.__S200_ADAPTER_CTX = {
      adapter: "pamukkale",
      providerKey: "pamukkale",
      url,
      query: q,
      region,
    };
  } catch {}

  let html = "";
  try {
    // Proxy first
    html = await withTimeout(proxyFetchHTML(url), options.timeoutMs || TIMEOUT_MS, "pamukkale:proxyFetchHTML");
  } catch (e1) {
    try {
      const res = await withTimeout(
        axios.get(url, {
          timeout: options.timeoutMs || TIMEOUT_MS,
          headers: {
            "User-Agent": "Mozilla/5.0 (FindAllEasy-S200)",
            "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.7",
          },
        }),
        options.timeoutMs || TIMEOUT_MS,
        "pamukkale:axios.get"
      );
      html = res?.data || "";
    } catch (e2) {
      const msg = (e2?.message || e1?.message || "fetch_failed");
      return asS200ArrayResult([], {
        ok: false,
        source: "pamukkale",
        _meta: {
          error: msg,
          stage: "fetch",
          url,
        },
      });
    }
  }

  if (!html || typeof html !== "string") {
    return asS200ArrayResult([], {
      ok: false,
      source: "pamukkale",
      _meta: {
        error: "html_not_string",
        stage: "fetch",
        url,
      },
    });
  }

  try {
    // loadCheerioS200: kit-locked parser init
    const $ = loadCheerioS200(html, cheerio);

    const rawItems = [];
    const cards = $(".search-result-item, .tour-card, .product-card, .card").toArray();

    for (let i = 0; i < cards.length; i++) {
      const el = cards[i];

      const title =
        safe($(el).find("h1,h2,h3,.title,.card-title,.tour-title").first().text()) ||
        safe($(el).find("a").first().attr("title"));

      let href =
        safe($(el).find("a").first().attr("href")) ||
        safe($(el).find("a[href]").first().attr("href"));

      if (!title || !href) continue;

      if (!href.startsWith("http")) href = BASE + href;

      const priceText =
        safe($(el).find(".price,.tour-price,.amount,.card-price").first().text()) ||
        safe($(el).find("[data-price]").first().attr("data-price"));

      let price = parsePriceS22(priceText);
      price = optimizePrice(price, { provider: "pamukkale" });

      const category = detectTourCategory(title);
      const imgVariants = extractImageS22($, el);

      const candidate = {
        id: stableId(href, title),
        title,
        price,
        currency: "TRY",
        region: String(region || "TR").toUpperCase(),
        category,
        providerKey: "pamukkale",
        provider: "tour",
        vertical: "tour",
        url: href,
        deeplink: href,
        image: imgVariants.image,
        imageOriginal: imgVariants.imageOriginal,
        imageProxy: imgVariants.imageProxy,
        raw: {
          originUrl: href,
          url: href,
          providerKey: "pamukkale",
          category,
        },
      };

      const normalized = normalizeItemS200(candidate, "pamukkale", {
        vertical: "tour",
        category,
        providerFamily: "tour",
      });

      if (normalized) rawItems.push(normalized);
    }

    const items = coerceItemsS200(rawItems);

    return asS200ArrayResult(items, {
      ok: true,
      source: "pamukkale",
      _meta: {
        url,
        region: String(region || "TR").toUpperCase(),
        fetched: true,
        parsed: true,
      },
    });
  } catch (err) {
    const msg = err?.message || String(err);
    const isTimeout = /timed out|timeout/i.test(msg);
    return asS200ArrayResult([], {
      ok: false,
      source: "pamukkale",
      _meta: {
        error: msg,
        timeout: isTimeout || undefined,
        stage: "parse",
        url,
      },
    });
  }
}

export const searchPamukkaleScrape = searchPamukkale;
export const searchPamukkaleAdapter = searchPamukkale;

export default {
  searchPamukkale,
  searchPamukkaleScrape,
  searchPamukkaleAdapter,
};

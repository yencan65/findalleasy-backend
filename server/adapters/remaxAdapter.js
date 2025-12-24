// server/adapters/remaxAdapter.js
// ============================================================================
// REMAX — S200 HARDENED (v20251218_025640)
// ZERO DELETE: export isimleri korunur.
// FIXES:
// - NO RANDOM ID: stableIdS200 (Math.random yasak)
// - Observable fail: fetch/timeout/parse => ok:false + items:[]
// - withTimeout: network calls
// - S200 output: Array return + {ok, items, count, source, _meta}
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
} from "../core/s200AdapterKit.js";

// -----------------------------------------
// HELPERS
// -----------------------------------------
const safe = (v) => String(v ?? "").trim();

function asS200ArrayResult(items, { ok, source, _meta } = {}) {
  const arr = Array.isArray(items) ? items.filter(Boolean) : [];
  const out = arr.slice();
  out.ok = !!ok;
  out.items = arr.slice(); // non-circular
  out.count = out.items.length;
  out.source = source || "remax";
  out._meta = _meta || {};
  return out;
}

function stableId(url, title) {
  // ZERO DELETE: isim korunur ama deterministic (NO RANDOM).
  return stableIdS200("remax", url, title);
}

function parsePriceS22(text) {
  const n = sanitizePrice(text, { provider: "remax" });
  return Number.isFinite(n) ? n : null;
}

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

function detectEstateCategoryAI(title) {
  const t = (title || "").toLowerCase();
  if (/kiralık|rent/.test(t)) return "estate_rent";
  if (/satılık|sale/.test(t)) return "estate_sale";
  return "estate";
}

const BASE = process.env.REMAX_BASE_URL || "https://www.remax.com.tr";
const TIMEOUT_MS = Number(process.env.S200_PROVIDER_TIMEOUT_MS || 6500);

// ============================================================================
// MAIN SCRAPE
// ============================================================================
export async function searchRemaxScrape(query, regionOrOptions = "TR") {
  const region = typeof regionOrOptions === "string" ? regionOrOptions : (regionOrOptions?.region || "TR");
  const options = typeof regionOrOptions === "object" ? (regionOrOptions || {}) : {};

  const q = safe(query);
  if (!q) return asS200ArrayResult([], {
    ok: true,
    source: "remax",
    _meta: { emptyQuery: true },
  });

  const url = `${BASE}/arama?query=${encodeURIComponent(q)}`;

  try {
    globalThis.__S200_ADAPTER_CTX = {
      adapter: "remax",
      providerKey: "remax",
      url,
      query: q,
      region,
    };
  } catch {}

  let html = "";
  try {
    html = await withTimeout(proxyFetchHTML(url), options.timeoutMs || TIMEOUT_MS, "remax:proxyFetchHTML");
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
        "remax:axios.get"
      );
      html = res?.data || "";
    } catch (e2) {
      const msg = (e2?.message || e1?.message || "fetch_failed");
      return asS200ArrayResult([], {
        ok: false,
        source: "remax",
        _meta: { error: msg, stage: "fetch", url },
      });
    }
  }

  if (!html || typeof html !== "string") {
    return asS200ArrayResult([], {
      ok: false,
      source: "remax",
      _meta: { error: "html_not_string", stage: "fetch", url },
    });
  }

  try {
    const $ = loadCheerioS200(html, cheerio);

    const rawItems = [];
    const cards = $(".listing-item, .property-item, .card, li").toArray();

    for (let i = 0; i < cards.length; i++) {
      const el = cards[i];

      const title =
        safe($(el).find(".title,.property-title,h2,h3").first().text()) ||
        safe($(el).find("a").first().attr("title"));

      let href =
        safe($(el).find("a[href]").first().attr("href"));

      if (!title || !href) continue;
      if (!href.startsWith("http")) href = BASE + href;

      const priceText =
        safe($(el).find(".price,.property-price,.amount").first().text()) ||
        safe($(el).find("[data-price]").first().attr("data-price"));

      let price = parsePriceS22(priceText);
      price = optimizePrice(price, { provider: "remax" });

      const category = detectEstateCategoryAI(title);
      const img = extractImageS22($, el);

      const candidate = {
        id: stableId(href, title),
        title,
        price,
        currency: "TRY",
        region: String(region || "TR").toUpperCase(),
        category,
        providerKey: "remax",
        provider: "estate",
        vertical: "estate",
        url: href,
        image: img.image,
        imageOriginal: img.imageOriginal,
        imageProxy: img.imageProxy,
        raw: { originUrl: href, url: href },
      };

      const normalized = normalizeItemS200(candidate, "remax", {
        vertical: "estate",
        category,
        providerFamily: "estate",
      });

      if (normalized) rawItems.push(normalized);
    }

    const items = coerceItemsS200(rawItems);

    return asS200ArrayResult(items, {
      ok: true,
      source: "remax",
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
      source: "remax",
      _meta: { error: msg, timeout: isTimeout || undefined, stage: "parse", url },
    });
  }
}

// Alias (ZERO DELETE)
export async function searchRemaxAdapter(query, regionOrOptions = "TR") {
  return searchRemaxScrape(query, regionOrOptions);
}

export default {
  searchRemaxScrape,
  searchRemaxAdapter,
};

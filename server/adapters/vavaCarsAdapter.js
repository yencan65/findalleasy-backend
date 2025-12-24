// server/adapters/vavaCarsAdapter.js
// ============================================================================
// VAVACARS — S200 HARDENED (KIT-LOCKED, DRIFT-SAFE)
// - Output: { ok, items, count, source, _meta }
// - Contract: title+url required, price<=0 => null
// - Deterministic id: stableIdS200(providerKey,url,title) via normalizeItemS200
// - URL priority: affiliateUrl/deeplink/finalUrl > originUrl > url (kit)
// - NO FAKE: fetch/parse fail => ok:false + items:[]
// - withTimeout: all network calls
// ============================================================================
// ZERO DELETE: helper/parse yapısı korunur; sadece S200 pipeline'a bağlandı.

import axios from "axios";
import * as cheerio from "cheerio"; // legacy import (kept)

import { proxyFetchHTML } from "../core/proxyEngine.js";

// S21 fiyat motoru (kept)
import { sanitizePrice } from "../utils/priceSanitizer.js";
import { optimizePrice } from "../utils/priceFixer.js";

// Görsel sistemi (kept)
import { buildImageVariants } from "../utils/imageFixer.js";

// Affiliate motoru (kept)
import { buildAffiliateUrlS9 as buildAffiliateUrlS10 } from "./affiliateEngine.js";

import {
  loadCheerioS200,
  normalizeItemS200,
  withTimeout,
  TimeoutError,
  fixKey,
} from "../core/s200AdapterKit.js";

const BASE = "https://www.vava.cars";
const PROVIDER_KEY = fixKey("vavacars") || "vavacars";

// --------------------------------------------------------------
// HELPERS (kept)
// --------------------------------------------------------------
function safe(v) {
  return v == null ? "" : String(v).trim();
}

function parsePrice(txt) {
  if (!txt) return null;
  const cleaned = String(txt).replace(/[^\d]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// Legacy stable id helper (kept) — S200 uses stableIdS200 via normalizeItemS200
function buildStableId(href, title) {
  try {
    if (href) return "vavacars_" + Buffer.from(href).toString("base64");
    return "vavacars_" + Buffer.from(title).toString("base64");
  } catch {
    return href || title;
  }
}

// DIRECT + PROXY fetch (hardened)
async function fetchHTMLWithProxy(url, config = {}) {
  const timeoutMs = Math.max(800, Math.min(20000, Number(config.timeout) || 14000));
  const signal = config.signal;
  try {
    const direct = await withTimeout(
      axios.get(url, {
        timeout: Math.min(timeoutMs + 800, 22000),
        ...(config.headers ? { headers: config.headers } : {}),
        ...(signal ? { signal } : {}),
      }),
      timeoutMs,
      `${PROVIDER_KEY}_direct`
    );
    return direct?.data || null;
  } catch (err) {
    try {
      const html = await withTimeout(proxyFetchHTML(url), timeoutMs, `${PROVIDER_KEY}_proxy`);
      return html || null;
    } catch {
      return null;
    }
  }
}

// --------------------------------------------------------------
// MAIN
// --------------------------------------------------------------
export async function searchVavaCarsAdapter(query, options = {}) {
  const t0 = Date.now();
  const q = safe(query);

  const providerKey = PROVIDER_KEY;
  const providerFamily = fixKey(options.providerFamily || options.family || "vehicle_sale") || "vehicle_sale";

  const region = safe(options.region || "TR") || "TR";
  const signal = options.signal;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1200, Math.min(16000, options.timeoutMs)) : 6500;
  const maxItems = Number.isFinite(options.maxItems) ? Math.max(1, Math.min(80, options.maxItems)) : 40;

  if (!q) {
    return {
      ok: false,
      items: [],
      count: 0,
      source: providerKey,
      provider: providerFamily,
      providerKey,
      providerFamily,
      _meta: { adapter: providerKey, code: "EMPTY_QUERY", ms: Date.now() - t0 },
    };
  }

  const searchUrl = `${BASE}/tr/araclar?search=${encodeURIComponent(q)}`;

  // ctx: kit logları "unknown" demesin
  try {
    globalThis.__S200_ADAPTER_CTX = { adapter: providerKey, providerKey, providerFamily, url: searchUrl, query: q };
  } catch {}

  let html = null;
  try {
    html = await fetchHTMLWithProxy(searchUrl, {
      signal,
      timeout: timeoutMs,
      headers: {
        "User-Agent": "Mozilla/5.0 (FindAllEasy-S200)",
        "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.7",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
      },
    });
  } catch {
    html = null;
  }

  if (!html) {
    return {
      ok: false,
      items: [],
      count: 0,
      source: providerKey,
      provider: providerFamily,
      providerKey,
      providerFamily,
      _meta: { adapter: providerKey, code: "FETCH_FAIL", url: searchUrl, timeoutMs, ms: Date.now() - t0 },
    };
  }

  let $;
  try {
    $ = loadCheerioS200(html, { adapter: providerKey, url: searchUrl });
  } catch (e) {
    return {
      ok: false,
      items: [],
      count: 0,
      source: providerKey,
      provider: providerFamily,
      providerKey,
      providerFamily,
      _meta: { adapter: providerKey, code: "HTML_PARSE_FAIL", error: e?.message || String(e), ms: Date.now() - t0 },
    };
  }

  const normalized = [];
  const seenIds = new Set();

  const sel = ".car-card, [data-testid='car-card'], .carCard";
  $(sel).each((i, el) => {
    try {
      const title =
        safe($(el).find(".car-card__title, .car-card__name, h3, h2").first().text()) ||
        safe($(el).find("a").first().attr("title"));

      const priceTxt =
        safe($(el).find(".car-card__price, .car-card__priceValue, .price").first().text()) || "";

      const rawPrice = parsePrice(priceTxt);
      const sanitized = sanitizePrice(rawPrice, { provider: providerKey, category: "car" });

      let href = safe($(el).find("a").first().attr("href"));
      if (href && !href.startsWith("http")) href = BASE + (href.startsWith("/") ? "" : "/") + href;
      if (!title || !href) return;

      const affiliateUrl = buildAffiliateUrlS10({ url: href, provider: providerKey });

      let imgRaw =
        safe($(el).find("img").first().attr("src")) ||
        safe($(el).find("img").first().attr("data-src")) ||
        "";

      if (imgRaw && imgRaw.startsWith("//")) imgRaw = "https:" + imgRaw;

      const imageVariants = buildImageVariants(imgRaw || null, providerKey);

      let rawItem = {
        title,
        price: sanitized,
        priceText: priceTxt,
        currency: "TRY",
        region: String(region || "TR").toUpperCase(),

        url: href,
        originUrl: href,
        affiliateUrl,

        image: imageVariants.image,
        _imageVariants: imageVariants,

        category: "car",
        raw: { title, priceTxt, href, imgRaw },
      };

      rawItem = optimizePrice(rawItem, { provider: providerKey, region, category: "car" });

      const n = normalizeItemS200(rawItem, providerKey, {
        providerFamily,
        vertical: "vehicle_sale",
        category: "car",
        baseUrl: BASE,
        region,
      });

      if (!n) return;

      // image variants preserve (optional)
      if (rawItem?._imageVariants && typeof rawItem._imageVariants === "object") {
        n.imageOriginal = rawItem._imageVariants.imageOriginal || null;
        n.imageProxy = rawItem._imageVariants.imageProxy || null;
        n.hasProxy = !!rawItem._imageVariants.hasProxy;
      }

      if (seenIds.has(n.id)) return;
      seenIds.add(n.id);
      normalized.push(n);
    } catch {
      // ignore single item crash
    }
  });

  const items = normalized.slice(0, maxItems);

  return {
    ok: items.length > 0,
    items,
    count: items.length,
    source: providerKey,
    provider: providerFamily,
    providerKey,
    providerFamily,
    _meta: {
      adapter: providerKey,
      query: q,
      url: searchUrl,
      region,
      timeoutMs,
      parsed: normalized.length,
      returned: items.length,
      ms: Date.now() - t0,
    },
  };
}

export default { searchVavaCarsAdapter };

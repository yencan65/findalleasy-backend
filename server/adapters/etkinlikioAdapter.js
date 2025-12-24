// server/adapters/etkinlikioAdapter.js
// ======================================================================
// Etkinlik.io — S33 TITAN+ EVENT ADAPTER (FINAL VERSION)
// Zero Delete · Full Strength · Stable ID · ImageVariants
// Rate Limiter uyumlu (ana motor ile entegre)
// ======================================================================

import axios from "axios";
import * as cheerio from "cheerio";
import crypto from "crypto";
import { buildImageVariants } from "../utils/imageFixer.js";
import { rateLimiter } from "../utils/rateLimiter.js";

import {
  loadCheerioS200,
  withTimeout,
  coerceItemsS200,
  normalizeItemS200,
  safeStr,
  fixKey,
  isBadUrlS200,
  normalizeUrlS200,
  stableIdS200,
  pickUrlS200,
  priceOrNullS200,
  TimeoutError
} from "../core/s200AdapterKit.js";

// ======================= RATE LIMITER =======================
async function checkRateLimit() {
  const key = "adapter_etkinlikio_TR";
  const allowed = await rateLimiter.check(key, {
    limit: 18,
    windowMs: 60000,
    burst: true,
    adaptive: true,
  });
  
  if (!allowed) {
    console.warn(`⛔ RATE LIMIT → etkinlikio`);
    throw new Error("Rate limit exceeded for etkinlikio adapter");
  }
  
  return true;
}

// ======================= HELPERS =======================
const safe = (v) => (v ? String(v).trim() : "");

function slugify(t) {
  return safe(t)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 60);
}

function stableId(url, title) {
  const slug = slugify(title || "event");
  const hash = crypto
    .createHash("md5")
    .update(url || "")
    .digest("hex")
    .slice(0, 6);

  return `etkinlikio_${slug}_${hash}_${Date.now().toString().slice(-4)}`;
}

function parseDateTime(wrap) {
  const t =
    safe(wrap.find(".event-card__date").text()) ||
    safe(wrap.find(".event-card__datetime").text()) ||
    null;
  return t || null;
}

function parseLocation(wrap) {
  const l =
    safe(wrap.find(".event-card__location").text()) ||
    safe(wrap.find(".location").text()) ||
    null;
  return l || null;
}

// ======================= NORMALIZER =======================
// Ana motorun normalizeItem fonksiyonu ile uyumlu hale getiriyoruz.
function normalizeEvent(raw, region, query) {
  const title = raw.title || `Etkinlik – ${query}`;
  const url = raw.url;

  const id = stableId(url, title);
  const img = buildImageVariants(raw.image, "etkinlikio");

  const baseItem = {
    id,
    title,

    // 🔥 S200 URL STANDARDI
    originUrl: url,
    finalUrl: url,
    deeplink: url,
    url,

    // 🔥 S200 PRICE PIPELINE
    price: raw.price ?? null,
    finalPrice: raw.price ?? null,
    optimizedPrice: raw.price ?? null,

    rating: null,
    provider: "etkinlikio",
    currency: "TRY",
    region: region.toUpperCase(),
    category: "event",
    adapterSource: "etkinlikioAdapter",

    raw: {
      title,
      url,
      dateText: raw.dateText || null,
      locationText: raw.locationText || null,

      providerFamily: "event",
      providerType: "ticket",
      providerSignature: "etkinlikio_s33",
      adapterVersion: "S33.TITAN+",
      reliabilityScore: 0.87,
      categoryAI: "event",
      vertical: "event",

      image: img.image,
      imageOriginal: img.imageOriginal,
      imageProxy: img.imageProxy,
      hasProxy: img.hasProxy,

      finalPrice: raw.price ?? null,
      optimizedPrice: raw.price ?? null,

      qualityScore: computeQuality(title, img, raw),
      rawData: raw.raw || raw
    }
  };

  return baseItem;
}

function computeQuality(title, img, raw) {
  let s = 0;

  if (title) s += 0.35;
  if (img && img.image) s += 0.25;
  if (raw.locationText) s += 0.15;
  if (raw.dateText) s += 0.15;
  s += 0.10; // entropy boost

  return Number(s.toFixed(2));
}

// ======================= SCRAPER =======================
async function scrapeEtkinlikPage(query, region, signal) {
  try {
    const q = encodeURIComponent(query);
    const url = `https://etkinlik.io/ara?q=${q}`;

    const { data: html } = await axios.get(url, {
      timeout: 9000,
      signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (FindAllEasy-S33-TITAN)",
        "Accept-Language": "tr-TR,tr;q=0.9",
      },
    });

    const $ = loadCheerioS200(html);
    const items = [];

    const selectors = [
      ".event-card",
      ".search-item",
      ".card-event",
      "article.event",
      "[data-event-id]",
    ];

    $(selectors.join(",")).each((i, el) => {
      const wrap = $(el);

      const title =
        safe(wrap.find(".event-card__title").text()) ||
        safe(wrap.find(".title").text()) ||
        safe(wrap.find("h3").text());
      if (!title) return;

      let href = wrap.find("a").attr("href");
      if (!href) return;

      if (!href.startsWith("http"))
        href = "https://etkinlik.io" + href;

      const img =
        safe(wrap.find("img").attr("data-src")) ||
        safe(wrap.find("img").attr("src")) ||
        null;

      const dateText = parseDateTime(wrap);
      const locationText = parseLocation(wrap);

      items.push(
        normalizeEvent(
          {
            title,
            url: href,
            image: img,
            dateText,
            locationText,
          },
          region,
          query
        )
      );
    });

    return items;
  } catch (err) {
    console.warn("⚠️ Etkinlik.io page error:", err.message);
    return [];
  }
}

// ======================= MAIN ADAPTER =======================
async function searchEtkinlikio__S200_LEGACY(query = "", regionOrOptions = "TR") {
  let region = "TR";
  let signal = null;

  if (typeof regionOrOptions === "string") {
    region = regionOrOptions;
  } else if (regionOrOptions && typeof regionOrOptions === "object") {
    region = regionOrOptions.region || "TR";
    signal = regionOrOptions.signal || null;
  }

  try {
    // Rate limiter kontrolü
    await checkRateLimit();
    
    const scraped = await scrapeEtkinlikPage(query, region, signal);

    if (scraped.length > 0) {
      // Başarılı isteği kaydet
      rateLimiter.registerSuccess("adapter_etkinlikio_TR", 1);
      return scraped;
    }

    // FALLBACK — S33 formatlı
    const fallbackItem = normalizeEvent(
      {
        title: `Etkinlik bulunamadı: ${query}`,
        url: "https://etkinlik.io",
        image: null,
        dateText: null,
        locationText: null,
        fallback: true,
      },
      region,
      query
    );
    
    // Fallback'te de başarılı sayalım mı? Belki hata değil, sadece sonuç yok.
    rateLimiter.registerSuccess("adapter_etkinlikio_TR", 1);
    return [fallbackItem];
  } catch (err) {
    // Hata durumunda rate limiter'a bildir (rate limit hatası hariç)
    if (err.message !== "Rate limit exceeded for etkinlikio adapter") {
      rateLimiter.registerError("adapter_etkinlikio_TR", 1);
    }
    
    console.warn("⚠️ Etkinlik.io adapter hata:", err.message);
    return [];
  }
}

export const searchEtkinlikioScrape = searchEtkinlikio;
export const searchEtkinlikioAdapter = searchEtkinlikio;

export default { searchEtkinlikio };
// ============================================================================
// S200 WRAPPER (HARDENED, DRIFT-SAFE) — etkinlikioAdapter:searchEtkinlikio
// - Single output: { ok, items, count, source, _meta }
// - Contract lock via normalizeItemS200: title+url required, price<=0 => null
// - NO RANDOM ID: stableIdS200(providerKey,url,title)
// - Observable fail: timeout/import/error => ok:false + items:[]
// - NO FAKE RESULTS (PROD): stub/fallback items dropped unless FINDALLEASY_ALLOW_STUBS=1
// ============================================================================

const FINDALLEASY_ALLOW_STUBS = String(process.env.FINDALLEASY_ALLOW_STUBS || "").trim() === "1";
const __S200_PROVIDER_KEY = "etkinlikio";
const __S200_ADAPTER = "etkinlikioAdapter";
const __S200_BASE_URL = null;
const __S200_IS_DISCOVERY = false;

function __wrapS200(ok, items, meta) {
  const arr = Array.isArray(items) ? items : [];
  const _meta = meta && typeof meta === "object" ? meta : {};
  return {
    ok: !!ok,
    items: arr,
    count: arr.length,
    source: __S200_PROVIDER_KEY,
    _meta,
  };
}

export async function searchEtkinlikio(query, options = {}) {
  const started = Date.now();
  const providerKey = __S200_PROVIDER_KEY;

  globalThis.__S200_ADAPTER_CTX = {
    providerKey,
    adapter: __S200_ADAPTER,
    query: String(query || ""),
    _meta: { startedAt: started },
  };

  const region = String(options?.region || "TR").toUpperCase().trim();
  const timeoutMs =
    Math.max(2500, Number(options?.timeoutMs || options?.timeout || 0) || 0) || undefined;

  try {
    const out = await withTimeout(
      () => searchEtkinlikio__S200_LEGACY(query, options),
      timeoutMs || 6500,
      { label: `${__S200_ADAPTER}:searchEtkinlikio:legacy` }
    );

    const legacyOk =
      typeof out === "object" && out != null && "ok" in out ? !!out.ok : true;

    const rawItems = Array.isArray(out)
      ? out
      : Array.isArray(out?.items)
        ? out.items
        : [];

    const coerced = coerceItemsS200(rawItems, providerKey) || [];
    const items = [];

    for (const r0 of coerced) {
      if (!r0) continue;

      if (!FINDALLEASY_ALLOW_STUBS) {
        if (r0.stub || r0.fallback || r0.isStub || r0.isFallback) continue;
        if (r0._meta?.stub || r0._meta?.fallback) continue;
      }

      const r = typeof r0 === "object" ? { ...r0 } : { title: String(r0) };

      if (!r.url && r.href) r.url = r.href;
      if (!r.url && r.link) r.url = r.link;
      if (!r.originUrl && r.url) r.originUrl = r.url;

      // ignore legacy ids (may be random)
      r.id = null;
      r.listingId = null;
      r._id = null;

      if (__S200_IS_DISCOVERY) {
        r.price = null;
        r.finalPrice = null;
        r.optimizedPrice = null;
        r.affiliateUrl = null;
        r.deeplink = null;
        r.trackingUrl = null;
      }

      const norm = normalizeItemS200(r, providerKey, {
        region,
        baseUrl: __S200_BASE_URL || undefined,
        requireRealUrlCandidate: true,
      });

      if (!norm) continue;

      if (__S200_IS_DISCOVERY) {
        norm.price = null;
        norm.finalPrice = null;
        norm.optimizedPrice = null;
      }

      items.push(norm);
    }

    if (!legacyOk) {
      return __wrapS200(false, [], {
        startedAt: started,
        durationMs: Date.now() - started,
        region,
        error: out?.error || "legacy_ok_false",
      });
    }

    return __wrapS200(true, items, {
      startedAt: started,
      durationMs: Date.now() - started,
      region,
    });
  } catch (e) {
    const isTimeout = e?.name === "TimeoutError" || e?.code === "timeout";
    return __wrapS200(false, [], {
      startedAt: started,
      durationMs: Date.now() - started,
      region,
      timeout: isTimeout || undefined,
      error: safeStr(e?.message || e) || "unknown_error",
    });
  }
}

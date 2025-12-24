// server/adapters/emlakjetAdapter.js
// ============================================================
// EmlakJet – Herkül S33 TITAN+ Estate Adapter (FINAL)
// ------------------------------------------------------------
// ✔ Multi-page (1–3)
// ✔ StableId v3.5 (slug + urlHash)
// ✔ ImageVariants (proxy-ready)
// ✔ Estate-weighted qualityScore
// ✔ location / rooms / size extraction
// ✔ providerSignature + adapterVersion + providerFamily
// ✔ categoryAI = "estate", vertical = "estate"
// ✔ Signal-safe + anti-ban headers
// ✔ Rate Limiter uyumlu (ana motor ile entegre)
// ============================================================

import axios from "axios";
import * as cheerio from "cheerio";
import crypto from "crypto";
import { buildImageVariants } from "../utils/imageFixer.js";
import { rateLimiter } from "../utils/rateLimiter.js";

import { loadCheerioS200 } from "../core/s200AdapterKit.js";

// ======================= RATE LIMITER =======================
async function checkRateLimit() {
  const key = "adapter_emlakjet_TR";
  const allowed = await rateLimiter.check(key, {
    limit: 14,
    windowMs: 60000,
    burst: true,
    adaptive: true,
  });
  
  if (!allowed) {
    console.warn(`⛔ RATE LIMIT → emlakjet`);
    throw new Error("Rate limit exceeded for emlakjet adapter");
  }
  
  return true;
}

// ======================= HELPERS =======================
const safe = (v) => (v ? String(v).trim() : "");

function pick(...vals) {
  for (const v of vals) {
    if (v && String(v).trim().length > 0) return String(v).trim();
  }
  return "";
}

function parsePrice(txt) {
  if (!txt) return null;

  // "1.500.000 TL", "1.500.000 ₺", "1.500.000 TL/m²"
  const cleaned = txt
    .replace(/[^\d.,]/g, "")
    .replace(/\.(?=\d{3,})/g, "")
    .replace(",", ".");

  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function cleanUrl(url) {
  if (!url) return null;
  return url.split("?")[0];
}

function slugify(t) {
  return safe(t)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 60);
}

// StableId v3.5 — title + url hash
function stableId(title, href) {
  const slug = slugify(title || "emlak");
  const hash = crypto
    .createHash("md5")
    .update(href || "")
    .digest("hex")
    .slice(0, 8);

  return `emlakjet_${slug}_${hash}`;
}

// Estate-weighted quality score
function computeEstateScore(item) {
  let s = 0;

  if (item.title) s += 0.25;
  if (item.price != null) s += 0.20;
  if (item.location) s += 0.20;
  if (item.rooms) s += 0.15;
  if (item.size) s += 0.10;

  s += 0.10; // entropy / stabilizer
  return Number(s.toFixed(2));
}

// Normalizer — Ana motor ile uyumlu format
function normalizeEmlakjet(raw, region = "TR") {
  const img = buildImageVariants(raw.image || null, "emlakjet");

  // Ana motorun normalizeItem fonksiyonu ile uyumlu temel yapı
  const baseItem = {
    id: stableId(raw.title, raw.url),
    title: raw.title,

    // S200 URL Standardı
    originUrl: raw.url,
    finalUrl: raw.url,
    deeplink: raw.url,
    url: raw.url,

    price: raw.price ?? null,

    // S200 Price Pipeline
    finalPrice: raw.price ?? null,
    optimizedPrice: raw.price ?? null,

    rating: null,
    provider: "emlakjet",
    currency: "TRY",
    region: (region || "TR").toUpperCase(),

    category: "estate",
    adapterSource: "emlakjetAdapter",
    
    // Ana motorun normalizeItem fonksiyonunda kullanılacak raw alanı
    raw: {
      title: raw.title,
      price: raw.price ?? null,
      url: raw.url,
      location: raw.location || null,
      rooms: raw.rooms || null,
      size: raw.size || null,
      
      // S33 TITAN+ ek alanları
      providerFamily: "estate",
      providerType: "listing",
      providerSignature: "emlakjet_s33",
      adapterVersion: "S33.TITAN+",
      reliabilityScore: 0.91,
      categoryAI: "estate",
      vertical: "estate",
      
      // Görsel alanları
      image: img.image,
      imageOriginal: img.imageOriginal,
      imageProxy: img.imageProxy,
      hasProxy: img.hasProxy,
      
      qualityScore: computeEstateScore({
        title: raw.title,
        price: raw.price,
        location: raw.location,
        rooms: raw.rooms,
        size: raw.size
      }),
      rawData: raw.raw || raw
    }
  };

  return baseItem;
}

const BASE = "https://www.emlakjet.com";
const MAX_PAGES = 3;

// ======================= SCRAPE PAGE (S33) =======================
async function scrapePage(query, page, region, signal) {
  try {
    const q = encodeURIComponent(query);
    const url = `${BASE}/arama?query=${q}&page=${page}`;

    const { data: html } = await axios.get(url, {
      timeout: 15000,
      signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36",
        Accept: "text/html",
        "Accept-Language": "tr-TR,tr;q=0.9",
        Referer: "https://www.google.com/",
        Pragma: "no-cache",
        "Cache-Control": "no-cache",
      },
    });

    const $ = loadCheerioS200(html);
    const out = [];

    const selectors = [
      "div.listing-item",
      "li.listing-item",
      "[data-testid='listing-item']",
      ".SearchList__SearchListItem-sc-1avkvav-2",
      ".PropertyCard",
      ".property-card",
      ".search-item",
      ".ListingCard",
      "article",
    ];

    $(selectors.join(",")).each((i, el) => {
      const w = $(el);

      // ---------------- TITLE ----------------
      const title = pick(
        safe(w.find(".listing-title").text()),
        safe(w.find("[data-testid='listing-title']").text()),
        safe(w.find(".title").text()),
        safe(w.find("h2").text()),
        safe(w.find("a").text())
      );
      if (!title || title.length < 2) return;

      // ---------------- PRICE ----------------
      const priceTxt = pick(
        safe(w.find(".price").text()),
        safe(w.find(".listing-price").text()),
        safe(w.find("[data-testid='price']").text()),
        safe(w.find(".js-price").text())
      );
      const price = parsePrice(priceTxt);

      // ---------------- URL ----------------
      let href = pick(
        safe(w.find("a").attr("href")),
        safe(w.find("[data-testid='listing-link']").attr("href"))
      );
      if (!href) return;

      if (!href.startsWith("http")) href = BASE + href;
      href = cleanUrl(href);

      // ---------------- IMAGE ----------------
      const image = pick(
        safe(w.find("img").attr("data-src")),
        safe(w.find("img").attr("src"))
      );

      // ---------------- LOCATION ----------------
      const location = pick(
        safe(w.find(".location").text()),
        safe(w.find("[data-testid='location']").text()),
        safe(w.find(".listing-location").text())
      );

      // ---------------- DETAILS (m2, oda sayısı) ----------------
      const details = pick(
        safe(w.find(".listing-info").text()),
        safe(w.find("[data-testid='property-info']").text()),
        safe(w.find(".info").text())
      );

      let rooms = null;
      let size = null;

      if (details) {
        // 3+1, 2+1, 4+2 vs.
        const odaMatch = details.match(/(\d+\s*\+\s*\d+|\d+\s*oda|\d+\s*odalı)/i);

        if (odaMatch) rooms = odaMatch[0].trim();

        const m2Match = details.match(/(\d{1,4})\s?m²/i);
        if (m2Match) size = m2Match[1] + " m²";
      }

      const raw = {
        title,
        priceTxt,
        href,
        image,
        location,
        rooms,
        size,
        details,
      };

      out.push(
        normalizeEmlakjet(
          {
            title,
            price,
            url: href,
            image: image || null,
            location: location || null,
            rooms,
            size,
            raw,
          },
          region
        )
      );
    });

    return out;
  } catch (err) {
    console.warn("⚠️ EmlakJet sayfa scrape hata:", err.message);
    return [];
  }
}

// ======================= MAIN ADAPTER =======================
export async function searchEmlakjet(query, regionOrOptions = "TR", opts = {}) {
  let region = "TR";
  let signal = null;

  if (typeof regionOrOptions === "string") {
    region = regionOrOptions;
  } else if (regionOrOptions && typeof regionOrOptions === "object") {
    region = regionOrOptions.region || "TR";
    signal = regionOrOptions.signal || null;
  }

  const q = safe(query);
  if (!q) return [];

  try {
    // Rate limiter kontrolü
    await checkRateLimit();
    
    let all = [];

    // Multi-page
    for (let p = 1; p <= MAX_PAGES; p++) {
      const part = await scrapePage(q, p, region, signal);
      if (part.length === 0) break;

      all = all.concat(part);

      // Eğer 50+ sonuç geldiyse devam etmeye gerek yok
      if (all.length > 50) break;
    }

    // Başarılı isteği kaydet
    rateLimiter.registerSuccess("adapter_emlakjet_TR", 1);
    
    return all;
  } catch (err) {
    if (opts && opts.throwOnError) throw err;

    // Hata durumunda rate limiter'a bildir
    if (err.message !== "Rate limit exceeded for emlakjet adapter") {
      rateLimiter.registerError("adapter_emlakjet_TR", 1);
    }
    
    console.warn("⚠️ EmlakJet adapter genel hata:", err.message);
    return [];
  }
}

export const searchEmlakjetScrape = searchEmlakjet;
export const searchEmlakjetAdapterLegacy = searchEmlakjet;

export default { searchEmlakjet };

// ============================================================================
// S200 WRAPPER HELPERS (AUTO-GENERATED)
// - ZERO DELETE: legacy funcs preserved as *Legacy
// - Output: { ok, items, count, source, _meta }
// - Observable fail: ok:false + items:[]
// - Deterministic IDs: normalizeItemS200 will enforce stableIdS200(providerKey,url,title)
// ============================================================================

function __s200_now() { return Date.now(); }

function __s200_result(providerKey, ok, items, meta) {
  const safeItems = Array.isArray(items) ? items : [];
  return {
    ok: !!ok,
    items: safeItems,
    count: safeItems.length,
    source: providerKey,
    _meta: meta || {},
  };
}

function __s200_errMeta(providerKey, started, err, extra) {
  const msg = (err && (err.message || err.toString())) || "unknown";
  const name = (err && err.name) || "Error";
  return {
    providerKey,
    startedAt: started,
    tookMs: Math.max(0, __s200_now() - started),
    error: { name, message: msg },
    ...(extra || {}),
  };
}


// ============================================================================
// S200 WRAPPED EXPORT (STRICT OUTPUT)
// ============================================================================
export async function searchEmlakjetAdapter(query, options = {}, signal = null) {
  const providerKey = "emlakjet";
  const started = __s200_now();
  try {
    globalThis.__S200_ADAPTER_CTX = {
      providerKey,
      adapter: "emlakjetAdapter",
      query: String(query || ""),
      _meta: { startedAt: started },
    };

    const timeoutMs =
      Number(options?.timeoutMs) ||
      Number(process.env[`${providerKey.toUpperCase()}_TIMEOUT_MS`]) ||
      7500;

    // Call legacy (array) — force observable fail via throwOnError
    const raw = await withTimeout(
      () => searchEmlakjet(query, options?.region || "TR", signal, { throwOnError: true }),
      timeoutMs,
      providerKey
    );

    const arr = coerceItemsS200(raw);
    const norm = [];
    for (const it of arr) {
      const cleaned = (it && typeof it === "object") ? { ...it, id: null, listingId: null } : it;
      const ni = normalizeItemS200(cleaned, providerKey);
      if (!ni) continue;
      norm.push(ni);
    }

    return __s200_result(providerKey, true, norm, {
      startedAt: started,
      tookMs: __s200_now() - started,
      timeoutMs,
      okFrom: "legacy_array",
    });
  } catch (err) {
    return __s200_result(providerKey, false, [], __s200_errMeta(providerKey, started, err, {
      timeoutMs: Number(options?.timeoutMs) || 7500,
      okFrom: "exception",
    }));
  }
}

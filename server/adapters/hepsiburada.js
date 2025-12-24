// server/adapters/hepsiburada.js
// =======================================================================
//  HEPSIBURADA — S33 TITAN+ → S200 FINAL MAX (HARDENED)
//  ZERO DELETE — hiçbir fonksiyon silinmedi, sadece güçlendirildi.
// =======================================================================

import axios from "axios";
import * as cheerio from "cheerio";
import crypto from "crypto";

import { sanitizePrice } from "../utils/priceSanitizer.js";
import { optimizePrice } from "../utils/priceFixer.js"; // ZERO-DELETE: import korunur (S200 default NO-OP)
import { buildImageVariants } from "../utils/imageFixer.js";
import { proxyFetchHTML } from "../core/proxyEngine.js";
import { buildAffiliateUrlS9 as buildAffiliateUrlS10 } from "./affiliateEngine.js";
import { rateLimiter } from "../utils/rateLimiter.js";

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

function looksBlockedHB(html = "") {
  const t = String(html || "").toLowerCase();
  if (!t) return false;

  // Common botwall / block signatures
  return (
    t.includes("captcha") ||
    t.includes("cloudflare") ||
    t.includes("access denied") ||
    t.includes("forbidden") ||
    t.includes("bot") ||
    t.includes("robot") ||
    t.includes("verify you are") ||
    t.includes("unusual traffic") ||
    t.includes("service unavailable") ||
    t.includes("please enable javascript")
  );
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


// =======================================================================
// ⭐️ S200 NORMALIZER — Tüm adapter çıktısını TEK STANDART YAPIYA ZORUNLU SOKAR
// =======================================================================

function normalizeS200(item) {
  if (!item) return null;

  // originUrl: temiz ürün linki
  const originUrl = item.url || item.originUrl || item.deeplink || null;

  // finalUrl: affiliate/deeplink varsa onu kullan
  const finalUrl = item.deeplink || item.affiliateUrl || originUrl;

  const subCategory =
    item.subCategory || item.categoryAI || item.category || "product";

  return {
    // S200 minimum alanlar
    id: item.id,
    title: item.title || "",
    price: item.price ?? null,

    provider: "hepsiburada",
    providerKey: "hepsiburada",
    providerFamily: "hepsiburada",
    providerType: "retailer",
    vertical: "product",

    category: item.category || "product",
    subCategory,
    categoryAI: item.categoryAI || "product",

    currency: item.currency || "TRY",
    region: String(item.region || "TR").toUpperCase(),

    // URL seti (motor hangi alanı ararsa bulsun)
    url: finalUrl || originUrl,
    originUrl,
    finalUrl,
    deeplink: finalUrl || originUrl,
    affiliateUrl: finalUrl || originUrl,

    // fiyat türevleri (S200 motor tarafında optimize eder; biz güvenli alan bırakırız)
    priceText: item.priceText ?? null,
    finalPrice: item.finalPrice ?? item.price ?? null,
    optimizedPrice: item.optimizedPrice ?? item.finalPrice ?? item.price ?? null,

    rating: item.rating ?? null,
    reviewCount: item.reviewCount ?? null,

    // stok / availability
    stockStatus:
      item.stock === "out" || item.stockStatus === "out_of_stock"
        ? "out_of_stock"
        : "in_stock",
    availability:
      item.stock === "out" || item.stockStatus === "out_of_stock"
        ? "out_of_stock"
        : "in_stock",

    // görsel
    image: item.image || null,
    imageOriginal: item.imageOriginal || null,
    imageProxy: item.imageProxy || null,
    hasProxy: item.hasProxy ?? false,

    // kalite
    qualityScore: item.qualityScore ?? 0,

    // raw (asla null olmasın)
    raw: item.raw || { legacy: item },
  };
}

// =======================================================================
// (DEVAMINDAKİ BÜTÜN S33 FONKSIYONLAR AYNEN KORUNDU — ZERO DELETE)
// =======================================================================

const safe = (v) => (v == null ? "" : String(v).trim());

function parsePriceStrong(txt) {
  if (!txt) return null;
  try {
    let clean = String(txt)
      .replace(/[^\d.,]/g, "")
      .replace(/\.(?=\d{3})/g, "")
      .replace(",", ".");
    const n = Number(clean);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function slugify(t) {
  return safe(t)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function stableId(provider, title, href, price) {
  const slug = slugify(title) || "item";
  const urlHash = crypto.createHash("md5").update(String(href || "")).digest("hex").slice(0, 6);
  return `${provider}_${slug}_${urlHash}`;
}

function inferCategoryAI(title) {
  const t = safe(title).toLowerCase();

  if (t.includes("iphone") || t.includes("galaxy") || t.includes("telefon"))
    return "smartphone";
  if (t.includes("laptop") || t.includes("notebook") || t.includes("macbook"))
    return "laptop";
  if (t.includes("kulaklık") || t.includes("earbuds") || t.includes("headset"))
    return "audio";
  if (t.includes("televizyon") || t.includes("tv") || t.includes("oled"))
    return "television";
  if (
    t.includes("çamaşır") ||
    t.includes("bulaşık") ||
    t.includes("buzdolabı") ||
    t.includes("kurutma") ||
    t.includes("fırın")
  )
    return "appliance";
  if (
    t.includes("klavye") ||
    t.includes("mouse") ||
    t.includes("monitor") ||
    t.includes("monitör")
  )
    return "computer-accessory";

  return "product";
}

function computeQualityScore(item) {
  let s = 0;

  if (item.title) s += 0.30;
  if (item.price != null) s += 0.25;
  if (item.image) s += 0.20;
  if (item.rating != null) s += 0.05;
  if (item.stock && item.stock !== "out") s += 0.10;
  if (item.categoryAI && item.categoryAI !== "product") s += 0.03;
  if (item.reviewCount && item.reviewCount > 10) s += 0.05;
  s += 0.02;

  return Number(s.toFixed(2));
}

function imageFallback(title) {
  const q = encodeURIComponent(title || "product");
  return `https://source.unsplash.com/featured/?product,${q}`;
}

function normalizeHepsiburadaUrl(rawHref) {
  let href = safe(rawHref);
  if (!href) return null;

  try {
    if (href.startsWith("//")) href = "https:" + href;

    if (!href.startsWith("http")) {
      href =
        "https://www.hepsiburada.com" +
        (href.startsWith("/") ? "" : "/") +
        href;
    }

    // 1) önce URL parse
    let u = new URL(href);

    // 2) redirect param varsa onu çöz ve yeniden parse et (önceki kodun en büyük açığı buydu)
    const redirectParam =
      u.searchParams.get("url") ||
      u.searchParams.get("redirect") ||
      u.searchParams.get("redirectUrl");

    if (redirectParam) {
      const decoded = decodeURIComponent(redirectParam);
      if (decoded && decoded.startsWith("http")) {
        href = decoded;
        u = new URL(href);
      }
    }

    // 3) tracking temizle
    [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "ref",
      "affiliateId",
      "af_ref",
      "gclid",
      "fbclid",
    ].forEach((k) => u.searchParams.delete(k));

    const qs = u.searchParams.toString();
    href = u.origin + u.pathname + (qs ? `?${qs}` : "");
  } catch {
    if (!href.startsWith("http")) {
      href = "https://www.hepsiburada.com" + href;
    }
  }

  return href;
}

function parseRating(root) {
  try {
    const avgTxt =
      safe(root.find("[data-test-id='review-average']").text()) ||
      safe(root.find(".rating-star").attr("data-rating")) ||
      safe(root.find(".rating-star").text());

    const countTxt =
      safe(root.find("[data-test-id='review-count']").text()) ||
      safe(root.find(".rating-count").text());

    let rating = null;
    let reviewCount = null;

    if (avgTxt) {
      const n = Number(
        avgTxt.replace(",", ".").replace(/[^\d.]/g, "").trim()
      );
      if (Number.isFinite(n) && n > 0 && n <= 5.0) rating = n;
    }

    if (countTxt) {
      const c = Number(countTxt.replace(/[^\d]/g, "").trim());
      if (Number.isFinite(c) && c >= 0) reviewCount = c;
    }

    return { rating, reviewCount };
  } catch {
    return { rating: null, reviewCount: null };
  }
}

function parseStock(root) {
  const txt =
    safe(root.find(".out-of-stock").text()) ||
    safe(root.find(".stock-info").text()) ||
    safe(root.find(".stok").text()) ||
    safe(root.find("[data-test-id='stock-info']").text()) ||
    ""; // ZERO-DELETE: root.text() çok false-positive üretiyor; bunu kısıyoruz

  const l = txt.toLowerCase();

  if (
    l.includes("tükendi") ||
    l.includes("stokta yok") ||
    l.includes("bulunmamaktadır") ||
    l.includes("sold out")
  )
    return "out";

  return "var";
}

// =======================================================================
// S200 yardımcılar (ek) — NO-CRASH wrappers
// =======================================================================

function safeSanitizePrice(n, opts = null) {
  if (n == null) return null;
  try {
    // sanitizePrice bazı projelerde (value, opts) ister; bazıları tek argüman.
    return opts ? sanitizePrice(n, opts) : sanitizePrice(n);
  } catch {
    return Number.isFinite(n) ? n : null;
  }
}

function safeBuildImage(imgRaw) {
  try {
    return buildImageVariants(imgRaw, "hepsiburada");
  } catch {
    return {
      image: imgRaw || null,
      imageOriginal: imgRaw || null,
      imageProxy: null,
      hasProxy: false,
    };
  }
}

function safeBuildAffiliate(provider, href, meta = {}) {
  try {
    if (typeof buildAffiliateUrlS10 === "function") {
      const u = buildAffiliateUrlS10(provider, href, meta);
      return u || href;
    }
  } catch {}
  return href;
}

function maybeOptimizePrice(finalPrice, region, opts = {}) {
  // S200 kuralı: default NO-OP. Eski S33 davranışını ENV/opts ile açarsın.
  const allow =
    opts?.allowOptimizePrice === true ||
    process.env.S200_ADAPTER_OPTIMIZE === "1" ||
    process.env.ALLOW_ADAPTER_OPTIMIZE === "1";

  if (!allow) return finalPrice;

  try {
    const out = optimizePrice(
      { price: finalPrice, provider: "hepsiburada" },
      { provider: "hepsiburada", region }
    );

    // optimizePrice bazı projelerde number döner, bazılarında objeyi mutate eder
    if (typeof out === "number" && Number.isFinite(out)) return out;
    if (out && typeof out === "object" && typeof out.price === "number")
      return out.price;
  } catch {}

  return finalPrice;
}

async function fetchHBHtml(url, { timeoutMs = 20000, headers = {}, signal = null } = {}) {
  // 1) proxyFetchHTML (ua-rotation vs.)
  try {
    const html = await proxyFetchHTML(url, {
      timeout: timeoutMs, // ZERO-DELETE compatibility
      timeoutMs, // yeni kullanım
      headers,
      signal,
    });
    if (looksBlockedHB(html)) {
      throw Object.assign(new Error("HB_BLOCKED"), { code: "HB_BLOCKED", status: 403 });
    }
    if (html && typeof html === "string" && html.length > 1000) return html;
  } catch (e) {
    // swallow here; caller strict mode will throw later if needed
  }

  // 2) direct axios
  try {
    const res = await axios.get(url, {
      timeout: timeoutMs,
      headers,
      signal,
      maxRedirects: 5,
      // 4xx'leri de yakalayalım ki strict modda observable fail olsun
      validateStatus: (s) => s >= 200 && s < 500,
    });

    const status = res?.status;
    const html = res?.data;
    if (!html || typeof html !== "string") {
      throw Object.assign(new Error("HB_EMPTY_HTML"), { code: "HB_EMPTY_HTML", status });
    }
    if (looksBlockedHB(html)) {
      throw Object.assign(new Error("HB_BLOCKED"), { code: "HB_BLOCKED", status: status || 403 });
    }
    if (status && status >= 400) {
      throw Object.assign(new Error(`HB_HTTP_${status}`), { code: "HB_HTTP", status });
    }
    return html;
  } catch (e) {
    // bubble up with status when possible
    const status = e?.status ?? e?.response?.status;
    const err = Object.assign(new Error(_errStr(e)), {
      code: e?.code || "HB_FETCH_FAIL",
      status: status || undefined,
    });
    throw err;
  }
}

// =======================================================================
// S33 DOM ITEM PARSER
// =======================================================================

function buildItemFromDom(root, region, opts = {}) {
  const title =
    safe(root.find("h3.product-title").text()) ||
    safe(root.find(".product-title").text()) ||
    safe(root.find("[data-test-id='product-title']").text()) ||
    safe(root.find("h2").text()) ||
    safe(root.find("a[title]").attr("title"));

  if (!title) return null;

  const lw = title.toLowerCase();
  if (
    lw.includes("tamir") ||
    lw.includes("onarım") ||
    lw.includes("servis") ||
    lw.includes("montaj") ||
    lw.includes("parça") ||
    lw.includes("ekran değişimi")
  ) {
    return null;
  }

  const ptxt =
    safe(root.find(".price-value").text()) ||
    safe(root.find(".product-price").text()) ||
    safe(root.find(".extra-discounted-price").text()) ||
    safe(root.find(".ins-price").text()) ||
    safe(root.find("[data-test-id='price-current-price']").text());

  const parsedStrong = parsePriceStrong(ptxt);
  const finalPrice = safeSanitizePrice(parsedStrong, {
    provider: "hepsiburada",
    region,
    category: "product",
  });

  const rawHref =
    safe(root.find("a[data-test-id='product-card-image']").attr("href")) ||
    safe(root.find("a[data-test-id='product-title']").attr("href")) ||
    safe(root.find("a").attr("href"));

  const href = normalizeHepsiburadaUrl(rawHref);
  if (!href) return null;

  let imgRaw =
    safe(root.find("img").attr("data-src")) ||
    safe(root.find("img").attr("data-original")) ||
    safe(root.find("img").attr("data-image-src")) ||
    safe(root.find("img").attr("src"));

  if (!imgRaw) imgRaw = imageFallback(title);

  const imageData = safeBuildImage(imgRaw);
  const stock = parseStock(root);
  const categoryAI = inferCategoryAI(title);
  const { rating, reviewCount } = parseRating(root);

  const id = stableId("hepsiburada", title, href, finalPrice);

  const optimizedPrice =
    finalPrice != null ? maybeOptimizePrice(finalPrice, region, opts) : null;

  // S200: deeplink üretmek serbest; ama çökmesine izin yok
  const deeplink = safeBuildAffiliate("hepsiburada", href, {
    region,
    rawTitle: title,
  });

  const base = {
    id,
    title,
    price: finalPrice,
    priceText: ptxt,
    finalPrice,
    optimizedPrice,

    url: href,
    originUrl: href,
    deeplink,
    affiliateUrl: deeplink,

    provider: "hepsiburada",
    providerType: "retailer",
    providerFamily: "hepsiburada",
    vertical: "product",

    currency: "TRY",
    region,

    category: "product",
    subCategory: categoryAI,
    categoryAI,

    rating,
    reviewCount,
    stock,

    image: imageData.image,
    imageOriginal: imageData.imageOriginal,
    imageProxy: imageData.imageProxy,
    hasProxy: imageData.hasProxy,

    qualityScore: computeQualityScore({
      title,
      price: finalPrice,
      image: imageData.image,
      rating,
      stock,
      categoryAI,
      reviewCount,
    }),

    raw: {
      ptxt,
      href,
      imgRaw,
      extractedAt: new Date().toISOString(),
      adapterVersion: "s200_hepsiburada_3.2",
    },
  };

  return base;
}

// JSON-LD fallback (ZERO DELETE)
function buildItemsFromJsonLd($, region, opts = {}) {
  const items = [];
  try {
    $("script[type='application/ld+json']").each((_, el) => {
      const txt = safe($(el).contents().text());
      if (!txt) return;

      let data;
      try {
        data = JSON.parse(txt);
      } catch {
        return;
      }

      const arr = Array.isArray(data) ? data : [data];

      for (const node of arr) {
        if (!node || typeof node !== "object") continue;

        if (Array.isArray(node.itemListElement)) {
          node.itemListElement.forEach((it) => {
            const product = it.item || it;

            if (!product || typeof product !== "object") return;

            const title = product.name || product.title;
            const offer = product.offers || {};
            const priceValue =
              offer.price ||
              (offer.priceSpecification && offer.priceSpecification.price);

            const parsed = parsePriceStrong(String(priceValue || ""));
            const finalPrice = safeSanitizePrice(parsed, {
              provider: "hepsiburada",
              region,
              category: "product",
            });

            const href =
              product.url ||
              (product["@id"] && String(product["@id"])) ||
              null;

            if (!title || !href) return;

            const normHref = normalizeHepsiburadaUrl(href);
            if (!normHref) return;

            const img =
              product.image ||
              (Array.isArray(product.image) ? product.image[0] : null) ||
              imageFallback(title);

            const imageData = safeBuildImage(img);
            const categoryAI = inferCategoryAI(title);
            const id = stableId("hepsiburada", title, normHref, finalPrice);

            const optimizedPrice =
              finalPrice != null ? maybeOptimizePrice(finalPrice, region, opts) : null;

            const deeplink = safeBuildAffiliate("hepsiburada", normHref, {
              region,
              rawTitle: title,
            });

            const rating =
              product.aggregateRating &&
              product.aggregateRating.ratingValue != null
                ? Number(
                    String(product.aggregateRating.ratingValue)
                      .replace(",", ".")
                      .replace(/[^\d.]/g, "")
                  )
                : null;

            const reviewCountRaw =
              product.aggregateRating &&
              product.aggregateRating.reviewCount != null
                ? Number(String(product.aggregateRating.reviewCount).replace(/[^\d]/g, ""))
                : null;

            const base = {
              id,
              title,
              price: finalPrice,
              priceText: finalPrice != null ? String(finalPrice) : null,
              finalPrice,
              optimizedPrice,

              url: normHref,
              originUrl: normHref,
              deeplink,
              affiliateUrl: deeplink,

              provider: "hepsiburada",
              providerType: "retailer",
              providerFamily: "hepsiburada",
              vertical: "product",

              currency: offer.priceCurrency || "TRY",
              region,

              category: "product",
              subCategory: categoryAI,
              categoryAI,

              rating: Number.isFinite(rating) ? rating : null,
              reviewCount: Number.isFinite(reviewCountRaw) ? reviewCountRaw : null,
              stock: "var",

              image: imageData.image,
              imageOriginal: imageData.imageOriginal,
              imageProxy: imageData.imageProxy,
              hasProxy: imageData.hasProxy,

              raw: {
                href: normHref,
                imgRaw: img,
                extractedAt: new Date().toISOString(),
                adapterVersion: "s200_hepsiburada_3.2_jsonld",
              },
            };

            items.push({
              ...base,
              qualityScore: computeQualityScore(base),
            });
          });
        }
      }
    });
  } catch {}

  return items;
}

// =======================================================================
// MAIN SCRAPER — FINAL OUTPUT = S200 NORMALIZED
// =======================================================================

export async function searchHepsiburadaLegacy(query, regionOrOptions = "TR") {
  // S200: invalid query => []
  if (!query || typeof query !== "string" || !query.trim()) return [];

  // region + options
  let region = "TR";
  let signal = null;
  let extraHeaders = {};
  let timeoutMs = 20000;
  let shadow = false;
  let strict = false;

  if (typeof regionOrOptions === "string") {
    region = regionOrOptions;
  } else if (regionOrOptions && typeof regionOrOptions === "object") {
    region = regionOrOptions.region || "TR";
    signal = regionOrOptions.signal || null;
    extraHeaders =
      regionOrOptions.headers ||
      regionOrOptions.requestHeaders ||
      regionOrOptions.proxyHeaders ||
      {};
    timeoutMs = Number(regionOrOptions.timeoutMs || regionOrOptions.timeout || 20000);
    shadow = Boolean(regionOrOptions.shadow);
  }

  region = String(region || "TR").toUpperCase();

  // Adapter-level RL (engine’de olsa bile HB agresif banlar)
  const bypassLocalRL =
    shadow ||
    process.env.S200_DISABLE_RL === "1" ||
    process.env.S200_RL_BYPASS === "1" ||
    process.env.DISABLE_RATE_LIMIT === "1";

  if (!bypassLocalRL) {
    try {
      const allowed = await rateLimiter.check(`s200:adapter:hepsiburada:${region}`, {
        limit: 12,
        windowMs: 60_000,
        burst: true,
        adaptive: true,
      });
      if (!allowed) return [];
    } catch {
      // RL patlarsa adapteri öldürme
    }
  }

  const q = encodeURIComponent(safe(query));
  const url = `https://www.hepsiburada.com/ara?q=${q}`;

  try {
    const headers = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.7,en;q=0.6",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      ...extraHeaders,
    };

    const html = await fetchHBHtml(url, { timeoutMs, headers, signal });

    const $ = loadCheerioS200(html);
    const items = [];

    const selectors = [
      "li.productListContent-item",
      "li.productListContent-z38",
      "li[data-test-id='product-card']",
      "div[data-test-id='product-card']",
      "div.product-card",
      "ul.ProductList li",
      ".search-item",
      ".shelf-product-card",
      "li[id*='i0']",
    ];

    $(selectors.join(",")).each((i, el) => {
      const node = $(el);
      const item = buildItemFromDom(node, region, regionOrOptions);
      if (!item) return;
      items.push(item);
    });

    if (items.length === 0) {
      const jsonLd = buildItemsFromJsonLd($, region, regionOrOptions);
      jsonLd.forEach((it) => items.push(it));
    }

    // EMERGENCY FALLBACK — aynen korunuyor
    if (items.length === 0) {
      $("a[href*='/-']").each((_, el) => {
        const a = $(el);
        const title = safe(a.attr("title") || a.text());
        if (!title) return;

        const href = normalizeHepsiburadaUrl(a.attr("href"));
        if (!href) return;

        const id = stableId("hepsiburada", title, href, null);

        const img = safe(a.find("img").attr("src")) || imageFallback(title);

        const imageData = safeBuildImage(img);
        const categoryAI = inferCategoryAI(title);

        const deeplink = safeBuildAffiliate("hepsiburada", href, {
          region,
          rawTitle: title,
        });

        const base = {
          id,
          title,
          price: null,
          priceText: null,
          finalPrice: null,
          optimizedPrice: null,

          url: href,
          originUrl: href,
          deeplink,
          affiliateUrl: deeplink,

          provider: "hepsiburada",
          providerType: "retailer",
          providerFamily: "hepsiburada",
          vertical: "product",

          currency: "TRY",
          region,

          category: "product",
          subCategory: categoryAI,
          categoryAI,

          rating: null,
          reviewCount: null,
          stock: "var",

          image: imageData.image,
          imageOriginal: imageData.imageOriginal,
          imageProxy: imageData.imageProxy,
          hasProxy: imageData.hasProxy,

          raw: {
            href,
            imgRaw: img,
            extractedAt: new Date().toISOString(),
            adapterVersion: "s200_hepsiburada_3.2_emergency",
          },
        };

        items.push({
          ...base,
          qualityScore: computeQualityScore(base),
        });
      });
    }

    // dedupe (url bazlı)
    const seen = new Set();
    const deduped = [];
    for (const it of items) {
      const key = it?.url || it?.deeplink || it?.id;
      if (!key) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(it);
      if (deduped.length >= 60) break;
    }

    const finalItems = deduped.slice(0, 40);

    // ⭐⭐⭐ S200 CAST — ANA MOTORUN İSTEDİĞİ TEK FORMAT
    return finalItems.map((x) => normalizeS200(x)).filter(Boolean);
    } catch (err) {
    const msg = err?.message || String(err);
    if (strict) {
      const status = err?.status ?? err?.response?.status;
      const e = Object.assign(new Error(msg), {
        code: err?.code || "HB_FAIL",
        status: status || undefined,
      });
      throw e;
    }
    console.warn("HB hata:", msg);
    return [];
  }
}

export const searchHepsiburadaAdapterLegacy = searchHepsiburadaLegacy;
// (S200) export default moved to bottom

// ============================================================================
// S200 WRAPPER (single output format) — preferred
// ============================================================================
export async function searchHepsiburadaAdapter(query, regionOrOptions = "TR") {
  let region = "TR";
  let options = {};
  if (typeof regionOrOptions === "string") {
    region = regionOrOptions || "TR";
  } else if (regionOrOptions && typeof regionOrOptions === "object") {
    region = regionOrOptions.region || "TR";
    options = regionOrOptions;
  }
  const timeoutMs = Number(options.timeoutMs || process.env.S200_PROVIDER_TIMEOUT_MS || 6500);

  const prevCtx = globalThis.__S200_ADAPTER_CTX;
  globalThis.__S200_ADAPTER_CTX = { adapter: "hepsiburada", providerKey: "hepsiburada", url: "" };

  try {
const rooStrict =
  typeof regionOrOptions === "string"
    ? { region, strict: true }
    : { ...options, region, strict: true };

const raw = await withTimeout(() => searchHepsiburadaLegacy(query, rooStrict), timeoutMs, "hepsiburada.legacy");
    const items = _normalizeMany(raw, "hepsiburada", { providerFamily: "hepsiburada", vertical: "product", category: "product", currency: "TRY", region, baseUrl: "https://www.hepsiburada.com" });
    return _mkRes("hepsiburada", true, items, { code: items.length ? "OK" : "OK_EMPTY", region, timeoutMs });
  } catch (err) {
    return _mkRes("hepsiburada", false, [], { code: _isTimeout(err) ? "TIMEOUT" : "ERROR", error: _errStr(err), region, timeoutMs });
  } finally {
    globalThis.__S200_ADAPTER_CTX = prevCtx;
  }
}

export const searchHepsiburada = searchHepsiburadaAdapter;


export default { searchHepsiburada };

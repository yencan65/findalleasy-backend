// server/adapters/pttavmAdapter.js
// ============================================================================
// PTTAVM — S200 HARDENED (v2025.12.19)
// ProxyFetchHTML • StableID • Price Extractor Hardened • Image Picker
// ZERO DELETE — mevcut export isimleri korunur, sadece güçlendirilir.
//
// Patch:
// ✅ Price extraction güçlendirildi (data-* / itemprop / text regex / anchor fallback)
// ✅ Badge image yerine ürün görselini seç (product_badges filtre)
// ✅ Daha sağlam ürün link yakalama (-p-<id>) + dedupe
// ✅ Alias exports eklendi (case drift yüzünden “fn is not a function” yemeyesin)
// ============================================================================

import { proxyFetchHTML } from "../core/proxyEngine.js";

import {
  loadCheerioS200,
  normalizeItemS200,
  stableIdS200,
  withTimeout,
  TimeoutError,
} from "../core/s200AdapterKit.js";

import { sanitizePrice } from "../utils/priceSanitizer.js";
import { optimizePrice } from "../utils/priceFixer.js";
import { buildImageVariants } from "../utils/imageFixer.js";

const PROVIDER_KEY = "pttavm";
const BASE = "https://www.pttavm.com";
const TIMEOUT_MS = Number(process.env.S200_PROVIDER_TIMEOUT_MS || 6500);

function safe(v) {
  return v ? String(v).trim() : "";
}

function cleanText(v) {
  return safe(v).replace(/\s+/g, " ").trim();
}

function normalizeHref(href) {
  const h = safe(href);
  if (!h) return "";
  if (h.startsWith("http://") || h.startsWith("https://")) return h;
  if (h.startsWith("//")) return "https:" + h;
  if (h.startsWith("/")) return BASE + h;
  return BASE + "/" + h;
}

function isLikelyProductUrl(url) {
  const u = safe(url);
  // PTTAVM ürün URL’leri genelde “-p-<digits>” ile biter.
  return /-p-\d+/i.test(u) || /\/p-\d+/i.test(u);
}

function stripPriceFromText(txt) {
  const t = cleanText(txt);
  if (!t) return "";
  // En sondaki “12.345,67 TL/₺” parçasını kırp.
  const all = [...t.matchAll(/(\d[\d\.\s]*([,\.]\d{1,2})?)\s*(TL|₺)\b/gi)];
  if (!all.length) return t;
  const last = all[all.length - 1];
  const idx = last?.index ?? -1;
  if (idx <= 0) return t;
  return cleanText(t.slice(0, idx));
}

function pickFirstNonEmpty(...vals) {
  for (const v of vals) {
    const s = safe(v);
    if (s) return s;
  }
  return "";
}

function pickAttr($, el, ...attrs) {
  for (const a of attrs) {
    const v = $(el).attr(a);
    if (safe(v)) return safe(v);
  }
  return "";
}

function pickDataPrice($, root) {
  // data-price benzeri attribute’larda bazen direkt sayı olur.
  const attrs = [
    "data-price",
    "data-prc",
    "data-sale-price",
    "data-final-price",
    "data-price-amount",
    "data-priceamount",
    "data-product-price",
    "data-productprice",
  ];
  for (const attr of attrs) {
    const v = pickAttr($, root, attr);
    if (v) return v;
  }
  // root altında da ara
  const els = $(root)
    .find(
      "[data-price],[data-prc],[data-sale-price],[data-final-price],[data-price-amount],[data-priceamount],[data-product-price],[data-productprice]"
    )
    .toArray();
  for (const el of els) {
    const v = pickAttr($, el, ...attrs);
    if (v) return v;
  }
  return "";
}

function extractPriceTextS22($, card, anchorEl) {
  // 1) data-* numeric
  const dataPrice = pickDataPrice($, card);
  if (dataPrice) return cleanText(dataPrice);

  // 2) itemprop price (meta content veya span)
  const metaPrice = $(card).find("meta[itemprop='price']").attr("content");
  if (safe(metaPrice)) return cleanText(metaPrice);

  const itemprop = $(card).find("[itemprop='price']").first();
  if (itemprop?.length) {
    const c = itemprop.attr("content");
    if (safe(c)) return cleanText(c);
    const t = cleanText(itemprop.text());
    if (t) return t;
  }

  // 3) class/selector heuristics (en yaygın)
  const priceSelectors = [
    ".price",
    ".product-price",
    ".productPrice",
    ".sale-price",
    ".current-price",
    ".amount",
    ".prd-price",
    ".search-price",
    "[class*='price']",
    "[class*='Price']",
  ];
  for (const sel of priceSelectors) {
    const node = $(card).find(sel).first();
    if (!node?.length) continue;
    const t = cleanText(node.text());
    if (t && /\d/.test(t)) return t;
  }

  // 4) anchor text’inden yakala (sayfa erişilebilir modda title+price tek satır gelebiliyor)
  if (anchorEl) {
    const aText = cleanText($(anchorEl).text());
    const mAll = [...aText.matchAll(/(\d[\d\.\s]*([,\.]\d{1,2})?)\s*(TL|₺)\b/gi)];
    if (mAll.length) return cleanText(mAll[mAll.length - 1][0]);
  }

  // 5) card full text regex (son çare)
  const full = cleanText($(card).text());
  const mAll = [...full.matchAll(/(\d[\d\.\s]*([,\.]\d{1,2})?)\s*(TL|₺)\b/gi)];
  if (mAll.length) return cleanText(mAll[mAll.length - 1][0]);

  return "";
}

function parsePriceS22(priceText) {
  const txt = cleanText(priceText);
  if (!txt) return null;

  // Eğer attribute’dan “43998” gibi geldiyse de sanitize et.
  const p = sanitizePrice(txt);
  if (!p || p <= 0) return null;
  const op = optimizePrice(p);
  return op && op > 0 ? op : p;
}

function extractTitleS22($, card, anchorEl) {
  // Öncelik: card içindeki title alanları
  const t1 = cleanText($(card).find(".title, .product-title, h3, h2").first().text());
  if (t1) return stripPriceFromText(t1);

  // anchor title attr
  if (anchorEl) {
    const tAttr = pickAttr($, anchorEl, "title", "aria-label");
    if (tAttr) return stripPriceFromText(tAttr);

    // anchor text
    const t2 = cleanText($(anchorEl).text());
    if (t2) return stripPriceFromText(t2);
  }

  // fallback: card text
  const t3 = cleanText($(card).text());
  return stripPriceFromText(t3);
}

function extractProductImageS22($, card, anchorEl) {
  const imgs = [];

  const pushSrc = (src) => {
    const s = safe(src);
    if (!s) return;
    if (s.startsWith("data:")) return;
    // badge/ikonları ele (senin çıktıda yakaladığın bu: product_badges)
    if (/product_badges/i.test(s)) return;
    if (/badge|icon|sprite/i.test(s)) return;
    imgs.push(s);
  };

  const scan = (root) => {
    if (!root) return;
    const nodes = $(root).find("img").toArray();
    for (const img of nodes) {
      pushSrc($(img).attr("data-src"));
      pushSrc($(img).attr("data-original"));
      pushSrc($(img).attr("src"));
    }
  };

  scan(card);
  scan(anchorEl);

  // Eğer hiç bulamadıysak badge’i bile alalım (hiç resim olmamasından iyidir)
  if (!imgs.length) {
    const fallback = $(card).find("img").first();
    if (fallback?.length) {
      const s = pickFirstNonEmpty(
        fallback.attr("data-src"),
        fallback.attr("data-original"),
        fallback.attr("src")
      );
      if (s && !s.startsWith("data:")) imgs.push(s);
    }
  }

  // seçim: ilk
  return imgs[0] || "";
}

function detectCategoryS22(title) {
  const t = cleanText(title).toLowerCase();
  // “kılıf” sorgusunda electronics diye kirletme.
  if (/(kılıf|kilif|case|cover|kapak|ekran koruyucu|temperli|cam|film)/i.test(t)) return "accessories";
  if (/(iphone|ipad|macbook|samsung|xiaomi|telefon|akıllı|laptop|bilgisayar|tablet|kulaklık)/i.test(t)) return "electronics";
  return "product";
}

// ----------------------------------------------------------------------------
// Core scrape
// ----------------------------------------------------------------------------
async function searchPTTAVMScrape(query = "", region = "TR") {
  const q = cleanText(query);
  const url = `${BASE}/arama?q=${encodeURIComponent(q || "")}`;

  const startedAt = Date.now();
  try {
    const html = await withTimeout(
      proxyFetchHTML(url, {
        headers: {
          "accept-language": "tr-TR,tr;q=0.9,en;q=0.7",
        },
      }),
      TIMEOUT_MS,
      `pttavm timeout (${TIMEOUT_MS}ms)`
    );

    const $ = loadCheerioS200(html);

    // Öncelik: ürün linkleri
    const anchors = $("a[href]")
      .toArray()
      .filter((a) => isLikelyProductUrl(normalizeHref($(a).attr("href"))));

    // Fallback: eski yaklaşım (çok geniş) — ama crash yok.
    const fallbackCards = $(".product, .product-card, .product-item, .prd, li").toArray();

    const seen = new Set();
    const rawItems = [];

    const makeFrom = (cardEl, aEl) => {
      if (!aEl) return;
      const $a = $(aEl);
      const $card = cardEl ? $(cardEl) : $a.closest(".product, .product-card, .product-item, .prd, li");
      const href = normalizeHref($a.attr("href") || $card.find("a[href]").first().attr("href"));
      if (!href || !isLikelyProductUrl(href)) return;
      if (seen.has(href)) return;

      const rootEl = cardEl || $card.get(0) || $a.parent().get(0);

      const title = extractTitleS22($, rootEl, aEl);
      if (!title) return;

      const priceText = extractPriceTextS22($, rootEl, aEl);
      const price = parsePriceS22(priceText);

      const image = extractProductImageS22($, rootEl, aEl);
      const images = buildImageVariants(image);

      const category = detectCategoryS22(title);

      rawItems.push({
        id: stableIdS200(PROVIDER_KEY, href, title),
        title,
        url: href,
        price,
        currency: "TRY",
        providerKey: PROVIDER_KEY,
        provider: "market",
        vertical: "product",
        category,
        region,
        image: images.image,
        ...images,
        // Debug için sakla (fiyat null olursa nereden geldiğini gör)
        raw: {
          originUrl: href,
          url: href,
          priceText: priceText || null,
        },
      });

      seen.add(href);
    };

    if (anchors.length) {
      for (const a of anchors) {
        const card = $(a).closest(".product, .product-card, .product-item, .prd, li");
        const cardEl = card?.length ? card.get(0) : $(a).parent().get(0);
        makeFrom(cardEl, a);
        if (rawItems.length >= 60) break;
      }
    } else {
      for (const el of fallbackCards) {
        const card = $(el);
        const a = card.find("a[href]").first();
        const aEl = a?.length ? a.get(0) : null;
        if (!aEl) continue;
        makeFrom(el, aEl);
        if (rawItems.length >= 60) break;
      }
    }

    const items = rawItems
      .map((it) => normalizeItemS200(it, PROVIDER_KEY))
      .filter(Boolean);

    const out = asS200ArrayResult(items, {
      ok: true,
      source: PROVIDER_KEY,
      _meta: {
        query: q,
        url,
        region,
        tookMs: Date.now() - startedAt,
        parsed: items.length,
        // yardımcı debug: kaçında fiyat yakaladık
        priced: items.filter((x) => x && x.price != null).length,
      },
    });

    return out;
  } catch (e) {
    const isTimeout = e instanceof TimeoutError || /timeout/i.test(String(e?.message || e));
    return asS200ArrayResult([], {
      ok: false,
      source: PROVIDER_KEY,
      _meta: {
        query: q,
        url,
        region,
        error: safe(e?.message || e),
        timeout: !!isTimeout,
      },
    });
  }
}

// ----------------------------------------------------------------------------
// Public entrypoints (ZERO DELETE)
// ----------------------------------------------------------------------------
async function searchPTTAVM(query, region = "TR") {
  return searchPTTAVMScrape(query, region);
}

async function searchPTTAVMAdapter(query, region = "TR") {
  return searchPTTAVM(query, region);
}

// ----------------------------------------------------------------------------
// Compat helpers
// ----------------------------------------------------------------------------
function asS200ArrayResult(items, opts = {}) {
  const arr = Array.isArray(items) ? items : [];
  const ok = !!opts.ok;
  const source = opts.source || PROVIDER_KEY;
  const _meta = opts._meta || {};

  // Array üstüne S200 alanları ekleyip geri dönüyoruz.
  // Not: Bu formatı sistemin diğer yerlerinde zaten tolere ediyorsun.
  arr.ok = ok;
  arr.items = arr;
  arr.count = arr.length;
  arr.source = source;
  arr._meta = _meta;
  return arr;
}

// ----------------------------------------------------------------------------
// Exports (ZERO DELETE + alias)
// ----------------------------------------------------------------------------
export { searchPTTAVM, searchPTTAVMAdapter, searchPTTAVMScrape };

// Alias exports: yanlış casing/isim yüzünden “fn is not a function” yemeyesin.
export const searchPttavm = searchPTTAVM;
export const searchPttavmAdapter = searchPTTAVMAdapter;
export const searchPttavmScrape = searchPTTAVMScrape;

export default {
  searchPTTAVM,
  searchPTTAVMAdapter,
  searchPTTAVMScrape,
  // alias
  searchPttavm,
  searchPttavmAdapter,
  searchPttavmScrape,
};

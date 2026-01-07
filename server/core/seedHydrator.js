// server/core/seedHydrator.js
// ============================================================
//  SEED HYDRATOR — S1 (GENERIC PRICE EXTRACTION)
//  Amaç: URL seed -> (title + price + currency + image) çıkar,
//        sonra S200 item’a dönüştür.
//  Not: Bu fallback; en iyi-effort. Price yoksa item üretilmez.
// ============================================================

import { httpGet } from "../utils/httpClient.js";

function safeStr(x) {
  return x == null ? "" : String(x);
}

function normalizeUrl(u) {
  try {
    const url = new URL(u);
    // remove obvious tracking params
    const kill = [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "gclid",
      "fbclid",
      "yclid",
      "mc_cid",
      "mc_eid",
      "ref",
      "ref_",
      "tag",
    ];
    for (const k of kill) url.searchParams.delete(k);
    // trim fragments
    url.hash = "";
    return url.toString();
  } catch {
    return safeStr(u).trim();
  }
}

function hostnameOf(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function findFirstMeta(html, patterns) {
  for (const p of patterns) {
    const m = html.match(p);
    if (m && m[1]) return safeStr(m[1]).trim();
  }
  return "";
}

function decodeHtmlEntities(s) {
  // minimal decode: enough for titles
  return safeStr(s)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .trim();
}

function parseLocalePrice(raw) {
  const s = safeStr(raw).replace(/\s+/g, " ").trim();
  if (!s) return null;

  // currency detect
  let currency = "";
  const curMap = [
    { re: /₺|TL|TRY/i, cur: "TRY" },
    { re: /\bUSD\b|\$/i, cur: "USD" },
    { re: /\bEUR\b|€/i, cur: "EUR" },
    { re: /\bGBP\b|£/i, cur: "GBP" },
  ];
  for (const c of curMap) {
    if (c.re.test(s)) {
      currency = c.cur;
      break;
    }
  }

  // keep digits + separators
  const numPart = s.replace(/[^\d.,]/g, "");
  if (!numPart) return null;

  // Decide decimal separator: last occurrence of '.' or ','
  const lastDot = numPart.lastIndexOf(".");
  const lastComma = numPart.lastIndexOf(",");
  let decSep = "";
  if (lastDot >= 0 || lastComma >= 0) {
    decSep = lastDot > lastComma ? "." : ",";
  }

  let normalized = numPart;
  if (decSep === ",") {
    // TR style: thousands '.' , decimal ','
    normalized = normalized.replace(/\./g, "").replace(",", ".");
  } else if (decSep === ".") {
    // US style: thousands ',' , decimal '.'
    normalized = normalized.replace(/,/g, "");
  } else {
    // integers
    normalized = normalized.replace(/[.,]/g, "");
  }

  const val = Number(normalized);
  if (!Number.isFinite(val) || val <= 0) return null;

  return { value: val, currency: currency || "" };
}

function extractJsonLd(html) {
  const out = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const raw = safeStr(m[1]).trim();
    if (!raw) continue;
    try {
      // Some pages put multiple JSON objects; try parse directly
      const json = JSON.parse(raw);
      out.push(json);
    } catch {
      // try to salvage: strip leading/trailing junk
      try {
        const cleaned = raw
          .replace(/^\s*<!--/g, "")
          .replace(/-->\s*$/g, "")
          .trim();
        const json = JSON.parse(cleaned);
        out.push(json);
      } catch {
        // ignore
      }
    }
  }
  return out;
}

function flattenJsonLd(node, acc) {
  if (node == null) return;
  if (Array.isArray(node)) {
    for (const it of node) flattenJsonLd(it, acc);
    return;
  }
  if (typeof node === "object") {
    acc.push(node);
    // common wrappers
    if (node["@graph"]) flattenJsonLd(node["@graph"], acc);
    return;
  }
}

function pickProductFromLd(ldObjs) {
  const flat = [];
  for (const o of ldObjs) flattenJsonLd(o, flat);
  // prefer Product
  for (const o of flat) {
    const t = safeStr(o["@type"]).toLowerCase();
    if (t === "product" || t.includes("product")) return o;
  }
  return null;
}

function pickOfferPrice(product) {
  if (!product) return null;
  const offers = product.offers;
  const list = Array.isArray(offers) ? offers : offers ? [offers] : [];
  for (const off of list) {
    const price = off?.price ?? off?.priceSpecification?.price;
    const currency = off?.priceCurrency ?? off?.priceSpecification?.priceCurrency;
    const parsed = parseLocalePrice(`${price ?? ""} ${currency ?? ""}`);
    if (parsed) return parsed;
  }
  // some sites: product.price
  const p2 = product.price || product.lowPrice || product.highPrice;
  const c2 = product.priceCurrency;
  const parsed2 = parseLocalePrice(`${p2 ?? ""} ${c2 ?? ""}`);
  if (parsed2) return parsed2;
  return null;
}

function pickTitle(html, product) {
  const og = findFirstMeta(html, [
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+name=["']og:title["'][^>]+content=["']([^"']+)["'][^>]*>/i,
  ]);
  if (og) return decodeHtmlEntities(og);

  const ldName = product?.name;
  if (ldName) return decodeHtmlEntities(ldName);

  const t = findFirstMeta(html, [/<title[^>]*>([^<]+)<\/title>/i]);
  if (t) return decodeHtmlEntities(t);

  return "";
}

function pickImage(html, product) {
  const og = findFirstMeta(html, [
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+name=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*>/i,
  ]);
  if (og) return og;

  const img = product?.image;
  if (Array.isArray(img) && img[0]) return safeStr(img[0]);
  if (typeof img === "string") return img;

  return "";
}

function pickSnippet(html) {
  const d = findFirstMeta(html, [
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["'][^>]*>/i,
  ]);
  return decodeHtmlEntities(d);
}

export async function hydrateSeedUrl(url, { timeoutMs } = {}) {
  const u = normalizeUrl(url);
  if (!u) return { ok: false, url: u, reason: "empty_url" };

  // Basic sanity: avoid obvious non-html
  if (/\.(pdf|jpg|jpeg|png|webp|gif|svg)(\?|$)/i.test(u)) {
    return { ok: false, url: u, reason: "non_html" };
  }

  try {
    const r = await httpGet(u, {
      timeoutMs: timeoutMs ?? Number(process.env.SEED_HYDRATE_TIMEOUT_MS || 5000),
      retries: Number(process.env.SEED_HYDRATE_RETRIES || 1),
      headers: {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": process.env.SEED_HYDRATE_ACCEPT_LANGUAGE || "tr-TR,tr;q=0.9,en;q=0.8",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
      },
      responseType: "text",
    });

    const html = safeStr(r?.data || "");
    if (!html) return { ok: false, url: u, reason: "empty_html" };

    const ld = extractJsonLd(html);
    const product = pickProductFromLd(ld);
    const offer = pickOfferPrice(product);

    // Fallback: meta price
    let metaPrice = null;
    if (!offer) {
      const mp = findFirstMeta(html, [
        /<meta[^>]+property=["']product:price:amount["'][^>]+content=["']([^"']+)["'][^>]*>/i,
        /<meta[^>]+property=["']product:price["'][^>]+content=["']([^"']+)["'][^>]*>/i,
        /itemprop=["']price["'][^>]*content=["']([^"']+)["']/i,
      ]);
      const mc = findFirstMeta(html, [
        /<meta[^>]+property=["']product:price:currency["'][^>]+content=["']([^"']+)["'][^>]*>/i,
        /itemprop=["']priceCurrency["'][^>]*content=["']([^"']+)["']/i,
      ]);
      metaPrice = parseLocalePrice(`${mp} ${mc}`);
    }

    const picked = offer || metaPrice;
    if (!picked) return { ok: false, url: u, reason: "no_price" };

    const title = pickTitle(html, product);
    const image = pickImage(html, product);
    const snippet = pickSnippet(html);
    const host = hostnameOf(u);

    return {
      ok: true,
      url: u,
      host,
      title: title || host || "Item",
      image: image || "",
      snippet: snippet || "",
      price: picked.value,
      currency: picked.currency || "",
    };
  } catch (e) {
    return { ok: false, url: u, reason: e?.message || String(e) };
  }
}

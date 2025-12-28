// ============================================================================
// FEED INGEST WORKER — S200 ULTRA (GENERIC)
// ZERO DELETE: Yeni worker. Var olan admitadIngest.mjs aynen durur.
//
// Hedef:
//   Herhangi bir affiliate product feed (CSV / XML / JSON) -> MongoDB: catalog_items
//   Sonra /api/catalog/search ve catalogAdapter üzerinden /api/search'e akar.
//
// ENV (minimum):
//   MONGO_URI / MONGODB_URI
//   FEED_URL
//
// ENV (opsiyonel):
//   FEED_PROVIDER_KEY           (default: "feed")
//   FEED_PROVIDER_NAME          (default: providerKey)
//   FEED_CAMPAIGN_ID            (default: "0")
//   FEED_FORMAT                 (csv|xml|json)  // otomatik tespit eder
//   FEED_ITEM_PATH              (xml/json için dot-path, ör: "yml_catalog.shop.offers.offer")
//   FEED_DEFAULT_CURRENCY       (default: "TRY")
//   FEED_HEADERS_JSON           (JSON string)   // ör: {"Authorization":"Bearer ..."}
//   FEED_GZIP                   (1 => zorla gzip aç)
//   FEED_MAX_ITEMS              (default: 20000) // ilk aşama için güvenlik
// ============================================================================

import "dotenv/config";
import mongoose from "mongoose";
import crypto from "node:crypto";
import zlib from "node:zlib";
import fetch from "node-fetch";

import { parse as parseCsv } from "csv-parse/sync";
import { XMLParser } from "fast-xml-parser";
// ------------------------------
// Helpers
// ------------------------------
const now = () => new Date();

function toNum(x) {
  if (x == null) return null;
  if (typeof x === "number" && Number.isFinite(x)) return x;
  const s = String(x).trim();
  if (!s) return null;
  // "1.234,56" -> "1234.56" / "1,234.56" -> "1234.56" (best-effort)
  const normalized = s
    .replace(/\s+/g, "")
    .replace(/\.(?=\d{3}(\D|$))/g, "")
    .replace(/,(?=\d{1,2}(\D|$))/g, ".")
    .replace(/[^0-9.\-]/g, "");
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function firstNonEmpty(...vals) {
  for (const v of vals) {
    if (v == null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return null;
}

function getByPath(obj, path) {
  if (!path) return null;
  const parts = String(path).split(".").filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return null;
    cur = cur[p];
  }
  return cur;
}

function collectArrays(node, path, out) {
  if (node == null) return;
  if (Array.isArray(node)) {
    if (node.length && typeof node[0] === "object") out.push({ path, arr: node });
    return;
  }
  if (typeof node !== "object") return;
  for (const [k, v] of Object.entries(node)) {
    collectArrays(v, path ? `${path}.${k}` : k, out);
  }
}

function scoreItem(obj) {
  if (!obj || typeof obj !== "object") return 0;
  const keys = Object.keys(obj).map((k) => k.toLowerCase());
  const has = (re) => keys.some((k) => re.test(k));
  let score = 0;
  if (has(/(^|_)(name|title|product)/)) score += 3;
  if (has(/(^|_)(url|link|deeplink)/)) score += 3;
  if (has(/(^|_)(price|sale_price|current_price|amount)/)) score += 3;
  if (has(/(^|_)(image|picture|img)/)) score += 1;
  if (has(/(^|_)(id|sku|offer)/)) score += 1;
  return score;
}

function pickBestArray(root, overridePath) {
  if (overridePath) {
    const v = getByPath(root, overridePath);
    if (Array.isArray(v)) return { path: overridePath, arr: v };
    if (v && typeof v === "object") {
      // tek obje geldiyse listeye sar.
      return { path: overridePath, arr: [v] };
    }
  }

  const arrays = [];
  collectArrays(root, "", arrays);
  let best = null;
  let bestScore = -1;

  for (const c of arrays) {
    const sample = c.arr.slice(0, 5);
    const s = sample.reduce((acc, it) => acc + scoreItem(it), 0);
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }

  return best;
}

function stableFallbackId(title, url) {
  const base = `${title || ""}::${url || ""}`;
  return crypto.createHash("sha1").update(base).digest("hex").slice(0, 16);
}

function normalizeRawItem(raw, defaults) {
  const rawObj = raw && typeof raw === "object" ? raw : {};

  // XML parser attributes often come with "@" prefix. Keep synonyms broad.
  const id = firstNonEmpty(
    rawObj.offer_id,
    rawObj.offerId,
    rawObj.product_id,
    rawObj.productId,
    rawObj.id,
    rawObj.sku,
    rawObj.SKU,
    rawObj["g:id"],
    rawObj["@id"],
    rawObj["@offer_id"],
    rawObj["@product_id"]
  );

  const title = firstNonEmpty(
    rawObj.name,
    rawObj.title,
    rawObj.product_name,
    rawObj.productName,
    rawObj["g:title"],
    rawObj["@name"]
  );

  const url = firstNonEmpty(
    rawObj.deeplink,
    rawObj.finalUrl,
    rawObj.final_url,
    rawObj.url,
    rawObj.link,
    rawObj.product_url,
    rawObj.productUrl,
    rawObj["g:link"],
    rawObj["@url"]
  );

  const image = firstNonEmpty(
    rawObj.picture,
    rawObj.image,
    rawObj.image_link,
    rawObj.img,
    rawObj["g:image_link"],
    rawObj["@picture"]
  );

  const currency = firstNonEmpty(rawObj.currencyId, rawObj.currency, rawObj.curr, defaults.currency);

  const price = toNum(
    rawObj.sale_price ?? rawObj.salePrice ?? rawObj.current_price ?? rawObj.currentPrice ?? rawObj.price
  );
  const oldPrice = toNum(rawObj.oldprice ?? rawObj.oldPrice ?? rawObj.price_old ?? rawObj.priceOld);

  const offerId = firstNonEmpty(id, stableFallbackId(title, url));

  // Minimum valid: title + url (veya en azından url)
  if (!url) return null;

  return {
    offerId,
    title: title || "(untitled)",
    finalUrl: url,
    originUrl: url,
    image: image || null,
    price,
    oldPrice,
    currency,
    raw: rawObj,
  };
}

async function downloadBytes(url, headers) {
  const r = await fetch(url, { headers });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Feed download failed ${r.status}: ${t.slice(0, 200)}`);
  }
  const ab = await r.arrayBuffer();
  return Buffer.from(ab);
}

// ============================================================================
// XML STREAMING PARSER (prevents OOM on huge feeds)
//
// Enable with:
//   $env:FEED_XML_STREAM="1"
// Optional:
//   $env:FEED_XML_ITEM_TAG="entry"   # default: entry
//
// Why: maxItems cap alone is NOT enough if we still download the entire feed
// into memory. This parser streams and aborts once maxItems are collected.
// ============================================================================
async function streamParseXmlItems(url, headers, opts = {}) {
  const maxItems = Number(opts.maxItems || 20000);
  const itemTag = String(opts.itemTag || "entry").trim() || "entry";
  const forceGz = !!opts.forceGz;

  const controller = new AbortController();
  const r = await fetch(url, {
    method: "GET",
    headers: headers || {},
    redirect: "follow",
    signal: controller.signal,
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Feed HTTP ${r.status}: ${t.slice(0, 200)}`);
  }
  if (!r.body) throw new Error("Feed body empty");

  // NOTE: node-fetch (v3) gives a Node.js readable stream here.
  // We stream-decode UTF-8 text and slice out <entry>...</entry> chunks.
  // This avoids buffering 60k/600k items into memory.
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  const items = [];

  // IMPORTANT: In JS strings, "\b" becomes a backspace unless you escape the backslash.

  // We need a literal regex word-boundary, hence "\\b".

  const openTagRe = new RegExp(`<${itemTag}\b`, "i");
  const closeTag = `</${itemTag}>`;

  const safeTrimBuffer = () => {
    // Prevent runaway memory if we haven't found a full item yet.
    // Keep only the tail where an opening tag could start.
    const maxKeep = 2_000_000; // 2MB of text tail
    if (buf.length > maxKeep) buf = buf.slice(-maxKeep);
  };

  try {
    for await (const chunk of r.body) {
      buf += decoder.decode(chunk, { stream: true });

      // fast path: if close tag not present, keep reading
      while (true) {
        const openIdx = buf.search(openTagRe);
        if (openIdx < 0) {
          safeTrimBuffer();
          break;
        }
        const closeIdx = buf.indexOf(closeTag, openIdx);
        if (closeIdx < 0) {
          // keep from the opening tag onward (drop everything before it)
          if (openIdx > 0) buf = buf.slice(openIdx);
          safeTrimBuffer();
          break;
        }
        const itemXml = buf.slice(openIdx, closeIdx + closeTag.length);
        buf = buf.slice(closeIdx + closeTag.length);

        let parsed = null;
        try {
          parsed = xmlParser.parse(itemXml);
        } catch (e) {
          // skip malformed chunk
          continue;
        }

        // parsed could be { entry: {...} } or { product: {...} }
        const maybeItem = parsed?.[itemTag] || parsed?.entry || parsed?.product || null;
        if (maybeItem) {
          items.push(maybeItem);
          if (items.length % 250 === 0) console.log(`... stream parsed: ${items.length}`);
        }

        if (items.length >= maxItems) {
          try { controller.abort(); } catch {}
          try { r.body.destroy?.(); } catch {}
          return items;
        }
      }
    }
  } finally {
    try { controller.abort(); } catch {}
  }

  // flush decoder
  buf += decoder.decode();
  return items;
}


function inferFormat(url, explicit) {
  if (explicit) return String(explicit).toLowerCase();
  const u = String(url).toLowerCase();
  if (u.includes("format=json") || u.endsWith(".json") || u.includes(".json?")) return "json";
  if (u.includes("format=xml") || u.endsWith(".xml") || u.includes(".xml?")) return "xml";
  if (u.includes("format=csv") || u.endsWith(".csv") || u.includes(".csv?")) return "csv";
  // default
  return "csv";
}

function maybeGunzip(buf, force) {
  const isGz = force || (buf?.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b);
  if (!isGz) return buf;
  return zlib.gunzipSync(buf);
}

// ------------------------------
// Main
// ------------------------------
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
if (!MONGO_URI) throw new Error("MONGO_URI missing");

const FEED_URL = process.env.FEED_URL || process.env.ADMITAD_FEED_URL;
if (!FEED_URL) throw new Error("FEED_URL missing");

const providerKey = String(process.env.FEED_PROVIDER_KEY || "feed").trim() || "feed";
const providerName = String(process.env.FEED_PROVIDER_NAME || providerKey).trim() || providerKey;
const campaignId = String(process.env.FEED_CAMPAIGN_ID || "0").trim() || "0";
const format = inferFormat(FEED_URL, process.env.FEED_FORMAT);
const itemPath = process.env.FEED_ITEM_PATH ? String(process.env.FEED_ITEM_PATH).trim() : "";
const currencyDefault = String(process.env.FEED_DEFAULT_CURRENCY || "TRY").trim() || "TRY";
const maxItems = Number(process.env.FEED_MAX_ITEMS || 20000);

let headers = {};
if (process.env.FEED_HEADERS_JSON) {
  try {
    const parsed = JSON.parse(process.env.FEED_HEADERS_JSON);
    if (parsed && typeof parsed === "object") headers = parsed;
  } catch {
    // ignore
  }
}

console.log("\n🧱 FEED INGEST (GENERIC) — starting");
console.log(JSON.stringify({ providerKey, campaignId, format, hasHeaders: !!Object.keys(headers).length }, null, 2));

await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 15000 });
console.log("✅ MongoDB connected");

const db = mongoose.connection.db;
const col = db.collection("catalog_items");

const t0 = Date.now();
const forceGz = String(process.env.FEED_GZIP || "0") === "1";
const useXmlStream =
  format === "xml" && String(process.env.FEED_XML_STREAM || "1") === "1";

let itemsRaw = [];

if (useXmlStream) {
  // IMPORTANT: avoids downloading the entire (possibly 60k/600k) XML into memory.
  const itemTag = String(process.env.FEED_XML_ITEM_TAG || "entry").trim() || "entry";
  itemsRaw = await streamParseXmlItems(FEED_URL, headers, {
    maxItems,
    itemTag,
    forceGz,
  });
} else {
  let buf = await downloadBytes(FEED_URL, headers);
  buf = maybeGunzip(buf, forceGz);

  if (format === "csv") {
    const text = buf.toString("utf8");
    itemsRaw = parseCsv(text, {
      columns: true,
      skip_empty_lines: true,
      relax_quotes: true,
      relax_column_count: true,
      trim: true,
    });
  } else if (format === "json") {
    const text = buf.toString("utf8");
    const root = JSON.parse(text);
    if (Array.isArray(root)) itemsRaw = root;
    else {
      const picked = pickBestArray(root, itemPath);
      itemsRaw = picked?.arr || [];
      console.log("🧭 JSON itemPath pick:", picked?.path || "(none)", "items:", itemsRaw.length);
    }
  } else if (format === "xml") {
    const text = buf.toString("utf8");
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@",
      trimValues: true,
    });
    const root = parser.parse(text);
    const picked = pickBestArray(root, itemPath);
    itemsRaw = picked?.arr || [];
    console.log("🧭 XML itemPath pick:", picked?.path || "(none)", "items:", itemsRaw.length);
  } else {
    throw new Error(`Unsupported FEED_FORMAT: ${format}`);
  }
}

if (!Array.isArray(itemsRaw)) itemsRaw = [];
if (itemsRaw.length > maxItems) {
  itemsRaw = itemsRaw.slice(0, maxItems);
  console.log(`⚠️ maxItems cap applied: ${maxItems}`);
}

const defaults = { currency: currencyDefault };

let normalized = [];
for (const it of itemsRaw) {
  const n = normalizeRawItem(it, defaults);
  if (n) normalized.push(n);
}

// de-dup by offerId
const seen = new Set();
normalized = normalized.filter((x) => {
  if (!x?.offerId) return false;
  const key = String(x.offerId);
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

console.log(`📦 parsed items: raw=${itemsRaw.length} normalized=${normalized.length}`);

// Optional currency allowlist (helps keep TR-only catalog clean)
// Examples:
//   FEED_ALLOWED_CURRENCIES="TRY"
//   FEED_ALLOWED_CURRENCIES="TRY,USD"
const allowedCurrenciesRaw =
  String(process.env.FEED_ALLOWED_CURRENCIES || process.env.FEED_ALLOWED_CURRENCY || "").trim();
if (allowedCurrenciesRaw) {
  const allowedSet = new Set(
    allowedCurrenciesRaw
      .split(/[\s,;]+/)
      .map((x) => String(x).trim().toUpperCase())
      .filter(Boolean)
  );
  const before = normalized.length;
  normalized = normalized.filter((x) =>
    allowedSet.has(String(x?.currency || "").trim().toUpperCase())
  );
  console.log(
    `💱 currency filter applied: allowed=${[...allowedSet].join(",")} before=${before} after=${normalized.length}`
  );
}

const batchSize = 500;
let upserts = 0;
for (let i = 0; i < normalized.length; i += batchSize) {
  const batch = normalized.slice(i, i + batchSize);
  const ops = batch.map((item) => {
    const doc = {
      providerKey,
      providerName,
      campaignId,
      offerId: item.offerId,
      title: item.title,
      originUrl: item.originUrl,
      finalUrl: item.finalUrl,
      image: item.image,
      price: item.price,
      oldPrice: item.oldPrice,
      currency: item.currency,
      raw: item.raw,
      updatedAt: now(),
    };
    return {
      updateOne: {
        filter: { providerKey, campaignId, offerId: item.offerId },
        update: { $set: doc, $setOnInsert: { createdAt: now() } },
        upsert: true,
      },
    };
  });

  const res = await col.bulkWrite(ops, { ordered: false });
  upserts += (res.upsertedCount || 0) + (res.modifiedCount || 0);
  console.log(`... batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(normalized.length / batchSize)} done`);
}

const dt = Date.now() - t0;
console.log("✅ FEED INGEST DONE", JSON.stringify({ providerKey, campaignId, items: normalized.length, ms: dt }, null, 2));

await mongoose.disconnect();

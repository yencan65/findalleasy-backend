import crypto from "node:crypto";
import zlib from "node:zlib";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { MongoClient } from "mongodb";
import { parse } from "csv-parse";

const feedUrl = process.env.ADMITAD_FEED_URL;
const campaignId = Number(process.env.ADMITAD_CAMPAIGN_ID || 0);
const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI || process.env.MONGO_URL;
const delimiter = process.env.ADMITAD_CSV_DELIMITER || ";";
const maxRows = Number((process.argv.find(a=>a.startsWith("--maxRows="))||"").split("=")[1] || "5000");

const INGEST_DISABLED = String(process.env.ADMITAD_INGEST_DISABLED || "").trim() === "1";
const ALLOWED_CURRENCIES = String(process.env.ADMITAD_ALLOWED_CURRENCIES || process.env.ADMITAD_ALLOWED_CURRENCY || "").trim();
const allowedCurrencySet = new Set(ALLOWED_CURRENCIES
  .split(/[,;\s]+/g)
  .map((s)=>String(s||"").trim().toUpperCase())
  .filter(Boolean));

const colName = String(process.env.CATALOG_COLLECTION || "catalog_items").trim() || "catalog_items";

if (!feedUrl) throw new Error("ADMITAD_FEED_URL missing");
if (!campaignId) throw new Error("ADMITAD_CAMPAIGN_ID missing");
if (!mongoUri) throw new Error("MONGODB_URI missing");

if (INGEST_DISABLED) {
  console.log(JSON.stringify({ ok: true, skipped: true, reason: "ADMITAD_INGEST_DISABLED=1" }, null, 2));
  process.exit(0);
}

function sha1(s){ return crypto.createHash("sha1").update(String(s)).digest("hex"); }
function pick(o, ks){ for(const k of ks){ const v=o?.[k]; if(v!==undefined && v!==null && String(v).trim()!=="") return v; } return null; }
function toNum(v){ if(v===null||v===undefined) return null; const s=String(v).trim().replace(/\s/g,"").replace(",","."); const n=Number(s); return Number.isFinite(n)?n:null; }

const providerKey = "admitad";

const client = new MongoClient(mongoUri, { maxPoolSize: 5 });
await client.connect();
const db = process.env.MONGODB_DB ? client.db(process.env.MONGODB_DB) : client.db();
const col = db.collection(colName);

// index (idempotent)
await col.createIndex({ providerKey: 1, campaignId: 1, offerId: 1 }, { unique: true });
await col.createIndex({ providerKey: 1, updatedAt: -1 });
await col.createIndex({ providerKey: 1, title: 1 });

const r = await fetch(feedUrl, { method: "GET", redirect: "follow" });
if (!r.ok) {
  const t = await r.text().catch(()=> "");
  throw new Error(`Feed download failed ${r.status}: ${t.slice(0,200)}`);
}

const enc = (r.headers.get("content-encoding") || "").toLowerCase();
const isGzip = enc.includes("gzip") || feedUrl.toLowerCase().includes(".gz");

const src = Readable.fromWeb(r.body);
const gunzip = isGzip ? zlib.createGunzip() : null;

let seen = 0, accepted = 0, errors = 0, upserts = 0;
const ops = [];
const BATCH = 1000;

const parser = parse({
  columns: true,
  bom: true,
  delimiter,
  relax_column_count: true,
  relax_quotes: true,
  skip_empty_lines: true,
  trim: true,
});

parser.on("data", (row) => {
  if (seen >= maxRows) return;
  try {
    seen++;

    const offerId = String(pick(row, ["id","offer_id","product_id","sku"]) || sha1(pick(row,["url","name"])||JSON.stringify(row)).slice(0,16));
    const title = String(pick(row, ["name","title"]) || "(no-title)").slice(0,300);
    const url = pick(row, ["url","link","deeplink"]) ? String(pick(row, ["url","link","deeplink"])) : null;
    const img = pick(row, ["picture","image","image_url","img"]) ? String(pick(row, ["picture","image","image_url","img"])) : null;

    const price = toNum(pick(row, ["price","sale_price","current_price"]));
    const oldPrice = toNum(pick(row, ["oldprice","old_price","price_old"]));
    const currency = String(pick(row, ["currencyId","currency","curr"]) || "USD").slice(0,10);

    const cur = String(currency || "").trim().toUpperCase();
    if (allowedCurrencySet.size && cur && !allowedCurrencySet.has(cur)) {
      return;
    }

    accepted++;

    const doc = {
      providerKey,
      campaignId,
      offerId,
      title,
      originUrl: url,
      finalUrl: url,
      image: img,
      price,
      oldPrice,
      currency,
      source: "admitad_feed",
      raw: row,
      updatedAt: new Date(),
    };

    ops.push({
      updateOne: {
        filter: { providerKey, campaignId, offerId },
        update: { $set: doc },
        upsert: true,
      }
    });

    if (ops.length >= BATCH) {
      parser.pause();
      col.bulkWrite(ops, { ordered: false })
        .then((res) => { upserts += (res.upsertedCount||0) + (res.modifiedCount||0); ops.length = 0; parser.resume(); })
        .catch(() => { errors++; ops.length = 0; parser.resume(); });
    }
  } catch {
    errors++;
  }
});

await pipeline(gunzip ? src.pipe(gunzip) : src, parser);

if (ops.length) {
  try {
    const res = await col.bulkWrite(ops, { ordered: false });
    upserts += (res.upsertedCount||0) + (res.modifiedCount||0);
  } catch {
    errors++;
  }
}

await client.close();

console.log(JSON.stringify({ ok:true, seen, accepted, upserts, errors, delimiter, isGzip, colName, allowedCurrencies: ALLOWED_CURRENCIES || null }, null, 2));

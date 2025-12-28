// Ensure standalone tools behave like the server (load .env automatically).
import "dotenv/config";

import { MongoClient } from "mongodb";

// ---------------------------------------------------------------------------
// catalogPurge.mjs
// Purge catalog_items (or CATALOG_COLLECTION) with simple filters.
// Usage examples:
//   node server/tools/catalogPurge.mjs --provider=admitad --campaignId=15488
//   node server/tools/catalogPurge.mjs --provider=admitad --currencyNot=TRY
//   node server/tools/catalogPurge.mjs --provider=admitad --currency=RUB --dryRun=1
// ---------------------------------------------------------------------------

function arg(name) {
  const p = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!p) return null;
  return p.split("=").slice(1).join("=");
}

const mongoUri =
  process.env.MONGODB_URI ||
  process.env.MONGO_URI ||
  process.env.MONGO_URL ||
  process.env.MONGODB_URL ||
  process.env.DATABASE_URL;
if (!mongoUri) throw new Error("MONGODB_URI missing");

const colName = String(process.env.CATALOG_COLLECTION || "catalog_items").trim() || "catalog_items";

// CLI flags still work, but you can also drive the tool via env vars (Windows-friendly).
// Examples:
//   $env:PURGE_PROVIDER_KEY="admitad"; $env:PURGE_CAMPAIGN_ID="0"; node server/tools/catalogPurge.mjs
//   $env:PURGE_ALL="1"; node server/tools/catalogPurge.mjs
const provider = (
  arg("provider") ||
  arg("providerKey") ||
  process.env.PURGE_PROVIDER_KEY ||
  process.env.PURGE_PROVIDER ||
  ""
).trim();

const campaignIdRaw =
  arg("campaignId") ||
  arg("campaign") ||
  process.env.PURGE_CAMPAIGN_ID ||
  process.env.PURGE_CAMPAIGN ||
  "";

const currency = (arg("currency") || process.env.PURGE_CURRENCY || "").trim();
const currencyNot = (arg("currencyNot") || process.env.PURGE_CURRENCY_NOT || "").trim();
const dryRun = String(arg("dryRun") || process.env.PURGE_DRY_RUN || "0").trim() === "1";
const purgeAll = String(arg("all") || process.env.PURGE_ALL || "0").trim() === "1";

const filter = {};

// If PURGE_ALL=1, we intentionally wipe the whole collection (dangerous, but explicit).
if (purgeAll) {
  // leave filter empty
} else {
  if (provider) filter.providerKey = provider;
  if (campaignIdRaw !== "") {
    const n = Number(campaignIdRaw);
    // allow campaignId=0 as "unknown" (your ingest default)
    if (!Number.isFinite(n) || n < 0) throw new Error("campaignId must be a non-negative number");
    filter.campaignId = n;
  }
  if (currency) filter.currency = currency;
  if (currencyNot) filter.currency = { ...(filter.currency || {}), $ne: currencyNot };

  // sensible default for your situation: purge non-TRY admitad items
  if (!provider && campaignIdRaw === "" && !currency && !currencyNot) {
    filter.providerKey = "admitad";
    filter.currency = { $ne: "TRY" };
  }
}

const client = new MongoClient(mongoUri, { maxPoolSize: 3 });
await client.connect();
const db = process.env.MONGODB_DB ? client.db(process.env.MONGODB_DB) : client.db();
const col = db.collection(colName);

const toDelete = await col.countDocuments(filter);

if (dryRun) {
  console.log(JSON.stringify({ ok: true, dryRun: true, colName, filter, matched: toDelete }, null, 2));
  await client.close();
  process.exit(0);
}

const res = await col.deleteMany(filter);

await client.close();

console.log(JSON.stringify({ ok: true, colName, filter, matched: toDelete, deleted: res?.deletedCount || 0 }, null, 2));

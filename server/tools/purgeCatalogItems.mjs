// server/tools/purgeCatalogItems.mjs
// ===============================================================
//  Purge catalog_items by provider/campaign/currency
//  ZERO-DELETE: standalone tool; safe defaults (dryRun)
// ===============================================================

import { MongoClient } from "mongodb";

function arg(name, fallback = "") {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  return hit.slice(name.length + 3);
}

function toNum(v) {
  const n = Number(String(v ?? "").trim());
  return Number.isFinite(n) ? n : null;
}

const providerKey = String(arg("provider", "admitad") || "admitad").trim().toLowerCase();
const campaignId = toNum(arg("campaignId", ""));
const currency = String(arg("currency", "") || "").trim().toUpperCase();

const confirmRaw = String(arg("confirm", "0")).trim().toLowerCase();
const confirm = confirmRaw === "1" || confirmRaw === "true" || confirmRaw === "yes";

const mongoUri =
  process.env.MONGODB_URI ||
  process.env.MONGO_URI ||
  process.env.MONGO_URL ||
  process.env.MONGODB_URL;

const dbName =
  process.env.MONGODB_DB ||
  process.env.MONGO_DB ||
  process.env.MONGO_DATABASE ||
  "findalleasy";

if (!mongoUri) {
  throw new Error("MONGO URI missing (set MONGODB_URI or MONGO_URI)");
}

const filter = { providerKey };
if (campaignId) filter.campaignId = campaignId;
if (currency) filter.currency = currency;

const client = new MongoClient(mongoUri, { maxPoolSize: 5 });
await client.connect();
const db = client.db(dbName);
const col = db.collection("catalog_items");

const count = await col.countDocuments(filter);
const sample = await col
  .find(filter, { projection: { _id: 0, providerKey: 1, campaignId: 1, offerId: 1, currency: 1, title: 1 } })
  .limit(3)
  .toArray();

if (!confirm) {
  console.log(
    JSON.stringify(
      {
        ok: true,
        dryRun: true,
        filter,
        matched: count,
        sample,
        hint: "Run again with --confirm=1 to delete",
      },
      null,
      2
    )
  );
  await client.close();
  process.exit(0);
}

const res = await col.deleteMany(filter);
await client.close();

console.log(
  JSON.stringify(
    {
      ok: true,
      deleted: res.deletedCount || 0,
      filter,
    },
    null,
    2
  )
);

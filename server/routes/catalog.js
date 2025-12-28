import express from "express";
import { MongoClient } from "mongodb";

const router = express.Router();

function must(v, msg) {
  if (!v) throw new Error(msg);
  return v;
}

let _client = null;
async function getMongo() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI || process.env.MONGO_URL;
  must(uri, "MONGODB_URI missing");
  if (_client) return _client;
  _client = new MongoClient(uri, { maxPoolSize: 10 });
  await _client.connect();
  return _client;
}

router.get("/ping", async (req, res) => {
  try {
    const c = await getMongo();
    // Keep DB name selection consistent with server/db.js
    const dbName = process.env.MONGODB_DB || process.env.MONGO_DB || "findalleasy";
    const db = c.db(dbName);
    const n = await db.collection("catalog_items").countDocuments();
    res.json({ ok: true, count: n });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// GET /api/catalog/sample?limit=20
// Quick sanity endpoint: returns recent items without needing a query string.
router.get("/sample", async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(50, Number(req.query.limit || 20)));
    const providerKey = String(req.query.provider || req.query.providerKey || "admitad")
      .trim()
      .toLowerCase();
    const currencyFilter = String(process.env.CATALOG_CURRENCY || "")
      .trim()
      .toUpperCase();
    const campaignAllowRaw = String(
      process.env.CATALOG_CAMPAIGN_ALLOWLIST || process.env.ADMITAD_CAMPAIGN_ALLOWLIST || ""
    ).trim();
    const campaignAllow = (campaignAllowRaw || "")
      .split(/[,;\s]+/g)
      .map((x) => Number(String(x || "").trim()))
      .filter((n) => Number.isFinite(n) && n > 0);

    try {
      res.set("Cache-Control", "no-store");
    } catch {}

    const c = await getMongo();
    const dbName = process.env.MONGODB_DB || process.env.MONGO_DB || "findalleasy";
    const db = c.db(dbName);
    const col = db.collection("catalog_items");

    const filter = { providerKey };
    if (currencyFilter) filter.currency = currencyFilter;
    if (campaignAllow.length) filter.campaignId = { $in: campaignAllow };

    const docs = await col
      .find(filter)
      .sort({ updatedAt: -1 })
      .limit(limit)
      .project({
        _id: 0,
        providerKey: 1,
        campaignId: 1,
        offerId: 1,
        title: 1,
        price: 1,
        oldPrice: 1,
        currency: 1,
        image: 1,
        originUrl: 1,
        finalUrl: 1,
        updatedAt: 1,
      })
      .toArray();

    const items = docs.map((d) => ({
      id: `${d.providerKey}:${d.campaignId}:${d.offerId}`,
      title: d.title,
      price: d.price,
      oldPrice: d.oldPrice,
      currency: d.currency,
      image: d.image,
      originUrl: d.originUrl,
      finalUrl: d.finalUrl,
      providerKey: d.providerKey,
      provider: d.providerKey,
      campaignId: d.campaignId,
      updatedAt: d.updatedAt,
    }));

    res.json({ ok: true, items });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// GET /api/catalog/search?q=...&limit=20
router.get("/search", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const limit = Math.max(1, Math.min(50, Number(req.query.limit || 20)));
    const providerKey = String(req.query.provider || req.query.providerKey || "admitad").trim().toLowerCase();
    const currencyFilter = String(process.env.CATALOG_CURRENCY || "").trim().toUpperCase();
    const campaignAllowRaw = String(process.env.CATALOG_CAMPAIGN_ALLOWLIST || process.env.ADMITAD_CAMPAIGN_ALLOWLIST || "").trim();
    const campaignAllow = (campaignAllowRaw || "").split(/[,;\s]+/g).map((x)=>Number(String(x||"").trim())).filter((n)=>Number.isFinite(n) && n>0);

    try { res.set("Cache-Control","no-store"); } catch {}

    if (!q) return res.json({ ok: true, items: [] });

    const c = await getMongo();
    const dbName = process.env.MONGODB_DB || process.env.MONGO_DB || "findalleasy";
    const db = c.db(dbName);
    const col = db.collection("catalog_items");

    // Basit ama etkili: regex title search (164 ürün için yeter)
    // Sonra scale olunca text index + $text’a geçeriz.
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

    const filter = { title: re, providerKey };
    if (currencyFilter) filter.currency = currencyFilter;
    if (campaignAllow.length) filter.campaignId = { $in: campaignAllow };

    const docs = await col
      .find(filter)
      .sort({ updatedAt: -1 })
      .limit(limit)
      .project({
        _id: 0,
        providerKey: 1,
        campaignId: 1,
        offerId: 1,
        title: 1,
        price: 1,
        oldPrice: 1,
        currency: 1,
        image: 1,
        originUrl: 1,
        finalUrl: 1,
        updatedAt: 1,
      })
      .toArray();

    // FE’nin sevdiği forma yaklaştır (minimum)
    const items = docs.map((d) => ({
      id: `${d.providerKey}:${d.campaignId}:${d.offerId}`,
      title: d.title,
      price: d.price,
      oldPrice: d.oldPrice,
      currency: d.currency,
      image: d.image,
      originUrl: d.originUrl,
      finalUrl: d.finalUrl,
      // Both names are returned for convenience; keep FE flexible.
      providerKey: d.providerKey,
      provider: d.providerKey,
      campaignId: d.campaignId,
      updatedAt: d.updatedAt,
    }));

    res.json({ ok: true, items });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;

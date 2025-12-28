// server/adapters/catalogAdapter.js
// Mongo catalog_items -> S200 item list (ZERO-DELETE friendly)
// ENV:
//  FINDALLEASY_CATALOG_MONGO=0  => disable
//  CATALOG_PROVIDER_KEY=admitad  => source filter
//  CATALOG_LIMIT_DEFAULT=20

import { getDb } from "../db.js";

function escRe(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function toNum(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

export default async function catalogAdapter(input, ctx = {}) {
  const enabled = String(process.env.FINDALLEASY_CATALOG_MONGO ?? "1") !== "0";
  if (!enabled) return [];

  const q =
    typeof input === "string"
      ? input
      : String(input?.q ?? input?.query ?? input?.text ?? "").trim();

  if (!q) return [];

  const limitRaw =
    typeof input === "object" ? (input?.limit ?? input?.maxResults) : null;
  const limit = Math.max(
    1,
    Math.min(50, Number(limitRaw ?? process.env.CATALOG_LIMIT_DEFAULT ?? 20))
  );

  const providerKey = String(process.env.CATALOG_PROVIDER_KEY ?? "admitad");

  // getDb() is async
  const db = await getDb();
  const col = db.collection("catalog_items");

  // Küçük dataset için regex yeterli (şimdilik). Scale olunca $text yaparız.
  const re = new RegExp(escRe(q), "i");

  const docs = await col
    .find({ providerKey, title: re })
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
      raw: 1,
    })
    .toArray();

  return docs.map((d) => {
    const price = toNum(d.price);
    const oldPrice = toNum(d.oldPrice);

    return {
      id: `${d.providerKey}:${d.campaignId}:${d.offerId}`,
      title: d.title,

      originUrl: d.originUrl,
      finalUrl: d.finalUrl,
      image: d.image,

      price,
      finalPrice: price,
      optimizedPrice: price,
      oldPrice,
      currency: d.currency || "RUB",

      providerKey: d.providerKey,
      providerName: "Admitad Feed",
      campaignId: d.campaignId,

      source: "mongo_catalog",
      updatedAt: d.updatedAt,
      raw: d.raw,
    };
  });
}

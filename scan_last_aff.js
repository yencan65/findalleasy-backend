const skip = new Set(["admin","local","config"]);
const dbs = db.adminCommand({ listDatabases: 1 }).databases
  .map(d => d.name)
  .filter(n => !skip.has(n));

for (const dbName of dbs) {
  const d = db.getSiblingDB(dbName);

  if (d.getCollectionNames().includes("affiliateclicks16")) {
    print("=== " + dbName + ".affiliateclicks16 (last 5) ===");
    d.affiliateclicks16.find().sort({ _id: -1 }).limit(5).forEach(x => printjson({clickId:x.clickId, ts:x.ts, provider:x.provider, url:x.url || x.targetUrl || x.finalUrl}));
  }

  if (d.getCollectionNames().includes("affiliateconversions16")) {
    print("=== " + dbName + ".affiliateconversions16 (last 5) ===");
    d.affiliateconversions16.find().sort({ _id: -1 }).limit(5).forEach(x => printjson({orderId:x.orderId, clickId:x.clickId, ts:x.ts, provider:x.provider, amount:x.amount, currency:x.currency}));
  }
}

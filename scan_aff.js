const cid = "UY_kGyOyN7xlRM18gae5Vw";
const oid = "TEST-172100";

const skip = new Set(["admin","local","config"]);
const dbs = db.adminCommand({ listDatabases: 1 }).databases
  .map(d => d.name)
  .filter(n => !skip.has(n));

for (const dbName of dbs) {
  const d = db.getSiblingDB(dbName);
  for (const col of d.getCollectionNames()) {
    const c = d.getCollection(col);

    const clickHit = c.findOne({ $or: [
      { clickId: cid },
      { fae_click: cid },
      { subid: cid },
      { "meta.clickId": cid },
      { "raw.clickId": cid }
    ]});

    if (clickHit) print("FOUND CLICK in: " + dbName + "." + col);

    const orderHit = c.findOne({ $or: [
      { orderId: oid },
      { "raw.orderId": oid }
    ]});

    if (orderHit) print("FOUND ORDER in: " + dbName + "." + col);
  }
}

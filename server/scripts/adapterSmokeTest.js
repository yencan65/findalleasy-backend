import CATEGORY_ADAPTER_MAP, { getAdapterSystemStatus } from "../core/adapterRegistry.js";


const SAMPLE_QUERIES = {
  product: ["iphone 15", "dyson v15"],
  market: ["süt 1 litre", "zeytinyağı"],
  fashion: ["nike air force", "mont erkek"],
  travel: ["istanbul bodrum otel", "izmir uçak bileti"],
  car_rental: ["bodrum araç kiralama"],
  tour: ["kapadokya tur"],
  spa: ["masaj beşiktaş"],
  health: ["dermatolog istanbul"],
  checkup: ["check up ankara"],
  estate: ["kadıköy satılık daire"],
  insurance: ["kasko fiyat"],
  education: ["ingilizce kursu"],
  event: ["istanbul konser"],
  office: ["coworking kadıköy"],
  craft: ["elektrikçi beşiktaş"],
  rental: ["kamera kiralama"],
  repair: ["iphone ekran değişimi"],
  vehicle_sale: ["2018 passat dizel"],
  lawyer: ["boşanma avukatı ankara"],
  location: ["kadıköy"],
};

function validateItem(it) {
  const provider = (it?.provider || it?.providerKey || "").toString().trim();
  const title = (it?.title || "").toString().trim();
  const url = (it?.url || it?.finalUrl || it?.originUrl || "").toString().trim();
  const price = it?.finalPrice ?? it?.optimizedPrice ?? it?.price ?? null;
  const ok =
    provider.length > 0 &&
    title.length > 0 &&
    url.startsWith("http") &&
    (price == null || (typeof price === "number" && Number.isFinite(price) && price > 0));
  return ok;
}

async function runOne(adapter, category, query) {
  const t0 = Date.now();
  try {
    const out = await adapter.fn(query, { category });
    const items = Array.isArray(out) ? out : (out?.items || []);
    const ms = Date.now() - t0;
    const bad = items.filter((x) => !validateItem(x)).length;
    return { ok: true, ms, count: items.length, bad };
  } catch (e) {
    const ms = Date.now() - t0;
    return { ok: false, ms, count: 0, bad: 0, err: e?.message || String(e) };
  }
}

(async () => {
  console.log("STATUS:", getAdapterSystemStatus());

  for (const [cat, list] of Object.entries(CATEGORY_ADAPTER_MAP)) {
    if (!Array.isArray(list) || !list.length) continue;
    const q = (SAMPLE_QUERIES[cat] || SAMPLE_QUERIES.product || ["test"])[0];

    console.log("\n===", cat, "===", "adapters:", list.length, "query:", q);
    for (const ad of list) {
      if (!ad?.fn) continue;
      const r = await runOne(ad, cat, q);
      console.log(
        `${ad.provider || ad.name} :: ok=${r.ok} ms=${r.ms} count=${r.count} bad=${r.bad}` +
          (r.err ? ` err=${r.err}` : "")
      );
    }
  }
})();

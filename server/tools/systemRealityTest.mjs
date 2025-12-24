const BASE = "http://localhost:8080";

const isBadImg = (u) => {
  const s = String(u||"").trim().toLowerCase();
  return !s || s.startsWith("data:image/gif") || s.includes("blank.gif") || s.includes("/static/css/jquery/img/blank.gif") || s === "about:blank";
};

const isBadLink = (it) => {
  const u = String(it?.finalUrl || it?.url || it?.originUrl || "").trim();
  if (!u) return true;
  try {
    const x = new URL(u);
    // “ana sayfa” linki = ölüm (dönüşüm yok). Basit heuristik:
    const p = x.pathname || "/";
    if (p === "/" || p === "/index.html") return true;
    return false;
  } catch {
    return true;
  }
};

const groupCounts = (items) => {
  const m = new Map();
  for (const it of items) {
    const k = it?.providerKey || it?.provider || it?.adapterSource || "unknown";
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()].sort((a,b)=>b[1]-a[1]);
};

async function postJson(path, body) {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  let j = null;
  try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
}

async function run() {
  const tests = [
    { q: "ütü", category: "product" },
    { q: "iphone 15", category: "product" },
    { q: "airfryer", category: "product" },
    { q: "nike ayakkabı", category: "fashion" },
    { q: "süt", category: "market" },
  ];

  for (const t of tests) {
    const bodySearch = { query: t.q, q: t.q, region: "TR", locale: "tr", category: t.category, group: t.category, limit: 30, offset: 0 };
    const bodyVitrin  = { query: t.q, q: t.q, region: "TR", locale: "tr", category: t.category, group: t.category };

    const s = await postJson("/api/search", bodySearch);
    const items = Array.isArray(s?.json?.items) ? s.json.items : (Array.isArray(s?.json?.results) ? s.json.results : []);
    const badImg = items.filter(x => isBadImg(x?.image)).length;
    const badLink = items.filter(isBadLink).length;

    console.log("\n==============================");
    console.log("SEARCH", t.category, `"${t.q}"`, "HTTP", s.status, "ok", !!s?.json?.ok, "items", items.length);
    console.log("meta.adaptersWithItems:", s?.json?._meta?.adaptersWithItems, "rateLimit:", s?.json?._meta?.rateLimit);
    console.log("top providers:", groupCounts(items).slice(0, 8));
    console.log("badImg:", badImg, "badLink(home/empty):", badLink);

    // vitrin
    const v = await postJson("/api/vitrin/dynamic", bodyVitrin);
    const keys = v?.json ? Object.keys(v.json).sort() : [];
    const bestList = Array.isArray(v?.json?.best_list) ? v.json.best_list : (Array.isArray(v?.json?.items) ? v.json.items : []);
    const best = v?.json?.best || bestList[0] || null;

    const vitrinHasSmart = keys.includes("smart") || (v?.json?.cards && Object.prototype.hasOwnProperty.call(v.json.cards, "smart"));
    const vitrinHasOthers = keys.includes("others") || (v?.json?.cards && Object.prototype.hasOwnProperty.call(v.json.cards, "others"));

    console.log("VITRIN", t.category, `"${t.q}"`, "HTTP", v.status, "ok", !!v?.json?.ok, "best_list", bestList.length);
    console.log("vitrin keys:", keys);
    console.log("vitrin_has_smart:", vitrinHasSmart, "vitrin_has_others:", vitrinHasOthers);
    console.log("best sample:", best ? {
      title: best.title,
      price: best.price,
      providerKey: best.providerKey,
      provider: best.provider,
      region: best.region,
      image: best.image,
      url: best.finalUrl || best.url,
      originUrl: best.originUrl
    } : null);
  }
}

run().catch(e => { console.error("TEST_CRASH", e); process.exit(1); });

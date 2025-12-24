// server/tools/azE2E.mjs
// Default E2E is STRICT: no stubs, no mock, isolate cache by engineVariant, disable reward-engine DB work.
process.env.FINDALLEASY_ALLOW_STUBS = process.env.FINDALLEASY_ALLOW_STUBS ?? "0";
process.env.FINDALLEASY_MOCK_VITRIN = process.env.FINDALLEASY_MOCK_VITRIN ?? "0";
process.env.FINDALLEASY_ENGINE_VARIANT = process.env.FINDALLEASY_ENGINE_VARIANT ?? "az_e2e";
process.env.REWARD_ENGINE_DISABLE = process.env.REWARD_ENGINE_DISABLE ?? "1";
import "dotenv/config";

const boot = {
  cwd: process.cwd(),
  SERPAPI_KEY: !!process.env.SERPAPI_KEY,
  GOOGLE_PLACES_KEY: !!process.env.GOOGLE_PLACES_KEY,
  PLACES_API_KEY: !!process.env.PLACES_API_KEY,
};
console.log("[BOOT]", JSON.stringify(boot));



import { performance } from "node:perf_hooks";

function isZero(v) {
  return v === 0 || v === "0";
}
function hasBadZeroPrice(it) {
  return [it?.price, it?.finalPrice, it?.optimizedPrice].some(isZero);
}

function assertItemContract(it, where = "") {
  const title = String(it?.title || "").trim();
  const url = String(
    it?.url ||
      it?.finalUrl ||
      it?.originUrl ||
      it?.deeplink ||
      it?.affiliateUrl ||
      ""
  ).trim();

  if (!title) return { ok: false, reason: `missing_title ${where}` };
  if (!url) return { ok: false, reason: `missing_url ${where}` };
  if (url === "#") return { ok: false, reason: `fake_url_hash ${where}` };
  if (hasBadZeroPrice(it)) return { ok: false, reason: `zero_price_drift ${where}` };

  return { ok: true };
}

function pickSig(r) {
  const b = r?.best || null;
  const smart = Array.isArray(r?.smart) ? r.smart : [];
  return {
    bestKey: b ? (b.id || b.url || b.title) : null,
    smartTop: smart.slice(0, 3).map((x) => x?.id || x?.url || x?.title || null),
    metaSource: r?._meta?.source || null,
    category: r?.category || null,
    ok: !!r?.ok,
  };
}

async function runOne(buildDynamicVitrinSafe, test, region = "TR") {
  const t0 = performance.now();

  // vitrinEngine normalizeVitrinContext context objesini kabul ediyor (sessionId vs.)
  const ctx = { sessionId: "az_e2e", userId: "az_e2e" };

  const res = await buildDynamicVitrinSafe(test.q, region, test.category, ctx);
  const ms = Math.round(performance.now() - t0);

  const best = res?.best || null;
  const smart = Array.isArray(res?.smart) ? res.smart : [];

  // Contract checks (BEST + SMART)
  const problems = [];
  if (best) {
    const a = assertItemContract(best, "best");
    if (!a.ok) problems.push(a.reason);
  }
  for (let i = 0; i < Math.min(6, smart.length); i++) {
    const a = assertItemContract(smart[i], `smart[${i}]`);
    if (!a.ok) problems.push(a.reason);
  }

  // Global “bad zero price” scan (light)
  const pool = [
    ...(best ? [best] : []),
    ...smart.slice(0, 20),
    ...(Array.isArray(res?.best_list) ? res.best_list.slice(0, 5) : []),
  ];
  const zeroBad = pool.filter(hasBadZeroPrice);
  if (zeroBad.length) problems.push(`zero_price_drift_pool(${zeroBad.length})`);

  // NO-FAKE guard (STRICT)
  const src = res?._meta?.source || null;
  if (src === "mock") problems.push("NO_FAKE_FAIL: meta.source=mock");
  if (src === "empty-product") problems.push("WARN: empty-product");

  return { res, ms, problems };
}

async function main() {
  // IMPORTANT: correct path (the screenshot error was importing from server/tools/vitrinEngine.js)
  const { buildDynamicVitrinSafe } = await import("../core/vitrinEngine.js");

  const tests = [
    // product
    { q: "iphone 15 256", category: "product" },
    { q: "ps5", category: "product" },
    { q: "robot süpürge", category: "product" },

    // service
    { q: "psikolog bodrum", category: "psychologist" },
    { q: "avukat istanbul", category: "lawyer" },
    { q: "klima tamiri", category: "repair" },

    // travel
    { q: "bodrum otel", category: "hotel" },
    { q: "istanbul antalya uçak bileti", category: "flight" },
    { q: "bodrum araç kiralama", category: "car_rental" },

    // estate/education
    { q: "bodrum satılık daire", category: "estate" },
    { q: "ingilizce kursu", category: "education" },
  ];

  let pass = 0,
    fail = 0;
  const started = new Date().toISOString();

  console.log("🧪 AZ E2E START", {
    started,
    STRICT_STUBS: process.env.FINDALLEASY_ALLOW_STUBS,
    ENGINE_VARIANT: process.env.FINDALLEASY_ENGINE_VARIANT,
    MOCK: process.env.FINDALLEASY_MOCK_VITRIN,
    REWARD_ENGINE_DISABLE: process.env.REWARD_ENGINE_DISABLE,
  });

  for (const t of tests) {
    // determinism probe: same query twice
    const a1 = await runOne(buildDynamicVitrinSafe, t, "TR");
    const a2 = await runOne(buildDynamicVitrinSafe, t, "TR");

    const s1 = pickSig(a1.res);
    const s2 = pickSig(a2.res);

    const problems = [...a1.problems, ...a2.problems].filter(Boolean);

    const isFail = problems.some(
      (p) =>
        p.startsWith("NO_FAKE_FAIL") ||
        p.includes("missing_") ||
        p.includes("fake_url_hash") ||
        p.includes("zero_price_drift")
    );
    if (isFail) fail++;
    else pass++;

    console.log("\n==============================");
    console.log("🔎 QUERY:", t.q, "| category:", t.category);
    console.log("⏱️  ms:", a1.ms, "/", a2.ms);
    console.log("SIG1:", s1);
    console.log("SIG2:", s2);

    // drift info
    const drift = JSON.stringify(s1) !== JSON.stringify(s2);
    if (drift) console.log("Δ NOTE: sonuçlar farklı (network/provider oynaklığı olabilir).");

    if (problems.length) console.log("❌ PROBLEMS:", problems);
    else console.log("✅ OK");
  }

  console.log("\n✅ AZ E2E DONE", { pass, fail, total: pass + fail });
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error("❌ AZ E2E CRASH:", e?.stack || e?.message || e);
  process.exit(1);
});

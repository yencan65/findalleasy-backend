// server/core/adapterEngine/healthAdapterMap.js
// ============================================================================
// HEALTH ADAPTER MAP — DRIFT-SAFE COMPAT BRIDGE (S200)
// - Önce gerçek grup dosyası: ../../adapters/groups/healthAdapters.js
// - Sonra legacy (varsa):     ../../adapters/healthAdapters.js
// Amaç: routes/vitrine.js -> getHealthAdapters(intent) sync array döndürsün.
// ============================================================================

const WARN_KEYS = new Set();
function warnOnce(key, msg, err) {
  if (WARN_KEYS.has(key)) return;
  WARN_KEYS.add(key);
  console.warn(msg, err?.message || err || "");
}

function isModuleNotFoundErr(e) {
  const code = e?.code || "";
  const msg = String(e?.message || "");
  return (
    code === "ERR_MODULE_NOT_FOUND" ||
    msg.includes("Cannot find module") ||
    msg.includes("ERR_MODULE_NOT_FOUND")
  );
}

function makeStubFn(name = "health_stub") {
  const fn = async (..._args) => ({
    ok: false,
    items: [],
    count: 0,
    source: "health_stub",
    provider: "health",
    providerFamily: "health",
    error: "NOT_IMPLEMENTED",
    note: `Health vertical inactive — stub adapter executed (${name}).`,
    _meta: { stub: true, adapterName: name },
  });
  fn.__isStub = true;
  fn.adapterName = name;
  return fn;
}

function normalizeFnList(maybeArr) {
  if (!Array.isArray(maybeArr)) return [];
  const out = [];
  for (const x of maybeArr) {
    if (typeof x === "function") out.push(x);
    else if (x && typeof x.fn === "function") out.push(x.fn);
  }
  return out;
}

async function importFirstAvailable(paths) {
  const attempts = [];
  let lastErr = null;

  for (const p of paths) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const mod = await import(p);
      return { mod, loadedFrom: p, attempts };
    } catch (e) {
      lastErr = e;
      attempts.push({ path: p, code: e?.code, message: String(e?.message || "") });

      // Modül bulunamadıysa sıradakini dene
      if (isModuleNotFoundErr(e)) continue;

      // Modül bulundu ama içinde patladıysa yine de legacy'yi denemek isteyebiliriz.
      // Ama hatayı gömmeyelim: meta'da tutacağız.
      continue;
    }
  }

  const err = lastErr || new Error("No module paths attempted");
  err.__attempts = attempts;
  throw err;
}

// ✅ Önce doğru dosya, sonra legacy
const TRY_PATHS = [
  "../../adapters/groups/healthAdapters.js",
  "../../adapters/healthAdapters.js",
];

let healthMod = null;
let loadedFrom = null;
let loadAttempts = [];

try {
  const res = await importFirstAvailable(TRY_PATHS);
  healthMod = res?.mod || null;
  loadedFrom = res?.loadedFrom || null;
  loadAttempts = Array.isArray(res?.attempts) ? res.attempts : [];
} catch (e) {
  warnOnce("health_import_fail", "⚠️ HEALTH ADAPTERS NOT FOUND — using STUB functions", e);
  loadAttempts = Array.isArray(e?.__attempts) ? e.__attempts : [];
  healthMod = null;
  loadedFrom = null;
}

// Derive adapters
let getByType = null;
let allFns = [];

try {
  if (healthMod) {
    // Tercih: resolver (intent/type bazlı)
    if (typeof healthMod.getHealthAdaptersByType === "function") {
      getByType = healthMod.getHealthAdaptersByType;
    }

    // En sağlam: doğrudan fn listesi
    allFns = normalizeFnList(healthMod.healthAdapterFns);

    // Fallback: adapter objeleri -> fn
    if (!allFns.length) allFns = normalizeFnList(healthMod.healthAdapters);

    // Fallback: default export array olabilir
    if (!allFns.length) allFns = normalizeFnList(healthMod.default);

    // Son çare: herhangi bir export array bul (drift durumları için)
    if (!allFns.length) {
      for (const k of Object.keys(healthMod)) {
        const v = healthMod[k];
        const candidate = normalizeFnList(v);
        if (candidate.length) {
          allFns = candidate;
          break;
        }
      }
    }
  }
} catch (e) {
  warnOnce("health_derive_fail", "⚠️ HEALTH ADAPTER MAP derive error — using STUB functions", e);
  getByType = null;
  allFns = [];
}

// Son emniyet: boş kalmasın
if (!allFns.length) {
  if (healthMod) {
    warnOnce(
      "health_no_fns",
      "⚠️ HEALTH ADAPTERS LOADED but NO FUNCTIONS FOUND — using STUB",
      null
    );
  }
  allFns = [makeStubFn("health_empty")];
}

export function getHealthAdapters(intent = "general") {
  try {
    const t = String(intent || "general").toLowerCase().trim();

    if (getByType) {
      const maybe = getByType(t);
      const normalized = normalizeFnList(maybe);
      if (normalized.length) return normalized;
    }

    return allFns;
  } catch (e) {
    warnOnce("health_get_fail", "⚠️ getHealthAdapters error — fallback to allFns", e);
    return allFns;
  }
}

// Debug/telemetry için küçük meta (istersen kullan, kullanmazsan sorun değil)
export function __healthAdapterMapMeta() {
  return {
    loadedFrom,
    fnCount: Array.isArray(allFns) ? allFns.length : 0,
    hasResolver: typeof getByType === "function",
    stubOnly: Array.isArray(allFns) && allFns.every((f) => f?.__isStub),
    attempts: loadAttempts,
  };
}

export default getHealthAdapters;

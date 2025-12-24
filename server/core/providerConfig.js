// server/core/providerConfig.js
// ============================================================================
// PROVIDER CONFIG RESOLVER (ROBUST)
// Goal: give startup validation/coverage a REAL provider config source.
// - Prefers named export: PROVIDER_CONFIG
// - Accepts two common shapes:
//    A) Object map: { providerKey: { ...providerMeta... }, ... }   (values are objects)
//    B) Array:      [ { providerKey: "x", ... }, ... ]
// - Rejects module exports like { buildAffiliateUrl: [Function], ... } (values are functions)
// ============================================================================

const requireConfig =
  (process.env.AFF_REQUIRE_PROVIDER_CONFIG ??
    (process.env.NODE_ENV === "production" ? "1" : "0")) === "1";

// Optional hard pin (CI/prod): set the module to import relative to THIS file.
// Example:
//   set PROVIDER_CONFIG_PATH=../adapters/affiliateEngine.js
const PIN = String(process.env.PROVIDER_CONFIG_PATH || "").trim();

const CANDIDATES = [
  ...(PIN ? [PIN] : []),

  // Your current canonical source (after patch it exports PROVIDER_CONFIG)
  "../adapters/affiliateEngine.js",

  // Other possible repo layouts
  "./providerConfig.local.js",
  "./providers.js",
  "./providerRegistry.js",
  "../config/providerConfig.js",
  "../config/providers.js",
  "./affiliate/providerConfig.js",
  "./affiliateEngine/providerConfig.js",
  "./providerEngine/providerConfig.js",
  "./providerPriority/providerConfig.js",
];

function isNonEmptyStr(s) {
  return typeof s === "string" && s.trim().length > 0;
}

function looksLikeProviderArray(cfg) {
  if (!Array.isArray(cfg)) return false;
  return cfg.every((p) => p && typeof p === "object" && isNonEmptyStr(p.providerKey || p.key || p.id));
}

function looksLikeProviderMap(cfg) {
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return false;
  const entries = Object.entries(cfg);
  if (entries.length === 0) return true;

  // keys must be strings, values must be plain objects (NOT functions)
  return entries.every(([k, v]) => isNonEmptyStr(k) && v && typeof v === "object" && typeof v !== "function");
}

function looksLikeProviderConfig(cfg) {
  return looksLikeProviderArray(cfg) || looksLikeProviderMap(cfg);
}

async function tryImport(spec) {
  try {
    const mod = await import(spec);

    // Prefer explicit named export(s)
    const candidates = [
      mod?.PROVIDER_CONFIG,
      mod?.providers,
      mod?.PROVIDERS,
      mod?.default,
    ];

    for (const cfg of candidates) {
      if (cfg === undefined) continue;
      if (looksLikeProviderConfig(cfg)) return { spec, cfg };
    }

    // If we're pinned to this module, and it exports something but not a provider config, fail fast.
    if (PIN && spec === PIN) {
      throw new Error(`providerConfig resolver: pinned module "${spec}" did not export a valid provider config`);
    }

    // Otherwise, just skip this module.
    return null;
  } catch (e) {
    const msg = String(e?.message || "");
    if (e?.code === "ERR_MODULE_NOT_FOUND" || msg.includes("Cannot find module")) return null;
    throw e;
  }
}

let found = null;
for (const spec of CANDIDATES) {
  found = await tryImport(spec);
  if (found) break;
}

let PROVIDER_CONFIG = found?.cfg ?? {};

if (!found) {
  console.warn("⚠️ providerConfig resolver: no candidate matched; PROVIDER_CONFIG = {}");
  console.warn("   Fix: export PROVIDER_CONFIG from your config module or set PROVIDER_CONFIG_PATH.");
} else {
  console.log("✅ providerConfig resolver:", found.spec);
}

if (requireConfig && !found) {
  throw new Error(
    "AFF_REQUIRE_PROVIDER_CONFIG=1 but no provider config module matched. " +
      "Export PROVIDER_CONFIG or set PROVIDER_CONFIG_PATH."
  );
}

export { PROVIDER_CONFIG };
export default PROVIDER_CONFIG;

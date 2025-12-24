// server/core/affiliateContracts.validate.js
// Startup validator for affiliate contracts table.
// Supports modes: POSTBACK | PARAM | REPORT
// - POSTBACK: requires clickIdOutKey and clickIdInKeys includes it
// - PARAM: requires affiliateIdOutKey + affiliateIdEnvKey; click tracking optional
// ZERO SECRET: never store tokens here.

import { AFFILIATE_CONTRACTS } from "./affiliateContracts.js";

function die(msg) {
  const e = new Error(msg);
  e.code = "AFF_CONTRACT_INVALID";
  throw e;
}

function arr(v) {
  return Array.isArray(v) ? v : (v != null ? [v] : []);
}

export function validateAffiliateContracts({ providers = [], strict = true } = {}) {
  const seen = new Set();

  for (const [k, c] of Object.entries(AFFILIATE_CONTRACTS || {})) {
    if (!c || typeof c !== "object") die(`Contract bad type: ${k}`);
    if (seen.has(c.providerKey)) die(`Duplicate providerKey in contracts: ${c.providerKey}`);
    seen.add(c.providerKey);

    if (!c.providerKey || !c.networkKey) die(`Missing providerKey/networkKey: ${k}`);

    const mode = String(c.mode || "POSTBACK").toUpperCase();

    if (mode === "POSTBACK") {
      if (!c.out?.clickIdOutKey) die(`Missing out.clickIdOutKey: ${k}`);
      if (!Array.isArray(c.in?.clickIdInKeys) || c.in.clickIdInKeys.length < 1)
        die(`Missing in.clickIdInKeys: ${k}`);

      if (!c.in.clickIdInKeys.includes(c.out.clickIdOutKey))
        die(`Mismatch: out.clickIdOutKey not in in.clickIdInKeys for ${k}`);
    } else if (mode === "PARAM") {
      if (!c.out?.affiliateIdOutKey) die(`Missing out.affiliateIdOutKey (PARAM mode): ${k}`);
      if (!c.out?.affiliateIdEnvKey) die(`Missing out.affiliateIdEnvKey (PARAM mode): ${k}`);
      // clickIdOutKey optional
    } else if (mode === "REPORT") {
      // allow; coverage will warn if you haven't built report ingest
      if (!c.report && !c.in && !c.out) {
        // keep it loose; but avoid empty shells
        die(`REPORT mode contract too empty: ${k}`);
      }
    } else {
      die(`Unknown mode "${mode}" in contract: ${k}`);
    }

    const req = arr(c.rules?.require);
    for (const r of req) {
      if (!["clickId", "orderId", "amount", "currency", "status"].includes(r))
        die(`Unknown rules.require value "${r}" in ${k}`);
    }
  }

  // Provider list check: affiliate-enabled providers must have contracts (unless you intentionally disable strict)
  if (Array.isArray(providers) && providers.length) {
    const missing = [];
    for (const p of providers) {
      const providerKey = String(p?.providerKey || p?.key || "").trim();
      if (!providerKey) continue;

      const affOn = Boolean(p?.affiliate?.enabled || p?.aff?.enabled || p?.affiliateEnabled);
      if (!affOn) continue;

      if (!AFFILIATE_CONTRACTS?.[providerKey]) missing.push(providerKey);
    }

    if (missing.length) {
      const msg = `Missing affiliate contract(s) for providers: ${missing.join(", ")}`;
      if (strict) die(msg);
      else console.warn("⚠️", msg);
    }
  }

  return { ok: true, count: Object.keys(AFFILIATE_CONTRACTS || {}).length };
}

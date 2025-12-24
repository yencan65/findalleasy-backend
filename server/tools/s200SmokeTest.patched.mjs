#!/usr/bin/env node
// server/tools/s200SmokeTest.mjs
// ============================================================================
// S200 SMOKE TEST — PROD-REALISTIC (AFFILIATE-READY)
// - dotenv auto-load
// - Missing key => expectedFail/skip (not a "red" failure)
// - Stubs/fallback nav disabled by default (override via env)
// - Contract breaks => hard fail
// ============================================================================

import "dotenv/config";

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

import { isStubItemS200 } from "../core/s200AdapterKit.js";


import { AFFILIATE_CONTRACTS } from "../core/affiliateContracts.js";
import { PROVIDER_CONFIG } from "../core/providerConfig.js";
import {
  generateAffiliateContractsCoverage,
  printAffiliateContractsCoverage,
} from "../core/affiliateContracts.coverage.js";

// ----------------------------------------------------------------------------
// ENV DEFAULTS (prod-realistic)
// ----------------------------------------------------------------------------
process.env.FINDALLEASY_ALLOW_STUBS = process.env.FINDALLEASY_ALLOW_STUBS ?? "0";
process.env.FINDALLEASY_ALLOW_FALLBACK_NAV = process.env.FINDALLEASY_ALLOW_FALLBACK_NAV ?? "0";
process.env.FINDALLEASY_MOCK_VITRIN = process.env.FINDALLEASY_MOCK_VITRIN ?? "0";
process.env.FINDALLEASY_ENGINE_VARIANT = process.env.FINDALLEASY_ENGINE_VARIANT ?? "smoke_v3";
process.env.REWARD_ENGINE_DISABLE = process.env.REWARD_ENGINE_DISABLE ?? "1";

// ----------------------------------------------------------------------------
// CONFIG
// ----------------------------------------------------------------------------
const GROUP_DIR = path.resolve("server/adapters/groups");
const OUTER_TIMEOUT_MS = Math.max(1500, Math.min(20000, Number(process.env.S200_SMOKE_OUTER_TIMEOUT_MS ?? 6500)));
const MAX_ADAPTERS_PER_GROUP = Math.max(1, Math.min(30, Number(process.env.S200_SMOKE_MAX_ADAPTERS_PER_GROUP ?? 6)));

const QUERY = String(process.env.S200_SMOKE_QUERY ?? "iphone 15").trim();
const REGION = String(process.env.S200_SMOKE_REGION ?? "TR").trim();
const LOCALE = String(process.env.S200_SMOKE_LOCALE ?? "tr").trim();

const STRICT_ITEMS = String(process.env.S200_SMOKE_STRICT_ITEMS ?? "1") === "1";
const STRICT_NO_STUBS = String(process.env.FINDALLEASY_ALLOW_STUBS ?? "0") !== "1";
const STRICT_NO_FALLBACK_NAV = String(process.env.FINDALLEASY_ALLOW_FALLBACK_NAV ?? "0") !== "1";

// Manual expected-fails (optional, comma-separated adapter ids)
const EXPECT_SET = new Set(
  String(process.env.S200_SMOKE_EXPECT_FAIL ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

// ----------------------------------------------------------------------------
// HELPERS
// ----------------------------------------------------------------------------
function nowMs() {
  return Math.round(performance.now());
}

function toStr(v) {
  return v == null ? "" : String(v);
}

function asArr(v) {
  return Array.isArray(v) ? v : [];
}

function normalizeOut(out, baseName = "") {
  if (Array.isArray(out)) {
    return { ok: true, items: out, count: out.length, source: baseName, _meta: { shape: "array" } };
  }
  const ok = !!out?.ok;
  const items = asArr(out?.items);
  const count = Number.isFinite(out?.count) ? out.count : items.length;
  const source = toStr(out?.source || baseName || out?.providerKey || out?.adapterSource || "");
  return { ok, items, count, source, _meta: out?._meta || {} };
}

function envHasAny(keys) {
  return keys.some((k) => {
    const v = toStr(process.env[k]).trim();
    return !!v;
  });
}

function getErrCode(out) {
  const code = toStr(out?._meta?.error?.code || out?._meta?.code || "");
  return code.toUpperCase();
}

function getErrMsg(out) {
  const e = out?._meta?.error;
  const metaMsg = typeof out?._meta?.message === "string" ? out._meta.message : "";
  const msg =
    typeof e === "string" ? e :
    typeof e?.message === "string" ? e.message :
    typeof out?.error === "string" ? out.error :
    "";
  return `${msg} ${metaMsg}`.toLowerCase().trim();
}

function isSystemBugMessage(msg = "") {
  const m = String(msg || "");
  return /\b(is not defined|referenceerror|syntaxerror|unexpected token|unexpected reserved word|typeerror|rangeerror|err_module_not_found|module_not_found|cannot find module|err_invalid_arg_type)\b/i.test(m);
}

function expectedFailReason(out, baseName) {
  if (EXPECT_SET.has(baseName)) return { code: "MANUAL_EXPECT_FAIL", reason: "S200_SMOKE_EXPECT_FAIL" };

  const exp = out?._meta?.expectedFail;
  if (exp && typeof exp === "object") {
    return { code: toStr(exp.code || "EXPECTED_FAIL"), reason: toStr(exp.reason || "") || "expectedFail meta" };
  }

  const code = getErrCode(out);
  const msg = getErrMsg(out);

  // SerpAPI is an optional upstream: treat generic failures as expected in STRICT smoke.
  if (baseName.includes("serpapi") && (code === "ERROR" || code === "unknown")) {
    return { code: "SERPAPI_FAIL", reason: msg || "SerpAPI failure" };
  }

  // Missing key => expectedFail only if that key is genuinely absent in env.
  if (code.includes("SERP") && code.includes("KEY")) {
    if (!envHasAny(["SERPAPI_KEY", "SERP_API_KEY", "SERPAPI_API_KEY"])) return { code, reason: "SERPAPI key missing" };
  }
  if (code.includes("PLACES") && code.includes("KEY")) {
    if (!envHasAny(["GOOGLE_PLACES_KEY", "PLACES_API_KEY", "GOOGLE_MAPS_API_KEY", "GOOGLE_MAPS_KEY"])) {
      return { code, reason: "Google Places/Maps key missing" };
    }
  }
  if (code.includes("OPENAI") && code.includes("KEY")) {
    if (!envHasAny(["OPENAI_API_KEY", "OPENAI_KEY"])) return { code, reason: "OpenAI key missing" };
  }

  // Some adapters don't set code, only message
  if (msg.includes("missing") && msg.includes("serp") && msg.includes("key")) {
    if (!envHasAny(["SERPAPI_KEY", "SERP_API_KEY", "SERPAPI_API_KEY"])) return { code: "MISSING_SERPAPI_KEY", reason: "SERPAPI key missing" };
  }
  if (msg.includes("missing") && msg.includes("places") && msg.includes("key")) {
    if (!envHasAny(["GOOGLE_PLACES_KEY", "PLACES_API_KEY", "GOOGLE_MAPS_API_KEY", "GOOGLE_MAPS_KEY"])) return { code: "MISSING_PLACES_KEY", reason: "Places/Maps key missing" };
  }

  // If this looks like our own code is broken, do NOT downgrade it to expectedFail.
  if (isSystemBugMessage(code) || isSystemBugMessage(msg)) return null;

  // Strict-disabled adapters are expected in STRICT mode.
  if (code === "STRICT_DISABLED") return { code, reason: "disabled in STRICT" };

  // Timeouts and upstream/network issues: expectedFail ("dış dünya").
  if (code === "timeout" || code === "TIMEOUT" || code.includes("TIMEOUT") || msg.includes("timed out")) {
    return { code: "TIMEOUT", reason: "upstream timeout" };
  }

  // Common upstream/network signals (403/401/429, DNS, TLS, etc.)
  const http4xx = /\b(401|403|404)\b/.test(msg) || msg.includes("status code 403") || msg.includes("status code 401") || msg.includes("status code 404");
  const http429 = /\b429\b/.test(msg) || msg.includes("rate limit") || msg.includes("too many requests");
  const http5xx = /\b5\d\d\b/.test(msg) || msg.includes("status code 500") || msg.includes("status code 502") || msg.includes("status code 503") || msg.includes("status code 504");
  const tls = msg.includes("certificate") || msg.includes("ssl") || msg.includes("tls") || msg.includes("self signed") || msg.includes("unable to verify");
  const dns = msg.includes("enotfound") || msg.includes("eai_again") || msg.includes("getaddrinfo");
  const net = msg.includes("econnreset") || msg.includes("econnrefused") || msg.includes("socket") || msg.includes("network") || msg.includes("fetch") || msg.includes("proxy");
  const blocked = msg.includes("captcha") || msg.includes("access denied") || msg.includes("blocked") || msg.includes("robot") || msg.includes("forbidden");

  if (http429) return { code: "RATE_LIMIT", reason: "upstream rate limit" };
  if (http4xx) return { code: "HTTP_4XX", reason: "upstream denied/not found" };
  if (http5xx) return { code: "HTTP_5XX", reason: "upstream server error" };
  if (tls) return { code: "TLS", reason: "TLS/cert issue" };
  if (dns) return { code: "DNS", reason: "DNS resolution issue" };
  if (blocked) return { code: "BOT_BLOCK", reason: "blocked/captcha" };

  // Last-resort: if the adapter explicitly returns ok:false with a generic error,
  // treat it as upstream-only if message indicates network.
  if ((code === "ERROR" || code === "unknown" || code === "FETCH_FAIL") && (net || http4xx || http5xx || tls || dns || blocked)) {
    return { code: "UPSTREAM", reason: "upstream/network" };
  }

  return null;
}

function isZero(v) {
  return v === 0 || v === "0";
}

function isBadItemContract(it) {
  const title = toStr(it?.title).trim();
  const url = toStr(it?.finalUrl || it?.affiliateUrl || it?.deeplink || it?.originUrl || it?.url).trim();

  if (!title) return "missing_title";
  if (!url) return "missing_url";
  if (!/^https?:\/\//i.test(url)) return "bad_url_scheme";

  // price fields: 0 is corruption; null/undefined OK
  if ([it?.price, it?.finalPrice, it?.optimizedPrice].some(isZero)) return "zero_price";

  // Hard ban: explicit fallback/stub kinds when strict
  const kind = toStr(it?.raw?.kind || it?.raw?.type || it?.kind).toLowerCase();
  if ((STRICT_NO_STUBS || STRICT_NO_FALLBACK_NAV) && ["fallback_nav", "placeholder", "stub", "mock", "fake"].includes(kind)) return `stub_kind:${kind}`;

  // Heuristic stub detector (kit) — only when strict.
  if ((STRICT_NO_STUBS || STRICT_NO_FALLBACK_NAV) && isStubItemS200(it)) return "stub_item";

  return null;
}

async function withTimeout(promise, ms, label = "timeout") {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`${label} (${ms}ms)`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(t);
  }
}

async function safeImportModule(absPath) {
  const url = pathToFileURL(absPath).href;
  return await import(url);
}

function pickAdaptersFromModule(mod) {
  // Most groups export one primary array (default or named). We'll take the first array we see.
  if (Array.isArray(mod?.default)) return mod.default;
  for (const k of Object.keys(mod || {})) {
    if (Array.isArray(mod[k])) return mod[k];
  }
  return [];
}

// ----------------------------------------------------------------------------
// MAIN
// ----------------------------------------------------------------------------
console.log(`\n🧪 S200 SMOKE TEST — groups: auto-scan`);
console.log(`mode: STRICT (FINDALLEASY_ALLOW_STUBS=${process.env.FINDALLEASY_ALLOW_STUBS} | FINDALLEASY_ALLOW_FALLBACK_NAV=${process.env.FINDALLEASY_ALLOW_FALLBACK_NAV})`);
console.log(`outerTimeout: ${OUTER_TIMEOUT_MS}ms | maxAdaptersPerGroup: ${MAX_ADAPTERS_PER_GROUP}`);
console.log(`query: "${QUERY}" | region:${REGION} | locale:${LOCALE}\n`);


// ----------------------------------------------------------------------------
// AFFILIATE CONTRACTS COVERAGE GATE (para hattı test kapsamına girer)
// - affiliate enabled provider'larda contract yoksa FAIL (strict modda)
// - WARN/FAIL sayımı ile "sessiz para kaybı"nı testte yakalar
// Env:
//   AFF_COVERAGE_STRICT=1          -> FAIL/WARN durumunda smoke test abort (failOnWarn'e bağlı)
//   AFF_COVERAGE_FAIL_ON_WARN=1    -> WARN'ları da fail say
// ----------------------------------------------------------------------------
const asBool = (v) => v === true || v === 1 || v === "1" || String(v ?? "").toLowerCase() === "true";

const __AFF_COV_STRICT =
  asBool(process.env.AFF_COVERAGE_STRICT ?? process.env.AFF_CONTRACT_STRICT ?? (process.env.NODE_ENV === "production" ? "1" : "0"));

const __AFF_FAIL_ON_WARN = asBool(process.env.AFF_COVERAGE_FAIL_ON_WARN ?? "0");

try {
  const __affReport = generateAffiliateContractsCoverage({
    providerConfig: PROVIDER_CONFIG,
    contracts: AFFILIATE_CONTRACTS,
    strict: __AFF_COV_STRICT,
    failOnWarn: __AFF_FAIL_ON_WARN,
    recommended: true,
  });

  printAffiliateContractsCoverage(__affReport);

  if (__AFF_COV_STRICT && __affReport.shouldFail) {
    console.error("🚨 Affiliate contracts coverage FAIL — aborting smoke test.");
    process.exit(1);
  }
} catch (e) {
  console.error("🚨 Affiliate contracts coverage crashed:", e?.message || e);
  // Coverage gate crash is a system bug: fail-fast in strict mode, warn in non-strict.
  if (__AFF_COV_STRICT) process.exit(1);
}

let totalOk = 0;
let totalFail = 0;
let totalExpected = 0;
let totalGroups = 0;
let totalAdapters = 0;

const groupFiles = (await fs.readdir(GROUP_DIR))
  .filter((f) => f.endsWith(".js") || f.endsWith(".mjs"))
  .filter((f) => !f.startsWith("_") || f === "_allGroups.js") // keep _allGroups, skip other private helpers
  .sort();

for (const file of groupFiles) {
  totalGroups += 1;
  const absPath = path.join(GROUP_DIR, file);

  let adapters;
  try {
    const mod = await safeImportModule(absPath);
    adapters = pickAdaptersFromModule(mod);
  } catch (e) {
    totalFail += 1;
    console.log(`❌ GROUP IMPORT FAIL: ${file} — ${e?.message || e}`);
    continue;
  }

  const picked = asArr(adapters).slice(0, MAX_ADAPTERS_PER_GROUP);
  console.log(`\n=== GROUP: ${file} (adapters: ${asArr(adapters).length}, testing: ${picked.length}) ===`);

  for (let i = 0; i < picked.length; i++) {
    const a = picked[i] || {};
    const baseName = toStr(a?.baseName || a?.providerKey || a?.name || `adapter_${i}`).trim() || `adapter_${i}`;
    const label = `${baseName}@${file}#${i + 1}`;
    totalAdapters += 1;

    const t0 = nowMs();
    let rawOut;
    try {
      rawOut = await withTimeout(Promise.resolve(a.fn?.(QUERY, { region: REGION, locale: LOCALE, limit: 25 })), OUTER_TIMEOUT_MS, label);
    } catch (e) {
      const out = { ok: false, items: [], count: 0, source: baseName, _meta: { error: { code: "ADAPTER_THROW", message: toStr(e?.message || e) } } };
      const exp = expectedFailReason(out, baseName);
      if (exp) {
        totalExpected += 1;
        console.log(`🟡 EXPECTED_FAIL ${label} — ${exp.code}${exp.reason ? `: ${exp.reason}` : ""} (${nowMs() - t0}ms)`);
      } else {
        totalFail += 1;
        console.log(`❌ FAIL ${label} — THROW: ${toStr(e?.message || e)} (${nowMs() - t0}ms)`);
      }
      continue;
    }

    const out = normalizeOut(rawOut, baseName);
    const exp = expectedFailReason(out, baseName);

    const items = asArr(out.items);
    const badReasons = [];
    for (const it of items) {
      const r = isBadItemContract(it);
      if (r) badReasons.push(r);
    }
    const badCount = badReasons.length;

    if (exp) {
      totalExpected += 1;
      console.log(`🟡 EXPECTED_FAIL ${label} — ${exp.code}${exp.reason ? `: ${exp.reason}` : ""} | ok:${out.ok} items:${items.length} bad:${badCount} (${nowMs() - t0}ms)`);
      continue;
    }

    if (!out.ok) {
      totalFail += 1;
      console.log(`❌ FAIL ${label} — ok:false | items:${items.length} bad:${badCount} err:${getErrCode(out) || getErrMsg(out) || "unknown"} (${nowMs() - t0}ms)`);
      continue;
    }

    if (STRICT_ITEMS && badCount > 0) {
      totalFail += 1;
      const top = badReasons.slice(0, 3).join(", ");
      console.log(`❌ FAIL ${label} — CONTRACT/STUB break | items:${items.length} bad:${badCount} (${top}${badCount > 3 ? ", ..." : ""}) (${nowMs() - t0}ms)`);
      continue;
    }

    totalOk += 1;
    console.log(`✅ OK ${label} — ok:true items:${items.length} bad:${badCount} (${nowMs() - t0}ms)`);
  }
}

console.log(`\n====================`);
console.log(`SMOKE SUMMARY`);
console.log(`groups: ${totalGroups} | adapters tested: ${totalAdapters}`);
console.log(`ok: ${totalOk} | expectedFail: ${totalExpected} | fail: ${totalFail}`);
console.log(`strictItems: ${STRICT_ITEMS ? "ON" : "OFF"} | strictNoStubs: ${STRICT_NO_STUBS ? "ON" : "OFF"} | strictNoFallbackNav: ${STRICT_NO_FALLBACK_NAV ? "ON" : "OFF"}`);
console.log(`====================\n`);

process.exitCode = totalFail > 0 ? 1 : 0;

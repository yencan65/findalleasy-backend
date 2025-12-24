#!/usr/bin/env node
// server/tools/s200Gate.mjs
// ============================================================================
// S200 GATE — PROD-REALISTIC (AFFILIATE-READY)
// - dotenv auto-load
// - Missing key => expectedFail/skip
// - Stub/fallback nav disabled by default (override via env)
// - Contract breaks => hard fail
// - NO "minimum N results" fantasy threshold
// ============================================================================

import "dotenv/config";

import { performance } from "node:perf_hooks";
import { isStubItemS200 } from "../core/s200AdapterKit.js";

// ----------------------------------------------------------------------------
// ENV DEFAULTS (prod-realistic)
// ----------------------------------------------------------------------------
process.env.FINDALLEASY_ALLOW_STUBS = process.env.FINDALLEASY_ALLOW_STUBS ?? "0";
process.env.FINDALLEASY_ALLOW_FALLBACK_NAV = process.env.FINDALLEASY_ALLOW_FALLBACK_NAV ?? "0";
process.env.FINDALLEASY_MOCK_VITRIN = process.env.FINDALLEASY_MOCK_VITRIN ?? "0";
process.env.FINDALLEASY_ENGINE_VARIANT = process.env.FINDALLEASY_ENGINE_VARIANT ?? "gate_v3";
process.env.REWARD_ENGINE_DISABLE = process.env.REWARD_ENGINE_DISABLE ?? "1";

// IMPORTANT (ESM): adapterEngine import'u env default'larından ÖNCE yapılırsa
// reward engine gibi yan etkiler uyanabilir. Bu yüzden dynamic import.
const eng = await import("../core/adapterEngine.js");

// ----------------------------------------------------------------------------
// CONFIG
// ----------------------------------------------------------------------------
const REGION = String(process.env.S200_GATE_REGION ?? "TR").trim();
const LOCALE = String(process.env.S200_GATE_LOCALE ?? "tr").trim();

const STRICT_ITEMS = String(process.env.S200_GATE_STRICT_ITEMS ?? "1") === "1";
const STRICT_NO_STUBS = String(process.env.FINDALLEASY_ALLOW_STUBS ?? "0") !== "1";
const STRICT_NO_FALLBACK_NAV = String(process.env.FINDALLEASY_ALLOW_FALLBACK_NAV ?? "0") !== "1";

function toStr(v) {
  return v == null ? "" : String(v);
}
function asArr(v) {
  return Array.isArray(v) ? v : [];
}

function envHasAny(keys) {
  return keys.some((k) => !!toStr(process.env[k]).trim());
}

function extractErrMsg(out) {
  const msg =
    typeof out?.error === "string" ? out.error :
    typeof out?._meta?.error === "string" ? out._meta.error :
    typeof out?._meta?.error?.message === "string" ? out._meta.error.message :
    "";
  return msg.toLowerCase();
}

function expectedFailReason(out) {
  const code = toStr(out?._meta?.error?.code || "").toUpperCase();
  const msg = extractErrMsg(out);

  if (code.includes("SERP") && code.includes("KEY")) {
    if (!envHasAny(["SERPAPI_KEY", "SERP_API_KEY", "SERPAPI_API_KEY"])) return { code, reason: "SERPAPI key missing" };
  }
  if (code.includes("PLACES") && code.includes("KEY")) {
    if (!envHasAny(["GOOGLE_PLACES_KEY", "PLACES_API_KEY", "GOOGLE_MAPS_API_KEY", "GOOGLE_MAPS_KEY"])) {
      return { code, reason: "Google Places/Maps key missing" };
    }
  }

  if (msg.includes("missing") && msg.includes("serp") && msg.includes("key")) {
    if (!envHasAny(["SERPAPI_KEY", "SERP_API_KEY", "SERPAPI_API_KEY"])) return { code: "MISSING_SERPAPI_KEY", reason: "SERPAPI key missing" };
  }
  if (msg.includes("missing") && msg.includes("places") && msg.includes("key")) {
    if (!envHasAny(["GOOGLE_PLACES_KEY", "PLACES_API_KEY", "GOOGLE_MAPS_API_KEY", "GOOGLE_MAPS_KEY"])) {
      return { code: "MISSING_PLACES_KEY", reason: "Places/Maps key missing" };
    }
  }

  return null;
}

function isZero(v) {
  return v === 0 || v === "0";
}

function normalizeUrl(it) {
  return toStr(it?.finalUrl || it?.affiliateUrl || it?.deeplink || it?.originUrl || it?.url).trim();
}

function isBadItemContract(it) {
  const title = toStr(it?.title).trim();
  const url = normalizeUrl(it);

  if (!title) return "missing_title";
  if (!url) return "missing_url";
  if (!/^https?:\/\//i.test(url)) return "bad_url_scheme";
  if ([it?.price, it?.finalPrice, it?.optimizedPrice].some(isZero)) return "zero_price";

  const kind = toStr(it?.raw?.kind || it?.raw?.type || it?.kind).toLowerCase();
  if ((STRICT_NO_STUBS || STRICT_NO_FALLBACK_NAV) && ["fallback_nav", "placeholder", "stub", "mock", "fake"].includes(kind)) return `stub_kind:${kind}`;

  if ((STRICT_NO_STUBS || STRICT_NO_FALLBACK_NAV) && isStubItemS200(it)) return "stub_item";

  return null;
}

// ----------------------------------------------------------------------------
// TESTS (E2E intent -> category -> adapters -> ranking)
// Pick queries that should route to meaningful categories.
// ----------------------------------------------------------------------------
const TESTS = [
  { name: "Product", q: "iphone 15" },
  { name: "Fashion", q: "nike air force" },
  { name: "Hotel", q: "otel bodrum" },
  { name: "Car rental", q: "araç kiralama bodrum" },
  { name: "Flight", q: "uçak bileti istanbul ankara" },
];

console.log(`\n🧪 S200 GATE — ${TESTS.length} E2E cases`);
console.log(`mode: STRICT (FINDALLEASY_ALLOW_STUBS=${process.env.FINDALLEASY_ALLOW_STUBS} | FINDALLEASY_ALLOW_FALLBACK_NAV=${process.env.FINDALLEASY_ALLOW_FALLBACK_NAV})`);
console.log(`region:${REGION} | locale:${LOCALE}`);
console.log(`strictItems: ${STRICT_ITEMS ? "ON" : "OFF"}\n`);

let okCount = 0;
let expectedCount = 0;
let failCount = 0;

for (const t of TESTS) {
  const t0 = performance.now();
  let out;
  try {
    out = await eng.runAdapters(t.q, REGION, { region: REGION, locale: LOCALE, limit: 40, offset: 0 });
  } catch (e) {
    failCount += 1;
    console.log(`❌ FAIL ${t.name} — THROW: ${toStr(e?.message || e)}`);
    continue;
  }

  if (!out || typeof out !== "object") {
    failCount += 1;
    console.log(`❌ FAIL ${t.name} — bad output shape`);
    continue;
  }

  if (out.ok !== true) {
    const exp = expectedFailReason(out);
    if (exp) {
      expectedCount += 1;
      console.log(`🟡 EXPECTED_FAIL ${t.name} — ${exp.code}: ${exp.reason} (${Math.round(performance.now() - t0)}ms)`);
    } else {
      failCount += 1;
      console.log(`❌ FAIL ${t.name} — ok:false error:${toStr(out?.error || out?._meta?.error || "unknown")} (${Math.round(performance.now() - t0)}ms)`);
    }
    continue;
  }

  const items = asArr(out.items);
  const badReasons = [];
  for (const it of items) {
    const r = isBadItemContract(it);
    if (r) badReasons.push(r);
  }
  const badCount = badReasons.length;

  if (STRICT_ITEMS && badCount > 0) {
    failCount += 1;
    const top = badReasons.slice(0, 4).join(", ");
    console.log(`❌ FAIL ${t.name} — CONTRACT/STUB break | category:${toStr(out.category)} items:${items.length} bad:${badCount} (${top}${badCount > 4 ? ", ..." : ""}) (${Math.round(performance.now() - t0)}ms)`);
    continue;
  }

  okCount += 1;
  console.log(`✅ OK ${t.name} — category:${toStr(out.category)} items:${items.length} bad:${badCount} (${Math.round(performance.now() - t0)}ms)`);
}

console.log(`\n====================`);
console.log(`GATE SUMMARY`);
console.log(`ok: ${okCount} | expectedFail: ${expectedCount} | fail: ${failCount}`);
console.log(`====================\n`);

process.exitCode = failCount > 0 ? 1 : 0;

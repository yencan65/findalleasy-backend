// server/tools/affContractsCoverage.mjs
// Standalone runner: prints affiliate contracts coverage report and sets exit code on FAIL.
// Usage:
//   node server/tools/affContractsCoverage.mjs
// Env:
//   AFF_COVERAGE_STRICT=1          -> fail process when FAIL exists
//   AFF_COVERAGE_FAIL_ON_WARN=1    -> fail also on WARN
//   AFF_COVERAGE_RECOMMENDED=0     -> skip recommended checks
//   AFF_COVERAGE_OUT=./reports     -> write JSON report (folder) OR ./reports/file.json

import fs from "node:fs";
import path from "node:path";

import { AFFILIATE_CONTRACTS } from "../core/affiliateContracts.js";
import { PROVIDER_CONFIG } from "../core/providerConfig.js";
import {
  generateAffiliateContractsCoverage,
  printAffiliateContractsCoverage,
} from "../core/affiliateContracts.coverage.js";

function asBool(v) {
  return v === true || v === 1 || v === "1" || String(v).toLowerCase() === "true";
}

function writeJson(rep) {
  const out = String(process.env.AFF_COVERAGE_OUT || "").trim();
  if (!out) return;

  const file = out.endsWith(".json") ? out : path.join(out, "affContractsCoverage.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(rep, null, 2), "utf8");
  console.log("📝 wrote:", file);
}

const strict = asBool(
  process.env.AFF_COVERAGE_STRICT ??
    process.env.AFF_CONTRACT_STRICT ??
    (process.env.NODE_ENV === "production" ? "1" : "0")
);

const failOnWarn = asBool(process.env.AFF_COVERAGE_FAIL_ON_WARN ?? "0");
const recommended = String(process.env.AFF_COVERAGE_RECOMMENDED ?? "1").trim() !== "0";

const report = generateAffiliateContractsCoverage({
  providerConfig: PROVIDER_CONFIG,
  contracts: AFFILIATE_CONTRACTS,
  strict,
  failOnWarn,
  recommended,
});

printAffiliateContractsCoverage(report);
writeJson(report);

if (strict && report.shouldFail) {
  console.error("🚨 Affiliate contracts coverage FAIL — aborting.");
  process.exit(1);
}

// server/core/affiliateContracts.coverage.js
// Coverage report for affiliate-enabled providers vs affiliateContracts table.
// Supports modes:
// - POSTBACK: requires clickId mapping + recommended IN keys for robust postback parsing
// - PARAM: requires affiliateId mapping (param key + env key), click tracking optional (WARN if missing)
// - REPORT: contract exists but no S2S postback (WARN unless you build report ingest)
// ZERO SECRET: contracts contain only mapping/schema, never tokens.
// ESM module.

function asBool(v) {
  return v === true || v === 1 || v === "1" || String(v).toLowerCase() === "true";
}

function arr(v) {
  return Array.isArray(v) ? v : (v != null ? [v] : []);
}

export function isAffiliateEnabled(p) {
  return asBool(p?.affiliate?.enabled ?? p?.aff?.enabled ?? p?.affiliateEnabled ?? p?.affiliateOn ?? false);
}

export function normalizeProviderList(providerConfig) {
  const raw = providerConfig ?? {};
  const list = Array.isArray(raw) ? raw : Object.values(raw);
  return list
    .map((p) => ({
      providerKey: String(p?.providerKey || p?.key || p?.id || "").trim(),
      affiliateEnabled: isAffiliateEnabled(p),
      declaredNetworkKey: String(p?.affiliate?.networkKey || p?.networkKey || "").trim() || null,
    }))
    .filter((p) => p.providerKey);
}

export function checkAffiliateContract(providerKey, contract, opts = {}) {
  const issues = [];
  const recommended = opts.recommended !== false;

  if (!contract || typeof contract !== "object") {
    issues.push({ level: "FAIL", code: "MISSING_CONTRACT", msg: "Contract yok" });
  } else {
    const mode = String(contract.mode || "POSTBACK").toUpperCase();
    if (!contract.providerKey) issues.push({ level: "FAIL", code: "MISSING_PROVIDERKEY", msg: "providerKey yok" });
    if (!contract.networkKey) issues.push({ level: "FAIL", code: "MISSING_NETWORKKEY", msg: "networkKey yok" });

    if (mode === "POSTBACK") {
      const outKey = contract?.out?.clickIdOutKey;
      if (!outKey) issues.push({ level: "FAIL", code: "MISSING_OUT_CLICKID", msg: "out.clickIdOutKey yok" });

      const inClick = arr(contract?.in?.clickIdInKeys);
      if (!inClick.length) issues.push({ level: "FAIL", code: "MISSING_IN_CLICKID", msg: "in.clickIdInKeys yok" });

      if (outKey && inClick.length && !inClick.includes(outKey)) {
        issues.push({ level: "FAIL", code: "CLICKID_KEY_MISMATCH", msg: `OUT key "${outKey}" IN listesinde yok` });
      }

      if (recommended) {
        if (!arr(contract?.in?.orderIdKeys).length)
          issues.push({ level: "WARN", code: "MISSING_ORDERID_KEYS", msg: "in.orderIdKeys önerilir" });
        if (!arr(contract?.in?.amountKeys).length)
          issues.push({ level: "WARN", code: "MISSING_AMOUNT_KEYS", msg: "in.amountKeys önerilir" });
        if (!arr(contract?.in?.currencyKeys).length)
          issues.push({ level: "WARN", code: "MISSING_CURRENCY_KEYS", msg: "in.currencyKeys önerilir" });
        if (!arr(contract?.in?.statusKeys).length)
          issues.push({ level: "WARN", code: "MISSING_STATUS_KEYS", msg: "in.statusKeys önerilir" });
        if (!arr(contract?.in?.approvedValues).length)
          issues.push({ level: "WARN", code: "MISSING_APPROVED_VALUES", msg: "in.approvedValues önerilir" });
      }

      const req = arr(contract?.rules?.require);
      for (const r of req) {
        if (!["clickId", "orderId", "amount", "currency", "status"].includes(r)) {
          issues.push({ level: "WARN", code: "UNKNOWN_REQUIRE_FIELD", msg: `rules.require tanımsız: ${r}` });
        }
      }
    } else if (mode === "PARAM") {
      const outK = contract?.out?.affiliateIdOutKey;
      const envK = contract?.out?.affiliateIdEnvKey;
      if (!outK) issues.push({ level: "FAIL", code: "MISSING_AFF_OUT_KEY", msg: "out.affiliateIdOutKey yok" });
      if (!envK) issues.push({ level: "FAIL", code: "MISSING_AFF_ENV_KEY", msg: "out.affiliateIdEnvKey yok" });

      // Optional click tracking for PARAM mode
      const clickOut = contract?.out?.clickIdOutKey;
      if (!clickOut) {
        issues.push({
          level: "WARN",
          code: "NO_CLICK_TRACKING",
          msg: "PARAM mode: clickIdOutKey yok (click-level tracking yok)",
        });
      }
    } else if (mode === "REPORT") {
      issues.push({
        level: "WARN",
        code: "REPORT_MODE",
        msg: "REPORT mode: S2S postback yok; rapor ingest hattı gerekir",
      });
    } else {
      issues.push({ level: "FAIL", code: "UNKNOWN_MODE", msg: `Bilinmeyen mode: ${mode}` });
    }
  }

  const fail = issues.some((i) => i.level === "FAIL");
  const warn = !fail && issues.some((i) => i.level === "WARN");
  const status = fail ? "FAIL" : warn ? "WARN" : "OK";
  const score = fail ? 0 : warn ? 70 : 100;

  return { providerKey, status, score, issues };
}

export function generateAffiliateContractsCoverage({
  providerConfig,
  contracts,
  strict = false,
  failOnWarn = false,
  recommended = true,
} = {}) {
  const providers = normalizeProviderList(providerConfig).filter((p) => p.affiliateEnabled);

  const rows = providers.map((p) => {
    const c = contracts?.[p.providerKey];
    const row = checkAffiliateContract(p.providerKey, c, { recommended });

    if (c?.networkKey && p.declaredNetworkKey && c.networkKey !== p.declaredNetworkKey) {
      row.issues.push({
        level: "WARN",
        code: "NETWORKKEY_MISMATCH",
        msg: `provider config networkKey="${p.declaredNetworkKey}" ama contract networkKey="${c.networkKey}"`,
      });
      if (row.status === "OK") row.status = "WARN";
    }

    return row;
  });

  const summary = {
    strict: Boolean(strict),
    failOnWarn: Boolean(failOnWarn),
    recommended: Boolean(recommended),
    affEnabled: rows.length,
    ok: rows.filter((r) => r.status === "OK").length,
    warn: rows.filter((r) => r.status === "WARN").length,
    fail: rows.filter((r) => r.status === "FAIL").length,
  };

  summary.coveragePct = summary.affEnabled ? (summary.ok / summary.affEnabled) * 100 : 100;

  const shouldFail = summary.fail > 0 || (failOnWarn && summary.warn > 0);
  return { summary, rows, shouldFail, ts: new Date().toISOString() };
}

export function printAffiliateContractsCoverage(report) {
  const rep = report || {};
  const s = rep.summary || {};

  console.log("=====================================================");
  console.log("💰 AFFILIATE CONTRACTS COVERAGE REPORT");
  console.log("ts:", rep.ts || new Date().toISOString());
  console.log(
    "affEnabled:", s.affEnabled ?? 0,
    "| OK:", s.ok ?? 0,
    "| WARN:", s.warn ?? 0,
    "| FAIL:", s.fail ?? 0,
    "| coverage%:", Number.isFinite(s.coveragePct) ? s.coveragePct.toFixed(1) : "n/a",
  );
  console.log("strict:", Boolean(s.strict), "| failOnWarn:", Boolean(s.failOnWarn), "| recommendedChecks:", Boolean(s.recommended));
  console.log("-----------------------------------------------------");

  for (const row of rep.rows || []) {
    const tag = row.status === "OK" ? "✅" : row.status === "WARN" ? "⚠️" : "🛑";
    const pk = String(row.providerKey || "").padEnd(18);
    const st = String(row.status || "").padEnd(4);
    console.log(`${tag} ${pk} ${st} issues:${(row.issues || []).length}`);

    for (const it of row.issues || []) {
      console.log(`   - [${it.level}] ${it.code}: ${it.msg}`);
    }
  }

  console.log("=====================================================");
}

// server/core/affiliateContracts.js
// =============================================================================
// AFFILIATE CONTRACTS (repo-lived)
// - providerKey -> networkKey -> mode -> out/in mappings
// - ZERO SECRET: only mapping/schema, never tokens.
// Modes:
//   POSTBACK: S2S postback with clickId (subid/cid) mapping.
//   PARAM: only affiliate id param injection (click tracking optional; coverage WARN).
//   REPORT: report/CSV based attribution (needs ingest pipeline).
// =============================================================================

export const AFFILIATE_CONTRACTS = {
  trendyol: {
    providerKey: "trendyol",
    networkKey: "trendyol",
    mode: "POSTBACK",
    out: {
      // Affiliate account id injected at outbound click (PARAM mode inside affiliateEngine)
      affiliateIdOutKey: process.env.TRENDYOL_AFF_PARAM || "aff_id",
      affiliateIdEnvKey: "TRENDYOL_AFF_ID",

      // Per-click tracking key (cid -> subid4)
      clickIdOutKey: "subid4",
      extraOutKeys: ["subid1", "subid2", "subid3"],
    },
    in: {
      clickIdInKeys: ["subid4", "subid", "clickid", "cid"],
      orderIdKeys: ["order_id", "orderId", "oid"],
      amountKeys: ["order_sum", "amount", "sum"],
      currencyKeys: ["currency", "cur"],
      statusKeys: ["payment_status", "status"],
      approvedValues: ["approved", "paid", "success"],
    },
    rules: {
      require: ["clickId", "orderId", "amount"],
      amountMin: 0.01,
      allowCurrencies: ["TRY", "USD", "EUR"],
    },
  },

  acibadem: {
    providerKey: "acibadem",
    networkKey: "acibadem",
    mode: "PARAM",
    out: {
      affiliateIdOutKey: process.env.ACIBADEM_AFF_PARAM || "aff_id",
      affiliateIdEnvKey: "ACIBADEM_AFF_ID",
      // Optional: if provider/network supports per-click subid, set clickIdOutKey here later.
      // clickIdOutKey: "subid4",
    },
  },
  activities: {
    providerKey: "activities",
    networkKey: "activities",
    mode: "PARAM",
    out: {
      affiliateIdOutKey: "partner_id",
      affiliateIdEnvKey: "ACTIVITIES_PARTNER_ID",
      // Optional: if provider/network supports per-click subid, set clickIdOutKey here later.
      // clickIdOutKey: "subid4",
    },
  },
  a101: {
    providerKey: "a101",
    networkKey: "a101",
    mode: "PARAM",
    out: {
      affiliateIdOutKey: process.env.A101_AFF_PARAM || "aff_id",
      affiliateIdEnvKey: "A101_AFF_ID",
      // Optional: if provider/network supports per-click subid, set clickIdOutKey here later.
      // clickIdOutKey: "subid4",
    },
  },
  aliexpress: {
    providerKey: "aliexpress",
    networkKey: "aliexpress",
    mode: "PARAM",
    out: {
      affiliateIdOutKey: process.env.ALIEXPRESS_AFF_PARAM || "aff_fcid",
      affiliateIdEnvKey: "ALIEXPRESS_AFF_ID",
      // Optional: if provider/network supports per-click subid, set clickIdOutKey here later.
      // clickIdOutKey: "subid4",
    },
  },
  amazon: {
    providerKey: "amazon",
    networkKey: "amazon",
    mode: "PARAM",
    out: {
      affiliateIdOutKey: "tag",
      affiliateIdEnvKey: "AMAZON_TR_TAG",
      // Optional: if provider/network supports per-click subid, set clickIdOutKey here later.
      // clickIdOutKey: "subid4",
    },
  },
  agoda: {
    providerKey: "agoda",
    networkKey: "agoda",
    mode: "PARAM",
    out: {
      affiliateIdOutKey: process.env.AGODA_AFF_PARAM || "cid",
      affiliateIdEnvKey: "AGODA_AFF_ID",
      // Optional: if provider/network supports per-click subid, set clickIdOutKey here later.
      // clickIdOutKey: "subid4",
    },
  },
  booking: {
    providerKey: "booking",
    networkKey: "booking",
    mode: "PARAM",
    out: {
      affiliateIdOutKey: process.env.BOOKING_AFF_PARAM || "aid",
      affiliateIdEnvKey: "BOOKING_AFF_ID",
      // Optional: if provider/network supports per-click subid, set clickIdOutKey here later.
      // clickIdOutKey: "subid4",
    },
  },
  ciceksepeti: {
    providerKey: "ciceksepeti",
    // Çiçeksepeti influencer setup is commonly run on TUNE (HasOffers).
    // TUNE standard: aff_id identifies affiliate, aff_sub carries sub-id (click id).
    networkKey: process.env.CICEK_NETWORK_KEY || "tune",
    mode: "POSTBACK",
    out: {
      affiliateIdOutKey: process.env.CICEK_AFF_PARAM || "aff_id",
      affiliateIdEnvKey: "CICEK_AFF_ID",

      clickIdOutKey: process.env.CICEK_CLICKID_PARAM || "aff_sub",
      extraOutKeys: ["aff_sub2", "aff_sub3", "aff_sub4", "aff_sub5"],
    },
    in: {
      clickIdInKeys: ["aff_sub", "clickId", "subid4", "cid"],
      orderIdKeys: ["transaction_id", "order_id", "orderId", "oid", "tid"],
      amountKeys: ["sale_amount", "order_sum", "amount", "sum"],
      currencyKeys: ["currency", "cur"],
      statusKeys: ["status", "payment_status"],
      approvedValues: ["approved", "paid", "success"],
    },
    rules: {
      require: ["clickId", "orderId", "amount"],
      amountMin: 0.01,
    },
  },

  hepsiburada: {
    providerKey: "hepsiburada",
    // NOTE: Public docs rarely expose program network details. Treat this as a
    // default "Admitad-style" postback contract (subid4 carries click_id).
    // If your HB program uses a different network/param, override via env.
    networkKey: process.env.HEPSI_NETWORK_KEY || "admitad",
    mode: "POSTBACK",
    out: {
      // Optional: if your outbound deeplink needs affiliate id injection
      // keep these; otherwise your link already embeds publisher id.
      affiliateIdOutKey: process.env.HEPSI_AFF_PARAM || "aff_id",
      affiliateIdEnvKey: "HEPSI_AFF_ID",

      // Click-level attribution (Admitad guidance: use subid4 for click_id)
      clickIdOutKey: process.env.HEPSI_CLICKID_PARAM || "subid4",
      extraOutKeys: ["subid", "subid1", "subid2", "subid3"],
    },
    in: {
      // Incoming postback: accept both "standard names" and our canonical aliases
      clickIdInKeys: ["subid4", "clickId", "subid", "clickid", "cid"],
      orderIdKeys: ["order_id", "orderId", "oid", "transaction_id", "tid"],
      amountKeys: ["order_sum", "amount", "sum", "sale_amount"],
      currencyKeys: ["currency", "cur"],
      statusKeys: ["payment_status", "status"],
      approvedValues: ["approved", "paid", "success"],
    },
    rules: {
      require: ["clickId", "orderId", "amount"],
      amountMin: 0.01,
    },
  },
  n11: {
    providerKey: "n11",
    // Default to "Admitad-style" click attribution (subid4 = click_id).
    // If your program differs, override via env.
    networkKey: process.env.N11_NETWORK_KEY || "admitad",
    mode: "POSTBACK",
    out: {
      affiliateIdOutKey: process.env.N11_AFF_PARAM || "aff_id",
      affiliateIdEnvKey: "N11_AFF_ID",

      clickIdOutKey: process.env.N11_CLICKID_PARAM || "subid4",
      extraOutKeys: ["subid", "subid1", "subid2", "subid3"],
    },
    in: {
      clickIdInKeys: ["subid4", "clickId", "subid", "clickid", "cid"],
      orderIdKeys: ["order_id", "orderId", "oid", "transaction_id", "tid"],
      amountKeys: ["order_sum", "amount", "sum", "sale_amount"],
      currencyKeys: ["currency", "cur"],
      statusKeys: ["payment_status", "status"],
      approvedValues: ["approved", "paid", "success"],
    },
    rules: {
      require: ["clickId", "orderId", "amount"],
      amountMin: 0.01,
    },
  },

  sahibinden: {
    providerKey: "sahibinden",
    networkKey: "sahibinden",
    mode: "PARAM",
    out: {
      affiliateIdOutKey: process.env.SAH_AFF_PARAM || "fae_src",
      affiliateIdEnvKey: "SAH_AFF_ID",
      // Optional: if provider/network supports per-click subid, set clickIdOutKey here later.
      // clickIdOutKey: "subid4",
    },
  },
};

export default AFFILIATE_CONTRACTS;

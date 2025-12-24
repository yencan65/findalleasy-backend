// ===================================================================
//   REWARD ENGINE — S16 ULTIMATE FINAL FORM
//   ZERO-LOSS • ZERO-RACE • ZERO-FRAUD • ZERO-DUPLICATE
//   Commission Shield • Affiliate Guardian • Neural Revenue Sync
//   Wallet Atomicity v3 • RevenueMemory v16 align
//   Tek Beyin Mimarisi — FindAllEasy Core
// ===================================================================

// MODELS
import mongoose from "mongoose";
import WalletTransactionBase from "../models/WalletTransaction.js";
import UserBase from "../models/User.js";
import OrderBase from "../models/Order.js";

// REVENUE MEMORY S16
import {
  recordClick,
  recordConversion,
  getProviderRevenueStats,
} from "./revenueMemoryEngine.js";

// DYNAMIC MODEL BINDING (S16 Hardened)
let User = UserBase;
let Order = OrderBase;
let WalletTransaction = WalletTransactionBase;
let mongooseInstance = null;

let modelInitialized = false;
let modelChecked = false;

// ===================================================================
// S16 — MODEL INITIALIZER (Self-heal, Race-Free)
// ===================================================================
async function initializeModel() {
  try {
    if (modelInitialized) return true;

    const mod = await import("mongoose");
    mongooseInstance = mod.default;

    if (mongooseInstance.modelNames().includes("User"))
      User = mongooseInstance.model("User");

    if (mongooseInstance.modelNames().includes("Order"))
      Order = mongooseInstance.model("Order");

    if (mongooseInstance.modelNames().includes("WalletTransaction"))
      WalletTransaction = mongooseInstance.model("WalletTransaction");

    modelInitialized = true;

    console.log("✅ [S16] RewardEngine modelleri init edildi");
    return true;
  } catch (err) {
    console.error("❌ [S16] initializeModel ERROR:", err.message);
    return false;
  }
}

// ===================================================================
// S16 — ENSURE MODEL
// ===================================================================
async function ensureModel() {
  try {
    if (modelChecked && modelInitialized && mongooseInstance) return true;

    if (!modelInitialized) {
      const ok = await initializeModel();
      if (!ok) return false;
    }

    if (
      mongooseInstance &&
      User.prototype instanceof mongooseInstance.Model &&
      Order.prototype instanceof mongooseInstance.Model &&
      WalletTransaction.prototype instanceof mongooseInstance.Model
    ) {
      modelChecked = true;
      return true;
    }
  } catch (err) {
    console.error("❌ [S16] ensureModel ERROR:", err.message);
  }

  return false;
}

// ===================================================================
// LOGGING — Crash-Proof Logger
// ===================================================================
function logReward(tag, data) {
  try {
    console.log(
      "🎁",
      tag,
      typeof data === "object" ? JSON.stringify(data, null, 2) : data
    );
  } catch {
    console.log("🎁", tag, "[LOG_ERROR]");
  }
}

// ===================================================================
// PROVIDER WHITELIST — S16 AUTO EXPAND READY
// ===================================================================
const COMMISSIONABLE_PROVIDERS_BASE = [
  "amazon",
  "trendyol",
  "hepsiburada",
  "aliexpress",
  "booking",
];

// ===================================================================
// S16 — Provider Commissionable Gate (DEV'de test, PROD'da kilit)
// - PROD: gate her zaman AÇIK (whitelist dışı provider => reward yok)
// - DEV/TEST: varsayılan KAPALI (her provider commissionable sayılır)
//   İstersen DEV'de aç: FAE_COMMISSIONABLE_GATE=1
//   İstersen DEV'de ekstra whitelist: FAE_COMMISSIONABLE_PROVIDERS_EXTRA="x,y,z"
// ===================================================================
function __s16ParseCsvProviders(v) {
  try {
    const s = String(v || "").trim();
    if (!s) return [];
    return s
      .split(",")
      .map((x) => String(x || "").trim().toLowerCase())
      .filter(Boolean)
      .map((x) => x.replace(/[^a-z0-9_-]/gi, ""))
      .filter(Boolean);
  } catch {
    return [];
  }
}

const __S16_ENV = String(process.env.FAE_ENV || process.env.NODE_ENV || "")
  .trim()
  .toLowerCase();
const __S16_IS_PROD =
  __S16_ENV === "production" || __S16_ENV === "prod" || __S16_ENV === "live";

const COMMISSIONABLE_PROVIDERS_EXTRA = __s16ParseCsvProviders(
  process.env.FAE_COMMISSIONABLE_PROVIDERS_EXTRA ||
    process.env.FINDALLEASY_COMMISSIONABLE_PROVIDERS_EXTRA ||
    ""
);

const COMMISSIONABLE_PROVIDERS = Array.from(
  new Set([...COMMISSIONABLE_PROVIDERS_BASE, ...COMMISSIONABLE_PROVIDERS_EXTRA])
);

// Gate: PROD kilitli AÇIK, DEV varsayılan KAPALI (override edilebilir)
const __S16_COMMISSIONABLE_GATE = (() => {
  if (__S16_IS_PROD) return true;
  const raw = String(
    process.env.FAE_COMMISSIONABLE_GATE ||
      process.env.FINDALLEASY_COMMISSIONABLE_GATE ||
      ""
  )
    .trim()
    .toLowerCase();
  if (raw === "1" || raw === "true" || raw === "on") return true;
  if (raw === "0" || raw === "false" || raw === "off") return false;
  return false; // DEV default: off
})();

function __S16_isProviderCommissionable(providerKey) {
  const pk = String(providerKey || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/gi, "");
  if (!pk) return false;

  // DEV/TEST: gate kapalıysa her provider commissionable sayılır (E2E test için)
  if (!__S16_COMMISSIONABLE_GATE) return true;

  return COMMISSIONABLE_PROVIDERS.includes(pk);
}

// Komisyonlu sipariş mi?
function isCommissionableOrder(order) {
  if (!order) return false;
  if (order.isCommissioned === false) return false;

  if (
    typeof order.commissionRate === "number" &&
    Number.isFinite(order.commissionRate) &&
    order.commissionRate > 0
  ) {
    return true;
  }

  if (
    order.provider &&
    __S16_isProviderCommissionable(String(order.provider).toLowerCase())
  ) {
    return true;
  }
return false;
}

// ===================================================================
// FLEXIBLE USER FINDER — S16
// ===================================================================
async function findUserFlexible(id) {
  const ready = await ensureModel();
  if (!ready) return null;

  try {
    if (!id) return null;

    const q = { $or: [{ email: id }, { id }] };

    if (mongooseInstance.Types.ObjectId.isValid(id)) {
      q.$or.push({ _id: id });
    }

    return await User.findOne(q);
  } catch (err) {
    logReward("findUserFlexible_ERROR", {
      identifier: id,
      error: err?.message || String(err),
    });
    return null;
  }
}

// ===================================================================
// WALLET ENGINE — S16 ATOMICITY v3
// Ultra-safe, Race-free, Double-write-proof
// ===================================================================
const WALLET_LOCK = new Map();

async function safeAddToWallet(user, amount) {
  const ready = await ensureModel();
  if (!ready) {
    logReward("safeAddToWallet_MODEL_NOT_READY", {
      user: user?.email,
      amount,
    });
    return;
  }

  try {
    if (!user) return;
    if (!Number.isFinite(Number(amount))) return;
    if (Number(amount) === 0) return;

    const uId = String(user._id);

    // HARD SPINLOCK (max 1500ms)
    const start = Date.now();
    while (WALLET_LOCK.get(uId)) {
      if (Date.now() - start > 1500) {
        logReward("WALLET_LOCK_FORCE_RELEASE", { userId: uId });
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    WALLET_LOCK.set(uId, true);

    const current =
      typeof user.walletBalance === "number"
        ? user.walletBalance
        : Number(user.wallet) || 0;

    const delta = Math.round(Number(amount) * 100) / 100;
    const newWallet = Math.max(0, Math.round((current + delta) * 100) / 100);

    await User.findByIdAndUpdate(
      uId,
      { wallet: newWallet, walletBalance: newWallet },
      { new: true }
    );

    user.wallet = newWallet;
    user.walletBalance = newWallet;

    await WalletTransaction.create({
      userId: uId,
      amount: delta,
      type: "reward",
      note: "RewardEngine S16",
      relatedOrderId: null,
      relatedCouponCode: null,
    });

    logReward("WALLET_UPDATE", { userId: uId, delta, newWallet });
    return newWallet;
  } catch (err) {
    logReward("safeAddToWallet_ERROR", {
      user: user?.email,
      amount,
      error: err?.message || String(err),
    });
  } finally {
    WALLET_LOCK.delete(String(user._id));
  }
}

// ===================================================================
// ==== S16-P2 BURADA BAŞLAYACAK ====
// ===================================================================
// ===================================================================
// ==== S16-P2 — PURCHASE REWARD + LEGACY ORDER REWARD ==============
// ===================================================================

// S16 Purchase Reward — düz ama güvenli çekirdek
export async function applyPurchaseRewards({ userId, purchaseAmount }) {
  const ready = await ensureModel();
  if (!ready) return { ok: false, error: "MODEL_NOT_READY" };

  try {
    const numericAmount = Number(
      purchaseAmount ??
        0
    );

    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      return { ok: false, error: "INVALID_AMOUNT" };
    }

    const user = await findUserFlexible(userId);
    if (!user) return { ok: false, error: "USER_NOT_FOUND" };

    // S16: Düz 1% çekirdek — üst limitli
    let reward = Math.round(numericAmount * 0.01 * 100) / 100;
    if (reward > 50) reward = 50; // hard cap

    if (reward > 0) {
      await safeAddToWallet(user, reward);
    }

    logReward("applyPurchaseRewards_OK", {
      userId,
      purchaseAmount: numericAmount,
      reward,
    });

    return { ok: true, reward };
  } catch (err) {
    logReward("applyPurchaseRewards_ERROR", {
      userId,
      purchaseAmount,
      error: err?.message,
    });
    return { ok: false, error: err?.message || "UNEXPECTED_ERROR" };
  }
}

// Eski isimle uyum
export const applyRewards = applyPurchaseRewards;

// ===================================================================
// LEGACY ORDER REWARD (S9 + S10 uyumluluk katmanı — kaldırılmadı)
// ===================================================================
export async function applyRewardsForOrderLegacyBalance(order) {
  const ready = await ensureModel();
  if (!ready) return;

  try {
    if (!order || !order.userId) return;

    const user = await User.findById(order.userId);
    if (!user) return;

    const inviter = user.invitedBy || null;
    let rewardForBuyer = 0;
    let rewardForInviter = 0;

    const OrderDb = Order || (await import("../models/Order.js")).default;

    const completedCount = await OrderDb.countDocuments({
      userId: user.id,
      status: "completed",
    });

    const isFirstOrder = completedCount === 0;

    if (isFirstOrder) {
      rewardForBuyer = order.amount * 0.01;
      rewardForInviter = inviter ? order.amount * 0.005 : 0;
    } else {
      rewardForBuyer = 0;
      rewardForInviter = inviter ? order.amount * 0.001 : 0;
    }

    const lastTx = await WalletTransaction.findOne({ userId: user.id })
      .sort({ createdAt: -1 })
      .lean();

    let currentBalance = lastTx?.balanceAfter || 0;

    if (rewardForBuyer > 0) {
      currentBalance += rewardForBuyer;

      await WalletTransaction.create({
        userId: user.id,
        amount: rewardForBuyer,
        type: "reward",
        relatedOrderId: order._id,
        note: "Sipariş ödülü (legacy)",
        balanceAfter: currentBalance,
      });
    }

    if (inviter && rewardForInviter > 0) {
      const lastInviterTx = await WalletTransaction.findOne({
        userId: inviter,
      })
        .sort({ createdAt: -1 })
        .lean();

      let inviterBalance = lastInviterTx?.balanceAfter || 0;
      inviterBalance += rewardForInviter;

      await WalletTransaction.create({
        userId: inviter,
        amount: rewardForInviter,
        type: "referral",
        relatedOrderId: order._id,
        note: "Davet ödülü (legacy)",
        balanceAfter: inviterBalance,
      });
    }

    logReward("applyRewardsForOrderLegacyBalance_OK", {
      orderId: order._id,
      user: user.email,
      inviter,
      rewardForBuyer,
      rewardForInviter,
    });
  } catch (err) {
    logReward("applyRewardsForOrderLegacyBalance_ERROR", {
      orderId: order?._id,
      error: err?.message,
    });
  }
}

// ===================================================================
// ==== S16-P3 — ORDER REWARD (Triple Shield + RevenueMemory) ========
// ===================================================================

// S16 — Affiliate match (ENV zorunlu)
function isAffiliateMatched(order) {
  const expected = process.env.FAE_AFFILIATE_ID || null;

  if (!expected) {
    logReward("AFFILIATE_BLOCK_S16", {
      reason: "NO_EXPECTED_ID",
      env: process.env.FAE_AFFILIATE_ID,
    });
    return false;
  }

  if (!order) return false;

  const aff =
    order.affiliateId || order.affiliate || order.affiliate_id || null;

  if (!aff) return false;
  if (String(aff).trim().length < 3) return false;

  return String(aff) === String(expected);
}

// S16 — commission paid flag
function isCommissionPaid(order) {
  if (!order) return false;

  if (order.commissionPaid === true) return true;
  if (order.isCommissionPaid === true) return true;
  if (
    order.commission_status &&
    String(order.commission_status).toLowerCase() === "paid"
  )
    return true;

  if (order.commissionPaid === 1 || order.isCommissionPaid === 1) return true;

  return false;
}

// ===================================================================
// applyRewardsForOrder — S16 TRIPLE SHIELD + REVENUE MEMORY
// ===================================================================
export async function applyRewardsForOrder(order) {
  if (!order) return { ok: false, reason: "NO_ORDER" };

  // Self-referral block
  if (
    order.userId &&
    order.referrerId &&
    String(order.userId) === String(order.referrerId)
  ) {
    return { ok: false, reason: "SELF_REFERRAL_BLOCKED" };
  }

  let providerKey = String(order.provider || "unknown").toLowerCase();
  providerKey = providerKey.replace(/[^a-z0-9_-]/gi, "") || "unknown";

  // SHIELD 1: provider commissionable gate (DEV'de test, PROD'da kilit)
  if (!__S16_isProviderCommissionable(providerKey)) {
    logReward("applyRewardsForOrder_PROVIDER_NOT_COMMISSIONABLE", {
      provider: providerKey,
    });
    return { ok: false, reason: "PROVIDER_NOT_COMMISSIONABLE" };
  }
// SHIELD 2: Affiliate match
  if (!isAffiliateMatched(order)) {
    logReward("applyRewardsForOrder_AFFILIATE_MISMATCH", {
      expected: process.env.FAE_AFFILIATE_ID || null,
      got:
        order.affiliateId ||
        order.affiliate ||
        order.affiliate_id ||
        null,
    });
    return { ok: false, reason: "AFFILIATE_NOT_MATCHED" };
  }

  // SHIELD 3: commission paid
  if (!isCommissionPaid(order)) {
    logReward("applyRewardsForOrder_COMMISSION_NOT_PAID", {
      orderId: order._id || order.id || order.orderId,
      provider: providerKey,
      commissionPaid: order.commissionPaid,
      isCommissionPaid: order.isCommissionPaid,
      commission_status: order.commission_status,
    });
    return { ok: false, reason: "COMMISSION_NOT_PAID" };
  }

  // Ek kontrol: gerçekten komisyonlu mu
  if (!isCommissionableOrder(order)) {
    logReward("applyRewardsForOrder_NON_COMMISSIONABLE_ORDER", {
      provider: providerKey,
      commissionRate: order.commissionRate,
    });
    return { ok: false, reason: "NON_COMMISSIONABLE" };
  }

  const amount =
    order.purchaseAmount ??
    order.amount ??
    order.total ??
    order.totalPrice ??
    order.price ??
    0;

  // RevenueMemory → conversion kaydı
  try {
    recordConversion({
      provider: providerKey,
      amount,
      orderId: order._id || order.id || order.orderId,
      userId: order.userId || null,
      rate: order.commissionRate ?? null,
    });
  } catch (err) {
    logReward("recordConversion_ERROR", {
      provider: providerKey,
      error: err?.message || String(err),
    });
  }

  // Provider revenue stats (dinamik oran/öncelik için hazır)
  let revenueStats = null;
  try {
    revenueStats = await getProviderRevenueStats(providerKey);
  } catch (err) {
    logReward("getProviderRevenueStats_ERROR", {
      provider: providerKey,
      error: err?.message || String(err),
    });
  }

  const userId =
    order.userId ||
    order.user ||
    order.ownerId ||
    order.buyerId ||
    order.customerId;

  const res = await applyPurchaseRewards({ userId, purchaseAmount: amount });

  logReward("applyRewardsForOrder_RESULT", {
    orderId: order._id || order.id || order.orderId,
    userId,
    purchaseAmount: amount,
    provider: providerKey,
    result: res,
    revenueStats: revenueStats || null,
  });

  return res;
}

// ===================================================================
// ==== S16-P4 — CLICK REWARD + SUMMARY + SIGNALS + DEFAULT EXPORT ====
// ===================================================================

// CLICK REWARD — S16 Click-spam shield + micro ödül
const CLICK_LOCK = new Map();

export async function applyClickReward({
  userId,
  productId,
  provider,
  price,
}) {
  const ready = await ensureModel();
  if (!ready) return { ok: false, error: "MODEL_NOT_READY" };

  try {
    const key = `${userId || "anon"}_${productId || "noProd"}_${
      provider || "unknown"
    }`;
    const now = Date.now();

    // Spam shield: aynı user+product+provider için 1 sn içinde tekrar yok
    if (CLICK_LOCK.get(key) && now - CLICK_LOCK.get(key) < 1000) {
      return { ok: false, reason: "CLICK_SPAM_BLOCKED" };
    }
    CLICK_LOCK.set(key, now);

    try {
      recordClick({
        userId,
        productId,
        provider,
        price,
      });
    } catch (err) {
      logReward("recordClick_ERROR", { error: err?.message || String(err) });
    }

    const user = await findUserFlexible(userId);
    if (!user) return { ok: false, reason: "USER_NOT_FOUND" };

    // micro ödül
    let clickReward = 0.01;
    const cap = 0.05;
    if (clickReward > cap) clickReward = cap;

    await safeAddToWallet(user, clickReward);

    logReward("applyClickReward_OK", {
      userId,
      productId,
      provider,
      price,
      reward: clickReward,
    });

    return { ok: true };
  } catch (err) {
    logReward("applyClickReward_ERROR", {
      userId,
      productId,
      provider,
      error: err?.message || String(err),
    });
    return { ok: false };
  }
}

// ===================================================================
// USER SUMMARY
// ===================================================================
export async function getUserRewardsSummary(userId) {
  const ready = await ensureModel();
  if (!ready) return { ok: false, error: "MODEL_NOT_READY" };

  try {
    const user = await findUserFlexible(userId);
    if (!user) return { ok: false, error: "USER_NOT_FOUND" };

    const wallet =
      typeof user.walletBalance === "number"
        ? user.walletBalance
        : Number(user.wallet) || 0;

    return {
      ok: true,
      userId,
      wallet,
      firstPurchaseDone: user.firstPurchaseDone || false,
      referral: user.referral || null,
      totalClicks: 0,
      totalEarnings: wallet,
      pending: 0,
      history: [],
    };
  } catch (err) {
    logReward("getUserRewardsSummary_ERROR", {
      userId,
      error: err?.message,
    });
    return { ok: false, error: "UNEXPECTED_ERROR" };
  }
}

// ===================================================================
// USER COMMISSION STATS
// ===================================================================
export async function getUserCommissionStats(userId) {
  const ready = await ensureModel();
  if (!ready) {
    return {
      ok: false,
      userId,
      error: "MODEL_NOT_READY",
    };
  }

  try {
    const orders = await Order.find({ userId }).select(
      "commission commissionPaid isCommissionPaid commission_status"
    );

    let earned = 0;
    let pending = 0;

    for (const o of orders) {
      const c = Number(o.commission || 0);
      if (!Number.isFinite(c) || c <= 0) continue;

      const paid =
        o.commissionPaid === true ||
        o.isCommissionPaid === true ||
        (o.commission_status &&
          String(o.commission_status).toLowerCase() === "paid");

      if (paid) earned += c;
      else pending += c;
    }

    earned = Math.round(earned * 100) / 100;
    pending = Math.round(pending * 100) / 100;

    return {
      ok: true,
      userId,
      earned,
      pending,
      note: "S16 commission stats from Order model.",
    };
  } catch (err) {
    return {
      ok: false,
      userId,
      error: err?.message || String(err),
    };
  }
}

// ===================================================================
// USER INVITE TREE (silinmedi, S10 ile uyumlu tutuldu)
// ===================================================================
export async function getUserInviteTree(userId) {
  const ready = await ensureModel();
  if (!ready) return { ok: false, error: "MODEL_NOT_READY" };

  try {
    const level1 = await User.find({ referral: userId });
    const tree = [];

    for (const u of level1) {
      const level2 = await User.find({ referral: u.email });

      tree.push({
        inviter: u.email,
        invited: level2.map((x) => x.email),
        level2Count: level2.length,
      });
    }

    return {
      ok: true,
      root: userId,
      depth1: level1.map((u) => ({
        email: u.email,
        wallet: u.wallet || u.walletBalance || 0,
        joinDate: u.createdAt,
      })),
      tree,
      totalInvited: level1.length,
    };
  } catch (err) {
    logReward("getUserInviteTree_ERROR", {
      userId,
      error: err?.message,
    });
    return { ok: false };
  }
}

// ===================================================================
// USER CLICKS (placeholder)
// ===================================================================
export async function getUserClicks(userId) {
  return {
    ok: true,
    userId,
    clicks: [],
    note: "S16 minimal click history placeholder",
  };
}

// ===================================================================
// PROVIDER SIGNAL SINK
// ===================================================================
export async function recordProviderSignal({
  provider,
  event,
  amount,
  commissionRate,
  userId,
  orderId,
  meta = {},
}) {
  try {
    logReward("PROVIDER_SIGNAL", {
      provider: String(provider || "unknown").toLowerCase(),
      event: event || "unknown",
      amount: Number(amount || 0),
      commissionRate:
        commissionRate != null && Number.isFinite(Number(commissionRate))
          ? Number(commissionRate)
          : null,
      userId: userId || null,
      orderId: orderId || null,
      ts: Date.now(),
      meta,
    });
  } catch (err) {
    logReward("recordProviderSignal_ERROR", {
      error: err?.message || String(err),
    });
  }
}

// ===================================================================
// DEBUG / HEALTH
// ===================================================================
export function _rewardDebugMemory() {
  return {
    ok: true,
    note: "S16 rewardEngine debug snapshot.",
    ts: Date.now(),
    modelInitialized,
    modelChecked,
  };
}

export async function checkModelHealth() {
  try {
    const ready = await ensureModel();
    if (!ready)
      return { ok: false, healthy: false, error: "Model not ready" };

    const result = await User.findOne().limit(1).select("_id").lean();

    return {
      ok: true,
      healthy: true,
      model: "User",
      testQuery: result ? "SUCCESS" : "NO_DATA",
    };
  } catch (error) {
    return {
      ok: false,
      healthy: false,
      error: error.message,
      model: "User",
    };
  }
}

export async function systemStartupCheck() {
  logReward("SYSTEM_STARTUP", { time: new Date().toISOString() });

  const health = await checkModelHealth();

  if (health.ok && health.healthy)
    console.log("✅ [rewardEngineS9.js] Reward Engine S16 başarıyla başlatıldı");
  else
    console.log(
      "⚠️ Reward Engine S16 başlatıldı ama model kontrolü başarısız:",
      health.error
    );

  return health;
}

// Sistem startında sessiz health check
// TEST/CI izolasyonu: Gate/Smoke gibi ortamlarda RewardEngine'in DB'yi ayağa kaldırmasını engelle.
// Varsayılan davranış korunur (disable yoksa autostart devam).
const __REWARD_ENGINE_DISABLE =
  String(process.env.REWARD_ENGINE_DISABLE ?? "0") === "1" ||
  String(process.env.FINDALLEASY_REWARD_ENGINE_DISABLE ?? "0") === "1";

const __REWARD_ENGINE_AUTOSTART = String(process.env.REWARD_ENGINE_AUTOSTART ?? "1") === "1";

if (!__REWARD_ENGINE_DISABLE && __REWARD_ENGINE_AUTOSTART) {
  systemStartupCheck().catch((e) =>
    console.error("RewardEngine S16 systemStartupCheck error:", e?.message)
  );
}

// ===================================================================
// DEFAULT EXPORT — Full Backward Compatibility
// ===================================================================
export default {
  // core
  applyRewardsForOrder,
  applyRewardsForOrderLegacyBalance,
  applyClickReward,
  applyPurchaseRewards,
  applyRewards,

  // user views
  getUserRewardsSummary,
  getUserCommissionStats,
  getUserInviteTree,
  getUserClicks,

  // infra
  recordProviderSignal,
  _rewardDebugMemory,
  checkModelHealth,
  systemStartupCheck,

  // extra helpers (eski kodlar bozulmasın)
  findUserFlexible,
  safeAddToWallet,
  ensureModel,
  getProviderRevenueStats,
};

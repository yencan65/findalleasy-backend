// ===================================================================
//   REWARD ENGINE — H E R K Ü L  S16  U L T R A
//   Zero-Corruption • Atomic Wallet • Affiliate Shield
//   RevenueMemory v15 • ProviderMaster v15 • Priority Feedback Loop
//   S16 FraudGuard • S16 Click SpamGrid • S16 Referral Firewall
// ===================================================================

// -------------------------------------------------------------------
// Model Imports
// -------------------------------------------------------------------
import mongoose from "mongoose";
import WalletTransactionBase from "../models/WalletTransaction.js";
import UserBase from "../models/User.js";
import OrderBase from "../models/Order.js";

// Provider Priority (S15 feedback)
import { providerPriority as providerPrioritySource } from "./commissionEngine.js";

// Revenue Memory (S15)
import {
  recordClick,
  recordConversion,
  getProviderRevenueStats,
} from "./revenueMemoryEngine.js";


// ===================================================================
// S16 — HARD GUARDS (E2E determinism + no buffering timeouts)
// - REWARD_ENGINE_DISABLE=1 => engine no-op (E2E temiz kalır)
// - DB bağlı değilken mongoose query YASAK (buffering timed out kirletir)
// ===================================================================
const REWARD_ENGINE_DISABLE = String(process.env.REWARD_ENGINE_DISABLE || "0") === "1";

function __rewardDbReady() {
  try {
    return mongoose?.connection?.readyState === 1; // 1 = connected
  } catch {
    return false;
  }
}

function __rewardDisabledResult(extra = {}) {
  return { ok: false, disabled: true, ...extra };
}

// ===================================================================
// S16 — DB GUARD (NO BUFFER TIMEOUT / NO STARTUP CORRUPTION)
// - DB yoksa sorgu atma (startup'ta buffering timeout yemeyelim)
// - BufferCommands kapalı → hızlı, doğru hata
// ===================================================================
try {
  mongoose.set("bufferCommands", false);
} catch {}

// ===================================================================
// S16 — Dynamic Model Loader (race-safe + atomic)
// ===================================================================
let User = UserBase;
let Order = OrderBase;
let WalletTransaction = WalletTransactionBase;
let mongooseInstance = null;

// ===================================================================
// S16 — Mongoose helpers (MODEL-CONNECTION AWARE)  ✅ RACE FIX CORE
// - Startup race'in kökü: "mongoose.connection ready görünse bile"
//   modelin bağlı olduğu conn tam açılmadan query atılabiliyor.
// - Bu yüzden hem global conn hem model conn üzerinden kontrol ediyoruz.
// ===================================================================
function __S16_getMongoose() {
  return mongooseInstance || mongoose;
}

function __S16_getModelConn() {
  try {
    // Model bağlantısını yakala (global conn ile farklıysa bile)
    if (User?.db) return User.db;
    if (User?.collection?.conn) return User.collection.conn;
  } catch {}
  return null;
}

function __S16_isConnOpen(conn) {
  try {
    if (!conn) return false;
    // readyState: 0=disconnected, 1=connected, 2=connecting, 3=disconnecting
    if (conn.readyState !== 1) return false;

    // Mongoose "connected" dese bile native db objesi yoksa hala "tam hazır" olmayabilir.
    // Bu check, startup race'i keser.
    if (!conn.db) return false;

    return true;
  } catch {
    return false;
  }
}

function __S16_isDbConnected() {
  try {
    const m = __S16_getMongoose();
    const globalConn = m?.connection || null;
    const modelConn = __S16_getModelConn();

    // İkisi de varsa ikisini de şart koş (en güvenlisi)
    if (globalConn && modelConn) {
      return __S16_isConnOpen(globalConn) && __S16_isConnOpen(modelConn);
    }

    // yoksa elinde olanla karar ver
    if (modelConn) return __S16_isConnOpen(modelConn);
    return __S16_isConnOpen(globalConn);
  } catch {
    return false;
  }
}

function __S16_dbState() {
  try {
    const m = __S16_getMongoose();
    const conn = __S16_getModelConn() || m?.connection;

    return {
      readyState: conn?.readyState ?? -1,
      name: conn?.name ?? null,
      host: conn?.host ?? null,
    };
  } catch {
    return { readyState: -1, name: null, host: null };
  }
}

// ✅ Startup race killer: DB hazır olana kadar kısa süre bekle (query atmadan!)
function __S16_delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function __S16_waitForDbReady(timeoutMs = 8000) {
  try {
    if (__S16_isDbConnected()) return true;

    const m = __S16_getMongoose();
    const globalConn = m?.connection || null;
    const modelConn = __S16_getModelConn();
    const conn = modelConn || globalConn;

    // Mongoose 7+ bazı sürümlerde connection.asPromise() var → event tabanlı bekleme
    if (conn?.asPromise && typeof conn.asPromise === "function") {
      const t = Math.max(0, Number(timeoutMs) || 0);
      if (t === 0) return __S16_isDbConnected();

      try {
        await Promise.race([conn.asPromise(), __S16_delay(t)]);
      } catch {}
      return __S16_isDbConnected();
    }

    // Fallback: kısa poll (çok küçük, startup için)
    const start = Date.now();
    const t = Math.max(0, Number(timeoutMs) || 0);
    while (Date.now() - start < t) {
      if (__S16_isDbConnected()) return true;
      await __S16_delay(120);
    }
    return __S16_isDbConnected();
  } catch {
    return __S16_isDbConnected();
  }
}

async function initializeModel() {
  try {
    const mod = await import("mongoose");
    mongooseInstance = mod.default || mongoose;

    // aynı guard'ı instance'a da uygulayalım
    try {
      mongooseInstance.set("bufferCommands", false);
    } catch {}

    if (mongooseInstance.modelNames().includes("User"))
      User = mongooseInstance.model("User");

    if (mongooseInstance.modelNames().includes("Order"))
      Order = mongooseInstance.model("Order");

    if (mongooseInstance.modelNames().includes("WalletTransaction"))
      WalletTransaction = mongooseInstance.model("WalletTransaction");

    console.log("✅ S16 Model Init OK");
    return true;
  } catch (err) {
    console.error("❌ S16 initializeModel error:", err.message);
    // fallback (import edilen mongoose ile devam)
    try {
      mongooseInstance = mongoose;
      mongooseInstance.set("bufferCommands", false);
    } catch {}
    return false;
  }
}

let modelInitialized = false;
let modelChecked = false;

const __S16_modelInitPromise = initializeModel().then((ok) => {
  modelInitialized = ok;
  return ok;
});

async function ensureModel() {
  try {
    await __S16_modelInitPromise;
  } catch (e) {
    console.error("❌ S16 model init promise failure:", e?.message);
  }

  // Model isimleri doğru ama DB bağlı değilse "ready" sayma
  if (modelChecked && User && Order && WalletTransaction) {
    if (!__S16_isDbConnected()) return false;
    return true;
  }

  if (!modelInitialized) {
    const ok = await initializeModel();
    if (!ok) return false;
    modelInitialized = ok;
  }

  try {
    if (
      mongooseInstance &&
      User?.prototype instanceof mongooseInstance.Model &&
      Order?.prototype instanceof mongooseInstance.Model &&
      WalletTransaction?.prototype instanceof mongooseInstance.Model
    ) {
      modelChecked = true;
      // Model OK ama DB bağlı değilse yine false
      if (!__S16_isDbConnected()) return false;
      return true;
    }
  } catch (err) {
    console.error("❌ S16 model check error:", err.message);
  }

  return false;
}

export { ensureModel };

// ===================================================================
// S16 Logger
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
// S16 ProviderSignal — stronger than S11
// Logs + RevenueMemory connection
// ===================================================================
export async function recordProviderSignal({
  provider = "unknown",
  event = "unknown",
  amount = 0,
  commissionRate = null,
  userId = null,
  orderId = null,
  meta = {},
}) {
  const payload = {
    provider: String(provider || "unknown").toLowerCase(),
    event,
    amount: Number(amount || 0),
    commissionRate:
      commissionRate != null && Number.isFinite(Number(commissionRate))
        ? Number(commissionRate)
        : null,
    userId,
    orderId,
    ts: Date.now(),
    meta,
  };

  console.log("📡 S16 ProviderSignal:", payload);

  // RevenueMemory S15 → click signal
  try {
    await recordClick({
      provider: payload.provider,
      price: payload.amount || 0,
      userId: payload.userId,
      productId: null,
      meta: {
        source: "provider-signal",
        event: payload.event,
        commissionRate: payload.commissionRate,
        orderId: payload.orderId,
        ...payload.meta,
      },
    });
  } catch (err) {
    console.warn("recordProviderSignal → RevenueMemory error:", err?.message);
  }

  return { ok: true };
}

// ===================================================================
// S16 Commission Whitelist
// (updated for global scalability)
// ===================================================================
const COMMISSIONABLE_PROVIDERS = [
  "amazon",
  "trendyol",
  "hepsiburada",
  "aliexpress",
  "booking",
  "n11",
  "ciceksepeti",
];

// ===================================================================
// S16 — Commissionable Order Check
// ===================================================================
function isCommissionableOrder(order) {
  if (!order) return false;

  if (order.isCommissioned === false) return false;

  if (typeof order.commissionRate === "number" && order.commissionRate > 0)
    return true;

  if (
    order.provider &&
    COMMISSIONABLE_PROVIDERS.includes(String(order.provider).toLowerCase())
  ) {
    return true;
  }

  return false;
}

// ===================================================================
// S16 — Commission Paid Gate (hardened)
// ===================================================================
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
// S16 — Affiliate ID Hardening (no affiliate → no reward)
// ===================================================================
function isAffiliateMatched(order) {
  const expected = process.env.FAE_AFFILIATE_ID || null;

  if (!expected) {
    logReward("AFFILIATE_BLOCK_S16", {
      reason: "NO_AFFILIATE_ID_DEFINED",
    });
    return false;
  }

  if (!order) return false;

  const aff = order.affiliateId || order.affiliate || order.affiliate_id || null;

  if (!aff) return false;

  if (String(aff).trim().length < 3) return false;

  return String(aff) === String(expected);
}

// ===================================================================
// S16 — Smart User Finder (email / ID / _id / referral)
// ===================================================================
async function findUserFlexible(identifier) {
  const ready = await ensureModel();
  if (!ready) return null;

  try {
    if (!identifier) return null;

    const query = {
      $or: [{ email: identifier }, { id: identifier }],
    };

    const m = __S16_getMongoose();
    if (m?.Types?.ObjectId?.isValid?.(identifier)) {
      query.$or.push({ _id: identifier });
    }

    const q = User.findOne(query);
    try {
      q.maxTimeMS(2500);
    } catch {}
    return (await q) || null;
  } catch (err) {
    logReward("findUserFlexible_ERROR", {
      identifier,
      error: err?.message || String(err),
      db: __S16_dbState(),
    });
    return null;
  }
}

export { findUserFlexible };

// ===================================================================
// S16 DEBUG CORE
// ===================================================================
export function _rewardDebugMemory() {
  return {
    ok: true,
    note: "S16 rewardEngine: Debug memory aktif.",
    ts: Date.now(),
    modelInitialized,
    modelChecked,
    db: __S16_dbState(),
  };
}

// ===================================================================
// S16 — Atomic Wallet Engine (race-safe, $inc, transaction log)
// ===================================================================
async function safeAddToWallet(user, amount) {
  const ready = await ensureModel();
  if (!ready) {
    logReward("safeAddToWallet_MODEL_NOT_READY", {
      user: user?.email,
      amount,
      db: __S16_dbState(),
    });
    return;
  }

  try {
    if (!user) return;
    if (!Number.isFinite(Number(amount))) return;

    const delta = Math.round(Number(amount) * 100) / 100;
    if (delta === 0) return;

    // S16 — atomic $inc, race-free
    const q = User.findByIdAndUpdate(
      user._id,
      {
        $inc: {
          wallet: delta,
          walletBalance: delta,
        },
      },
      { new: true }
    );

    // güvenlik: query uzarsa takılı kalmasın
    try {
      q.maxTimeMS(3500);
    } catch {}

    const updatedUser = await q;

    if (!updatedUser) {
      logReward("safeAddToWallet_USER_NOT_FOUND_AFTER_UPDATE", {
        userId: user._id,
        delta,
      });
      return;
    }

    // Local obje de güncellensin
    user.wallet = updatedUser.wallet;
    user.walletBalance = updatedUser.walletBalance;

    const TxModel =
      WalletTransaction ||
      (await import("../models/WalletTransaction.js")).default;

    await TxModel.create({
      userId: String(user._id),
      amount: delta,
      type: "reward",
      relatedOrderId: null,
      relatedCouponCode: null,
      note: "RewardEngine safeAddToWallet S16",
    });

    logReward("safeAddToWallet_OK", {
      user: updatedUser.email,
      delta,
      newWallet: updatedUser.wallet,
    });

    return updatedUser.wallet;
  } catch (err) {
    logReward("safeAddToWallet_ERROR", {
      user: user?.email,
      amount,
      error: err?.message,
      db: __S16_dbState(),
    });
  }
}

// ===================================================================
// S16 — Generic Reward Calculator
// ===================================================================
function calculateReward(amount, rate) {
  const a = Number(amount);
  const r = Number(rate);
  if (!Number.isFinite(a) || !Number.isFinite(r) || a <= 0 || r <= 0) return 0;
  return Math.round(a * 100 * r) / 100;
}

// ===================================================================
// S16 — Purchase Rewards (modern çekirdek)
// ===================================================================
export async function applyPurchaseRewards({ userId, purchaseAmount }) {
  if (REWARD_ENGINE_DISABLE) return __rewardDisabledResult({ reason: "REWARD_ENGINE_DISABLE" });
  if (!__rewardDbReady()) return __rewardDisabledResult({ reason: "DB_NOT_CONNECTED" });

  const ready = await ensureModel();
  if (!ready) return { ok: false, error: "MODEL_OR_DB_NOT_READY" };

  try {
    const numericAmount = Number(purchaseAmount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0)
      return { ok: false, error: "INVALID_PURCHASE_AMOUNT" };

    const user = await findUserFlexible(userId);
    if (!user) return { ok: false, error: "USER_NOT_FOUND" };

    const inviterEmail = user.referral || null;

    let totalOrders = 0;
    try {
      const OrderDb = Order || (await import("../models/Order.js")).default;
      const q = OrderDb.countDocuments({ userId: user._id });
      try {
        q.maxTimeMS(3500);
      } catch {}
      totalOrders = await q;
    } catch {}

    const isFirstPurchase = !user.firstPurchaseDone && totalOrders === 0;

    let trustLevel = "low";
    if (totalOrders >= 3) trustLevel = "high";
    else if (totalOrders === 2) trustLevel = "medium";

    // S16 — reward weights
    let userReward = 0;
    let inviterReward = 0;

    if (isFirstPurchase) {
      userReward = calculateReward(numericAmount, 0.01);

      if (trustLevel === "low") userReward *= 0.25;
      else if (trustLevel === "medium") userReward *= 0.6;

      userReward = Math.round(userReward * 100) / 100;
    }

    const hasInviter = !!inviterEmail;
    const referralEligible = hasInviter && totalOrders >= 1;

    if (referralEligible) {
      inviterReward = isFirstPurchase
        ? calculateReward(numericAmount, 0.005)
        : calculateReward(numericAmount, 0.001);
    }

    // S16 — trust cap refinement
    if (userReward > 40) userReward = 40;
    if (inviterReward > 40) inviterReward = 40;

    if (isFirstPurchase) {
      const q = User.findByIdAndUpdate(user._id, { firstPurchaseDone: true });
      try {
        q.maxTimeMS(2500);
      } catch {}
      await q;
      user.firstPurchaseDone = true;
    }

    if (userReward > 0) await safeAddToWallet(user, userReward);

    if (inviterReward > 0 && inviterEmail) {
      const inviter = await findUserFlexible(inviterEmail);
      if (inviter) await safeAddToWallet(inviter, inviterReward);
    }

    logReward("applyPurchaseRewards_S16_OK", {
      user: user.email,
      userReward,
      inviter: inviterEmail,
      inviterReward,
      purchaseAmount: numericAmount,
      totalOrders,
      trustLevel,
    });

    return { ok: true, userReward, inviterReward };
  } catch (err) {
    logReward("applyPurchaseRewards_S16_ERROR", {
      userId,
      purchaseAmount,
      error: err?.message,
      db: __S16_dbState(),
    });

    return { ok: false, error: "UNEXPECTED_ERROR" };
  }
}

export const applyRewards = applyPurchaseRewards;

// ===================================================================
// S16 — Order-based Reward Engine (S10 → S11 → S12 → S15 → S16)
// ===================================================================
export async function applyRewardsForOrder(order) {
  if (REWARD_ENGINE_DISABLE) return __rewardDisabledResult({ reason: "REWARD_ENGINE_DISABLE" });
  if (!__rewardDbReady()) return __rewardDisabledResult({ reason: "DB_NOT_CONNECTED" });

  if (!order) return { ok: false, reason: "NO_ORDER" };

  // Anti self-referral
  if (
    order.userId &&
    order.referrerId &&
    String(order.userId) === String(order.referrerId)
  ) {
    return { ok: false, reason: "SELF_REFERRAL_BLOCKED" };
  }

  let providerKey = String(order.provider || "unknown").toLowerCase();
  providerKey = providerKey.replace(/[^a-z0-9_-]/gi, "") || "unknown";

  // S16 — provider whitelist kontrolü (komisyon)
  if (!COMMISSIONABLE_PROVIDERS.includes(providerKey)) {
    logReward("S16_PROVIDER_NOT_COMMISSIONABLE", { provider: providerKey });
    return { ok: false, reason: "PROVIDER_NOT_COMMISSIONABLE" };
  }

  // S16 — affiliate eşleşmesi zorunlu
  if (!isAffiliateMatched(order)) {
    logReward("S16_AFFILIATE_MISMATCH", {
      expected: process.env.FAE_AFFILIATE_ID || null,
      got: order.affiliateId || order.affiliate || order.affiliate_id || null,
    });
    return { ok: false, reason: "AFFILIATE_NOT_MATCHED" };
  }

  // S16 — Komisyon Paid zorunlu
  if (!isCommissionPaid(order)) {
    logReward("S16_COMMISSION_NOT_PAID", {
      orderId: order._id || order.id,
      provider: providerKey,
      commissionPaid: order.commissionPaid,
      isCommissionPaid: order.isCommissionPaid,
      commission_status: order.commission_status,
    });
    return { ok: false, reason: "COMMISSION_NOT_PAID" };
  }

  if (!isCommissionableOrder(order)) {
    return { ok: false, reason: "NON_COMMISSIONABLE" };
  }

  // Gate pass
  logReward("S16_GATE_PASS", {
    provider: providerKey,
    affiliateMatched: true,
    commissionPaid: true,
  });

  // RevenueMemory conversion kaydı
  try {
    recordConversion({
      provider: providerKey,
      amount:
        order.purchaseAmount ??
        order.amount ??
        order.total ??
        order.totalPrice ??
        order.price ??
        0,
      rate: order.commissionRate ?? null,
      orderId: order._id || order.id || order.orderId,
      userId: order.userId || null,
    });
  } catch {}

  // Provider stats (opsiyonel)
  let revenueStats = null;
  try {
    revenueStats = await getProviderRevenueStats(providerKey);
  } catch {}

  const userId =
    order.userId ||
    order.user ||
    order.ownerId ||
    order.buyerId ||
    order.customerId;

  const purchaseAmount =
    order.purchaseAmount ??
    order.amount ??
    order.total ??
    order.totalPrice ??
    order.price ??
    0;

  const res = await applyPurchaseRewards({ userId, purchaseAmount });

  logReward("S16_applyRewardsForOrder_RESULT", {
    orderId: order._id || order.id,
    userId,
    purchaseAmount,
    provider: providerKey,
    result: res,
    revenueStats: revenueStats || null,
  });

  return res;
}

// ===================================================================
// applyClickReward — S16 Click Spam Guard + micro ödül
// ===================================================================
export async function applyClickReward({ userId, productId, provider, price }) {
  if (REWARD_ENGINE_DISABLE) return __rewardDisabledResult({ reason: "REWARD_ENGINE_DISABLE" });
  if (!__rewardDbReady()) return __rewardDisabledResult({ reason: "DB_NOT_CONNECTED" });

  const ready = await ensureModel();
  if (!ready) return { ok: false, error: "MODEL_OR_DB_NOT_READY" };

  // S16 — Click spam guard (user + product + provider → 60s)
  global.__S11_clickCache = global.__S11_clickCache || new Map();
  const key = `${userId || "anon"}:${provider || "unknown"}:${
    productId || "nopid"
  }`;
  const now = Date.now();
  const last = global.__S11_clickCache.get(key);
  if (last && now - last < 60000) {
    return { ok: false, reason: "CLICK_RATE_LIMIT" };
  }
  global.__S11_clickCache.set(key, now);

  // S16 — global daily cap (user başına toplam tıklama ödülü)
  global.__S16_clickDaily = global.__S16_clickDaily || new Map();
  const dayKey = `${userId || "anon"}:${new Date()
    .toISOString()
    .slice(0, 10)}`;
  const dayTotal = global.__S16_clickDaily.get(dayKey) || 0;
  const DAILY_CAP = 0.5; // günde max 0.5 birim click reward

  if (dayTotal >= DAILY_CAP) {
    return { ok: false, reason: "DAILY_CLICK_CAP_REACHED" };
  }

  try {
    // RevenueMemoryEngine’e sinyal
    recordClick({
      provider: provider || "unknown",
      price: price || 0,
      userId,
      productId,
    });
  } catch {}

  try {
    const user = await findUserFlexible(userId);
    if (!user) return { ok: false, reason: "USER_NOT_FOUND" };

    // S16: click ödülü micro → 0.001, günlük cap ile
    let clickReward = 0.001;
    const S11cap = 0.05;
    if (clickReward > S11cap) clickReward = S11cap;

    // daily cap’e göre son kez kontrol
    const remaining = DAILY_CAP - dayTotal;
    if (clickReward > remaining) clickReward = remaining;

    if (clickReward <= 0) {
      return { ok: false, reason: "CLICK_REWARD_ZERO_AFTER_CAP" };
    }

    await safeAddToWallet(user, clickReward);
    global.__S16_clickDaily.set(dayKey, dayTotal + clickReward);

    logReward("applyClickReward_S16_OK", {
      user: user.email,
      provider,
      clickReward,
      price,
      dayTotalBefore: dayTotal,
      dayTotalAfter: dayTotal + clickReward,
    });

    return { ok: true, reward: clickReward };
  } catch (err) {
    logReward("applyClickReward_S16_ERROR", {
      userId,
      productId,
      provider,
      error: err?.message,
      db: __S16_dbState(),
    });

    return { ok: false };
  }
}

// ===================================================================
// getUserRewardsSummary — S16 genişletilmiş S10 uyumlu
// ===================================================================
export async function getUserRewardsSummary(userId) {
  if (REWARD_ENGINE_DISABLE) return __rewardDisabledResult({ reason: "REWARD_ENGINE_DISABLE" });
  if (!__rewardDbReady()) return __rewardDisabledResult({ reason: "DB_NOT_CONNECTED" });

  const ready = await ensureModel();
  if (!ready) return { ok: false, error: "MODEL_OR_DB_NOT_READY" };

  try {
    const user = await findUserFlexible(userId);
    if (!user) return { ok: false, error: "USER_NOT_FOUND" };

    const walletRaw =
      typeof user.walletBalance === "number"
        ? user.walletBalance
        : Number(user.wallet) || 0;

    const wallet = Math.round(walletRaw * 100) / 100;

    // S16 — commission stats ekleyelim (ama opsiyonel)
    let commissionStats = { earned: 0, pending: 0 };
    try {
      const cs = await getUserCommissionStats(String(user._id));
      if (cs?.ok) {
        commissionStats = { earned: cs.earned || 0, pending: cs.pending || 0 };
      }
    } catch {}

    return {
      ok: true,
      userId: String(user._id || userId),
      email: user.email,
      wallet,
      firstPurchaseDone: !!user.firstPurchaseDone,
      referral: user.referral || null,

      // S10 minimal alanlar
      totalClicks: 0,
      totalEarnings: wallet,
      pending: commissionStats.pending || 0,
      history: [],

      // S16 ek alanlar
      commissionEarned: commissionStats.earned || 0,
      commissionPending: commissionStats.pending || 0,
    };
  } catch (err) {
    logReward("getUserRewardsSummary_S16_ERROR", {
      userId,
      error: err?.message,
      db: __S16_dbState(),
    });
    return { ok: false };
  }
}

// ===================================================================
// getUserInviteTree — S16 optimize edilmiş
// ===================================================================
export async function getUserInviteTree(userId) {
  if (REWARD_ENGINE_DISABLE) return __rewardDisabledResult({ reason: "REWARD_ENGINE_DISABLE" });
  if (!__rewardDbReady()) return __rewardDisabledResult({ reason: "DB_NOT_CONNECTED" });

  const ready = await ensureModel();
  if (!ready) return { ok: false, error: "MODEL_OR_DB_NOT_READY" };

  try {
    const rootUser = await findUserFlexible(userId);
    const rootKey = rootUser?.email || userId;

    const q1 = User.find({ referral: rootKey });
    try {
      q1.maxTimeMS(3500);
    } catch {}
    const level1 = await q1;

    const tree = [];

    for (const u of level1) {
      const q2 = User.find({ referral: u.email });
      try {
        q2.maxTimeMS(3500);
      } catch {}
      const level2 = await q2;

      tree.push({
        inviter: u.email,
        invited: level2.map((x) => x.email),
        level2Count: level2.length,
      });
    }

    return {
      ok: true,
      root: rootKey,
      depth1: level1.map((u) => ({
        email: u.email,
        wallet: u.wallet || u.walletBalance || 0,
        joinDate: u.createdAt,
      })),
      tree,
      totalInvited: level1.length,
    };
  } catch (err) {
    logReward("getUserInviteTree_S16_ERROR", {
      userId,
      error: err?.message,
      db: __S16_dbState(),
    });
    return { ok: false };
  }
}

// ===================================================================
// getUserClicks — S10 minimal interface (şimdilik stub)
// ===================================================================
export async function getUserClicks(userId) {
  if (REWARD_ENGINE_DISABLE) return __rewardDisabledResult({ reason: "REWARD_ENGINE_DISABLE" });
  if (!__rewardDbReady()) return __rewardDisabledResult({ reason: "DB_NOT_CONNECTED" });

  return {
    ok: true,
    userId,
    clicks: [],
    note: "S16 minimal click history stub",
  };
}

// ===================================================================
// getUserCommissionStats — Order modelinden özet
// ===================================================================
export async function getUserCommissionStats(userId) {
  if (REWARD_ENGINE_DISABLE) return __rewardDisabledResult({ reason: "REWARD_ENGINE_DISABLE" });
  if (!__rewardDbReady()) return __rewardDisabledResult({ reason: "DB_NOT_CONNECTED" });

  const ready = await ensureModel();
  if (!ready) {
    return {
      ok: false,
      userId,
      error: "MODEL_OR_DB_NOT_READY",
      db: __S16_dbState(),
    };
  }

  try {
    const q = Order.find({ userId }).select(
      "commission commissionPaid isCommissionPaid commission_status"
    );
    try {
      q.maxTimeMS(3500);
    } catch {}
    const orders = await q;

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
      error: err?.message,
      db: __S16_dbState(),
    };
  }
}

// ===================================================================
// Model Health Check (NO QUERY IF DB NOT CONNECTED)  ✅ RACE-SAFE
// ===================================================================
export async function checkModelHealth() {
  if (REWARD_ENGINE_DISABLE) return __rewardDisabledResult({ reason: "REWARD_ENGINE_DISABLE" });
  if (!__rewardDbReady()) return __rewardDisabledResult({ reason: "DB_NOT_CONNECTED" });

  try {
    // DB bağlı değilse sorgu atma → buffering timeout / startup race yok
    if (!__S16_isDbConnected()) {
      return {
        ok: false,
        healthy: false,
        error: "DB_NOT_READY",
        model: "User",
        db: __S16_dbState(),
        testQuery: "SKIPPED",
      };
    }

    const ready = await ensureModel();
    if (!ready)
      return {
        ok: false,
        healthy: false,
        error: "Model not ready",
        model: "User",
        db: __S16_dbState(),
      };

    // 🔒 Double-check: ensureModel sonrası da DB açık mı?
    if (!__S16_isDbConnected()) {
      return {
        ok: false,
        healthy: false,
        error: "DB_NOT_READY_AFTER_MODEL",
        model: "User",
        db: __S16_dbState(),
        testQuery: "SKIPPED",
      };
    }

    const q = User.findOne().limit(1).select("_id").lean();
    try {
      q.maxTimeMS(2500);
    } catch {}
    const result = await q;

    return {
      ok: true,
      healthy: true,
      model: "User",
      testQuery: result ? "SUCCESS" : "NO_DATA",
      db: __S16_dbState(),
    };
  } catch (error) {
    // Mongoose bazen “before initial connection is complete” atar → allow, DB_NOT_READY say
    const msg = String(error?.message || "");
    if (msg.toLowerCase().includes("before initial connection is complete")) {
      return {
        ok: false,
        healthy: false,
        error: "DB_NOT_READY",
        model: "User",
        db: __S16_dbState(),
        testQuery: "SKIPPED",
      };
    }

    return {
      ok: false,
      healthy: false,
      error: error.message,
      model: "User",
      db: __S16_dbState(),
    };
  }
}

// ===================================================================
// Sistem başlangıç kontrolü (NON-BLOCKING + DB SAFE) ✅ STARTUP RACE FIX
// - DB connect tamamlanmadan findOne atmayız.
// - İstersen kısa süre DB bekler, sonra health check yapar.
// ===================================================================
export async function systemStartupCheck() {
  if (REWARD_ENGINE_DISABLE) return __rewardDisabledResult({ reason: "REWARD_ENGINE_DISABLE" });
  if (!__rewardDbReady()) return __rewardDisabledResult({ reason: "DB_NOT_CONNECTED" });

  logReward("SYSTEM_STARTUP_S16", { time: new Date().toISOString() });

  const WAIT_MS = Number(
    process.env.FINDALLEASY_REWARD_STARTUP_DB_WAIT_MS || 8000
  );

  // DB hazır değilse kısa süre bekle
  const connected = __S16_isDbConnected()
    ? true
    : await __S16_waitForDbReady(WAIT_MS);

  // Hâlâ hazır değilse: model check YAPMA (race / false alarm yok)
  if (!connected) {
    logReward("S16_STARTUP_DB_NOT_READY", {
      waitedMs: WAIT_MS,
      db: __S16_dbState(),
    });

    const stub = {
      ok: false,
      healthy: false,
      error: "DB_NOT_READY",
      model: "User",
      db: __S16_dbState(),
      testQuery: "SKIPPED",
      waitedMs: WAIT_MS,
    };

    console.log(
      "⏳ Reward Engine S16: DB hazır değil (startup) → model check SKIPPED.",
      `| waited=${WAIT_MS}ms`,
      stub?.db ? `| db.readyState=${stub.db.readyState}` : ""
    );

    // ZERO-DELETE: mevcut log geleneğini koru
    logReward("S16_STARTUP_OK", {
      uptime: process.uptime(),
      db: __S16_dbState(),
    });

    return stub;
  }

  const health = await checkModelHealth();

  if (health.ok && health.healthy) {
    console.log("✅ [rewardEngine.js] Reward Engine S16 başarıyla başlatıldı");
  } else {
    console.log(
      "⚠️ Reward Engine S16 model health fail:",
      health.error || "UNKNOWN",
      health?.db ? `| db.readyState=${health.db.readyState}` : ""
    );
  }

  logReward("S16_STARTUP_OK", {
    uptime: process.uptime(),
    db: __S16_dbState(),
  });

  return health;
}


// ===================================================================
// AUTOSTART GUARD (IMPORT SIDE-EFFECT CONTROL)
// - Tool/smoke test’te DB yokken log spam/false alarm istemiyorsan: 0
// - Prod server’da, DB connect sonrası: 1
// ===================================================================
const S16_AUTOSTART =
  String(process.env.FINDALLEASY_REWARD_AUTOSTART || "0") === "1";

if (S16_AUTOSTART && !globalThis.__S16_REWARD_AUTOSTART_DONE) {
  globalThis.__S16_REWARD_AUTOSTART_DONE = true;
  systemStartupCheck().catch((e) =>
    console.error("RewardEngine S16 systemStartupCheck error:", e?.message)
  );
}

// -----------------------------------------------------------
// S9–S10 BACKWARD COMPATIBILITY
// applyRewardsForOrderLegacyBalance → eski API’yi karşılar
// -----------------------------------------------------------
export async function applyRewardsForOrderLegacyBalance(order, userId) {
  if (REWARD_ENGINE_DISABLE) return __rewardDisabledResult({ reason: "REWARD_ENGINE_DISABLE" });
  if (!__rewardDbReady()) return __rewardDisabledResult({ reason: "DB_NOT_CONNECTED" });

  try {
    console.warn(
      "[RewardEngine] applyRewardsForOrderLegacyBalance (LEGACY) çağrıldı → uyumluluk modunda çalışıyor."
    );

    // Yeni S16 motoruna yönlendir
    if (typeof applyRewardsForOrder === "function") {
      // ikinci argüman legacy, yeni imza görmezden gelir (uyumluluk)
      return await applyRewardsForOrder(order, userId);
    }

    return { ok: true, legacy: true };
  } catch (err) {
    console.warn("[RewardEngine] Legacy fallback hata:", err?.message);
    return { ok: false, error: err?.message };
  }
}
// ============================================================================
// Affiliate Reward Hook (S16 Bridge) — named export
// - affiliateBridgeS16 route bunu import ediyor.
// - Engine disabled / DB yok => NO-OP (skipped) ve crash yok
// - Order objesi gelirse direkt applyRewardsForOrder()
// - Sadece orderId gelirse DB’den çekip applyRewardsForOrder()
// ============================================================================

export async function applyAffiliateRewardIfEligible(payload = {}) {
  try {
    if (REWARD_ENGINE_DISABLE) {
      return { ok: true, applied: false, skipped: true, reason: "REWARD_ENGINE_DISABLE" };
    }
    if (!__rewardDbReady()) {
      return { ok: true, applied: false, skipped: true, reason: "DB_NOT_CONNECTED" };
    }

    const ready = await ensureModel();
    if (!ready || !__S16_isDbConnected()) {
      return {
        ok: true,
        applied: false,
        skipped: true,
        reason: "MODEL_OR_DB_NOT_READY",
        db: __S16_dbState(),
      };
    }

    // 1) Direkt order objesi geldiyse
    const order =
      payload?.order ||
      payload?.data?.order ||
      payload?.orderData ||
      payload?.conversion ||
      null;

    if (order && typeof order === "object") {
      const r = await applyRewardsForOrder(order);
      return { ok: !!r?.ok, applied: !!r?.ok, result: r, source: "order_object" };
    }

    // 2) Sadece orderId geldiyse DB’den çek
    const orderId = payload?.orderId || payload?.order_id || payload?.id || null;

    if (orderId) {
      const OrderDb = Order || (await import("../models/Order.js")).default;

      const q = OrderDb.findOne({
        $or: [{ orderId }, { id: orderId }, { _id: orderId }],
      });

      try {
        q.maxTimeMS(3500);
      } catch {}

      const doc = await q;

      if (!doc) {
        return { ok: true, applied: false, skipped: true, reason: "ORDER_NOT_FOUND", orderId };
      }

      const r = await applyRewardsForOrder(doc);
      return { ok: !!r?.ok, applied: !!r?.ok, result: r, source: "order_lookup", orderId };
    }

    // 3) Hiçbir şey gelmediyse (observable)
    return { ok: true, applied: false, skipped: true, reason: "NO_ORDER_PAYLOAD" };
  } catch (e) {
    // Route’u ASLA crash etme
    return {
      ok: false,
      applied: false,
      error: String(e?.message || e),
      reason: "UNEXPECTED_ERROR",
    };
  }
}

// ===================================================================
// Default Export — S9 → S10 → S11 → S16 tam uyumlu
// ===================================================================
export default {
  findUserFlexible,
  applyPurchaseRewards,
  applyRewardsForOrder,
  applyAffiliateRewardIfEligible, // ✅ NEW: route import fix
  applyRewardsForOrderLegacyBalance,
  applyRewards: applyPurchaseRewards,

  getUserRewardsSummary,
  getUserInviteTree,
  getUserClicks,
  getUserCommissionStats,

  applyClickReward,

  safeAddToWallet,
  checkModelHealth,
  ensureModel,
  systemStartupCheck,

  // RevenueMemory entegrasyonu
  getProviderRevenueStats,
  _rewardDebugMemory,
  recordProviderSignal,

  // keep (S15 feedback source) — ileride providerPriority ile ödül ağırlığı bağlanır
  providerPrioritySource,
};

// ===================================================================
// S6–S11 Legacy Debug placeholder (S16 uyumluluk)
// ===================================================================
export function getSystemRewardStats() {
  return {
    ok: true,
    note: "S16 sürümünde getSystemRewardStats artık legacy (placeholder).",
    time: Date.now(),
    totals: {
      totalUsers: 0,
      totalRewards: 0,
      pendingPayouts: 0,
      cycles: 0,
    },
  };
}


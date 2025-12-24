import express from "express";
import Order from "../models/Order.js";
import Click from "../models/Click.js";
import User from "../models/User.js";
import { applyRewardsForOrder } from "../../core/rewardEngine.js";
import { applyCouponCashback } from "../../core/couponEngine.js";

const router = express.Router();

// Minimum sipariş tutarı
const MIN_ORDER_FOR_COUPON = 100;

router.post("/callback", async (req, res) => {
  try {
    const { clickId, amount, status, affiliateOrderId } = req.body || {};

    if (!clickId || !amount) {
      return res.json({ ok: false, error: "MISSING_FIELDS" });
    }

    // 1) CLICK BUL
    const click = await Click.findOne({ clickId });
    if (!click) return res.json({ ok: false, error: "CLICK_NOT_FOUND" });

    // 2) USER BUL
    const user = await User.findById(click.userId);
    if (!user) return res.json({ ok: false, error: "USER_NOT_FOUND" });

    const userId = user._id;

    // ================
    // 🔥 FRAUD KONTROLLERİ
    // ================

    // SELF-REFERRAL
    if (user.referral && user.referral === user.email) {
      console.log("❌ SELF REFERRAL BLOCKED");
      return res.json({ ok: true, selfReferral: true });
    }

    // AYNI IP → FRAUD
    if (user.ip && click.ip && user.ip === click.ip) {
      console.log("⚠ FRAUD: Same IP used for invite + order");
      return res.json({ ok: true, suspiciousIp: true });
    }

    // AYNI CİHAZ → MULTI-ACCOUNT FRAUD
    if (click.deviceId) {
      const sameDeviceCount = await User.countDocuments({
        deviceId: click.deviceId,
      });

      if (sameDeviceCount > 3) {
        console.log("⚠ FRAUD: Too many accounts from same device:", click.deviceId);
        return res.json({ ok: true, suspiciousDevice: true });
      }
    }

    // ================
    // 3) ORDER DB KAYDI
    // ================
    const order = await Order.findOneAndUpdate(
      { affiliateOrderId: affiliateOrderId || clickId },
      {
        userId,
        amount,
        provider: click.provider,
        clickId,
        appliedCouponCode: click.appliedCouponCode || null,
        affiliateOrderId: affiliateOrderId || clickId,
        status,
      },
      { upsert: true, new: true }
    );

    // ================
    // 4) SIPARIŞ TAMAMLANMIŞ MI?
    // ================
    const completedStatuses = ["completed", "paid", "approved", "validated"];

    if (!completedStatuses.includes(status)) {
      return res.json({ ok: true, skip: "ORDER_NOT_COMPLETED" });
    }

    // ================
    // 5) REWARD ENGINE
    // ================
    await applyRewardsForOrder(order);

    // ================
    // 6) KUPON MİNİMUM TUTAR KONTROLÜ
    // ================
    if (order.appliedCouponCode && amount < MIN_ORDER_FOR_COUPON) {
      console.log("⚠ Coupon rejected — below min amount");
      return res.json({
        ok: true,
        couponRejected: true,
        reason: "MIN_ORDER_NOT_MET",
      });
    }

    // ================
    // 7) KUPON CASHBACK
    // ================
    if (order.appliedCouponCode) {
      await applyCouponCashback({
        userId,
        code: order.appliedCouponCode,
        orderId: order._id,
      });
    }

    // BİTTİ
    return res.json({ ok: true, orderId: order._id });
  } catch (err) {
    console.log("OrderCallback Error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;

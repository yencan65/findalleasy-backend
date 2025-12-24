// server/models/WalletTransaction.js
import mongoose from "mongoose";

const WalletTransactionSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true },
    amount: { type: Number, required: true },

    // reward | referral | coupon_cashback | correction | redeem | other
    type: { type: String, required: true },

    relatedOrderId: { type: String, default: null },
    relatedCouponCode: { type: String, default: null },

    note: { type: String, default: null },

    // 🆕 Cüzdan bakiyesi, işlemden sonra kalan net değer
    balanceAfter: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export default mongoose.models.WalletTransaction ||
  mongoose.model("WalletTransaction", WalletTransactionSchema);

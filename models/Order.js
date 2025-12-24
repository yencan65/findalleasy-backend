// server/models/Order.js
import mongoose from "mongoose";

const OrderSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true },
    provider: { type: String, default: "unknown" },
    amount: { type: Number, default: 0 },
    currency: { type: String, default: "TRY" },

    providerOrderId: { type: String, unique: true }, // iyzico / stripe order id
    status: { type: String, default: "pending" },    // pending | paid | failed

    referredBy: { type: String, default: null },     // referralCode

    paidAt: Date,
  },
  { timestamps: true }
);

export default mongoose.models.Order ||
  mongoose.model("Order", OrderSchema);

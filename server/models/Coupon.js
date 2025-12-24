import mongoose from "mongoose";

// Kupon şeması – sadece FindAllEasy içi cashback / ödül kuponu
const couponSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    amount: {
      // TL cinsinden, ör: 100 → 100 TL
      type: Number,
      required: true,
      min: 0,
    },
    status: {
      type: String,
      enum: ["active", "used", "expired"],
      default: "active",
      index: true,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
    expiresAt: {
      type: Date,
    },
    appliedOrderId: {
      type: String,
      default: null,
    },
  },
  { timestamps: false }
);

couponSchema.pre("validate", function (next) {
  if (!this.expiresAt) {
    const d = new Date();
    d.setDate(d.getDate() + 30);
    this.expiresAt = d;
  }
  next();
});

export default mongoose.model("Coupon", couponSchema);

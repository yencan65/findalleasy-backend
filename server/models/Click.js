// server/models/Click.js
import mongoose from "mongoose";

const ClickSchema = new mongoose.Schema(
  {
    userId: { type: String, required: false }, // giriş yapmış kullanıcı
    referralCode: { type: String, default: null }, // referral cookie

    provider: { type: String, required: true }, // amazon, trendyol, hb
    productId: { type: String, default: null },
    productName: { type: String, default: "" },
    price: { type: Number, default: 0 },
deviceId: { type: String, default: null },
    // Affiliate network'in bize göndereceği bağlantı ID
    clickId: { type: String, unique: true },

    ip: { type: String, default: "" },
    ua: { type: String, default: "" },

    // Sipariş geldiğinde eşleştirmek için
    orderCreated: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export default mongoose.models.Click ||
  mongoose.model("Click", ClickSchema);

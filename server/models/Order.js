// server/models/Order.js
import mongoose from "mongoose";

const OrderSchema = new mongoose.Schema(
  {
    // Hangi kullanıcı
    userId: { type: String, required: true },

    // Hangi platform: trendyol, hepsiburada, booking, expedia...
    provider: { type: String, default: "unknown", index: true },

    // Toplam sipariş tutarı
    amount: { type: Number, default: 0 },

    // TRY / USD / EUR...
    currency: { type: String, default: "TRY" },

    // Affiliate / ödeme sağlayıcı tarafındaki sipariş id
    providerOrderId: { type: String, unique: true, sparse: true },

    // Bizim sistemdeki click kaydı (Click.clickId)
    clickId: { type: String },

    // Kullanıcı bu siparişte bir kupon kullandıysa
    appliedCouponCode: { type: String, default: null },

    // Network bazlı id (CJ, Awin, vs için istersen kullanırsın)
    affiliateOrderId: { type: String },

    // pending | completed | failed | cancelled
    status: { type: String, default: "pending", index: true },

    // Referral mantığı için (user.referredBy / referralCode vs.)
    referredBy: { type: String, default: null },

    // Ödeme onay zamanı
    paidAt: { type: Date },

    // Extra alanlar: provider bize ne gönderirse buraya atabiliriz
    meta: { type: Object, default: {} },
  },
  { timestamps: true }
);

export default mongoose.models.Order ||
  mongoose.model("Order", OrderSchema);

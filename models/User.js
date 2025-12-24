// BACKEND/models/User.js
import mongoose from "mongoose";

// Eski + yeni sistem için kullanılabilir ödül kaydı şeması
const rewardSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["signup", "referral_first", "referral_repeat", "purchase"],
      required: true,
    }, // ne tür ödül
    value: { type: Number, required: true }, // parasal değer (ör: 12.5 TL)
    desc: { type: String },
    date: { type: Date, default: Date.now },
    orderId: { type: String },
    fromUser: { type: String }, // hangi arkadaşın alışverişinden geldi
  },
  { _id: false }
);

const userSchema = new mongoose.Schema(
  {
    // Eski kodlarla uyum için ayrıca "id" alanı da tutuyoruz
    id: {
      type: String,
      unique: true,
      default: () => new mongoose.Types.ObjectId().toString(),
    },

    // Temel bilgiler
    username: { type: String, required: true },
    email: { type: String, unique: true, required: true },

    // Şifre tarafı
    password: { type: String }, // eski kod buradan okuyorsa bozulmasın
    passwordHash: { type: String },

    emailVerified: { type: Boolean, default: false },

    // Şifre sıfırlama alanları (forgot/reset için)
    resetCode: { type: String },
    resetCodeExpires: { type: Date },

    // Referans sistemi
    inviteCode: {
      type: String,
      unique: true,
      sparse: true,
    },
    referredBy: {
      type: String, // davet edenin inviteCode'u veya userId'si
      default: null,
    },
    referredUsers: [{ type: String }],

    // Cüzdan ve ödül kaydı
    walletBalance: { type: Number, default: 0 },

    // 👉 GERİYE DÖNÜK UYUMLU: rewards her şey olabilir (eski kayıtlarda 0 var)
    // Yeni kodda daima Array'e çevirip kullanacağız.
    rewards: {
      type: mongoose.Schema.Types.Mixed,
      default: () => [],
    },

    // İleride işimize yarayabilecek ek alanlar
    registeredIP: { type: String },
    deviceFingerprint: { type: String },

    totalSpent: { type: Number, default: 0 },

    seasonalBadges: [{ type: String }],
    seasonPoints: { type: Number, default: 0 },
    seasonStart: { type: Date },
    seasonEnd: { type: Date },
  },
  {
    timestamps: true,
  }
);

/**
 * 🔧 GERİYE DÖNÜK PATCH #1
 * Eski kayıtlarda username yoksa email'den türet.
 */
userSchema.pre("validate", function (next) {
  if (!this.username) {
    if (this.email) {
      this.username = String(this.email).split("@")[0];
    } else {
      this.username = "Kullanıcı";
    }
  }
  next();
});

/**
 * 🔧 GERİYE DÖNÜK PATCH #2
 * Eski kayıtlarda rewards = 0 gibi number tutuyordun.
 * Bunu otomatik olarak cüzdana ekleyip rewards'ı diziye çevir.
 */
userSchema.pre("save", function (next) {
  const r = this.rewards;

  if (typeof r === "number") {
    // sayıyı cüzdana ekle
    this.walletBalance = (this.walletBalance || 0) + r;
    this.rewards = [];
  } else if (!Array.isArray(r)) {
    // null, undefined, object vs. ise güvenli halde dizi yap
    this.rewards = [];
  }

  next();
});

// Güvenli dışa aktarım helper
userSchema.methods.toSafeJSON = function () {
  return {
    id: this.id || this._id.toString(),
    email: this.email,
    username: this.username,
    inviteCode: this.inviteCode || null,
    referredBy: this.referredBy || null,
    walletBalance: this.walletBalance ?? 0,
    totalSpent: this.totalSpent ?? 0,
    seasonalBadges: this.seasonalBadges || [],
    seasonPoints: this.seasonPoints ?? 0,
  };
};

const User = mongoose.model("User", userSchema);
export default User;

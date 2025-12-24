import mongoose from "mongoose";

// ===============================
// REWARD SCHEMA (Mixed uyumlu)
// ===============================
const rewardSchema = new mongoose.Schema(
  {
    type: { type: String },      // "signup", "referral", "purchase"
    value: { type: Number },     // TL
    desc: { type: String },
    date: { type: Date, default: Date.now },
    orderId: { type: String },
    fromUser: { type: String },
  },
  { _id: false }
);

// ===============================
// USER SCHEMA (Herkül Modu)
// ===============================
const userSchema = new mongoose.Schema(
  {
    // Eski kod uyumu için
    id: {
      type: String,
      unique: true,
      default: () => new mongoose.Types.ObjectId().toString(),
    },
  deviceId: { type: String, default: null }, 
    // Temel bilgi
    username: { type: String, required: true },
    email: { type: String, unique: true, required: true },

    // Şifre alanları
    password: { type: String },
    passwordHash: { type: String },

    // Aktivasyon
    emailVerified: { type: Boolean, default: false },
    activated: { type: Boolean, default: false },
    activationCode: { type: String },

    // Şifre sıfırlama
    resetCode: { type: String },
    resetCodeExpires: { type: Date },

    // ======================================
    // DAVET KODU — Duplicate hatası yok artık
    // ======================================
    inviteCode: {
      type: String,
      unique: true,
      sparse: true, 
      default: () =>
        "fae-" +
        Math.random().toString(36).substring(2, 6) +
        "-" +
        Math.random().toString(36).substring(2, 6),
    },

    referredBy: { type: String, default: null },
    referredUsers: [{ type: String }],

 
     // Cüzdan
  walletBalance: { type: Number, default: 0 },
  wallet: { type: Number, default: 0 },

  // Rewards: Mixed + Auto-fix


    // Rewards: Mixed + Auto-fix
    rewards: {
      type: mongoose.Schema.Types.Mixed,
      default: () => [],
    },

    // Ek analitik
    registeredIP: { type: String },
    deviceFingerprint: { type: String },

    // Harcama takibi
    totalSpent: { type: Number, default: 0 },

    // Sezon sistemi
    seasonalBadges: [{ type: String }],
    seasonPoints: { type: Number, default: 0 },
    seasonStart: { type: Date },
    seasonEnd: { type: Date },
  },
  { timestamps: true }
);

// ======================================================
// AUTO USERNAME FALLBACK (Boş bırakılırsa düzgün doldur)
// ======================================================
userSchema.pre("validate", function (next) {
  if (!this.username || !String(this.username).trim()) {
    if (this.email) {
      this.username = this.email.split("@")[0];
    } else {
      this.username = "User" + Math.floor(1000 + Math.random() * 9000);
    }
  }
  next();
});

// ======================================================
// REWARDS AUTO NORMALIZE (Eski format → yeni format)
// ======================================================
userSchema.pre("save", function (next) {
  // rewards = sayıysa → cüzdana aktar → rewards boşalt
  if (typeof this.rewards === "number") {
    this.walletBalance = (this.walletBalance || 0) + this.rewards;
    this.rewards = [];
  }

  // rewards array değilse → array yap
  if (!Array.isArray(this.rewards)) {
    this.rewards = [];
  }

  next();
});

// ======================================================
// SAFE JSON (Frontend güvenli taşıma)
// ======================================================
userSchema.methods.toSafeJSON = function () {
  return {
    id: this.id || this._id.toString(),
    username: this.username,
    email: this.email,
    inviteCode: this.inviteCode,
    referredBy: this.referredBy,
    walletBalance: this.walletBalance,
    totalSpent: this.totalSpent,
    rewards: this.rewards,
  };
};

export default mongoose.model("User", userSchema);

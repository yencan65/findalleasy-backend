// BACKEND/BACKEND/server/models/VerificationCode.js
import mongoose from "mongoose";

const VerificationCodeSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true },
    code: { type: String, required: true },
    type: {
      type: String,
      enum: ["signup", "reset", "generic"],
      default: "generic",
    },
    expires: { type: Date, required: true },
  },
  { timestamps: true }
);

// Kodun süresi dolduysa otomatik sil
VerificationCodeSchema.index({ expires: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model("VerificationCode", VerificationCodeSchema);

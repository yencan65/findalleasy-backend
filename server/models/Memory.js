// server/models/Memory.js
import mongoose from "mongoose";

const MemorySchema = new mongoose.Schema(
  {
    userId: { type: String, required: true },
    key: { type: String, required: true },
    value: mongoose.Schema.Types.Mixed,
    lastUpdated: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// Aynı userId + key bir tane olsun
MemorySchema.index({ userId: 1, key: 1 }, { unique: true });

export default mongoose.models.Memory ||
  mongoose.model("Memory", MemorySchema);

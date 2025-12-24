import mongoose from "mongoose";

const schema = new mongoose.Schema({
  type: { type: String, default: "event" },
  message: { type: String, default: "" },
  payload: { type: Object, default: {} },
  userId: { type: String, default: null },
  ip: { type: String, default: "" },
  createdAt: { type: Date, default: Date.now }
});

// 30 günlük TTL index
schema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });

export default mongoose.model("TelemetryLog", schema);

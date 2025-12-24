// server/models/Profile.js
import mongoose from "mongoose";

const ProfileSchema = new mongoose.Schema(
  {
    userId: { type: String },
    sessionId: { type: String },

    locale: { type: String, default: "tr" },
    region: { type: String, default: "TR" },
    mood: { type: String, default: "calm" },
    ipCity: { type: String, default: "" },

    lastSeen: { type: Date, default: Date.now },

    lastQueries: [
      {
        q: String,
        at: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true }
);

export default mongoose.models.Profile ||
  mongoose.model("Profile", ProfileSchema);

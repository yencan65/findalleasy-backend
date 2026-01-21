import mongoose from "mongoose";

// ============================================================================
// BarcodeHint — free learning layer for strictFree mode
// Stores: barcode (GTIN/EAN) -> a human query/title discovered from user photo/OCR.
// This improves future scans without paid providers.
// ============================================================================

const BarcodeHintSchema = new mongoose.Schema(
  {
    barcode: { type: String, required: true, index: true },
    locale: { type: String, default: "tr", index: true },

    // Most useful field for affiliate search
    query: { type: String, default: "" },

    // Optional metadata
    title: { type: String, default: "" },
    brand: { type: String, default: "" },
    image: { type: String, default: "" },

    source: { type: String, default: "user-vision" },
    confidence: { type: String, default: "medium" },

    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { strict: false }
);

BarcodeHintSchema.index({ barcode: 1, locale: 1 }, { unique: true });

export default mongoose.models.BarcodeHint || mongoose.model("BarcodeHint", BarcodeHintSchema);

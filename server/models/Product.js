import mongoose from "mongoose";

// ============================================================================
// Product Model — S21 PATCH (QR/Barcode cache + backwards compatible)
// - ZERO DELETE: Existing fields kept (title/url/price/...)
// - Fix: product-info route caches { qrCode, name } etc. Old schema rejected those.
// - Strategy: make title optional, add name/qrCode/brand/image/description, keep strict:false.
// ============================================================================

const ProductSchema = new mongoose.Schema(
  {
    // Legacy fields (kept)
    title: { type: String, required: false, default: "" },
    url: { type: String, default: "" },
    price: { type: Number, default: null },
    rating: { type: Number, default: null },
    provider: { type: String, default: "" },
    currency: { type: String, default: "TRY" },
    region: { type: String, default: "TR" },
    category: { type: String, default: "product" },
    raw: { type: Object, default: null },

    // S21 additions (QR/Barcode resolver cache)
    qrCode: { type: String, index: true },
    name: { type: String, default: "" },
    brand: { type: String, default: "" },
    image: { type: String, default: "" },
    description: { type: String, default: "" },
    source: { type: String, default: "" },
  },
  { timestamps: true, strict: false }
);

export default mongoose.model("Product", ProductSchema);

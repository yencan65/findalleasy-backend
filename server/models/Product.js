import mongoose from "mongoose";

const ProductSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    url: { type: String },
    price: { type: Number },
    rating: { type: Number },
    provider: { type: String },
    currency: { type: String, default: "TRY" },
    region: { type: String, default: "TR" },
    category: { type: String, default: "product" },
    raw: { type: Object },
  },
  { timestamps: true }
);

export default mongoose.model("Product", ProductSchema);

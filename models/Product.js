// models/Product.js
import mongoose from "mongoose";

const ProductSchema = new mongoose.Schema({
  qrCode: { type: String, unique: true },
  name: String,
  brand: String,
  category: String,
  image: String,
  createdAt: { type: Date, default: Date.now },
});

export default mongoose.model("Product", ProductSchema);

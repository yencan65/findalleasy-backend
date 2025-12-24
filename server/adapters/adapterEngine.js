// server/adapters/adapterEngine.js
// Tekleştirilmiş adapter motoru wrapper'ı.
// Tüm gerçek mantık server/core/adapterEngine.js içindedir.
// Eski import yollarını bozmamak için buradan re-export yapıyoruz.
// İLERİYE DÖNÜK: Buraya global caching, rate-limit veya health-check eklenebilir.

import coreEngine, { runAdapters as coreRunAdapters } from "../core/adapterEngine.js";

// Eski sistemlerle uyumluluk
export const runAdapters = coreRunAdapters;

// Gelişmiş, anlamlı default export
// coreEngine zaten motorun kendisi → ama ileride buraya ek özellikler de bağlanabilir.
const adapterEngine = {
  ...coreEngine,
  runAdapters: coreRunAdapters,
};

export default adapterEngine;

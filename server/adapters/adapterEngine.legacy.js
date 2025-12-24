// server/adapters/adapterEngine.js
// Bu dosya ARTIK eski motoru çalıştırmaz.
// Yeni S5/Herkül motoru server/core/adapterEngine.js içindedir.
// Eski import yollarını kırmamak için sadece wrapper olarak bırakıldı.

import * as core from "../core/adapterEngine.js";

// Tüm modern adapter motoru fonksiyonlarını re-export et
export const runAdapters = core.runAdapters;

// Eski sistem çağıran dosyalar için default export
export default {
  runAdapters: core.runAdapters,
};

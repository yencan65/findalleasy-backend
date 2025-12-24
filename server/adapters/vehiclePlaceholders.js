// server/adapters/vehiclePlaceholders.js
// ============================================================================
// VEHICLE PLACEHOLDERS — S200 SAFE DUMMY ADAPTERS (HARDENED)
// Bu dosya motorun aradığı tüm fonksiyonları sağlar.
// Gerçek scraper yoksa bile motor çökmemesi için fallback döner.
//
// ✅ NO FAKE RESULTS: Sahte ilan üretmek YASAK.
// ✅ Observable fail: ok:false + error ile görünür hata (ama array signature korunur).
// ✅ NO RANDOM: Math.random vb. yok.
// ============================================================================

// NOT: Bazı yerlerde motor "ARRAY" bekliyor.
// Bu yüzden "array döndürme" davranışını KORUYORUZ ama üzerine ok/error/_meta yazarak
// failure'ı görünür kılıyoruz (S200 wrapper bunu anlayacak).

import { searchWithSerpApi } from "./serpApi.js";
import { safeStr, stableIdS200, normalizeUrlS200, isBadUrlS200, fixKey, withTimeout } from "../core/s200AdapterKit.js";

function failArray(providerKey, query, opt = {}, error = "NOT_IMPLEMENTED", note = "") {
  const pk = String(providerKey || "vehicle_sale").trim() || "vehicle_sale";
  const q = String(query || "");
  const fam = pk.split("_")[0] || pk;

  const arr = [];
  // Array üstüne meta bas (JS'de legal)
  arr.ok = false;
  arr.items = []; // bazı legacy coerce'lar out.items bakabiliyor
  arr.count = 0;
  arr.error = error;
  arr.note = note || `Adapter not implemented: ${pk}`;
  arr.provider = fam;
  arr.providerKey = pk;
  arr.providerFamily = fam;
  arr.category = "vehicle_sale";
  arr._meta = {
    stub: true,
    placeholder: true,
    providerKey: pk,
    providerFamily: fam,
    query: q,
    opt,
    timestamp: Date.now(),
  };

  return arr;
}

// ZERO-DELETE: eski isim kalsın ama artık FAKE item üretmesin.
function dummyResult(provider, query, opt = {}) {
  return failArray(provider, query, opt, "NOT_IMPLEMENTED", "Placeholders never generate fake listings");
}

// ============================================================================
// ARABAM
// ============================================================================
export async function searchArabam(query, opt = {}) {
  return searchVehicleSerpFallback("arabam_vehicle", query, {
    site: "site:arabam.com",
    hint: "araba otomobil ilan",
    opt,
  });
}

export async function searchArabamScrape(query, opt = {}) {
  // "scrape" versiyonu da güvenli şekilde SerpAPI fallback kullanır (no crash).
  return searchVehicleSerpFallback("arabam_vehicle_scrape", query, {
    site: "site:arabam.com",
    hint: "araba otomobil ilan",
    opt,
  });
}

export async function searchArabamAdapter(query, opt = {}) {
  // "adapter" birleşik yol: aynı fallback; üst wrapper zaten S200 normalize eder.
  return searchVehicleSerpFallback("arabam_vehicle_adapter", query, {
    site: "site:arabam.com",
    hint: "araba otomobil ilan",
    opt,
  });
}

async function searchVehicleSerpFallback(providerKey, query, { site, hint, opt } = {}) {
  const startedAt = Date.now();
  const q = safeStr(query);
  if (!q) return [];

  const serpQ = [site, hint, q].filter(Boolean).join(" ").trim();

  try {
    // SerpAPI bazen 1-2s sürer; dış wrapper timeout'u düşükse burada keselim.
    const raw = await withTimeout(searchWithSerpApi(serpQ, { mode: "web", num: 10 }), 2400, providerKey + ":serp");
    const arr = Array.isArray(raw) ? raw : [];
    const out = [];

    for (const r of arr) {
      const title = safeStr(r?.title);
      const url0 = safeStr(r?.finalUrl || r?.originUrl || r?.url);
      const url = normalizeUrlS200(url0);
      if (!title || !url || isBadUrlS200(url)) continue;

      out.push({
        id: stableIdS200(providerKey, url, title),
        title,
        url,
        originUrl: url,
        finalUrl: url,
        price: null, // discovery source
        currency: null,
        provider: "arabam",
        providerKey,
        providerFamily: "vehicle_sale",
        category: "vehicle_sale",
        vertical: "vehicle_sale",
        discovery: true,
        raw: r?.raw || r,
        _meta: { strategy: "serpapi", startedAt, tookMs: Date.now() - startedAt },
      });
    }

    return out;
  } catch (e) {
    // Observable fail: boş dön (wrapper tarafı ok=false yapabilir); burada crash yok.
    return [];
  }
}


// ============================================================================
// VAVACARS
// ============================================================================
export async function searchVavaCars(query, opt = {}) {
  return dummyResult("vavacars_vehicle", query, opt);
}
export async function searchVavaCarsScrape(query, opt = {}) {
  return dummyResult("vavacars_vehicle_scrape", query, opt);
}
export async function searchVavaCarsAdapter(query, opt = {}) {
  return dummyResult("vavacars_vehicle_adapter", query, opt);
}

// ============================================================================
// LETGO
// ============================================================================
export async function searchLetgoCar(query, opt = {}) {
  return dummyResult("letgo_vehicle", query, opt);
}
export async function searchLetgoCarScrape(query, opt = {}) {
  return dummyResult("letgo_vehicle_scrape", query, opt);
}
export async function searchLetgoCarAdapter(query, opt = {}) {
  return dummyResult("letgo_vehicle_adapter", query, opt);
}

// ============================================================================
// OTONET
// ============================================================================
export async function searchOtoNet(query, opt = {}) {
  return dummyResult("otonet_vehicle", query, opt);
}
export async function searchOtoNetScrape(query, opt = {}) {
  return dummyResult("otonet_vehicle_scrape", query, opt);
}
export async function searchOtoNetAdapter(query, opt = {}) {
  return dummyResult("otonet_vehicle_adapter", query, opt);
}

// ============================================================================
// DEFAULT EXPORT
// ============================================================================
export default {
  searchArabam,
  searchArabamScrape,
  searchArabamAdapter,
  searchVavaCars,
  searchVavaCarsScrape,
  searchVavaCarsAdapter,
  searchLetgoCar,
  searchLetgoCarScrape,
  searchLetgoCarAdapter,
  searchOtoNet,
  searchOtoNetScrape,
  searchOtoNetAdapter,
};

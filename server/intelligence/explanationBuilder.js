// server/intelligence/explanationBuilder.js
// ======================================================================
//  FAE EXPLANATION ENGINE — S200 HYPER-FUSION
//  BEST / SMART / OTHERS açıklama üretim beyni
//  ZERO-DELETE · ZERO-CRASH · BACKWARD-COMPATIBLE
//  AdapterEngine S200 sonuç formatıyla %100 uyumlu
// ======================================================================

// ------------------------------------------------------------
// SAFE HELPERS
// ------------------------------------------------------------
function safeArray(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  return [v];
}

function fmtPrice(price, currency = "TRY") {
  if (typeof price !== "number" || !isFinite(price)) return null;
  const symbol =
    currency === "TRY"
      ? "₺"
      : currency === "USD"
      ? "$"
      : currency === "EUR"
      ? "€"
      : currency + " ";
  return `${symbol}${price.toFixed(0)}`;
}

function summarizeStats(items = []) {
  if (!items.length) return null;

  let minPrice = Infinity;
  let maxPrice = 0;
  let sum = 0;
  let count = 0;

  for (const it of items) {
    if (typeof it.price === "number" && it.price > 0) {
      const p = it.price;
      minPrice = Math.min(minPrice, p);
      maxPrice = Math.max(maxPrice, p);
      sum += p;
      count++;
    }
  }

  if (!count) return null;

  return {
    minPrice,
    maxPrice,
    avgPrice: sum / count,
  };
}

function describeTrust(item) {
  const t = item._trustScore ?? item.trustScore ?? null;
  if (t == null) return null;

  if (t >= 0.95) return "çok yüksek güven puanına sahip";
  if (t >= 0.9) return "yüksek güven seviyesinde";
  if (t >= 0.8) return "güvenilir satıcılar arasında";
  if (t >= 0.7) return "makul güven profiline sahip";
  return "güven skoruna göre daha düşük risk profiline sahip";
}

function describePricePosition(item, stats) {
  if (!stats || typeof item.price !== "number") return null;

  if (item.price <= stats.minPrice) return "en düşük fiyatlı seçenek";
  if (item.price <= stats.avgPrice) return "ortalamanın altında fiyat sunuyor";
  if (item.price <= stats.maxPrice) return "ortalama seviyede";

  return null;
}

function buildSentence(parts = []) {
  const text = parts.filter(Boolean).join(". ");
  if (!text) return "";
  return text.replace(/\.\.+/g, ".") + ".";
}

// ======================================================================
//  BEST CARD — Ana açıklama
// ======================================================================
export function buildBestCardExplanation(bestItems, query, intent) {
  const items = safeArray(bestItems);

  if (!items.length) {
    return "Bu arama için BEST kart oluşturulamadı. Sonuçlar optimize ediliyor.";
  }

  const main = items[0];
  const stats = summarizeStats(items);

  const provider = main.provider || "seçili satıcı";
  const priceText = fmtPrice(main.price, main.currency);

  const chunks = [];
  const qText = query ? `"${query}" aramanız için` : "Bu arama için";

  if (priceText) {
    const desc = describePricePosition(main, stats);
    chunks.push(
      `${qText} ${provider} ${priceText} seviyesinde bir fiyat sunuyor${
        desc ? ` ve ${desc}` : ""
      }`
    );
  } else {
    chunks.push(`${qText} en yüksek fiyat/performans dengesini bu satıcı sağlıyor`);
  }

  const trustDesc = describeTrust(main);
  if (trustDesc) chunks.push(`Satıcı ${trustDesc}`);

  if (typeof main.rating === "number" && main.rating > 0) {
    chunks.push(`Kullanıcı değerlendirme puanı yaklaşık ${main.rating.toFixed(1)} / 5`);
  }

  if (main.isAffiliate || main?.commissionMeta?.discount > 0) {
    chunks.push(
      "Bu satıcı, anlaşmalı komisyon modeli sayesinde rakip platformlara göre fiyat avantajı sunuyor"
    );
  }

  if (intent?.type === "flight") {
    chunks.push("Uçuş seçenekleri fiyat, güvenilirlik ve toplam seyahat süresine göre optimize edildi");
  } else if (intent?.type === "hotel") {
    chunks.push("Konaklama seçenekleri fiyat, konum ve kullanıcı puanlamalarına göre değerlendirildi");
  } else if (intent?.type === "place") {
    chunks.push("Konuma yakınlık, yorumlar ve popülerlik skorları analiz edildi");
  }

  return (
    buildSentence(chunks) ||
    "Bu seçenek; fiyat, kalite ve güvenilirlik açısından en güçlü profil olarak seçildi."
  );
}

// ======================================================================
//  SMART CARD — Tamamlayıcı öneriler
// ======================================================================
export function buildSmartCardExplanation(smartItems, query, intent) {
  const items = safeArray(smartItems);

  if (!items.length) {
    return "Bu arama için ek akıllı öneri üretilemedi.";
  }

  const intentText =
    intent?.type === "flight"
      ? "yolculuğa uygun ek hizmetler"
      : intent?.type === "hotel"
      ? "konaklamayı kolaylaştıran ek hizmetler"
      : intent?.type === "place"
      ? "bulunduğunuz lokasyona uygun tamamlayıcı öneriler"
      : "ilgili ürün ve hizmetler";

  const chunks = [];

  chunks.push(
    query
      ? `"${query}" aramanıza göre ${intentText} önerdik`
      : `Bu kartta ${intentText} gösteriliyor`
  );

  const categories = new Set();
  for (const it of items) {
    const t = (it.category || it.type || "").toLowerCase();
    if (!t) continue;

    if (t.includes("otel") || t.includes("hotel")) categories.add("otel");
    else if (t.includes("car") || t.includes("rent")) categories.add("araç kiralama");
    else if (t.includes("tur") || t.includes("tour")) categories.add("tur");
    else if (t.includes("insurance") || t.includes("sigorta")) categories.add("sigorta");
    else categories.add("ilgili ürünler");
  }

  if (categories.size > 0) {
    chunks.push(`Öne çıkan kategoriler: ${Array.from(categories).join(", ")}`);
  }

  chunks.push("Bu öneriler, arama bağlamı ve kullanıcı davranış verilerine göre seçildi");

  return buildSentence(chunks);
}

// ======================================================================
//  OTHERS CARD — Alternatif teklifler
// ======================================================================
export function buildOthersCardExplanation(otherItems, query, intent) {
  const items = safeArray(otherItems);

  if (!items.length) {
    return "Bu arama için alternatif satıcı bulunamadı.";
  }

  const stats = summarizeStats(items);

  const chunks = [];

  chunks.push(
    query
      ? `"${query}" için ana seçenek dışındaki alternatif satıcılar burada listeleniyor`
      : "Ana seçenek dışındaki alternatif teklifleri burada gösteriyoruz"
  );

  if (stats) {
    const minText = fmtPrice(stats.minPrice);
    const maxText = fmtPrice(stats.maxPrice);
    if (minText && maxText) {
      chunks.push(`Alternatifler ${minText} – ${maxText} fiyat aralığında`);
    }
  }

  chunks.push(
    "Bu satıcılar, BEST kart kadar güçlü bir fiyat/kalite dengesi sunmasa da karşılaştırma için değerli"
  );

  if (intent?.type === "flight") {
    chunks.push("Aktarma sayısı, havayolu kalitesi ve toplam süre analiz edildi");
  } else if (intent?.type === "hotel") {
    chunks.push("Konum, iptal koşulları ve kullanıcı yorumları dikkate alındı");
  }

  return buildSentence(chunks);
}

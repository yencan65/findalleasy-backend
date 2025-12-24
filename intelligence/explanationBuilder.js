// server/intelligence/explanationBuilder.js
// BEST / SMART / OTHERS açıklamaları için akıllı beyin
// Fonksiyon isimleri ve işlevler %100 korunmuştur — sadece Herkül güçlendirme eklendi.

/* ============================================================
   --- KORUMA FONKSİYONLARI ---
   ============================================================ */
function safeArray(x) {
  if (!x) return [];
  if (Array.isArray(x)) return x;
  return [x];
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

// Ortalama-min-max çıkarımı
function summarizeStats(items = []) {
  if (!items.length) return null;

  let minPrice = Infinity;
  let maxPrice = 0;
  let sum = 0;
  let count = 0;

  items.forEach((it) => {
    if (typeof it.price === "number" && it.price > 0) {
      minPrice = Math.min(minPrice, it.price);
      maxPrice = Math.max(maxPrice, it.price);
      sum += it.price;
      count++;
    }
  });

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

/* ============================================================
   BEST CARD — EN GÜÇLÜ TEKLİF AÇIKLAMASI
   ============================================================ */
export function buildBestCardExplanation(bestItems, query, intent) {
  const items = safeArray(bestItems);
  if (!items.length) {
    return "Bu arama için öne çıkan uygun bir teklif bulunamadı. Sonuçları genişleterek en iyi seçeneği tekrar hesaplıyoruz.";
  }

  const main = items[0];
  const stats = summarizeStats(items);

  const provider = main.provider || "seçili satıcı";
  const priceText = fmtPrice(main.price, main.currency);

  const chunks = [];

  const qText = query ? `"${query}" aramanız için` : "Bu aramanız için";

  // --- Fiyat açıklaması ---
  if (priceText) {
    const desc = describePricePosition(main, stats);
    chunks.push(
      `${qText} ${provider} ${priceText} seviyesinde bir fiyat sunuyor` +
        (desc ? ` ve ${desc}` : "")
    );
  } else {
    chunks.push(
      `${qText} fiyat/performans, güven ve kalite dengesi açısından en güçlü profili bu satıcı sağlıyor`
    );
  }

  // --- Güven ---
  const trustDesc = describeTrust(main);
  if (trustDesc) {
    chunks.push(`Satıcı ${trustDesc}`);
  }

  // --- Rating ---
  if (typeof main.rating === "number" && main.rating > 0) {
    chunks.push(
      `Kullanıcı değerlendirme puanı yaklaşık ${main.rating.toFixed(1)} / 5`
    );
  }

  // --- Affiliate avantajı ---
  if (main.isAffiliate || main?.commissionMeta?.discount > 0) {
    chunks.push(
      "Bu satıcıyla yapılan komisyon anlaşması sayesinde fiyat, rakip platformlara kıyasla daha avantajlı hale getirildi"
    );
  }

  // --- Kullanıcının arama niyeti ---
  if (intent?.type === "flight") {
    chunks.push(
      "Uçuş seçenekleri arasında fiyat, güvenilirlik, toplam yolculuk süresi ve genel seyahat kalitesi birlikte optimize edildi"
    );
  } else if (intent?.type === "hotel") {
    chunks.push(
      "Konaklama için fiyat, konum, popülerlik ve kullanıcı puanlamaları birlikte değerlendirildi"
    );
  } else if (intent?.type === "place") {
    chunks.push(
      "Konuma yakınlık, ziyaretçi yorumları ve popülerlik skorları dikkate alındı"
    );
  }

  return (
    buildSentence(chunks) ||
    "Bu seçenek, fiyat, kalite ve güvenilirlik dengesi sayesinde en avantajlı satıcı olarak seçildi."
  );
}

/* ============================================================
   SMART CARD — Akıllı / Tamamlayıcı Öneriler
   ============================================================ */
export function buildSmartCardExplanation(smartItems, query, intent) {
  const items = safeArray(smartItems);
  if (!items.length) {
    return "Bu arama için ek akıllı öneri üretilemedi. Şu anda yalnızca ana sonuçları gösteriyoruz.";
  }

  const intentText =
    intent?.type === "flight"
      ? "yolculuğunuzu tamamlayabilecek ek hizmetler"
      : intent?.type === "hotel"
      ? "konaklamanız sırasında işinizi kolaylaştırabilecek hizmetler"
      : intent?.type === "place"
      ? "bulunduğunuz lokasyona uygun ek öneriler"
      : "alışveriş deneyiminizi tamamlayabilecek ilgili ürün ve hizmetler";

  const kinds = new Set();
  for (const it of items) {
    const t = (it.category || it.type || "").toLowerCase();
    if (!t) continue;

    if (t.includes("otel") || t.includes("hotel")) kinds.add("otel");
    else if (t.includes("arac") || t.includes("car") || t.includes("rent"))
      kinds.add("araç kiralama");
    else if (t.includes("transfer")) kinds.add("transfer");
    else if (t.includes("tur") || t.includes("tour")) kinds.add("tur");
    else if (t.includes("sigorta") || t.includes("insurance")) kinds.add("sigorta");
    else kinds.add("ilgili ürünler");
  }

  const chunks = [];

  if (query) {
    chunks.push(`"${query}" aramanıza göre ${intentText} önerdik`);
  } else {
    chunks.push(`Bu kartta ${intentText} gösteriyoruz`);
  }

  const kindText = Array.from(kinds).join(", ");
  if (kindText) {
    chunks.push(`Öne çıkan kategoriler: ${kindText}`);
  }

  chunks.push(
    "Bu öneriler, hem önceki kullanıcı davranışları hem de aramanızın bağlamı analiz edilerek seçildi"
  );

  return buildSentence(chunks);
}

/* ============================================================
   OTHERS CARD — Benzer / Alternatif Satıcılar
   ============================================================ */
export function buildOthersCardExplanation(otherItems, query, intent) {
  const items = safeArray(otherItems);
  if (!items.length) {
    return "Bu arama için ek alternatif satıcı kaydı bulunamadı.";
  }

  const stats = summarizeStats(items);

  const chunks = [];

  if (query) {
    chunks.push(
      `"${query}" için ana seçenek dışında kalan diğer satıcıları karşılaştırabilmeniz adına bu kartta listeliyoruz`
    );
  } else {
    chunks.push(
      "Ana seçeneğin dışındaki alternatif satıcılar bu kartta listeleniyor"
    );
  }

  if (stats) {
    const minText = fmtPrice(stats.minPrice);
    const maxText = fmtPrice(stats.maxPrice);
    if (minText && maxText) {
      chunks.push(
        `Alternatifler arasında fiyat aralığı yaklaşık ${minText} – ${maxText} arasında değişiyor`
      );
    }
  }

  chunks.push(
    "Bu seçenekler genellikle fiyat, kullanıcı puanı, teslimat süresi veya güven profili açısından BEST kart kadar güçlü bir denge sunmuyor"
  );

  if (intent?.type === "flight") {
    chunks.push(
      "Uçuş alternatiflerinde aktarma sayısı, havayolu kalitesi ve toplam seyahat süresi de değerlendirmeye dahil edildi"
    );
  } else if (intent?.type === "hotel") {
    chunks.push(
      "Konaklama seçeneklerinde konum, iptal koşulları, oda durumu ve kullanıcı yorumları analiz edildi"
    );
  }

  return buildSentence(chunks);
}

// server/adapters/categoryDetector.js
// ============================================================
// 🔥 Herkül S13 Category Engine — V11 + Zero-Shot LLM Hybrid
// ============================================================

import axios from "axios";

/* -----------------------------------------------------------
   0) LLM CATEGORY GUESSER
----------------------------------------------------------- */
async function llmGuessCategory(query = "") {
  try {
    const payload = {
      query,
      prompt: `
        Kullanıcının sorgusunu tek kelime kategoriye çevir:
        flight, hotel, car_rental, taxi, event, spa, tour,
        estate, lawyer, health, checkup, food, grocery,
        electronics, product.

        Sadece kategori ismi döndür.
        Sorgu: "${query}"
      `,
    };

    const res = await axios.post(
      process.env.LLM_CATEGORY_URL || "http://localhost:8080/api/llm/category",
      payload,
      { timeout: 2200 }
    );

    return String(res.data.category || "").trim().toLowerCase();
  } catch {
    return null;
  }
}

function scoreFromLLM(llmCat) {
  if (!llmCat) return {};

  const BOOST = {
    flight: 8,
    hotel: 8,
    car_rental: 8,
    taxi: 6,
    event: 7,
    spa: 6,
    tour: 8,
    estate: 8,
    lawyer: 9,
    health: 9,
    checkup: 8,
    food: 7,
    grocery: 6,
    electronics: 7,
    product: 4,
  };

  return { [llmCat]: BOOST[llmCat] || 0 };
}

/* -----------------------------------------------------------
   1) ANA MOTOR (V11) — SENİN ESKİ MOTORUN, SİLİNMİYOR
   NOT: product artık "default" olduğu için hafif base avantajı var.
----------------------------------------------------------- */
export function detectCategory(query = "") {
  const qRaw = String(query || "");
  const q = qRaw.toLowerCase().trim();
  if (!q) return "product";

  const has = (re) => re.test(q);

  const CATEGORY_CONFIG = [
    {
      key: "flight",
      base: 0,
      tests: [
        { re: /\b(uçak|ucak|flight|airline|hava yolu|havayolu|uçuş|bilet)\b/, score: 4 },
        { re: /\b(pegasus|thy|turkish airlines|sunexpress|anadolujet)\b/, score: 5 },
        {
          re: /(istanbul|ankara|izmir|antalya|paris|amsterdam|londra|berlin).+(istanbul|ankara|izmir|antalya|paris|amsterdam|londra|berlin)/,
          score: 3,
        },
        { re: /\b(gidiş dönüş|gidiş-dönüş|round trip)\b/, score: 2 },
      ],
    },

    {
      key: "hotel",
      base: 0,
      tests: [
        { re: /\b(otel|hotel|pansiyon|konaklama|resort|apart|bungalov|bungalow|villa|tatil köyü)\b/, score: 4 },
        { re: /\b(bodrum|antalya|çeşme|cesme|uludağ|uludag|marmaris|belek|kapadokya|fethiye|kıbrıs|kibris)\b/, score: 3 },
        { re: /\b(tatil|deniz manzaralı|sea view|beach|all inclusive|her şey dahil|hersey dahil)\b/, score: 3 },
        { re: /\b(gece fiyatı|gecelik|oda kahvaltı|yarım pansiyon|full pansiyon)\b/, score: 2 },
      ],
    },

    {
      key: "car_rental",
      base: 0,
      tests: [
        { re: /\b(araç kirala|araba kirala|araç kiralama|araba kiralama|kiralık araç|kiralik arac|kiralık araba|kiralik araba|rent a car|rentacar|oto kiralama|car rental|vehicle rental)\b/, score: 5 },
        { re: /\b(garenta|avec|enterprise|budget|avis|circular|sixt|hertz)\b/, score: 4 },
        { re: /\b(ekonomik sınıf|full kasko|km sınırı|km siniri)\b/, score: 2 },
      ],
    },

    {
      key: "taxi",
      base: 0,
      tests: [
        { re: /\b(taksi|taxi|cab|uber|bitaksi|bi taksi)\b/, score: 5 },
        { re: /\b(çağır|cagir|çağırmak|hemen gelsin)\b/, score: 1 },
      ],
    },

    {
      key: "event",
      base: 0,
      tests: [
        { re: /\b(konser|festival|biletix|tiyatro|show|etkinlik|sinema|müzikal|muzikal|stand ?up)\b/, score: 5 },
        { re: /\b(bilet|ticket|sahne|performans|konser bileti|salon)\b/, score: 3 },
        { re: /\b(dj|party|parti|club|arena|stadium|stadyum)\b/, score: 2 },
      ],
    },

    {
      key: "spa",
      base: 0,
      tests: [
        { re: /\b(spa|wellness|masaj|massage|hamam|sauna|kaplıca|kaplica|güzellik salonu|beauty center)\b/, score: 5 },
        { re: /\b(aroma terapi|sıcak taş|sicak tas|buhar odası|buhar odasi)\b/, score: 2 },
      ],
    },

    {
      key: "tour",
      base: 0,
      tests: [
        { re: /\b(tur|tour|gezi|city tour|tekne turu|boat tour|rafting|safari|museum|müze|muze|excursion)\b/, score: 5 },
        { re: /\b(kapadokya|pamukkale|çanakkale turu|canakkale turu|efes|göreme|goreme)\b/, score: 4 },
        { re: /\b(günübirlik|gunubirlik|rehberli tur|guide|guideli)\b/, score: 2 },
      ],
    },

    {
      key: "estate",
      base: 0,
      tests: [
        { re: /\b(kiralık|satılık|emlak|ev|daire|villa|arsa|ofis|konut|residence)\b/, score: 4 },
        { re: /\b(sahibinden|hepsiemlak|zingat|tapu|tapu\.com)\b/, score: 4 },
        { re: /\b(brut|net m2|metrekare|metre kare|kira getirisi)\b/, score: 2 },
      ],
    },

    {
      key: "lawyer",
      base: 0,
      tests: [
        { re: /\b(avukat|hukuk|icra|dava|tazminat|boşanma|bosanma|velayet|itiraz|dilekçe)\b/, score: 5 },
        { re: /\b(iş mahkemesi|is mahkemesi|ceza hukuku|aile hukuku|ticaret hukuku|miras hukuku)\b/, score: 4 },
        { re: /\b(arabulucu|arabuluculuk|icra dairesi|sgk davası|sgk davasi)\b/, score: 3 },
      ],
    },

    {
      key: "health",
      base: 0,
      tests: [
        { re: /\b(mhrs|doktor|doctor|hastane|hospital|tahlil|tetkik|muayene|enabız|e nabız|e-nabız)\b/, score: 5 },
        { re: /\b(randevu|appointment|poliklinik|klinik)\b/, score: 3 },
        { re: /\b(dahiliye|kardiyoloji|ortopedi|dermatoloji|psikiyatri|göz doktoru|goz doktoru)\b/, score: 3 },
      ],
    },

    {
      key: "checkup",
      base: 0,
      tests: [
        { re: /\b(check ?up|checkup|genel kontrol|sağlık paketi|saglik paketi)\b/, score: 5 },
        { re: /\b(kapsamlı|kapsamli|kadın checkup|kadin checkup|erkek checkup|kurumsal checkup)\b/, score: 3 },
      ],
    },

    {
      key: "food",
      base: 0,
      tests: [
        {
          re: /\b(yemek|döner|doner|pizza|burger|lahmacun|iskender|kebap|çorba|kahvaltı|tatlı)\b/,
          score: 5,
        },
        { re: /\b(restoran|restaurant|cafe|kafe|paket servis|gel al)\b/, score: 3 },
        { re: /\b(kfc|mcdonald|dominos|burger king|popeyes)\b/, score: 4 },
      ],
    },

    {
      key: "grocery",
      base: 0,
      tests: [
        { re: /\b(market|bim|a101|şok|carrefour|migros|gıda|şarküteri)\b/, score: 5 },
        { re: /\b(süt|yumurta|ekmek|sebze|meyve|temel ihtiyaç)\b/, score: 3 },
        { re: /\b(online market|hızlı market)\b/, score: 2 },
      ],
    },

    {
      key: "electronics",
      base: 0,
      tests: [
        {
          re: /\b(telefon|iphone|samsung|xiaomi|huawei|macbook|laptop|bilgisayar|airpods|tablet|ipad)\b/,
          score: 5,
        },
        { re: /\b(elektronik|akıllı cihaz|smart device)\b/, score: 3 },
        { re: /\b(tv|televizyon|oled|qled|soundbar|bluetooth hoparlör)\b/, score: 3 },
      ],
    },

    // DİKKAT: product burada DEFAULT, bu yüzden base = 1
    {
      key: "product",
      base: 1,
      tests: [
        { re: /\b(fiyatı|fiyat|satın al|alışveriş|indirim|kampanya)\b/, score: 2 },
        { re: /\b(kargo|teslimat|iade|garanti)\b/, score: 1 },
      ],
    },
  ];

  const isRepairQuery = has(
    /\b(tamir|onarım|servis|ekran değişimi|batarya değişimi|kamera değişimi|parça|montaj|sökme)\b/
  );

  const scores = {};
  for (const cat of CATEGORY_CONFIG) {
    let score = cat.base || 0;
    if (Array.isArray(cat.tests)) {
      for (const t of cat.tests) {
        if (t.re.test(q)) score += t.score;
      }
    }
    scores[cat.key] = score;
  }

  // Tamir kelimesi geçiyorsa ama elektronik de varsa,
  // elektronik skorunu biraz bastır (servis arıyor olabilir)
  if (isRepairQuery && scores["electronics"] > 0) {
    scores["electronics"] = Math.max(0, scores["electronics"] - 4);
  }

  const priorityOrder = [
    "flight",
    "hotel",
    "car_rental",
    "tour",
    "event",
    "spa",
    "estate",
    "lawyer",
    "health",
    "checkup",
    "food",
    "grocery",
    "electronics",
    "taxi",
    "product",
  ];

  let bestCategory = "product";
  let bestScore = 0;

  for (const key of Object.keys(scores)) {
    const sc = scores[key];
    if (sc > bestScore) {
      bestScore = sc;
      bestCategory = key;
    } else if (sc === bestScore && sc > 0) {
      const currentIdx = priorityOrder.indexOf(bestCategory);
      const candIdx = priorityOrder.indexOf(key);
      if (candIdx !== -1 && candIdx < currentIdx) bestCategory = key;
    }
  }

  // EK GÜVENLİK:
  // Skor çok düşükse (0 veya 1 civarı) → her durumda "product"
  if (bestScore <= 1) return "product";

  return bestCategory;
}

/* -----------------------------------------------------------
   2) S13 HYBRID MOTOR (V11 + LLM)
   NOT: Base kategori güçlü ise LLM onu kolay kolay deviremiyor.
----------------------------------------------------------- */
export async function detectCategoryS13(query = "") {
  const baseCategory = detectCategory(query);

  const cats = [
    "flight",
    "hotel",
    "car_rental",
    "tour",
    "event",
    "spa",
    "estate",
    "lawyer",
    "health",
    "checkup",
    "food",
    "grocery",
    "electronics",
    "taxi",
    "product",
  ];

  const baseScores = {};
  for (let c of cats) baseScores[c] = c === baseCategory ? 10 : 0;

  const llmCat = await llmGuessCategory(query);
  const llmScores = scoreFromLLM(llmCat);

  const finalScores = { ...baseScores };
  for (const k in llmScores) {
    finalScores[k] = (finalScores[k] || 0) + llmScores[k] * 1.3;
  }

  // Güvenlik: Base "product" ise, LLM sadece çok bariz
  // travel / estate / lawyer gibi kategorizasyonlarda override edebilir.
  const STRONG_NON_PRODUCT = [
    "flight",
    "hotel",
    "car_rental",
    "tour",
    "estate",
    "lawyer",
    "health",
    "checkup",
  ];

  let best = baseCategory;
  let bestScore = finalScores[baseCategory] ?? 0;

  for (const k of Object.keys(finalScores)) {
    const sc = finalScores[k];
    if (sc > bestScore) {
      // Eğer base product ise ve LLM saçma bir kategori önerdiyse
      // (ör: taxi, spa, event) → override ETME.
      if (
        baseCategory === "product" &&
        !STRONG_NON_PRODUCT.includes(k)
      ) {
        continue;
      }
      bestScore = sc;
      best = k;
    }
  }

  return best;
}

/* -----------------------------------------------------------
   3) AUTO MODE — Tüm sistemin kullanacağı fonksiyon
   NOT: Hata durumunda ve gri alanlarda "product"a düşer.
----------------------------------------------------------- */
export async function detectCategoryAuto(query = "") {
  try {
    const hybrid = await detectCategoryS13(query);
    return hybrid || detectCategory(query) || "product";
  } catch {
    return detectCategory(query) || "product";
  }
}

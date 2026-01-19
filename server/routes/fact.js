const express = require('express');

const router = express.Router();

// Small built-in fact pool (no external dependency).
// Purpose: give Sono something immediate even if external sources fail.
const FACTS = {
  tr: [
    'Ahtapotların üç kalbi vardır; ikisi solungaçlara, biri vücudun geri kalanına kan pompalar.',
    'Bir günün uzunluğu Dünya’da her yüzyılda çok küçük bir miktar artar; gezegen çok yavaş şekilde frenleniyor.',
    'Bal arıları yön bulmak için Güneş’i ve polarize ışığı kullanır.',
    'Bazı bambu türleri günde 90 cm’ye kadar uzayabilir (koşullara bağlı).',
    'Satürn’ün yoğunluğu sudan düşüktür; dev bir küvete sığsa teorik olarak “yüzebilir”.'
  ],
  en: [
    'Octopuses have three hearts: two pump blood to the gills and one to the rest of the body.',
    'The length of Earth’s day slowly increases over time because the planet is gradually slowing its rotation.',
    'Honeybees can navigate using the Sun and polarized light patterns in the sky.',
    'Some bamboo species can grow up to ~90 cm per day under ideal conditions.',
    'Saturn’s average density is lower than water; it would float in an enormous bathtub.'
  ]
};

function normLang(lang) {
  const x = String(lang || '').toLowerCase();
  return FACTS[x] ? x : 'en';
}

// GET /api/fact/random?lang=tr
router.get('/random', (req, res) => {
  const lang = normLang(req.query.lang);
  const pool = FACTS[lang];
  const fact = pool[Math.floor(Math.random() * pool.length)];
  return res.json({ ok: true, lang, fact, source: 'local' });
});

module.exports = router;

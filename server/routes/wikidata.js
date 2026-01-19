const express = require('express');
const createMemCache = require('../utils/memCache');

const router = express.Router();

// ENV
// WIKIDATA_UA: REQUIRED by Wikidata for responsible usage
// Example: FindAllEasy/1.0 (findalleasy@gmail.com)
const UA = process.env.WIKIDATA_UA || process.env.OFF_USER_AGENT || 'FindAllEasy/1.0 (findalleasy@gmail.com)';
const TIMEOUT_MS = Number(process.env.WIKIDATA_TIMEOUT_MS || 6000);
const CACHE_MS = Number(process.env.WIKIDATA_CACHE_MS || 6 * 60 * 60 * 1000);

const cache = createMemCache({ defaultTtlMs: CACHE_MS });

function abortableFetch(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  return fetch(url, {
    method: 'GET',
    headers: {
      'User-Agent': UA,
      'Accept': 'application/json'
    },
    signal: ctrl.signal,
  }).finally(() => clearTimeout(t));
}

function normLang(lang) {
  const x = String(lang || '').toLowerCase();
  if (['tr','en','fr','de','ru','ar','es','it','pt','nl'].includes(x)) return x;
  return 'en';
}

// GET /api/wikidata/search?q=istanbul&lang=tr&limit=5
router.get('/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const lang = normLang(req.query.lang);
  const limit = Math.max(1, Math.min(10, Number(req.query.limit || 5)));

  if (!q) return res.status(400).json({ ok: false, error: 'missing_q' });

  const ck = `s:${lang}:${limit}:${q}`;
  const hit = cache.get(ck);
  if (hit) return res.json({ ok: true, cached: true, ...hit });

  // Wikidata search API
  const url = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(q)}&language=${encodeURIComponent(lang)}&format=json&limit=${limit}`;

  try {
    const r = await abortableFetch(url);
    const j = await r.json().catch(() => null);
    if (!r.ok || !j) return res.status(502).json({ ok: false, error: 'wikidata_bad_response', status: r.status });

    const items = Array.isArray(j.search) ? j.search.map(s => ({
      id: s.id,
      label: s.label,
      description: s.description,
      url: s.concepturi,
    })) : [];

    const payload = { items };
    cache.set(ck, payload);
    return res.json({ ok: true, cached: false, ...payload });
  } catch (e) {
    const isAbort = String(e?.name) === 'AbortError';
    return res.status(504).json({ ok: false, error: isAbort ? 'timeout' : 'fetch_failed' });
  }
});

// GET /api/wikidata/entity/Q406?lang=tr
router.get('/entity/:id', async (req, res) => {
  const id = String(req.params.id || '').trim();
  const lang = normLang(req.query.lang);

  if (!/^Q\d+$/.test(id)) return res.status(400).json({ ok: false, error: 'invalid_id' });

  const ck = `e:${lang}:${id}`;
  const hit = cache.get(ck);
  if (hit) return res.json({ ok: true, cached: true, ...hit });

  // EntityData JSON is stable and cache-friendly
  const url = `https://www.wikidata.org/wiki/Special:EntityData/${encodeURIComponent(id)}.json`;

  try {
    const r = await abortableFetch(url);
    const j = await r.json().catch(() => null);
    if (!r.ok || !j) return res.status(502).json({ ok: false, error: 'wikidata_bad_response', status: r.status });

    const ent = j?.entities?.[id];
    if (!ent) return res.status(404).json({ ok: false, error: 'not_found' });

    const label = ent.labels?.[lang]?.value || ent.labels?.en?.value || null;
    const description = ent.descriptions?.[lang]?.value || ent.descriptions?.en?.value || null;

    // Prefer Wikipedia sitelink in requested lang
    const wikiKey = `${lang}wiki`;
    const sitelink = ent.sitelinks?.[wikiKey]?.title || ent.sitelinks?.enwiki?.title || null;
    const wikipediaUrl = sitelink
      ? `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(sitelink.replace(/ /g, '_'))}`
      : null;

    const payload = {
      id,
      label,
      description,
      wikipediaUrl,
      raw: {
        // keep raw minimal to avoid huge payloads
        claims: ent.claims ? Object.keys(ent.claims).slice(0, 30) : [],
      }
    };

    cache.set(ck, payload);
    return res.json({ ok: true, cached: false, ...payload });
  } catch (e) {
    const isAbort = String(e?.name) === 'AbortError';
    return res.status(504).json({ ok: false, error: isAbort ? 'timeout' : 'fetch_failed' });
  }
});

// GET /api/wikidata/summary?q=Galata%20Kulesi&lang=tr
// convenience: search -> best entity -> return label/description/wiki link
router.get('/summary', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const lang = normLang(req.query.lang);

  if (!q) return res.status(400).json({ ok: false, error: 'missing_q' });

  const ck = `sum:${lang}:${q}`;
  const hit = cache.get(ck);
  if (hit) return res.json({ ok: true, cached: true, ...hit });

  try {
    const sUrl = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(q)}&language=${encodeURIComponent(lang)}&format=json&limit=1`;
    const sr = await abortableFetch(sUrl);
    const sj = await sr.json().catch(() => null);
    if (!sr.ok || !sj) return res.status(502).json({ ok: false, error: 'wikidata_bad_response', status: sr.status });

    const top = sj?.search?.[0];
    if (!top?.id) {
      const payloadNF = { found: false };
      cache.set(ck, payloadNF, 15 * 60 * 1000);
      return res.json({ ok: true, cached: false, ...payloadNF });
    }

    const id = top.id;
    const eUrl = `https://www.wikidata.org/wiki/Special:EntityData/${encodeURIComponent(id)}.json`;
    const er = await abortableFetch(eUrl);
    const ej = await er.json().catch(() => null);
    if (!er.ok || !ej) return res.status(502).json({ ok: false, error: 'wikidata_bad_response', status: er.status });

    const ent = ej?.entities?.[id];
    const label = ent?.labels?.[lang]?.value || ent?.labels?.en?.value || top.label || null;
    const description = ent?.descriptions?.[lang]?.value || ent?.descriptions?.en?.value || top.description || null;

    const wikiKey = `${lang}wiki`;
    const sitelink = ent?.sitelinks?.[wikiKey]?.title || ent?.sitelinks?.enwiki?.title || null;
    const wikipediaUrl = sitelink
      ? `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(sitelink.replace(/ /g, '_'))}`
      : null;

    const payload = { found: true, id, label, description, wikipediaUrl };
    cache.set(ck, payload);
    return res.json({ ok: true, cached: false, ...payload });

  } catch (e) {
    const isAbort = String(e?.name) === 'AbortError';
    return res.status(504).json({ ok: false, error: isAbort ? 'timeout' : 'fetch_failed' });
  }
});

module.exports = router;

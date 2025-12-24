
// server/ai/profile.js
// Minimal profiling + geo-aware suggestions (additive).
// Collections: user_profiles { userId, history:[{q,ts,region}], prefs:{}, lastCity }
// Exposes:
//   POST /api/profile/track   { userId, q, region, city? }
//   POST /api/profile/suggest { userId, city?, region? } -> { intents:[], keywords:[], smart:[], categories:[] }

function normalizeQ(q=''){
  return (q||'').toString().trim().toLowerCase().slice(0,200);
}

function cityFromText(t){
  if(!t) return null;
  // ultra naive: look for common TR resort cities; can be extended
  const cities = ['bodrum','antalya','izmir','istanbul','çeşme','fethiye','marmaris','ankara','bursa'];
  const hit = cities.find(c => t.includes(c));
  return hit || null;
}

function registerProfileRoutes(app, db){
  const Profiles = db.collection('user_profiles');

  app.post('/api/profile/track', async (req,res)=>{
    try{
      const { userId, q, region, city } = req.body || {};
      const doc = await Profiles.findOne({ userId });
      const entry = { q: normalizeQ(q), ts: new Date(), region: (region||'TR'), city: city || cityFromText(q) };
      if(!doc){
        await Profiles.insertOne({ userId, history:[entry], prefs:{}, lastCity: entry.city||null });
      }else{
        const lastCity = entry.city || doc.lastCity || null;
        await Profiles.updateOne({ userId }, { $push: { history: entry }, $set: { lastCity } });
      }
      res.json({ ok:true });
    }catch(e){ res.status(500).json({ ok:false, error:e.message }); }
  });

  app.post('/api/profile/suggest', async (req,res)=>{
    try{
      const { userId, city, region } = req.body || {};
      const doc = await Profiles.findOne({ userId });
      const hist = (doc && doc.history) ? doc.history.slice(-10) : [];
      const lastQ = hist.length ? hist[hist.length-1].q : '';
      const lastCity = city || (doc && doc.lastCity) || null;
      const intents = [];
      const keywords = [];
      if(lastQ.includes('otel') || lastQ.includes('hotel')) intents.push('hotel');
      if(lastQ.includes('tekne') || lastQ.includes('boat')) intents.push('boat');
      if(lastQ.includes('elbise') || lastQ.includes('dress')) intents.push('fashion');
      // categories to hint vitrine
      const categories = intents.length ? intents : ['hotel','fashion','electronic'];
      const smart = [];
      if(lastCity){
        smart.push({ title: `${lastCity.toUpperCase()} için öneriler`, type:'city', items:['otel','tekne turu','spa','rent a car'] });
      }
      res.json({ ok:true, intents, keywords, smart, categories, region: region||'TR', city: lastCity });
    }catch(e){ res.status(500).json({ ok:false, error:e.message }); }
  });
}

module.exports = { registerProfileRoutes };

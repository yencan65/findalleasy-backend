
// server/commission.js
// Simple competitor-aware commission suggestion.
// GET /api/commission/sim?competitor=2.5 -> { target: 2.0 }  (always 0.5 below, min 0.5, clamp)
function registerCommissionSim(app){
  app.get('/api/commission/sim', (req,res)=>{
    const comp = Math.max(0.1, Number(req.query.competitor||2.0));
    let target = comp - 0.5;
    if(target < 0.5) target = 0.5;
    res.json({ ok:true, target: Number(target.toFixed(2)) });
  });
}
module.exports = { registerCommissionSim };

const d=db.getSiblingDB('findalleasy');
print('CLICK:');
printjson(d.affiliateclicks16.findOne({clickId:'XfQGP6gh3o1tgvy3XTY9VQ'},{clickId:1,userId:1,sid:1,ts:1,provider:1,finalUrl:1}));
print('CONV:');
printjson(d.affiliateconversions16.findOne({orderId:'TEST-184813'},{orderId:1,clickId:1,userId:1,currency:1,ts:1,paid:1,status:1}));

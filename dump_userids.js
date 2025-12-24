const fs = require('fs');
const d = db.getSiblingDB('findalleasy');
const ids = d.users.find({}, {_id:1}).limit(20).toArray().map(x => x._id.valueOf()).join('\n');
fs.writeFileSync('C:\\Users\\e1865\\Downloads\\BACKEND_AFF_PIPELINE_READY\\userids.txt', ids);
print('WROTE userids.txt');

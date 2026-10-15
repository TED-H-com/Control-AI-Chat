import { db } from '../lib/db.js';
const versions = db.prepare<[],{version:number;name:string}>('SELECT version,name FROM schema_version ORDER BY version').all();
console.log(JSON.stringify({status:'ok',applied:versions}));
db.close();

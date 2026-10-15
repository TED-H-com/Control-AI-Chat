import {accessSync,constants,statSync} from 'node:fs';
import Database from 'better-sqlite3';
import type {Config} from '../config.js';
import {assertStoredKeyCoverage,storedKeyCoverageDomains} from '../lib/crypto/key-coverage.js';

function refuse(message:string):never {
  console.error(`Refusing key coverage check: ${message}`);
  process.exit(2);
}
function detail(error:unknown):string {return error instanceof Error?error.message:String(error);}

process.env.DOTENV_CONFIG_QUIET='true';
let config:Config;
try {({config}=await import('../config.js'));}
catch(error){refuse(`configuration could not be loaded: ${detail(error)}`);}
const path=process.argv[2]?.trim()||process.env.DB_PATH?.trim();
if(!path)refuse('no database path was provided. Pass the database path as the first argument or set DB_PATH.');
let database:Database.Database;
try {
  if(!statSync(path).isFile())throw new Error('not a regular file');
  accessSync(path,constants.R_OK);
  database=new Database(path,{readonly:true,fileMustExist:true});
  database.pragma('query_only=ON');
} catch(error){refuse(`database is missing or unreadable: ${path}: ${detail(error)}`);}
try {
  // One read transaction keeps the listing and guard on the same live-database snapshot.
  database.transaction(()=>{
    const lines=storedKeyCoverageDomains().map(domain=>{
      const rows=database.prepare<unknown[],{key_version:unknown}>(domain.sql).all();
      const versions=[...new Set(rows.flatMap(row=>typeof row.key_version==='number'&&Number.isSafeInteger(row.key_version)?[row.key_version]:[]))].sort((a,b)=>a-b);
      return versions.length?`${domain.name}: ${versions.join(', ')}`:`${domain.name}:`;
    });
    try {assertStoredKeyCoverage(database,config);}
    catch(error){
      console.error(detail(error));
      process.exitCode=1;
      return;
    }
    for(const line of lines)console.log(line);
  })();
} catch(error){
  console.error(`Refusing key coverage check: stored key coverage could not be evaluated: ${detail(error)}`);
  process.exitCode=2;
} finally {database.close();}

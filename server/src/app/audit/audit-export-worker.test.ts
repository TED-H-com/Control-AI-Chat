import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { runMigrations } from '../../lib/migrations/index.js';
import type { TenantId } from '../../shared/types.js';
import { runAuditExportMaintenance, startAuditWorkers } from './workers.js';

const NOW=1_800_000_000_000,HOUR=60*60_000;
const TENANT='11111111-1111-4111-8111-111111111111' as TenantId;
const OTHER='22222222-2222-4222-8222-222222222222' as TenantId;
const USER='33333333-3333-4333-8333-333333333333';
const OTHER_USER='44444444-4444-4444-8444-444444444444';

function fixture(t:import('node:test').TestContext){
  const root=mkdtempSync(join(tmpdir(),'audit-export-worker-')),directory=join(root,'exports'),database=new Database(':memory:'),errors:string[]=[];
  t.after(()=>{database.close();rmSync(root,{recursive:true,force:true});});
  mkdirSync(directory);database.pragma('foreign_keys=ON');runMigrations(database);
  for(const tenant of [TENANT,OTHER]){
    database.prepare("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,?,?,'active',?,?)").run(tenant,tenant,tenant,NOW,NOW);
    database.prepare("INSERT INTO users(tenant_id,id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,?,'User','hash','active',?,?)").run(tenant,tenant===TENANT?USER:OTHER_USER,`user-${tenant.slice(0,4)}@example.test`,NOW,NOW);
  }
  function seed(input:{id?:string;tenantId?:TenantId;status?:string;created?:number;expires?:number;path?:string|null}={}){
    const id=input.id??randomUUID(),tenantId=input.tenantId??TENANT;
    database.prepare("INSERT INTO audit_exports(tenant_id,id,requested_by_user_id,format,include_content,filters_json,status,storage_path,created_at_ms,expires_at_ms) VALUES(?,?,?,'json',0,'{}',?,?,?,?)")
      .run(tenantId,id,tenantId===TENANT?USER:OTHER_USER,input.status??'completed',input.path??null,input.created??NOW-2*HOUR,input.expires??NOW-1);
    return id;
  }
  const row=(tenant:TenantId,id:string)=>database.prepare('SELECT status,error_code,completed_at_ms FROM audit_exports WHERE tenant_id=? AND id=?').get(tenant,id);
  const run=()=>runAuditExportMaintenance({database,exportDirectory:directory,logger:{error:message=>errors.push(message)},now:()=>NOW});
  return {root,directory,database,errors,seed,row,run};
}

test('expired export files and rows are removed while unexpired exports remain',async t=>{
  const f=fixture(t),expiredPath=join(f.directory,`${randomUUID()}.json`),freshPath=join(f.directory,`${randomUUID()}.json`),missingPath=join(f.directory,`${randomUUID()}.json`);
  writeFileSync(expiredPath,'expired');writeFileSync(freshPath,'fresh');
  const expired=f.seed({path:expiredPath,expires:NOW}),fresh=f.seed({path:freshPath,expires:NOW+1}),missing=f.seed({path:missingPath});
  await f.run();
  assert.equal(existsSync(expiredPath),false);assert.equal(f.row(TENANT,expired),undefined);assert.equal(f.row(TENANT,missing),undefined);
  assert.equal(existsSync(freshPath),true);assert.ok(f.row(TENANT,fresh));assert.deepEqual(f.errors,[]);
});

test('stale pending exports become interrupted failures while fresh pending exports remain pending',async t=>{
  const f=fixture(t),stale=f.seed({status:'pending',created:NOW-HOUR,expires:NOW+HOUR}),fresh=f.seed({status:'pending',created:NOW-HOUR+1,expires:NOW+HOUR});
  await f.run();
  assert.deepEqual(f.row(TENANT,stale),{status:'failed',error_code:'EXPORT_INTERRUPTED',completed_at_ms:NOW});
  assert.deepEqual(f.row(TENANT,fresh),{status:'pending',error_code:null,completed_at_ms:null});
});

test('only old matching temporary export files are removed',async t=>{
  const f=fixture(t),stale=join(f.directory,`.${randomUUID()}.tmp`),fresh=join(f.directory,`.${randomUUID()}.tmp`),unrelated=join(f.directory,'.unrelated.tmp');
  for(const file of [stale,fresh,unrelated])writeFileSync(file,'temporary');
  utimesSync(stale,(NOW-HOUR-1000)/1000,(NOW-HOUR-1000)/1000);
  utimesSync(fresh,NOW/1000,NOW/1000);utimesSync(unrelated,(NOW-2*HOUR)/1000,(NOW-2*HOUR)/1000);
  await f.run();
  assert.equal(existsSync(stale),false);assert.equal(existsSync(fresh),true);assert.equal(existsSync(unrelated),true);assert.deepEqual(f.errors,[]);
});

test('temporary export files that cannot be removed are logged and left for retry',async t=>{
  const f=fixture(t),name=`.${randomUUID()}.tmp`,path=join(f.directory,name);mkdirSync(path);writeFileSync(join(path,'content'),'data');
  utimesSync(path,(NOW-2*HOUR)/1000,(NOW-2*HOUR)/1000);
  await f.run();
  assert.equal(existsSync(path),true);assert.deepEqual(f.errors,[`Audit export temporary file ${name} could not be removed; it will be retried`]);
});

test('an expired export outside the export directory is left in place and its row removed',async t=>{
  const f=fixture(t),path=join(f.root,'outside.json');writeFileSync(path,'outside');const id=f.seed({path});
  await f.run();
  assert.equal(existsSync(path),true);assert.equal(f.row(TENANT,id),undefined);
  assert.deepEqual(f.errors,[`Audit export ${id} has a file outside the export directory; the file was left in place`]);
});

test('an export that cannot be unlinked keeps its row for retry',async t=>{
  const f=fixture(t),path=join(f.directory,'nonempty');mkdirSync(path);writeFileSync(join(path,'content'),'data');const id=f.seed({path});
  await f.run();
  assert.equal(existsSync(path),true);assert.ok(f.row(TENANT,id));assert.deepEqual(f.errors,[`Audit export ${id} could not be removed; it will be retried`]);
});

test('a missing export directory is harmless',async t=>{
  const f=fixture(t);rmSync(f.directory,{recursive:true});const id=f.seed({path:join(f.directory,'missing.json')});
  await f.run();assert.equal(f.row(TENANT,id),undefined);assert.deepEqual(f.errors,[]);
});

test('export cleanup is limited to 100 expired rows per tenant and does not add audit events',async t=>{
  const f=fixture(t);for(let i=0;i<101;i++)f.seed();const other=f.seed({tenantId:OTHER});
  await f.run();
  assert.equal(f.database.prepare('SELECT count(*) FROM audit_exports WHERE tenant_id=?').pluck().get(TENANT),1);
  assert.equal(f.row(OTHER,other),undefined);assert.equal(f.database.prepare('SELECT count(*) FROM audit_events WHERE tenant_id=?').pluck().get(TENANT),0);
  await f.run();assert.equal(f.database.prepare('SELECT count(*) FROM audit_exports WHERE tenant_id=?').pluck().get(TENANT),0);
});

test('the export timer runs with retention enforcement disabled',async t=>{
  const f=fixture(t),id=f.seed({status:'pending',created:NOW-HOUR,expires:NOW+HOUR});
  let retentionRan=false;
  t.mock.timers.enable({apis:['setTimeout']});
  const worker=startAuditWorkers({
    database:f.database,
    exportDirectory:f.directory,
    audit:{
      append(){retentionRan=true;throw new Error('unexpected audit append');},
      transact(){retentionRan=true;throw new Error('retention enforcement must stay disabled');},
    },
    blobStore:{put:async()=>{},read:async()=>null,remove:async()=>{}},
    retentionPolicy:()=>{retentionRan=true;throw new Error('retention enforcement must stay disabled');},
    retentionEnforcementEnabled:false,
    now:()=>NOW,
    logger:{error:message=>f.errors.push(message)},
  });
  try{
    t.mock.timers.tick(89_999);await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal((f.row(TENANT,id) as {status:string}).status,'pending');
    t.mock.timers.tick(1);
    for(let attempt=0;attempt<1000&&(f.row(TENANT,id) as {status:string}).status==='pending';attempt++)await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal((f.row(TENANT,id) as {status:string}).status,'failed');
    assert.equal(retentionRan,false);
    assert.deepEqual(f.errors,[]);
  }finally{await worker.stop();t.mock.timers.reset();}
});

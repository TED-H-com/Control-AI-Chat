import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { runMigrations } from '../../lib/migrations/index.js';
import type { RouteRequest } from '../../routes/types.js';
import { createHealthProbes } from './probes.js';

const AT=1_780_000_000_000;
const request={tenant:null,requestId:'r',params:{},query:{},headers:new Headers(),body:null,rawBody:null} satisfies RouteRequest;
const checks=(result:{body?:unknown}):Record<string,boolean>=>
  Object.fromEntries((result.body as {checks:{name:string;ok:boolean}[]}).checks.map(check=>[check.name,check.ok]));

test('liveness answers without consulting the database',()=>{
  const database=new Database(':memory:');runMigrations(database);
  const probes=createHealthProbes({database,startedAt:AT-90_000,now:()=>AT});
  database.close();
  // Closed on purpose. A liveness probe that queries a stalled database gets the process restarted
  // for a fault a restart cannot fix, so this must still answer.
  const result=probes.execute('health.live',request);
  assert.equal(result.status,undefined);
  assert.deepEqual(result.body,{status:'ok',uptimeSeconds:90});
});

test('readiness passes on a migrated database',()=>{
  const database=new Database(':memory:');runMigrations(database);
  const result=createHealthProbes({database,startedAt:AT}).execute('health.ready',request);
  assert.equal(result.status,undefined);
  assert.deepEqual(checks(result),{schema:true,integrity:true,chain:true});
  assert.equal((result.body as {status:string}).status,'ready');
  database.close();
});

test('an unmigrated database is not ready, and says which check failed',()=>{
  // A fresh volume mounted over a provisioned one: the file opens, queries parse, and nothing is
  // there. "Can I reach the database" reports this as healthy until the first tenant lookup.
  const database=new Database(':memory:');runMigrations(database);
  const probes=createHealthProbes({database,startedAt:AT});
  database.exec('DELETE FROM schema_version');
  const result=probes.execute('health.ready',request);
  assert.equal(result.status,503,'a load balancer reads the status code, not the body');
  assert.deepEqual(checks(result),{schema:false,integrity:true,chain:true});
  database.close();
});

test('readiness reports rather than throws when the database is gone',()=>{
  const database=new Database(':memory:');runMigrations(database);
  const probes=createHealthProbes({database,startedAt:AT});
  database.close();
  const result=probes.execute('health.ready',request);
  assert.equal(result.status,503);
  assert.deepEqual(checks(result),{schema:false,integrity:false,chain:false});
});

test('readiness retries integrity after a transient quick-check failure',()=>{
  const database=new Database(':memory:');runMigrations(database);
  const pragma=database.pragma.bind(database),probes=createHealthProbes({database,startedAt:AT});
  let unavailable=true;
  database.pragma=((source:string,options?:{simple?:boolean})=>{
    if(source==='quick_check(1)'&&unavailable){unavailable=false;throw new Error('transient busy');}
    return pragma(source,options as never);
  }) as typeof database.pragma;
  assert.deepEqual(checks(probes.execute('health.ready',request)),{schema:true,integrity:false,chain:true});
  const recovered=probes.execute('health.ready',request);
  assert.equal(recovered.status,undefined);
  assert.deepEqual(checks(recovered),{schema:true,integrity:true,chain:true});
  database.close();
});

test('readiness fails without identifying the tenant when an audit chain is broken',()=>{
  const database=new Database(':memory:');runMigrations(database);
  database.prepare("INSERT INTO audit_chain_heads(tenant_id,chain_epoch,last_sequence,last_hash,genesis_hash,status,updated_at_ms) VALUES('secret-tenant',1,0,? ,?,'broken',0)").run('a'.repeat(64),'a'.repeat(64));
  const result=createHealthProbes({database,startedAt:AT}).execute('health.ready',request);
  assert.equal(result.status,503);
  assert.equal(checks(result).chain,false);
  assert.doesNotMatch(JSON.stringify(result.body),/secret-tenant/);
  database.close();
});

test('neither probe discloses a version, a path or a row count',()=>{
  const database=new Database(':memory:');runMigrations(database);
  const probes=createHealthProbes({database,startedAt:AT});
  // Both are reachable from the internet: the catalog marks /health/ready `internal`, but
  // mountDefinitions only enforces `tenant`.
  for(const operation of ['health.live','health.ready'])
    assert.doesNotMatch(JSON.stringify(probes.execute(operation,request).body),/\d+\.\d+\.\d+|\/|sqlite|schema_version/i,`${operation} leaked an internal detail`);
  database.close();
});

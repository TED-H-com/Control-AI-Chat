import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {Hono} from 'hono';
import {services} from './integration-services.js';
import {db,forTenant} from './lib/db.js';
import {handleRequestError,type AppVariables} from './lib/http/index.js';
import {setTenantProviderCredential} from './lib/providers/tenant-registry.js';
import {routeDefinitions} from './routes/catalog.js';
import {mountDefinitions} from './routes/http.js';
import type {TenantId} from './shared/types.js';

const SECRET='synthetic-provider-secret-for-replay';
const REPLACEMENT='synthetic-provider-secret-replacement';
const GATEWAY='https://gateway.example.com/v1';
function fixture(){
 const tenantId=randomUUID() as TenantId,userId=randomUUID(),sessionId=randomUUID(),now=Date.now();
 db.prepare("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,?,?,'active',?,?)").run(tenantId,tenantId,'Credential replay',now,now);
 db.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,?,'Owner','hash','active',?,?)").run(userId,tenantId,`${userId}@example.test`,now,now);
 const seed=(provider='openai')=>setTenantProviderCredential(db,{tenantId,provider:provider as 'openai',secret:SECRET,key:Buffer.alloc(32,7),now});
 const row=(provider='openai')=>db.prepare('SELECT * FROM provider_config WHERE tenant_id=? AND provider_key=?').get(tenantId,provider);
 const events=()=>db.prepare("SELECT * FROM audit_events WHERE tenant_id=? AND action='admin.tenant_setting_changed' ORDER BY sequence").all(tenantId);
 const receipts=()=>db.prepare('SELECT * FROM idempotency_records WHERE tenant_id=? ORDER BY id').all(tenantId) as Array<{method:string;path:string;response_json:string}>;
 const snapshot=()=>({rows:db.prepare('SELECT * FROM provider_config WHERE tenant_id=? ORDER BY provider_key').all(tenantId),events:db.prepare('SELECT * FROM audit_events WHERE tenant_id=? ORDER BY sequence').all(tenantId),receipts:receipts()});
 const app=(options:{actor?:string;anonymous?:boolean;allowed?:boolean})=>{
  const mounted=new Hono<{Variables:AppVariables}>();mounted.onError(handleRequestError);
  mounted.use('*',async(c,next)=>{c.set('requestId','provider-credential-replay');if(!options.anonymous)c.set('tenant',{principal:{tenantId,userId:options.actor??userId,membershipId:userId,sessionId,roles:['owner'],permissions:new Set(options.allowed===false?[]:['admin:settings'])},db:forTenant({tenantId}),requestId:'provider-credential-replay',now:new Date()});await next()});
  mountDefinitions(mounted,services,routeDefinitions.filter(route=>route.operation==='admin.providers.clearCredential'||route.operation==='admin.providers.setCredential'));
  return mounted;
 };
 const request=(key:string|null,options:{provider?:string;query?:string;actor?:string;anonymous?:boolean;allowed?:boolean;ifMatch?:string}={})=>{
  const headers=new Headers();if(key!==null)headers.set('Idempotency-Key',key);if(options.ifMatch)headers.set('If-Match',options.ifMatch);
  return app(options).request(`/admin/providers/${options.provider??'openai'}/credential${options.query??''}`,{method:'DELETE',headers});
 };
 const put=(key:string|null,options:{provider?:string;query?:string;actor?:string;anonymous?:boolean;allowed?:boolean;ifMatch?:string;apiKey?:unknown;body?:Record<string,unknown>}={})=>{
  const headers=new Headers({'Content-Type':'application/json'});if(key!==null)headers.set('Idempotency-Key',key);if(options.ifMatch)headers.set('If-Match',options.ifMatch);
  return app(options).request(`/admin/providers/${options.provider??'openai'}/credential${options.query??''}`,{method:'PUT',headers,body:JSON.stringify(options.body??{apiKey:options.apiKey??SECRET,baseUrl:null})});
 };
 const assertReceipt=()=>{const records=receipts();assert.equal(records.length,1);assert.equal(records[0]!.method,'DELETE');assert.equal(records[0]!.path,'admin-provider-credential-delete:admin.providers.clearCredential');assert.deepEqual(JSON.parse(records[0]!.response_json),{status:204});};
 const assertPutReceipt=(suffix=SECRET.slice(-4))=>{const records=receipts();assert.equal(records.length,1);assert.equal(records[0]!.method,'PUT');assert.equal(records[0]!.path,'admin-provider-credential-put:admin.providers.setCredential');const cached=JSON.parse(records[0]!.response_json) as {status:number;body:{provider:string;source:string;maskedSuffix:string;auditEventId:string}};assert.equal(cached.status,200);assert.equal(cached.body.provider,'openai');assert.equal(cached.body.source,'byok');assert.equal(cached.body.maskedSuffix,suffix);assert.equal(typeof cached.body.auditEventId,'string');};
 return{tenantId,userId,sessionId,seed,row,events,receipts,snapshot,request,put,assertReceipt,assertPutReceipt};
}

test('credential DELETE replays its original 204 without clearing a later replacement or appending audit',async()=>{
 const f=fixture();f.seed();
 const response=await f.request('clear-once');assert.equal(response.status,204);assert.equal(await response.text(),'');
 assert.equal(f.events().length,1);
 const cleared=f.row() as {credential_ciphertext:string|null;key_version:number|null};assert.equal(cleared.credential_ciphertext,null);assert.equal(cleared.key_version,null);
 f.seed();const before=f.snapshot();assert.equal((await f.request('clear-once')).status,204);assert.deepEqual(f.snapshot(),before);f.assertReceipt();
 assert.doesNotMatch(JSON.stringify({events:f.events(),receipts:f.receipts()}),new RegExp(SECRET));
 assert.equal((await f.request('clear-next')).status,204);assert.equal(f.events().length,2);
});

test('concurrent credential DELETE retries commit one audit event and one method-pinned receipt',async()=>{
 const f=fixture();f.seed();const responses=await Promise.all([f.request('parallel'),f.request('parallel')]);
 assert.deepEqual(responses.map(response=>response.status),[204,204]);assert.equal(f.events().length,1);f.assertReceipt();
});

test('credential DELETE binds provider, query and If-Match while a conflict leaves the replacement intact',async()=>{
 const f=fixture();f.seed();f.seed('anthropic');assert.equal((await f.request('bound')).status,204);f.seed();const before=f.snapshot();
 for(const options of [{provider:'anthropic'},{query:'?scope=other'},{ifMatch:'42'}]){
  const response=await f.request('bound',options);assert.equal(response.status,409);assert.equal((await response.json() as {error:{code:string}}).error.code,'IDEMPOTENCY_CONFLICT');assert.deepEqual(f.snapshot(),before);
 }assert.equal((await f.request('bound')).status,204);assert.deepEqual(f.snapshot(),before);
});

test('credential DELETE separates tenants and actors sharing a retry key',async()=>{
 const a=fixture(),b=fixture();a.seed();b.seed();assert.equal((await a.request('shared')).status,204);assert.equal((await b.request('shared')).status,204);a.assertReceipt();b.assertReceipt();
 a.seed();const actor=randomUUID();assert.equal((await a.request('shared',{actor})).status,204);assert.equal(a.events().length,2);assert.equal(a.receipts().length,2);
 const before=a.snapshot();assert.equal((await b.request('shared',{query:`?tenantId=${a.tenantId}`})).status,409);assert.deepEqual(a.snapshot(),before);
});

test('credential DELETE persists a missing-row success so its replay cannot delete a later credential',async()=>{
 const f=fixture();assert.equal(f.row(),undefined);assert.equal((await f.request('missing')).status,204);f.assertReceipt();assert.equal(f.row(),undefined);
 f.seed();const before=f.snapshot();assert.equal((await f.request('missing')).status,204);assert.deepEqual(f.snapshot(),before);
});

for(const target of ['audit_events','idempotency_records'])test(`credential DELETE rolls back credential and audit when ${target} fails, then recovers with durable replay`,async()=>{
 const f=fixture();f.seed();const before=f.snapshot();
 db.exec(`CREATE TEMP TRIGGER reject_credential_receipt BEFORE INSERT ON ${target} BEGIN SELECT RAISE(ABORT,'synthetic credential write outage'); END`);
 try{assert.equal((await f.request('recover')).status,500);assert.deepEqual(f.snapshot(),before);}finally{db.exec('DROP TRIGGER reject_credential_receipt')}
 assert.equal((await f.request('recover')).status,204);f.assertReceipt();assert.equal(f.events().length,1);
 f.seed();const recovered=f.snapshot();assert.equal((await f.request('recover')).status,204);assert.deepEqual(f.snapshot(),recovered);
});

test('credential DELETE enforces authentication, permission and an explicit valid retry key before mutation',async()=>{
 const f=fixture();f.seed();const before=f.snapshot();
 for(const [key,options,status,code] of [[null,{anonymous:true},401,'UNAUTHENTICATED'],[null,{allowed:false},403,'FORBIDDEN'],[null,{},400,'INVALID_REQUEST'],['a'.repeat(129),{},422,'INVALID_REQUEST'],['valid',{provider:'unknown'},422,'VALIDATION_FAILED']] as const){
  const response=await f.request(key,options);assert.equal(response.status,status);assert.equal((await response.json() as {error:{code:string}}).error.code,code);assert.deepEqual(f.snapshot(),before);
 }
});

test('credential PUT replays its original 200 without replacing a later key or gateway or appending audit',async()=>{
 const f=fixture();
 const created=await f.put('set-once');assert.equal(created.status,200);
 const original=await created.json() as {provider:string;source:string;maskedSuffix:string;auditEventId:string};
 assert.deepEqual({provider:original.provider,source:original.source,maskedSuffix:original.maskedSuffix},{provider:'openai',source:'byok',maskedSuffix:SECRET.slice(-4)});
 assert.equal(f.events().length,1);f.assertPutReceipt();
 const first=f.row() as {credential_ciphertext:string;base_url:string|null};
 const replaced=await f.put('set-next',{body:{apiKey:REPLACEMENT,baseUrl:GATEWAY}});assert.equal(replaced.status,200);
 const before=f.snapshot();const later=f.row() as {credential_ciphertext:string;base_url:string|null};
 assert.notEqual(later.credential_ciphertext,first.credential_ciphertext);assert.equal(later.base_url,GATEWAY);
 const replay=await f.put('set-once');assert.equal(replay.status,200);assert.deepEqual(await replay.json(),original);assert.deepEqual(f.snapshot(),before);
 assert.doesNotMatch(JSON.stringify({events:f.events(),receipts:f.receipts()}),new RegExp(SECRET));
 assert.doesNotMatch(JSON.stringify({events:f.events(),receipts:f.receipts()}),new RegExp(REPLACEMENT));
});

test('concurrent credential PUT retries commit one audit event and one method-pinned receipt',async()=>{
 const f=fixture();const responses=await Promise.all([f.put('parallel'),f.put('parallel')]);
 assert.deepEqual(responses.map(response=>response.status),[200,200]);
 const bodies=await Promise.all(responses.map(response=>response.json()));assert.deepEqual(bodies[1],bodies[0]);
 assert.equal(f.events().length,1);f.assertPutReceipt();
});

test('credential PUT binds provider, query, If-Match, body and gateway while a conflict leaves the replacement intact',async()=>{
 const f=fixture();assert.equal((await f.put('bound')).status,200);
 assert.equal((await f.put('other',{body:{apiKey:REPLACEMENT,baseUrl:GATEWAY}})).status,200);const before=f.snapshot();
 for(const options of [{provider:'anthropic'},{query:'?scope=other'},{ifMatch:'42'},{apiKey:REPLACEMENT},{body:{apiKey:SECRET,baseUrl:GATEWAY}}] as const){
  const response=await f.put('bound',options);assert.equal(response.status,409);assert.equal((await response.json() as {error:{code:string}}).error.code,'IDEMPOTENCY_CONFLICT');assert.deepEqual(f.snapshot(),before);
 }assert.equal((await f.put('bound')).status,200);assert.deepEqual(f.snapshot(),before);
});

test('credential PUT separates tenants and actors sharing a retry key',async()=>{
 const a=fixture(),b=fixture();assert.equal((await a.put('shared')).status,200);assert.equal((await b.put('shared')).status,200);a.assertPutReceipt();b.assertPutReceipt();
 const actor=randomUUID();assert.equal((await a.put('shared',{actor,apiKey:REPLACEMENT})).status,200);assert.equal(a.events().length,2);assert.equal(a.receipts().length,2);
 const before=a.snapshot();assert.equal((await b.put('shared',{query:`?tenantId=${a.tenantId}`})).status,409);assert.deepEqual(a.snapshot(),before);
});

test('credential PUT persists its original success so its replay cannot restore a later removal',async()=>{
 const f=fixture();const created=await f.put('set-once');assert.equal(created.status,200);const original=await created.json();
 assert.equal((await f.request('clear-once')).status,204);const before=f.snapshot();
 const replay=await f.put('set-once');assert.equal(replay.status,200);assert.deepEqual(await replay.json(),original);assert.deepEqual(f.snapshot(),before);
 assert.equal((f.row() as {credential_ciphertext:string|null;enabled:number}).credential_ciphertext,null);
});

for(const target of ['audit_events','idempotency_records'])test(`credential PUT rolls back credential and audit when ${target} fails, then recovers with durable replay`,async()=>{
 const f=fixture();const before=f.snapshot();
 db.exec(`CREATE TEMP TRIGGER reject_credential_put BEFORE INSERT ON ${target} BEGIN SELECT RAISE(ABORT,'synthetic credential write outage'); END`);
 try{assert.equal((await f.put('recover')).status,500);assert.deepEqual(f.snapshot(),before);}finally{db.exec('DROP TRIGGER reject_credential_put')}
 assert.equal((await f.put('recover')).status,200);f.assertPutReceipt();assert.equal(f.events().length,1);
 assert.equal((await f.put('later',{body:{apiKey:REPLACEMENT,baseUrl:GATEWAY}})).status,200);const recovered=f.snapshot();
 assert.equal((await f.put('recover')).status,200);assert.deepEqual(f.snapshot(),recovered);
});

test('credential PUT enforces authentication, permission and an explicit valid retry key before mutation',async()=>{
 const f=fixture();const before=f.snapshot();
 for(const [key,options,status,code] of [[null,{anonymous:true},401,'UNAUTHENTICATED'],[null,{allowed:false},403,'FORBIDDEN'],[null,{},400,'INVALID_REQUEST'],['a'.repeat(129),{},422,'INVALID_REQUEST'],['valid',{provider:'unknown'},422,'VALIDATION_FAILED'],['valid',{body:{}},422,'VALIDATION_FAILED'],['valid',{body:{apiKey:SECRET,baseUrl:'http://insecure.example'}},422,'VALIDATION_FAILED']] as const){
  const response=await f.put(key,options);assert.equal(response.status,status);assert.equal((await response.json() as {error:{code:string}}).error.code,code);assert.deepEqual(f.snapshot(),before);
 }
});

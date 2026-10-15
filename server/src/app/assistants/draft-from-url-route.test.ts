import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {Hono} from 'hono';
import {db,forTenant} from '../../lib/db.js';
import {handleRequestError,type AppVariables} from '../../lib/http/index.js';
import {routeDefinitions} from '../../routes/catalog.js';
import {mountDefinitions} from '../../routes/http.js';
import type {TenantId} from '../../shared/types.js';
import {audit} from '../../integration-services.js';
import {DraftError} from './draft-from-url.js';
import {createAssistantDraftAdapter} from './draft-from-url-route.js';

const MODEL='11111111-1111-4111-8111-111111111111';
const SOURCE='https://example.test/public';
function fixture(){
 const tenantId=randomUUID() as TenantId,userId=randomUUID(),sessionId=randomUUID(),now=Date.now();
 db.prepare("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,?,?,'active',?,?)").run(tenantId,tenantId,'Draft replay',now,now);
 db.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,?,'Owner','hash','active',?,?)").run(userId,tenantId,`${userId}@example.test`,now,now);
 let calls=0;
 const adapter=createAssistantDraftAdapter({database:db,audit,hmacKey:Buffer.alloc(32,5),draftFromUrl:async()=>{calls+=1;return{name:'Helper',description:'Useful',systemPrompt:'Be helpful'}}});
 const receipts=()=>db.prepare('SELECT * FROM idempotency_records WHERE tenant_id=? ORDER BY id').all(tenantId) as Array<{method:string;path:string;status:string;response_json:string|null}>;
 const snapshot=()=>({receipts:receipts(),calls});
 const app=(options:{actor?:string;anonymous?:boolean;allowed?:boolean})=>{
  const mounted=new Hono<{Variables:AppVariables}>();mounted.onError(handleRequestError);
  mounted.use('*',async(c,next)=>{c.set('requestId','assistant-draft-replay');if(!options.anonymous)c.set('tenant',{principal:{tenantId,userId:options.actor??userId,membershipId:userId,sessionId,roles:['owner'],permissions:new Set(options.allowed===false?[]:['assistant:write'])},db:forTenant({tenantId}),requestId:'assistant-draft-replay',now:new Date()});await next()});
  mountDefinitions(mounted,{execute:(operation,request)=>adapter.execute(operation,request)},routeDefinitions.filter(route=>route.operation==='assistants.draftFromUrl'));
  return mounted;
 };
 const request=(key:string|null,options:{query?:string;actor?:string;anonymous?:boolean;allowed?:boolean;ifMatch?:string;body?:Record<string,unknown>}={})=>{
  const headers=new Headers({'Content-Type':'application/json'});if(key!==null)headers.set('Idempotency-Key',key);if(options.ifMatch)headers.set('If-Match',options.ifMatch);
  return app(options).request(`/assistants/draft-from-url${options.query??''}`,{method:'POST',headers,body:JSON.stringify(options.body??{url:SOURCE,modelCatalogId:MODEL})});
 };
 const assertReceipt=()=>{const records=receipts();assert.equal(records.length,1);assert.equal(records[0]!.method,'POST');assert.equal(records[0]!.path,'assistant-draft-from-url:assistants.draftFromUrl');assert.equal(records[0]!.status,'completed');assert.deepEqual(JSON.parse(records[0]!.response_json??'null'),{status:200,body:{name:'Helper',description:'Useful',systemPrompt:'Be helpful'}});};
 return{tenantId,userId,calls:()=>calls,receipts,snapshot,request,assertReceipt};
}

test('assistant draft POST replays its original 200 without a second model dispatch',async()=>{
 const f=fixture();
 const created=await f.request('draft-once');assert.equal(created.status,200);
 const original=await created.json();assert.deepEqual(original,{name:'Helper',description:'Useful',systemPrompt:'Be helpful'});
 assert.equal(f.calls(),1);f.assertReceipt();
 const replay=await f.request('draft-once');assert.equal(replay.status,200);assert.deepEqual(await replay.json(),original);assert.equal(f.calls(),1);
 assert.equal((await f.request('draft-next')).status,200);assert.equal(f.calls(),2);
});

test('concurrent assistant draft retries dispatch the model once',async()=>{
 const f=fixture();const responses=await Promise.all([f.request('parallel'),f.request('parallel')]);
 assert.deepEqual(responses.map(response=>response.status),[200,200]);
 const bodies=await Promise.all(responses.map(response=>response.json()));assert.deepEqual(bodies[1],bodies[0]);
 assert.equal(f.calls(),1);f.assertReceipt();
});

test('assistant draft POST binds URL, model, query and If-Match',async()=>{
 const f=fixture();assert.equal((await f.request('bound')).status,200);const before=f.snapshot();
 for(const options of [{body:{url:'https://example.test/other',modelCatalogId:MODEL}},{body:{url:SOURCE,modelCatalogId:'22222222-2222-4222-8222-222222222222'}},{query:'?scope=other'},{ifMatch:'42'}] as const){
  const response=await f.request('bound',options);assert.equal(response.status,409);assert.equal((await response.json() as {error:{code:string}}).error.code,'IDEMPOTENCY_CONFLICT');assert.deepEqual(f.snapshot(),before);
 }assert.equal((await f.request('bound')).status,200);assert.deepEqual(f.snapshot(),before);
});

test('assistant draft POST separates tenants and actors sharing a retry key',async()=>{
 const a=fixture(),b=fixture();assert.equal((await a.request('shared')).status,200);assert.equal((await b.request('shared')).status,200);a.assertReceipt();b.assertReceipt();
 const actor=randomUUID();assert.equal((await a.request('shared',{actor})).status,200);assert.equal(a.receipts().length,2);assert.equal(a.calls(),2);
 const before=a.snapshot();assert.equal((await b.request('shared',{query:`?tenantId=${a.tenantId}`})).status,409);assert.deepEqual(a.snapshot(),before);
});

test('a failed assistant draft drops its claim so the same key can recover',async()=>{
 const tenantId=randomUUID() as TenantId,userId=randomUUID(),sessionId=randomUUID(),now=Date.now();
 db.prepare("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,?,?,'active',?,?)").run(tenantId,tenantId,'Draft recover',now,now);
 db.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,?,'Owner','hash','active',?,?)").run(userId,tenantId,`${userId}@example.test`,now,now);
 let calls=0,fail=true;
 const adapter=createAssistantDraftAdapter({database:db,audit,hmacKey:Buffer.alloc(32,5),draftFromUrl:async()=>{calls+=1;if(fail)throw new DraftError('EMPTY_SOURCE');return{name:'Helper',description:'Useful',systemPrompt:'Be helpful'}}});
 const app=new Hono<{Variables:AppVariables}>();app.onError(handleRequestError);
 app.use('*',async(c,next)=>{c.set('requestId','assistant-draft-replay');c.set('tenant',{principal:{tenantId,userId,membershipId:userId,sessionId,roles:['owner'],permissions:new Set(['assistant:write'])},db:forTenant({tenantId}),requestId:'assistant-draft-replay',now:new Date()});await next()});
 mountDefinitions(app,{execute:(operation,request)=>adapter.execute(operation,request)},routeDefinitions.filter(route=>route.operation==='assistants.draftFromUrl'));
 const send=()=>app.request('/assistants/draft-from-url',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'recover'},body:JSON.stringify({url:SOURCE,modelCatalogId:MODEL})});
 assert.equal((await send()).status,422);assert.equal(calls,1);
 assert.equal(db.prepare('SELECT COUNT(*) FROM idempotency_records WHERE tenant_id=?').pluck().get(tenantId),0);
 fail=false;assert.equal((await send()).status,200);assert.equal(calls,2);
 assert.equal((await send()).status,200);assert.equal(calls,2);
});

test('assistant draft POST enforces authentication, permission and an explicit valid retry key before dispatch',async()=>{
 const f=fixture();const before=f.snapshot();
 for(const [key,options,status,code] of [[null,{anonymous:true},401,'UNAUTHENTICATED'],[null,{allowed:false},403,'FORBIDDEN'],[null,{},400,'INVALID_REQUEST'],['a'.repeat(129),{},422,'INVALID_REQUEST'],['valid',{body:{url:'',modelCatalogId:MODEL}},422,'VALIDATION_FAILED']] as const){
  const response=await f.request(key,options);assert.equal(response.status,status);assert.equal((await response.json() as {error:{code:string}}).error.code,code);assert.deepEqual(f.snapshot(),before);
 }
});

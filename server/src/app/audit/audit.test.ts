import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { runMigrations } from '../../lib/migrations/index.js';
import { forTenant, type TenantDb } from '../../lib/db.js';
import { AuditSearch, AuditStore, verifyAuditChain } from '../../lib/audit/index.js';
import type { RouteRequest } from '../../routes/types.js';
import { APPROVAL_STATUSES, type ApprovalReleaseStatus, type ApprovalStatus } from '../../shared/api.js';
import type { TenantId } from '../../shared/types.js';
import { createAuditRouteAdapter, type AuditAdapterDependencies, type AuditRouteAdapter } from './adapters.js';
import { evaluateAlerts, forEachMaintenanceTenant, runReservationMaintenance, startAuditWorkers } from './workers.js';

const tenantId='00000000-0000-4000-8000-000000000001' as TenantId;
// The reader hashes an address with this to filter on it, so it has to be the key the store wrote with.
const ipKey=Buffer.alloc(32,7);
function fixture():Database.Database {const db=new Database(':memory:');db.pragma('foreign_keys=ON');runMigrations(db);const now=1_700_000_000_000;db.prepare("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,?,'Test','active',?,?)").run(tenantId,'test',now,now);db.prepare('INSERT INTO tenant_settings(tenant_id,updated_at) VALUES(?,?)').run(tenantId,now);return db;}
// The real binding guard, not a stand-in: it refuses a statement that does not bind the tenant id
// first, which is the only thing standing between a new filter and another tenant's audit log.
function scoped(_db:Database.Database):TenantDb{return forTenant({tenantId});}
function adapter(db:Database.Database,approvalReleaseAvailable=true,approvalReleaseQueue:{wake():void}={wake(){}},exportDirectory='/tmp/gateway-audit-test',extra:Pick<AuditAdapterDependencies,'logger'>={}):AuditRouteAdapter{return createAuditRouteAdapter({database:db,cursorKey:Buffer.alloc(32),ipHmacKey:ipKey,idempotencyHmacKey:Buffer.alloc(32,11),exportDirectory,audit:store(db),approvalReleaseAvailable,now:()=>AT,...(approvalReleaseAvailable?{approvalReleaseQueue}:{}),...extra});}
function request(db:Database.Database,body:unknown,query:Readonly<Record<string,string>>={}):RouteRequest{return {tenant:{principal:{tenantId,userId:ID.actor,membershipId:'m',sessionId:'s',roles:['admin'],permissions:new Set()},db:scoped(db),requestId:'req',now:new Date()},requestId:'req',params:{id:'missing'},query,headers:new Headers({'If-Match':'"1"','Idempotency-Key':randomUUID()}),body,rawBody:null};}

function reviewerRequest(db:Database.Database,body:unknown,roles:readonly ('owner'|'admin'|'compliance'|'member')[],sessionId:string):RouteRequest{
  const base=request(db,body);
  return {...base,tenant:{...base.tenant!,principal:{...base.tenant!.principal,roles:[...roles],sessionId}}};
}

function seedSession(db:Database.Database,input:{id:string;authMethod:'mfa'|'password';createdAt?:number;mfaVerifiedAt?:number|null;totp?:boolean}):void{
  if(input.totp)db.prepare('UPDATE users SET totp_secret_ciphertext=?,totp_enabled_at=? WHERE tenant_id=? AND id=?').run('encrypted',AT-60_000,tenantId,ID.actor);
  db.prepare(`INSERT INTO sessions(id,tenant_id,user_id,token_hash,jwt_id,auth_method,created_at,last_seen_at,expires_at,mfa_verified_at_ms)
    VALUES(?,?,?,? ,?,?, ?,?,?,?)`).run(input.id,tenantId,ID.actor,input.id.replaceAll('-','').padEnd(64,'0').slice(0,64),'10101010-1010-4010-8010-'+input.id.slice(-12),input.authMethod,input.createdAt??AT-1_000,AT-1_000,AT+60_000,input.mfaVerifiedAt??null);
}

test('approval decisions require a written reason before repository access',async()=>{const db=fixture(),routes=adapter(db);const result=await routes.execute('gate.approvalDecision',request(db,{decision:'deny',reason:''}));assert.equal(result.status,422);assert.match(JSON.stringify(result.body),/written reason/);db.close();});

test('alert evaluation deduplicates a violation spike',()=>{const db=fixture(),now=1_700_000_000_000;db.exec('PRAGMA foreign_keys=OFF');for(let i=0;i<10;i++)db.prepare("INSERT INTO policy_violations(id,tenant_id,audit_event_id,direction,detector,gate_action,severity,status,rule_ids_json,redacted_excerpt,content_digest,created_at_ms,updated_at_ms) VALUES(?,?,?,'input','pii','block','high','open','[]','[redacted]','digest',?,?)").run(`v-${i}`,tenantId,`e-${i}`,now,now);assert.equal(evaluateAlerts(db,tenantId,now),1);assert.equal(evaluateAlerts(db,tenantId,now),0);assert.equal((db.prepare('SELECT count(*) count FROM alerts WHERE tenant_id=?').get(tenantId) as {count:number}).count,1);db.close();});

test('worker shutdown is idempotent before initial stagger fires',async()=>{const db=fixture();const workers=startAuditWorkers({database:db,audit:store(db),blobStore:{put:async()=>{},read:async()=>null,remove:async()=>{}},retentionPolicy:id=>({tenantId:id,chatTranscriptDays:90,violationTranscriptDays:365,approvalPayloadDays:30,auditMetadataDays:null,captureTranscripts:false,effectiveAtMs:AT})});assert.equal(workers.running,true);await workers.stop();await workers.stop();assert.equal(workers.running,false);db.close();});

test('maintenance tenant pagination visits rows beyond the first batch',async()=>{
  const db=fixture(),insert=db.prepare("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,?,?,'active',?,?)");
  for(let i=0;i<25;i++)insert.run(`10000000-0000-4000-8000-${String(i).padStart(12,'0')}`,`page-${i}`,`Page ${i}`,AT,AT);
  const visited:TenantId[]=[];
  await forEachMaintenanceTenant(db,25,id=>{visited.push(id);});
  assert.equal(visited.length,26);
  assert.equal(new Set(visited).size,26);
  assert.deepEqual(visited,[...visited].sort());
  db.close();
});

/**
 * A tenant with one governed entity of every kind the audit screen has a column for, and two events:
 * a blocked chat turn that touches all of them, and an unrelated completion that touches none. Every
 * filter below therefore has exactly one matching row and one that must be excluded.
 */
const ID={actor:'11111111-1111-4111-8111-111111111111',subject:'22222222-2222-4222-8222-222222222222',group:'33333333-3333-4333-8333-333333333333',project:'44444444-4444-4444-8444-444444444444',model:'55555555-5555-4555-8555-555555555555',provider:'66666666-6666-4666-8666-666666666666',conversation:'77777777-7777-4777-8777-777777777777'} as const;
const BLOCKED_AT=Date.UTC(2026,0,15,12,0,0),COMPLETED_AT=Date.UTC(2026,0,16,9,30,0);
const AT=1_700_000_000_000;
/** Every governed entity the three governance screens have a column for, under a name a person reads. */
function seed(db:Database.Database):void{
  const at=AT;
  const user=db.prepare("INSERT INTO users(tenant_id,id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,?,?,'hash','active',?,?)");
  user.run(tenantId,ID.actor,'ada@example.test','Ada Lovelace',at,at);
  user.run(tenantId,ID.subject,'grace@example.test','Grace Hopper',at,at);
  db.prepare("INSERT INTO groups(tenant_id,id,name,created_at,updated_at) VALUES(?,?,'Research',?,?)").run(tenantId,ID.group,at,at);
  db.prepare("INSERT INTO projects(tenant_id,id,owner_user_id,name,created_at,updated_at) VALUES(?,?,?,'Apollo',?,?)").run(tenantId,ID.project,ID.actor,at,at);
  db.prepare("INSERT INTO model_catalog(tenant_id,id,provider_key,model_key,display_name,context_window,max_output_tokens,input_microusd_per_million,output_microusd_per_million,created_at,updated_at) VALUES(?,?,'openai','gpt-5','GPT-5 Turbo',128000,4096,1,2,?,?)").run(tenantId,ID.model,at,at);
  db.prepare("INSERT INTO provider_config(tenant_id,id,provider_key,enabled,credential_source,created_at,updated_at) VALUES(?,?,'openai',1,'environment',?,?)").run(tenantId,ID.provider,at,at);
  db.prepare("INSERT INTO conversations(tenant_id,id,owner_user_id,title,created_at,updated_at) VALUES(?,?,?,'Quarterly review',?,?)").run(tenantId,ID.conversation,ID.actor,at,at);
}
function store(db:Database.Database):AuditStore{
  return new AuditStore({database:db,ipHmacKey:ipKey,transcriptKey:()=>Buffer.alloc(32,2),retentionPolicy:id=>({tenantId:id,chatTranscriptDays:90,violationTranscriptDays:365,approvalPayloadDays:30,auditMetadataDays:null,captureTranscripts:false,effectiveAtMs:AT}),now:()=>AT});
}
function stored(db:Database.Database,action:string):Array<{action:string;outcome:string;actor_id:string|null;actor_session_id:string|null;request_id:string;metadata_json:string}>{
  return db.prepare('SELECT action,outcome,actor_id,actor_session_id,request_id,metadata_json FROM audit_events WHERE tenant_id=? AND action=? ORDER BY sequence').all(tenantId,action) as Array<{action:string;outcome:string;actor_id:string|null;actor_session_id:string|null;request_id:string;metadata_json:string}>;
}
function governed():{db:Database.Database;routes:AuditRouteAdapter}{
  const db=fixture();
  seed(db);
  const store_=store(db);
  store_.append({tenantId,action:'gate.content_blocked',actor:{type:'user',id:ID.actor,sessionId:null,ip:'203.0.113.7',userAgent:null,authMethod:'password'},
    target:{type:'conversation',id:ID.conversation},outcome:'denied',context:{requestId:'req-blocked',traceId:null,source:'http',occurredAtMs:BLOCKED_AT},
    subjectUserId:ID.subject,groupId:ID.group,projectId:ID.project,conversationId:ID.conversation,modelId:ID.model,providerId:'openai',
    gateAction:'block',detector:'pii-direct',metadata:{summary:'Blocked a customer email address'}});
  store_.append({tenantId,action:'chat.message_completed',actor:{type:'user',id:ID.subject,sessionId:null,ip:'198.51.100.20',userAgent:null,authMethod:'password'},
    target:{type:'message',id:null},outcome:'success',context:{requestId:'req-completed',traceId:null,source:'http',occurredAtMs:COMPLETED_AT},
    metadata:{summary:'An unrelated completion'}});
  return {db,routes:adapter(db)};
}
async function items(routes:AuditRouteAdapter,db:Database.Database,query:Readonly<Record<string,string>>):Promise<Array<Record<string,unknown>>>{
  const result=await routes.execute('audit.events',request(db,null,query));
  assert.equal(result.status,undefined,`audit.events refused ${JSON.stringify(query)}: ${JSON.stringify(result.body)}`);
  return (result.body as {items:Array<Record<string,unknown>>}).items;
}

test('audit search records the applied filters, returned count, timing, and caller identity',async()=>{
  const {db,routes}=governed();
  const result=await items(routes,db,{category:'gate'});
  const [row]=stored(db,'admin.audit_searched');
  assert.ok(row,'admin.audit_searched was not stored');
  assert.deepEqual(JSON.parse(row.metadata_json),{filterNames:['category'],resultCount:result.length,elapsedMs:0});
  assert.deepEqual({actor:row.actor_id,session:row.actor_session_id,request:row.request_id},{actor:ID.actor,session:'s',request:'req'});
  db.close();
});
async function completedExport(routes:AuditRouteAdapter,db:Database.Database,body:unknown):Promise<{id:string;view:Record<string,unknown>}>{
  const created=await routes.execute('audit.createExport',request(db,body));assert.equal(created.status,202);
  const id=(created.body as {id:string}).id;
  for(let attempt=0;attempt<100;attempt++){
    const result=await routes.execute('audit.export',{...request(db,null),params:{id}}),view=result.body as Record<string,unknown>;
    if(view.status==='completed')return {id,view};
    if(view.status==='failed')assert.fail(`export failed: ${JSON.stringify(view)}`);
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  assert.fail('export did not complete');
}

test('audit exports select canonical fields, preserve filter parity, and hide internals',async()=>{
  const {db,routes}=governed();
  const csv=await completedExport(routes,db,{format:'csv',fields:['action','id'],filters:{category:'gate'}});
  assert.equal(csv.view.rowCount,(await items(routes,db,{category:'gate'})).length);
  assert.deepEqual(csv.view.fields,['id','action']);
  for(const action of ['admin.audit_export_requested','admin.audit_export_completed']){const [row]=stored(db,action);assert.ok(row,`${action} was not stored`);assert.deepEqual({actor:row.actor_id,session:row.actor_session_id,request:row.request_id},{actor:ID.actor,session:'s',request:'req'});}
  assert.deepEqual(JSON.parse(stored(db,'admin.audit_export_requested')[0]!.metadata_json),{exportId:csv.id,format:'csv',filterNames:['category'],includeContent:false});
  const completedMetadata=JSON.parse(stored(db,'admin.audit_export_completed')[0]!.metadata_json) as Record<string,unknown>;
  assert.deepEqual({exportId:completedMetadata.exportId,rowCount:completedMetadata.rowCount,sha256:completedMetadata.sha256},{exportId:csv.id,rowCount:1,sha256:csv.view.sha256});
  assert.ok(Number(completedMetadata.byteCount)>0);
  for(const forbidden of ['storage_path','tenant_id','include_content','requested_by_user_id'])assert.equal(forbidden in csv.view,false);
  const download=await routes.execute('audit.download',{...request(db,null),params:{id:csv.id}});
  const text=Buffer.from(download.body as Uint8Array).toString();assert.equal(text.split('\r\n')[0],'id,action');assert.equal(text.trim().split('\r\n').length-1,1);
  for(const format of ['json','ndjson'] as const){
    const made=await completedExport(routes,db,{format,fields:['severity','category'],filters:{category:'gate'}});
    const result=await routes.execute('audit.download',{...request(db,null),params:{id:made.id}}),raw=Buffer.from(result.body as Uint8Array).toString();
    const event=format==='json'?(JSON.parse(raw) as {events:Array<Record<string,unknown>>}).events[0]:JSON.parse(raw.split('\n')[0]!);
    assert.deepEqual(Object.keys(event!),['category','severity']);
  }
  const full=await completedExport(routes,db,{format:'json',filters:{}}),fullDownload=await routes.execute('audit.download',{...request(db,null),params:{id:full.id}}),serialized=Buffer.from(fullDownload.body as Uint8Array).toString();
  assert.doesNotMatch(serialized,/actor_ip_hmac|actor_user_agent/);
  const invalid=await routes.execute('audit.createExport',request(db,{format:'csv',fields:['storage_path'],filters:{}}));assert.equal(invalid.status,422);
  const tenantB='00000000-0000-4000-8000-000000000002' as TenantId;db.prepare("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,?,'Other','active',?,?)").run(tenantB,'export-other',AT,AT);db.prepare('INSERT INTO tenant_settings(tenant_id,updated_at) VALUES(?,?)').run(tenantB,AT);
  const base=request(db,null),foreign={...base,params:{id:csv.id},tenant:{...base.tenant!,principal:{...base.tenant!.principal,tenantId:tenantB},db:forTenant({tenantId:tenantB})}};
  assert.equal((await routes.execute('audit.export',foreign)).status,404);assert.equal((await routes.execute('audit.download',foreign)).status,404);db.close();
});

test('a failed audit export records matching failed export and audit outcomes',async()=>{
  const db=fixture();seed(db);const logged:unknown[][]=[],routes=adapter(db,true,{wake(){}},'/proc',{logger:{error(...args:unknown[]){logged.push(args);}}});
  const created=await routes.execute('audit.createExport',request(db,{format:'json',filters:{}}));
  assert.equal(created.status,202);
  const id=(created.body as {id:string}).id;
  let status:string|undefined;
  for(let attempt=0;attempt<100;attempt++){
    status=(db.prepare('SELECT status FROM audit_exports WHERE tenant_id=? AND id=?').pluck().get(tenantId,id) as string|undefined);
    if(status==='failed')break;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  assert.equal(status,'failed','the export record did not reach failed status');
  assert.equal(db.prepare('SELECT error_code FROM audit_exports WHERE tenant_id=? AND id=?').pluck().get(tenantId,id),'EXPORT_FAILED');
  assert.equal(logged.length,1,'the underlying file-system failure must be logged server-side');
  const view=(await routes.execute('audit.export',{...request(db,null),params:{id}})).body as {errorCode:string};
  assert.equal(view.errorCode,'EXPORT_FAILED');
  const [completed]=stored(db,'admin.audit_export_completed');
  assert.ok(completed,'admin.audit_export_completed was not stored for the failed export');
  assert.equal(completed.outcome,'failure');
  const [requested]=stored(db,'admin.audit_export_requested');
  assert.ok(requested,'admin.audit_export_requested was not stored for the failed export');
  assert.equal(requested.request_id,completed.request_id);
  db.prepare('UPDATE audit_exports SET error_code=? WHERE tenant_id=? AND id=?').run('/srv/private/exports leaked from a stored exception',tenantId,id);
  const sanitized=(await routes.execute('audit.export',{...request(db,null),params:{id}})).body as {errorCode:string};
  assert.equal(sanitized.errorCode,'EXPORT_FAILED','stored free text must never leave through the API');
  db.close();
});

test('the audit export row cap stores only EXPORT_TOO_LARGE',async()=>{
  const db=fixture();seed(db);store(db).append({tenantId,action:'system.retention_purged',actor:{type:'service',id:'retention',sessionId:null,ip:null,userAgent:null,authMethod:'system'},target:{type:'tenant',id:tenantId},outcome:'success',context:{requestId:'row-cap',traceId:null,source:'worker',occurredAtMs:AT},metadata:{}});
  const original=AuditSearch.prototype.search,logged:unknown[][]=[];
  AuditSearch.prototype.search=function(...args){const page=original.apply(this,args);return{...page,rows:Array.from({length:100_001},()=>page.rows[0]!)};};
  try{
    const routes=adapter(db,true,{wake(){}},'/tmp/gateway-audit-row-cap',{logger:{error(...args:unknown[]){logged.push(args);}}});
    const created=await routes.execute('audit.createExport',request(db,{format:'json',filters:{}})),id=(created.body as {id:string}).id;
    assert.equal(db.prepare('SELECT error_code FROM audit_exports WHERE tenant_id=? AND id=?').pluck().get(tenantId,id),'EXPORT_TOO_LARGE');
    const view=(await routes.execute('audit.export',{...request(db,null),params:{id}})).body as {errorCode:string};
    assert.equal(view.errorCode,'EXPORT_TOO_LARGE');assert.equal(logged.length,1);
  }finally{AuditSearch.prototype.search=original;db.close();}
});

/**
 * The screen renders exactly the columns named in web/src/admin/catalog.ts. The adapter spread the
 * raw SQLite row, so twelve of the fourteen keys did not exist on the response at all and the table
 * drew a column of em dashes over a log that had the answers.
 */
test('the audit row carries the columns the screen renders, resolved to names a person can read',async()=>{
  const {db,routes}=governed();
  const all=await items(routes,db,{});
  assert.equal(all.length,3);
  const row=all.find(item=>item.requestId==='req-blocked');
  assert.ok(row,`no row carries a requestId; the response keys are ${Object.keys(all[0]??{}).join(', ')}`);
  for(const column of ['occurredAt','category','action','actor','subject','user','group','model','provider','project','verdict','detector','requestId','chainStatus'])
    assert.notEqual(row[column]??null,null,`the audit table renders a "${column}" column, and the row has no such field`);
  assert.equal(row.occurredAt,new Date(BLOCKED_AT).toISOString());
  assert.deepEqual({actor:row.actor,user:row.user,group:row.group,model:row.model,provider:row.provider,project:row.project,subject:row.subject},
    {actor:'Ada Lovelace',user:'Grace Hopper',group:'Research',model:'GPT-5 Turbo',provider:'openai',project:'Apollo',subject:'Quarterly review'});
  for(const [column,value] of Object.entries({actor:row.actor,user:row.user,group:row.group,model:row.model,project:row.project,subject:row.subject}))
    assert.doesNotMatch(String(value),/^[0-9a-f]{8}-[0-9a-f]{4}-/,`${column} is a bare id, which names nothing to a reviewer`);
  // The ids stay next to the labels, because the drawer and any drill-through still address by id.
  assert.deepEqual({actorId:row.actorId,userId:row.userId,groupId:row.groupId,modelId:row.modelId,projectId:row.projectId},
    {actorId:ID.actor,userId:ID.subject,groupId:ID.group,modelId:ID.model,projectId:ID.project});
  assert.equal(row.verdict,'block');
  assert.equal(row.detector,'pii-direct');
  assert.equal(row.chainStatus,'verified');
  for(const internal of ['tenant_id','prev_hash','event_hash','occurred_at_ms','actor_ip_hmac','metadata_text','metadata_json'])
    assert.equal(internal in row,false,`${internal} is not a column of this screen and must not be a field of its rows`);
  // chainStatus is a verdict recomputed from the row, not a label: editing a stored event breaks it.
  db.prepare('UPDATE audit_events SET metadata_json=? WHERE tenant_id=? AND request_id=?').run('{"summary":"tampered"}',tenantId,'req-blocked');
  assert.equal((await items(routes,db,{requestId:'req-blocked'}))[0]?.chainStatus,'broken',
    'a row that no longer hashes to its stored event_hash must not report itself verified');
  db.close();
});

test('audit event detail returns only tenant-scoped cleansed message parts and resolved policy tallies',async()=>{
  const db=fixture();seed(db);const audit=store(db),policy=randomUUID(),detector=randomUUID(),rule=randomUUID();
  db.prepare("INSERT INTO detector_definitions(id,tenant_id,key,kind,config_json,config_sha256,created_at,updated_at) VALUES(?,?,?,'keyword','{}',?, ?,?)").run(detector,tenantId,'customer-secret','a'.repeat(64),AT,AT);
  db.prepare("INSERT INTO policies(id,tenant_id,name,created_at,updated_at) VALUES(?,?,'Customer secrets',?,?)").run(policy,tenantId,AT,AT);
  db.prepare("INSERT INTO policy_rules(id,tenant_id,policy_id,detector_id,scope_type,direction,action,created_at,updated_at) VALUES(?,?,?,?,'tenant','outbound','redact',?,?)").run(rule,tenantId,policy,detector,AT,AT);
  const add=(action:'redact'|'mask',text:string,original:string)=>{
    const message=randomUUID();
    db.prepare("INSERT INTO messages(id,tenant_id,conversation_id,author_user_id,role,status,sequence_no,created_at) VALUES(?,?,?,?, 'user','complete',?,?)").run(message,tenantId,ID.conversation,ID.actor,action==='redact'?0:1,AT);
    db.prepare("INSERT INTO message_parts(id,tenant_id,message_id,ordinal,kind,text_content,metadata_json,created_at) VALUES(?,?,?,0,?,?, '{}',?)").run(randomUUID(),tenantId,message,action==='redact'?'redacted_text':'text',text,AT);
    audit.append({tenantId,action:action==='redact'?'gate.content_redacted':'gate.content_masked',actor:{type:'user',id:ID.actor,sessionId:null,ip:null,userAgent:null,authMethod:'password'},target:{type:'message',id:message},outcome:'success',context:{requestId:`req-${action}`,traceId:null,source:'http',occurredAtMs:AT},conversationId:ID.conversation,messageId:message,gateAction:action,detector:'customer-secret',metadata:{ruleIds:[rule],matchCount:1,ruleCount:1}});
    const event=db.prepare('SELECT id FROM audit_events WHERE tenant_id=? AND request_id=?').pluck().get(tenantId,`req-${action}`) as string;return {message,event,original};
  };
  const cases=[add('redact','Send ⟦REDACTED:SECRET:token-1:check⟧ now','raw-redaction-secret'),add('mask','Send [MASKED] now','raw-mask-secret')];
  for(const item of cases){const result=await adapter(db).execute('audit.event',{...request(db,null),params:{id:item.event}});assert.equal(result.status,undefined);const body=result.body as Record<string,any>,serialized=JSON.stringify(body);assert.equal(body.detail.messageId,item.message);assert.deepEqual(body.detail.policiesApplied,[{ruleId:rule,ruleName:'Customer secrets',detector:'customer-secret',action:body.verdict}]);assert.equal(body.detail.cleansedPrompt.transformed,true);assert.equal(body.detail.matchCount,1);assert.equal(body.detail.ruleCount,1);assert.doesNotMatch(serialized,new RegExp(item.original));for(const forbidden of ['redaction_vault','payload_ciphertext','content_ciphertext','content_digest','content_sha256'])assert.equal(serialized.includes(forbidden),false);}
  assert.match(String(((await adapter(db).execute('audit.event',{...request(db,null),params:{id:cases[0]!.event}})).body as any).detail.cleansedPrompt.text),/⟦REDACTED:/);
  assert.match(String(((await adapter(db).execute('audit.event',{...request(db,null),params:{id:cases[1]!.event}})).body as any).detail.cleansedPrompt.text),/\[MASKED\]/);
  db.close();
});

test('audit detail records transcript viewing only when the response contains message content',async()=>{
  const db=fixture();seed(db);const audit=store(db),message=randomUUID();
  audit.append({tenantId,action:'admin.user_updated',actor:{type:'user',id:ID.actor,sessionId:null,ip:null,userAgent:null,authMethod:null},target:{type:'user',id:ID.subject},outcome:'success',context:{requestId:'metadata-only',traceId:null,source:'http'},metadata:{fields:['locale']}});
  const metadataId=db.prepare("SELECT id FROM audit_events WHERE request_id='metadata-only'").pluck().get() as string;
  await adapter(db).execute('audit.event',{...request(db,null),params:{id:metadataId}});
  assert.equal(stored(db,'admin.transcript_viewed').length,0,'metadata-only detail was recorded as a transcript view');
  db.prepare("INSERT INTO messages(id,tenant_id,conversation_id,author_user_id,role,status,sequence_no,created_at) VALUES(?,?,?,?, 'user','complete',0,?)").run(message,tenantId,ID.conversation,ID.actor,AT);
  db.prepare("INSERT INTO message_parts(id,tenant_id,message_id,ordinal,kind,text_content,metadata_json,created_at) VALUES(?,?,?,0,'text','cleansed content','{}',?)").run(randomUUID(),tenantId,message,AT);
  audit.append({tenantId,action:'gate.content_flagged',actor:{type:'user',id:ID.actor,sessionId:null,ip:null,userAgent:null,authMethod:null},target:{type:'message',id:message},outcome:'success',context:{requestId:'with-content',traceId:null,source:'http'},messageId:message,metadata:{}});
  const contentId=db.prepare("SELECT id FROM audit_events WHERE request_id='with-content'").pluck().get() as string;
  await adapter(db).execute('audit.event',{...request(db,null),params:{id:contentId}});
  const [row]=stored(db,'admin.transcript_viewed');
  assert.ok(row,'admin.transcript_viewed was not stored');
  assert.deepEqual(JSON.parse(row.metadata_json),{eventId:contentId});
  assert.deepEqual({actor:row.actor_id,session:row.actor_session_id,request:row.request_id},{actor:ID.actor,session:'s',request:'req'});
  db.close();
});

test('failed chain verification records its broken sequence and caller identity',async()=>{
  const {db,routes}=governed();
  db.prepare("UPDATE audit_events SET metadata_json='{}' WHERE tenant_id=? AND sequence=1").run(tenantId);
  const result=await routes.execute('audit.integrity',request(db,null));
  assert.equal((result.body as {valid:boolean}).valid,false);
  const [started]=stored(db,'admin.chain_verification_started'),[completed]=stored(db,'admin.chain_verification_completed');
  assert.ok(started,'admin.chain_verification_started was not stored');
  assert.ok(completed,'admin.chain_verification_completed was not stored');
  assert.equal(completed.outcome,'failure');
  assert.deepEqual(JSON.parse(completed.metadata_json),{mode:'full',checkedRows:0,elapsedMs:0,breakAtSequence:1});
  assert.deepEqual({actor:completed.actor_id,session:completed.actor_session_id,request:completed.request_id},{actor:ID.actor,session:'s',request:'req'});
  db.close();
});

test('audit detail cannot cross the principal tenant boundary',async()=>{
  const db=fixture();seed(db);store(db).append({tenantId,action:'gate.content_redacted',actor:{type:'service',id:null,sessionId:null,ip:null,userAgent:null,authMethod:null},target:{type:'message',id:null},outcome:'success',context:{requestId:'tenant-a',traceId:null,source:'worker',occurredAtMs:AT},gateAction:'redact',detector:'pii',metadata:{ruleIds:[]}});
  const event=db.prepare("SELECT id FROM audit_events WHERE tenant_id=? AND request_id='tenant-a'").pluck().get(tenantId) as string,tenantB='00000000-0000-4000-8000-000000000002' as TenantId;db.prepare("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,?,'Other','active',?,?)").run(tenantB,'other',AT,AT);db.prepare('INSERT INTO tenant_settings(tenant_id,updated_at) VALUES(?,?)').run(tenantB,AT);
  const base=request(db,null),foreign={...base,params:{id:event},tenant:{...base.tenant!,principal:{...base.tenant!.principal,tenantId:tenantB},db:forTenant({tenantId:tenantB})}};const result=await adapter(db).execute('audit.event',foreign);assert.equal(result.status,404);assert.doesNotMatch(JSON.stringify(result.body),/tenant-a/);db.close();
});

/**
 * Filter keys are the screen's, from web/src/admin/catalog.ts. The adapter read camelCase names the
 * console never sends, so eleven of these were dropped on the floor: the table came back unfiltered
 * and looked, to an administrator narrowing an investigation, exactly like a complete answer.
 */
test('every filter the audit screen offers narrows the result set',async()=>{
  const filters:ReadonlyArray<readonly [string,string,string]>=[
    ['search','Blocked a customer email address','nothing wrote this sentence'],
    ['actor','Ada Lovelace','Nobody At All'],
    ['subject','Quarterly review','Some other conversation'],
    ['category','gate','admin'],
    ['action','gate.content_blocked','admin.user_invited'],
    ['user','Grace Hopper','Nobody At All'],
    ['group','Research','Marketing'],
    ['model','GPT-5 Turbo','Some Other Model'],
    ['provider','openai','anthropic'],
    ['project','Apollo','Gemini'],
    ['date','2026-01-15','2026-01-17'],
    ['verdict','block','allow'],
    ['detector','pii-direct','secret-private-key'],
    ['requestId','req-blocked','req-nonexistent'],
    ['ip','203.0.113.7','198.51.100.99'],
  ];
  {const {db,routes}=governed();assert.equal((await items(routes,db,{})).length,3,'precondition: both fixture events and chain initialization are visible unfiltered');db.close();}
  for(const [key,matching,missing] of filters){
    const absent=governed(),missed=await items(absent.routes,absent.db,{[key]:missing});
    assert.equal(missed.length,0,`the ${key} filter is ignored: "${missing}" matches no event and still returned ${missed.length} rows`);
    absent.db.close();
    const present=governed(),matched=await items(present.routes,present.db,{[key]:matching});
    assert.deepEqual(matched.map(row=>row.requestId),['req-blocked'],`the ${key} filter must still select the event "${matching}" names`);
    present.db.close();
  }
});

/**
 * The same tenant, seen from the violation queue: one held violation carrying every attribute the
 * queue has a column or a filter for, and two controls that carry none of them. The controls exist so
 * that a filter which is read but never applied is caught — an ignored filter returns all three.
 */
const QUEUE={held:'88888888-8888-4888-8888-888888888888',other:'99999999-9999-4999-8999-999999999999',spare:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',policy:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',rule:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',detector:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',approval:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',spareApproval:'ffffffff-ffff-4fff-8fff-ffffffffffff',gateDecision:'abababab-abab-4bab-8bab-abababababab'} as const;
const HELD_AT=Date.UTC(2026,0,15,12,0,0),SPARE_AT=Date.UTC(2026,0,16,11,15,0);
const DUE_AT=Date.UTC(2026,0,18,12,0,0);
const EXCERPT='Contact ███ about the renewal';
function queued():{db:Database.Database;routes:AuditRouteAdapter}{
  const db=fixture(),at=AT;
  seed(db);
  db.prepare("INSERT INTO policies(tenant_id,id,name,created_at,updated_at) VALUES(?,?,'Customer data policy',?,?)").run(tenantId,QUEUE.policy,at,at);
  db.prepare("INSERT INTO detector_definitions(tenant_id,id,key,kind,config_json,config_sha256,created_at,updated_at) VALUES(?,?,'pii-direct','pii','{}',?,?,?)").run(tenantId,QUEUE.detector,'a'.repeat(64),at,at);
  db.prepare("INSERT INTO policy_rules(tenant_id,id,policy_id,detector_id,scope_type,scope_id,direction,action,severity,created_at,updated_at) VALUES(?,?,?,?,'tenant',NULL,'outbound','require_approval','high',?,?)").run(tenantId,QUEUE.rule,QUEUE.policy,QUEUE.detector,at,at);
  const store_=store(db);
  // The held turn: everything the queue can show hangs off this event or the violation raised from it.
  const held=store_.append({tenantId,action:'gate.approval_requested',actor:{type:'user',id:ID.subject,sessionId:null,ip:'203.0.113.7',userAgent:null,authMethod:'password'},
    target:{type:'message',id:null},outcome:'denied',context:{requestId:'req-held',traceId:null,source:'http',occurredAtMs:HELD_AT},
    subjectUserId:ID.subject,groupId:ID.group,projectId:ID.project,conversationId:ID.conversation,modelId:ID.model,providerId:'openai',
    gateAction:'require_approval',detector:'pii-direct',metadata:{summary:'Held for review'}});
  // Two unrelated turns by a different person, so no filter below can select one of these by accident.
  const control=(requestId:string,occurredAtMs:number)=>store_.append({tenantId,action:'gate.content_blocked',actor:{type:'user',id:ID.actor,sessionId:null,ip:'198.51.100.20',userAgent:null,authMethod:'password'},
    target:{type:'message',id:null},outcome:'denied',context:{requestId,traceId:null,source:'http',occurredAtMs},
    gateAction:'block',detector:'secret-private-key',metadata:{summary:'An unrelated block'}});
  const other=control('req-other',SPARE_AT),spare=control('req-spare',SPARE_AT);
  db.prepare(`INSERT INTO gate_decisions(id,tenant_id,user_id,conversation_id,direction,final_action,status,content_sha256,matched_rule_ids_json,matched_detector_keys_json,redacted_excerpt,latency_ms,cache_hit,decided_at)
    VALUES(?,?,?,?,'outbound','require_approval','pending_approval',?,?,?,?,0,0,?)`)
    .run(QUEUE.gateDecision,tenantId,ID.subject,ID.conversation,'3'.repeat(64),JSON.stringify([QUEUE.rule]),JSON.stringify(['pii-direct']),EXCERPT,HELD_AT);
  const violation=db.prepare("INSERT INTO policy_violations(id,tenant_id,audit_event_id,approval_id,subject_user_id,group_id,conversation_id,direction,detector,gate_action,severity,status,assignee_user_id,rule_ids_json,redacted_excerpt,content_digest,due_at_ms,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  violation.run(QUEUE.held,tenantId,held.id,QUEUE.approval,ID.subject,ID.group,ID.conversation,'outbound','pii-direct','require_approval','high','open',ID.actor,JSON.stringify([QUEUE.rule]),EXCERPT,'d'.repeat(64),DUE_AT,HELD_AT,HELD_AT);
  violation.run(QUEUE.other,tenantId,other.id,null,null,null,null,'inbound','secret-private-key','block','low','resolved',null,'[]','nothing of interest','e'.repeat(64),null,SPARE_AT,SPARE_AT);
  violation.run(QUEUE.spare,tenantId,spare.id,QUEUE.spareApproval,null,null,null,'inbound','secret-private-key','block','low','resolved',null,'[]','nothing of interest','f'.repeat(64),null,SPARE_AT,SPARE_AT);
  const approval=db.prepare("INSERT INTO policy_approval_requests(id,tenant_id,violation_id,gate_decision_id,requesting_user_id,status,payload_ciphertext,payload_nonce,key_version,payload_digest,policy_revision,assignee_user_id,expires_at_ms,created_at_ms) VALUES(?,?,?,?,?,?,?,?,1,?,1,?,?,?)");
  approval.run(QUEUE.approval,tenantId,QUEUE.held,QUEUE.gateDecision,ID.subject,'pending',Buffer.from('cipher'),Buffer.from('nonce'),'1'.repeat(64),ID.actor,HELD_AT+86_400_000,HELD_AT+300_000);
  approval.run(QUEUE.spareApproval,tenantId,QUEUE.spare,null,ID.actor,'released',Buffer.from('cipher'),Buffer.from('nonce'),'2'.repeat(64),null,SPARE_AT+86_400_000,SPARE_AT+300_000);
  return {db,routes:adapter(db)};
}
async function queuePage(routes:AuditRouteAdapter,db:Database.Database,operation:'admin.violations'|'gate.approvals',query:Readonly<Record<string,string>>):Promise<{items:Array<Record<string,unknown>>;nextCursor:string|null;hasMore:boolean}>{
  const result=await routes.execute(operation,request(db,null,query));
  assert.equal(result.status,undefined,`${operation} refused ${JSON.stringify(query)}: ${JSON.stringify(result.body)}`);
  return result.body as {items:Array<Record<string,unknown>>;nextCursor:string|null;hasMore:boolean};
}
async function rows(routes:AuditRouteAdapter,db:Database.Database,operation:'admin.violations'|'gate.approvals',query:Readonly<Record<string,string>>):Promise<Array<Record<string,unknown>>>{return (await queuePage(routes,db,operation,query)).items;}

/**
 * The violation queue declares twelve columns. The adapter answered with `SELECT v.*`, so every one
 * of them except `severity`, `direction` and `status` was absent from the JSON under the name the
 * table reads, and the queue drew an em dash where it should have named the person, their group, the
 * rule they tripped and when the review is due.
 */
test('the violation row carries the columns the queue renders, resolved to names a person can read',async()=>{
  const {db,routes}=queued();
  const all=await rows(routes,db,'admin.violations',{});
  assert.equal(all.length,3);
  const row=all.find(item=>item.id===QUEUE.held);
  assert.ok(row,`no row is addressable by id; the response keys are ${Object.keys(all[0]??{}).join(', ')}`);
  for(const column of ['occurredAt','severity','user','groups','detector','rule','direction','action','status','redactedExcerpt','assignee','dueAt'])
    assert.notEqual(row[column]??null,null,`the violation queue renders a "${column}" column, and the row has no such field`);
  assert.deepEqual({occurredAt:row.occurredAt,dueAt:row.dueAt},{occurredAt:new Date(HELD_AT).toISOString(),dueAt:new Date(DUE_AT).toISOString()},
    'occurredAt is the moment the content was sent, taken from the audit event, and both are instants rather than epoch milliseconds');
  assert.deepEqual({user:row.user,groups:row.groups,rule:row.rule,assignee:row.assignee,model:row.model,provider:row.provider,project:row.project},
    {user:'Grace Hopper',groups:['Research'],rule:['Customer data policy'],assignee:'Ada Lovelace',model:'GPT-5 Turbo',provider:'openai',project:'Apollo'});
  assert.deepEqual({severity:row.severity,detector:row.detector,direction:row.direction,action:row.action,status:row.status,redactedExcerpt:row.redactedExcerpt},
    {severity:'high',detector:'pii-direct',direction:'outbound',action:'require_approval',status:'open',redactedExcerpt:EXCERPT});
  // The ids stay beside the labels, because the drawer and every drill-through still address by id.
  assert.deepEqual({userId:row.userId,groupIds:row.groupIds,ruleIds:row.ruleIds,assigneeId:row.assigneeId},
    {userId:ID.subject,groupIds:[ID.group],ruleIds:[QUEUE.rule],assigneeId:ID.actor});
  // Violations.tsx reads these three names to decide whether to offer approve/deny and where to post.
  assert.deepEqual({approvalId:row.approvalId,approvalStatus:row.approvalStatus,approvalVersion:row.approvalVersion},{approvalId:QUEUE.approval,approvalStatus:'pending',approvalVersion:1});
  assert.deepEqual({releaseStatus:row.releaseStatus,releaseErrorCode:row.releaseErrorCode,releaseMessageId:row.releaseMessageId,releaseAttempts:row.releaseAttempts},
    {releaseStatus:'pending_review',releaseErrorCode:null,releaseMessageId:null,releaseAttempts:0});
  assert.equal('approval_id' in row,false);assert.equal('approval_status' in row,false);assert.equal('approval_version' in row,false);
  for(const internal of ['tenant_id','content_digest','subject_user_id','gate_action','rule_ids_json','redacted_excerpt','assignee_user_id','due_at_ms','created_at_ms','occurred_at_ms'])
    assert.equal(internal in row,false,`${internal} is not a column of this screen and must not be a field of its rows`);
  db.close();
});

test('linked violations project release progress without worker internals or raw errors',async()=>{
  const {db,routes}=queued(),messageId='12121212-1212-4212-8212-121212121212';
  db.prepare(`UPDATE policy_approval_requests SET status='releasing',release_phase='result_checkpointed',
    release_error_code='raw provider stack with bearer secret',release_message_id=?,release_attempts=4 WHERE id=?`).run(messageId,QUEUE.approval);
  const row=(await rows(routes,db,'admin.violations',{})).find(item=>item.id===QUEUE.held);
  assert.deepEqual(row&&{
    approvalStatus:row.approvalStatus,releaseStatus:row.releaseStatus,releaseErrorCode:row.releaseErrorCode,
    releaseMessageId:row.releaseMessageId,releaseAttempts:row.releaseAttempts,
  },{approvalStatus:'releasing',releaseStatus:'finalizing',releaseErrorCode:'release_failed',releaseMessageId:messageId,releaseAttempts:4});
  db.prepare("UPDATE policy_approval_requests SET release_error_code='provider_timeout' WHERE id=?").run(QUEUE.approval);
  const safe=(await rows(routes,db,'admin.violations',{})).find(item=>item.id===QUEUE.held);
  assert.equal(safe?.releaseErrorCode,'provider_timeout','documented worker error codes remain actionable');
  for(const internal of ['approval_release_phase','approval_release_error_code','releasePhase','releaseReservationId','providerStartedAtMs','resultDigest'])
    assert.equal(internal in (safe??{}),false,internal);
  db.close();
});

/**
 * Filter keys are the queue's own, from web/src/admin/catalog.ts. Only `status` was read; every other
 * box an administrator could type into returned the whole queue unchanged, which is indistinguishable
 * from a search that found everything rather than one that was never run.
 */
test('every filter the violation queue offers narrows the result set',async()=>{
  const {db,routes}=queued();
  const filters:ReadonlyArray<readonly [string,string,string]>=[
    ['search','renewal','nothing wrote this sentence'],
    ['status','open','dismissed'],
    ['severity','high','critical'],
    ['action','require_approval','redact'],
    ['detector','pii-direct','aws-access-key'],
    ['rule','Customer data policy','Some Other Policy'],
    ['user','Grace Hopper','Nobody At All'],
    ['user','grace@example.test','nobody@example.test'],
    ['group','Research','Marketing'],
    ['model','GPT-5 Turbo','Some Other Model'],
    ['provider','openai','anthropic'],
    ['project','Apollo','Gemini'],
    ['direction','outbound','file'],
    ['assignee','Ada Lovelace','Nobody At All'],
    ['date','2026-01-15','2026-01-17'],
  ];
  assert.equal((await rows(routes,db,'admin.violations',{})).length,3,'precondition: all three violations are visible unfiltered');
  for(const [key,matching,missing] of filters){
    const missed=await rows(routes,db,'admin.violations',{[key]:missing});
    assert.equal(missed.length,0,`the ${key} filter is ignored: "${missing}" matches no violation and still returned ${missed.length} rows`);
    const matched=await rows(routes,db,'admin.violations',{[key]:matching});
    assert.deepEqual(matched.map(row=>row.id),[QUEUE.held],`the ${key} filter must still select the violation "${matching}" names`);
  }
  // approvalOnly is the one filter with two populated sides rather than a match and a miss.
  assert.deepEqual((await rows(routes,db,'admin.violations',{approvalOnly:'true'})).map(row=>row.id),[QUEUE.spare,QUEUE.held],'newest first, by the time the content was sent');
  assert.deepEqual((await rows(routes,db,'admin.violations',{approvalOnly:'false'})).map(row=>row.id),[QUEUE.other]);
  const refused=await routes.execute('admin.violations',request(db,null,{approvalOnly:'sometimes'}));
  assert.equal(refused.status,422,'a value the filter cannot honour is refused rather than silently dropped');
  // Every clause at once: the shape an administrator narrowing an investigation actually sends, and
  // the one where a filter appended ahead of the tenant predicate would make `forTenant` throw.
  const narrowed=await rows(routes,db,'admin.violations',{search:'renewal',status:'open',severity:'high',action:'require_approval',detector:'pii-direct',rule:'Customer data policy',user:'Grace Hopper',group:'Research',model:'GPT-5 Turbo',provider:'openai',project:'Apollo',direction:'outbound',assignee:'Ada Lovelace',date:'2026-01-15',approvalOnly:'true'});
  assert.deepEqual(narrowed.map(row=>row.id),[QUEUE.held],'all fifteen filters together still select the violation every one of them names');
  db.close();
});

test('audit and violation date filters use the workspace calendar day',async()=>{
  const {db,routes}=queued(),at=Date.parse('2026-09-27T15:00:00.000Z');
  db.prepare("UPDATE tenant_settings SET timezone='Asia/Tokyo' WHERE tenant_id=?").run(tenantId);
  db.prepare('UPDATE audit_events SET occurred_at_ms=? WHERE tenant_id=? AND id=(SELECT audit_event_id FROM policy_violations WHERE tenant_id=? AND id=?)').run(at,tenantId,tenantId,QUEUE.held);
  assert.deepEqual((await items(routes,db,{date:'2026-09-28'})).map(row=>row.requestId),['req-held']);
  assert.deepEqual((await items(routes,db,{date:'2026-09-27'})).map(row=>row.requestId),[]);
  assert.deepEqual((await rows(routes,db,'admin.violations',{date:'2026-09-28'})).map(row=>row.id),[QUEUE.held]);
  assert.deepEqual((await rows(routes,db,'admin.violations',{date:'2026-09-27'})).map(row=>row.id),[]);
  db.close();
});

test('violation and approval cursors reach every row once in either supported order',async()=>{
  const {db,routes}=queued();
  const collect=async(operation:'admin.violations'|'gate.approvals',order:'asc'|'desc')=>{
    const ids:string[]=[];let cursor:string|undefined;let pages=0;
    do{
      const page=await queuePage(routes,db,operation,{limit:'1',order,...(cursor?{cursor}:{})});
      pages++;ids.push(...page.items.map(row=>String(row.id)));
      assert.equal(page.hasMore,page.nextCursor!==null,'hasMore and nextCursor must describe the same next page');
      cursor=page.nextCursor??undefined;
    }while(cursor);
    return {ids,pages};
  };
  assert.deepEqual(await collect('admin.violations','desc'),{ids:[QUEUE.spare,QUEUE.other,QUEUE.held],pages:3});
  assert.deepEqual(await collect('admin.violations','asc'),{ids:[QUEUE.held,QUEUE.other,QUEUE.spare],pages:3});
  assert.deepEqual(await collect('gate.approvals','desc'),{ids:[QUEUE.spareApproval,QUEUE.approval],pages:2});
  assert.deepEqual(await collect('gate.approvals','asc'),{ids:[QUEUE.approval,QUEUE.spareApproval],pages:2});

  const first=await queuePage(routes,db,'admin.violations',{limit:'1',order:'desc'});
  const changedOrder=await routes.execute('admin.violations',request(db,null,{limit:'1',order:'asc',cursor:first.nextCursor!}));
  assert.equal(changedOrder.status,422,'a cursor cannot be replayed against a different order');
  const malformed=await routes.execute('admin.violations',request(db,null,{cursor:'not-a-cursor'}));
  assert.equal(malformed.status,422);
  const unsupported=await routes.execute('admin.violations',request(db,null,{sort:'severity'}));
  assert.equal(unsupported.status,422,'only the indexed occurredAt sort is advertised and accepted');
  db.close();
});

/**
 * `gate.approvals` had the same two defects and one of its own: it answered with snake_case ids for
 * the requester, the assignee and the decider, so the queue of held requests named nobody at all.
 */
test('the approval queue names the people on it and answers every filter it is given',async()=>{
  const {db,routes}=queued();
  const all=await rows(routes,db,'gate.approvals',{});
  assert.equal(all.length,2);
  const row=all.find(item=>item.id===QUEUE.approval);
  assert.ok(row,`no approval is addressable by id; the response keys are ${Object.keys(all[0]??{}).join(', ')}`);
  assert.deepEqual({requester:row.requester,assignee:row.assignee,user:row.user,groups:row.groups,rule:row.rule},
    {requester:'Grace Hopper',assignee:'Ada Lovelace',user:'Grace Hopper',groups:['Research'],rule:['Customer data policy']});
  assert.deepEqual({violationId:row.violationId,status:row.status,severity:row.severity,detector:row.detector,action:row.action,violationStatus:row.violationStatus,redactedExcerpt:row.redactedExcerpt},
    {violationId:QUEUE.held,status:'pending',severity:'high',detector:'pii-direct',action:'require_approval',violationStatus:'open',redactedExcerpt:EXCERPT});
  assert.deepEqual({occurredAt:row.occurredAt,createdAt:row.createdAt,expiresAt:row.expiresAt,decidedAt:row.decidedAt},
    {occurredAt:new Date(HELD_AT).toISOString(),createdAt:new Date(HELD_AT+300_000).toISOString(),expiresAt:new Date(HELD_AT+86_400_000).toISOString(),decidedAt:null});
  for(const internal of ['tenant_id','payload_ciphertext','payload_nonce','payload_digest','key_version','requesting_user_id','assignee_user_id','expires_at_ms','created_at_ms','gate_action'])
    assert.equal(internal in row,false,`${internal} must not be a field of an approval the console renders`);
  const filters:ReadonlyArray<readonly [string,string,string]>=[
    ['search','renewal','nothing wrote this sentence'],
    ['status','pending','expired'],
    ['user','Grace Hopper','Nobody At All'],
    ['requester','grace@example.test','nobody@example.test'],
    ['assignee','Ada Lovelace','Nobody At All'],
    ['rule','Customer data policy','Some Other Policy'],
    ['detector','pii-direct','aws-access-key'],
    ['severity','high','critical'],
    ['action','require_approval','redact'],
    ['group','Research','Marketing'],
    ['date','2026-01-15','2026-01-17'],
    ['violationId',QUEUE.held,QUEUE.other],
  ];
  for(const [key,matching,missing] of filters){
    const missed=await rows(routes,db,'gate.approvals',{[key]:missing});
    assert.equal(missed.length,0,`the ${key} filter is ignored: "${missing}" matches no approval and still returned ${missed.length} rows`);
    const matched=await rows(routes,db,'gate.approvals',{[key]:matching});
    assert.deepEqual(matched.map(row=>row.id),[QUEUE.approval],`the ${key} filter must still select the approval "${matching}" names`);
  }
  db.close();
});

test('a single approval reads as the same record as its row in the queue',async()=>{
  const {db,routes}=queued();
  const one=await routes.execute('gate.approval',{...request(db,null,{}),params:{id:QUEUE.approval}});
  assert.equal(one.status,undefined);
  assert.deepEqual(one.body,(await rows(routes,db,'gate.approvals',{violationId:QUEUE.held}))[0]);
  const missing=await routes.execute('gate.approval',{...request(db,null,{}),params:{id:QUEUE.spare}});
  assert.equal(missing.status,404,'an id that is not an approval must not resolve to one');
  db.close();
});

test('the approval wire DTO preserves every durable raw status and a stable release projection',async()=>{
  const expected={pending:'pending_review',claimed:'pending_review',approved:'queued',releasing:'releasing',released:'released',rejected:'terminal',expired:'terminal',cancelled:'terminal',release_failed:'failed',release_indeterminate:'indeterminate'} satisfies Record<ApprovalStatus,ApprovalReleaseStatus>;
  const {db,routes}=queued();
  for(const status of APPROVAL_STATUSES){
    db.prepare('UPDATE policy_approval_requests SET status=?,release_phase=? WHERE id=?').run(status,status==='releasing'?'dispatching':null,QUEUE.approval);
    const result=await routes.execute('gate.approval',{...request(db,null,{}),params:{id:QUEUE.approval}});
    assert.equal(result.status,undefined);
    assert.deepEqual({status:(result.body as {status:string}).status,releaseStatus:(result.body as {releaseStatus:string}).releaseStatus},{status,releaseStatus:expected[status]});
  }
  db.prepare("UPDATE policy_approval_requests SET status='releasing',release_phase='result_checkpointed' WHERE id=?").run(QUEUE.approval);
  const finalizing=await routes.execute('gate.approval',{...request(db,null,{}),params:{id:QUEUE.approval}});
  assert.equal((finalizing.body as {releaseStatus:string}).releaseStatus,'finalizing');
  db.close();
});

test('a queue read expires a due approval and its violation once, in the audit transaction',async()=>{
  const {db,routes}=queued();
  db.prepare('UPDATE policy_approval_requests SET expires_at_ms=? WHERE tenant_id=? AND id=?').run(AT,tenantId,QUEUE.approval);

  const violation=(await rows(routes,db,'admin.violations',{})).find(row=>row.id===QUEUE.held);
  assert.deepEqual({status:violation?.status,approvalStatus:violation?.approvalStatus,approvalVersion:violation?.approvalVersion},
    {status:'expired',approvalStatus:'expired',approvalVersion:2});
  assert.deepEqual(db.prepare('SELECT status,version,decision_by_user_id,decision_reason_code,decided_at_ms FROM policy_approval_requests WHERE tenant_id=? AND id=?').get(tenantId,QUEUE.approval),
    {status:'expired',version:2,decision_by_user_id:null,decision_reason_code:'expired',decided_at_ms:AT});
  assert.deepEqual(db.prepare('SELECT status,version,updated_at_ms FROM policy_violations WHERE tenant_id=? AND id=?').get(tenantId,QUEUE.held),
    {status:'expired',version:2,updated_at_ms:AT});
  assert.deepEqual(db.prepare('SELECT status,reviewed_by_user_id,reviewed_at,review_note FROM gate_decisions WHERE tenant_id=? AND id=?').get(tenantId,QUEUE.gateDecision),
    {status:'denied',reviewed_by_user_id:null,reviewed_at:null,review_note:null},'expiry denies the evaluation without inventing a human reviewer');

  const event=db.prepare("SELECT action,outcome,actor_type,actor_id,subject_user_id,target_type,target_id,gate_action,detector,metadata_json FROM audit_events WHERE tenant_id=? AND action='gate.approval_expired'").get(tenantId) as Record<string,unknown>;
  assert.deepEqual({...event,metadata_json:JSON.parse(String(event.metadata_json))},{action:'gate.approval_expired',outcome:'cancelled',actor_type:'service',actor_id:'approval-expiry',subject_user_id:ID.subject,target_type:'approval',target_id:QUEUE.approval,gate_action:'require_approval',detector:'pii-direct',metadata_json:{approvalId:QUEUE.approval,violationId:QUEUE.held,expiresAtMs:AT,approvalVersion:1}});
  await rows(routes,db,'gate.approvals',{});
  assert.equal((db.prepare("SELECT COUNT(*) count FROM audit_events WHERE tenant_id=? AND action='gate.approval_expired'").get(tenantId) as {count:number}).count,1,'a second read must not re-expire or re-audit the row');
  assert.equal(verifyAuditChain(db,tenantId).valid,true);
  db.close();
});

test('an unavailable audit chain rolls back approval expiry across all linked rows',async()=>{
  const {db,routes}=queued();
  db.prepare('UPDATE policy_approval_requests SET expires_at_ms=? WHERE tenant_id=? AND id=?').run(AT,tenantId,QUEUE.approval);
  db.prepare("UPDATE audit_chain_heads SET status='broken' WHERE tenant_id=?").run(tenantId);
  await assert.rejects(rows(routes,db,'gate.approvals',{}),/Audit chain is unavailable/);
  assert.deepEqual(db.prepare('SELECT status,version,decision_by_user_id FROM policy_approval_requests WHERE tenant_id=? AND id=?').get(tenantId,QUEUE.approval),
    {status:'pending',version:1,decision_by_user_id:null});
  assert.deepEqual(db.prepare('SELECT status,version FROM policy_violations WHERE tenant_id=? AND id=?').get(tenantId,QUEUE.held),{status:'open',version:1});
  assert.deepEqual(db.prepare('SELECT status,reviewed_by_user_id,reviewed_at,review_note FROM gate_decisions WHERE tenant_id=? AND id=?').get(tenantId,QUEUE.gateDecision),
    {status:'pending_approval',reviewed_by_user_id:null,reviewed_at:null,review_note:null});
  assert.equal((db.prepare("SELECT count(*) count FROM audit_events WHERE tenant_id=? AND action='gate.approval_expired'").get(tenantId) as {count:number}).count,0);
  db.close();
});

test('a decision after the deadline expires the row and returns an explicit conflict',async()=>{
  const {db,routes}=queued();
  db.prepare('UPDATE policy_approval_requests SET expires_at_ms=? WHERE tenant_id=? AND id=?').run(AT,tenantId,QUEUE.approval);
  const result=await routes.execute('gate.approvalDecision',{...request(db,{decision:'deny',reason:'This arrived after the review window'}),params:{id:QUEUE.approval}});
  assert.equal(result.status,409);
  assert.equal(((result.body as {error:{code:string}}).error.code),'APPROVAL_EXPIRED');
  assert.deepEqual(db.prepare('SELECT status,version,decision_by_user_id,decision_reason_code,decision_note FROM policy_approval_requests WHERE tenant_id=? AND id=?').get(tenantId,QUEUE.approval),
    {status:'expired',version:2,decision_by_user_id:null,decision_reason_code:'expired',decision_note:null});
  assert.deepEqual(db.prepare('SELECT status,version FROM policy_violations WHERE tenant_id=? AND id=?').get(tenantId,QUEUE.held),{status:'expired',version:2});
  assert.deepEqual(db.prepare('SELECT status,reviewed_by_user_id,reviewed_at,review_note FROM gate_decisions WHERE tenant_id=? AND id=?').get(tenantId,QUEUE.gateDecision),
    {status:'denied',reviewed_by_user_id:null,reviewed_at:null,review_note:null});
  assert.equal((db.prepare("SELECT COUNT(*) count FROM audit_events WHERE tenant_id=? AND action='gate.approval_rejected'").get(tenantId) as {count:number}).count,0);
  assert.equal((db.prepare("SELECT COUNT(*) count FROM audit_events WHERE tenant_id=? AND action='gate.approval_expired'").get(tenantId) as {count:number}).count,1);
  db.close();
});

test('approve fails closed without claiming the row when release orchestration is unavailable',async()=>{
  const {db}=queued(),routes=adapter(db,false);
  const result=await routes.execute('gate.approvalDecision',{...request(db,{decision:'approve',reason:'Reviewed and approved'}),params:{id:QUEUE.approval}});
  assert.equal(result.status,503);assert.match(JSON.stringify(result.body),/request remains pending/);
  assert.deepEqual(db.prepare('SELECT status,version,release_attempts,decision_by_user_id FROM policy_approval_requests WHERE tenant_id=? AND id=?').get(tenantId,QUEUE.approval),
    {status:'pending',version:1,release_attempts:0,decision_by_user_id:null});
  assert.equal(db.prepare('SELECT status FROM gate_decisions WHERE tenant_id=? AND id=?').pluck().get(tenantId,QUEUE.gateDecision),'pending_approval');
  db.close();
});

test('approve cannot queue a violation that was already dismissed or resolved',async()=>{
  for(const status of ['dismissed','resolved'] as const){
    const {db}=queued(),sessionId=randomUUID();seedSession(db,{id:sessionId,authMethod:'mfa',mfaVerifiedAt:AT-1_000,totp:true});db.prepare('UPDATE policy_violations SET status=?,version=version+1,updated_at_ms=? WHERE id=?').run(status,AT,QUEUE.held);let wakes=0;
    const result=await adapter(db,true,{wake(){wakes++;}}).execute('gate.approvalDecision',{...reviewerRequest(db,{decision:'approve',reason:'Reviewed under current policy'},['owner'],sessionId),params:{id:QUEUE.approval}});assert.equal(result.status,409,status);assert.equal(wakes,0,status);assert.deepEqual(db.prepare('SELECT status,version FROM policy_approval_requests WHERE id=?').get(QUEUE.approval),{status:'pending',version:1});assert.equal(db.prepare('SELECT status FROM gate_decisions WHERE id=?').pluck().get(QUEUE.gateDecision),'pending_approval');assert.equal(db.prepare("SELECT COUNT(*) FROM audit_events WHERE action='gate.approval_claimed' AND target_id=?").pluck().get(QUEUE.approval),0);db.close();
  }
});

test('an owner with fresh MFA queues stable release identities and wakes the worker after commit',async()=>{
  const {db}=queued(),sessionId='20202020-2020-4020-8020-202020202020';
  seedSession(db,{id:sessionId,authMethod:'mfa',mfaVerifiedAt:AT-1_000,totp:true});
  let wakes=0;const routes=adapter(db,true,{wake(){wakes++;}});
  const result=await routes.execute('gate.approvalDecision',{...reviewerRequest(db,{decision:'approve',reason:'Reviewed under current policy'},['owner'],sessionId),params:{id:QUEUE.approval}});
  assert.deepEqual(result,{status:202,body:{id:QUEUE.approval,status:'approved',releaseStatus:'queued',reason:'Reviewed under current policy'}});
  assert.equal(wakes,1);
  const approval=db.prepare('SELECT status,release_phase,release_next_attempt_at_ms,release_run_id,release_user_message_id,release_message_id,decision_note FROM policy_approval_requests WHERE id=?').get(QUEUE.approval) as Record<string,unknown>;
  assert.deepEqual({status:approval.status,phase:approval.release_phase,next:approval.release_next_attempt_at_ms,note:approval.decision_note},{status:'approved',phase:'queued',next:AT,note:'Reviewed under current policy'});
  for(const key of ['release_run_id','release_user_message_id','release_message_id'])assert.match(String(approval[key]),/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.equal(db.prepare('SELECT status FROM gate_decisions WHERE id=?').pluck().get(QUEUE.gateDecision),'approved');
  assert.equal(db.prepare("SELECT actor_session_id FROM audit_events WHERE tenant_id=? AND action='gate.approval_claimed' ORDER BY sequence DESC LIMIT 1").pluck().get(tenantId),sessionId);
  assert.equal(verifyAuditChain(db,tenantId).valid,true);
  db.close();
});

test('an exact approve retry replays before fresh MFA and never wakes or audits twice',async()=>{
  const {db}=queued(),sessionId=randomUUID();seedSession(db,{id:sessionId,authMethod:'mfa',mfaVerifiedAt:AT-1_000,totp:true});
  let wakes=0;const routes=adapter(db,true,{wake(){wakes++;}}),original={...reviewerRequest(db,{decision:'approve',reason:'Reviewed once under current policy'},['owner'],sessionId),params:{id:QUEUE.approval}};
  original.headers.set('Idempotency-Key','approval-exact-replay');
  const first=await routes.execute('gate.approvalDecision',original);
  db.prepare("UPDATE sessions SET auth_method='password',mfa_verified_at_ms=NULL WHERE tenant_id=? AND id=?").run(tenantId,sessionId);
  const replay=await routes.execute('gate.approvalDecision',original);
  assert.deepEqual(replay,first);assert.equal(wakes,1);
  assert.deepEqual(db.prepare('SELECT status,version FROM policy_approval_requests WHERE tenant_id=? AND id=?').get(tenantId,QUEUE.approval),{status:'approved',version:2});
  assert.equal(db.prepare("SELECT COUNT(*) FROM audit_events WHERE tenant_id=? AND action='gate.approval_claimed' AND target_id=?").pluck().get(tenantId,QUEUE.approval),1);
  assert.equal(db.prepare("SELECT COUNT(*) FROM idempotency_records WHERE tenant_id=? AND path='approval-decision:decide' AND idempotency_key=?").pluck().get(tenantId,'approval-exact-replay'),1);

  const changedBody={...original,body:{decision:'approve',reason:''}};
  const changedId={...original,params:{id:'different-approval'}};
  const changedVersion={...original,headers:new Headers(original.headers)};changedVersion.headers.set('If-Match','"2"');
  for(const changed of [changedBody,changedId,changedVersion]){
    const conflict=await routes.execute('gate.approvalDecision',changed);assert.equal(conflict.status,409);assert.equal((conflict.body as {error:{code:string}}).error.code,'IDEMPOTENCY_CONFLICT');
  }
  assert.equal(wakes,1);assert.equal(db.prepare("SELECT COUNT(*) FROM audit_events WHERE tenant_id=? AND action='gate.approval_claimed'").pluck().get(tenantId),1);db.close();
});

test('approval release distinguishes reviewer role and a fresh MFA authentication event',async()=>{
  const cases=[
    {role:'admin' as const,method:'mfa' as const,mfaVerifiedAt:AT-1_000,totp:true,code:'FORBIDDEN'},
    {role:'owner' as const,method:'password' as const,mfaVerifiedAt:null,totp:true,code:'MFA_REQUIRED'},
    {role:'compliance' as const,method:'mfa' as const,mfaVerifiedAt:AT-15*60_000-1,totp:true,code:'MFA_REQUIRED'},
  ];
  for(const [index,item] of cases.entries()){
    const {db}=queued(),sessionId=`30303030-3030-4030-8030-30303030303${index}`;
    seedSession(db,{id:sessionId,authMethod:item.method,mfaVerifiedAt:item.mfaVerifiedAt,totp:item.totp});
    const result=await adapter(db).execute('gate.approvalDecision',{...reviewerRequest(db,{decision:'approve',reason:'Reviewed under current policy'},[item.role],sessionId),params:{id:QUEUE.approval}});
    assert.equal(result.status,403);assert.equal((result.body as {error:{code:string}}).error.code,item.code);
    assert.equal(db.prepare('SELECT status FROM policy_approval_requests WHERE id=?').pluck().get(QUEUE.approval),'pending');
    db.close();
  }
});

test('deny closes the approval and violation in the same audited transaction',async()=>{
  const {db,routes}=queued();
  const foreignTenant='12121212-1212-4212-8212-121212121212',foreignDecision='13131313-1313-4313-8313-131313131313';
  db.prepare("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,?,'Foreign','active',?,?)").run(foreignTenant,'foreign-approval',AT,AT);
  db.prepare(`INSERT INTO gate_decisions(id,tenant_id,direction,final_action,status,content_sha256,matched_rule_ids_json,matched_detector_keys_json,latency_ms,cache_hit,decided_at)
    VALUES(?,?,'outbound','require_approval','pending_approval',?,'[]','[]',0,0,?)`).run(foreignDecision,foreignTenant,'4'.repeat(64),AT);
  const result=await routes.execute('gate.approvalDecision',{...request(db,{decision:'deny',reason:'Sensitive data is not approved'}),params:{id:QUEUE.approval}});
  assert.deepEqual(result.body,{id:QUEUE.approval,status:'rejected',reason:'Sensitive data is not approved'});
  assert.deepEqual(db.prepare('SELECT status,version,decision_by_user_id,decision_reason_code,decision_note,decided_at_ms FROM policy_approval_requests WHERE tenant_id=? AND id=?').get(tenantId,QUEUE.approval),
    {status:'rejected',version:2,decision_by_user_id:ID.actor,decision_reason_code:'rejected',decision_note:'Sensitive data is not approved',decided_at_ms:AT});
  assert.deepEqual(db.prepare('SELECT status,version,updated_at_ms FROM policy_violations WHERE tenant_id=? AND id=?').get(tenantId,QUEUE.held),
    {status:'rejected',version:2,updated_at_ms:AT});
  assert.deepEqual(db.prepare('SELECT status,reviewed_by_user_id,reviewed_at,review_note FROM gate_decisions WHERE tenant_id=? AND id=?').get(tenantId,QUEUE.gateDecision),
    {status:'denied',reviewed_by_user_id:ID.actor,reviewed_at:AT,review_note:'Sensitive data is not approved'});
  assert.deepEqual(db.prepare('SELECT status,reviewed_by_user_id,reviewed_at,review_note FROM gate_decisions WHERE tenant_id=? AND id=?').get(foreignTenant,foreignDecision),
    {status:'pending_approval',reviewed_by_user_id:null,reviewed_at:null,review_note:null},'a denial must not mutate another tenant\'s pending decision');
  const event=db.prepare("SELECT action,outcome,actor_id,subject_user_id,group_id,conversation_id,target_type,target_id,gate_action,detector,request_id,metadata_json FROM audit_events WHERE tenant_id=? AND action='gate.approval_rejected'").get(tenantId) as Record<string,unknown>;
  assert.deepEqual({...event,metadata_json:JSON.parse(String(event.metadata_json))},{action:'gate.approval_rejected',outcome:'denied',actor_id:ID.actor,subject_user_id:ID.subject,group_id:ID.group,conversation_id:ID.conversation,target_type:'approval',target_id:QUEUE.approval,gate_action:'require_approval',detector:'pii-direct',request_id:'req',metadata_json:{approvalId:QUEUE.approval,violationId:QUEUE.held,decision:'deny',reasonCode:'rejected',reviewNoteLength:30,approvalVersion:1}});
  assert.equal(verifyAuditChain(db,tenantId).valid,true);
  db.close();
});

test('an exact deny retry returns the cached decision without another mutation or audit',async()=>{
  const {db}=queued(),routes=adapter(db),original={...request(db,{decision:'deny',reason:'Denied once after reviewer inspection'}),params:{id:QUEUE.approval}};
  original.headers.set('Idempotency-Key','deny-exact-replay');
  const first=await routes.execute('gate.approvalDecision',original),replay=await routes.execute('gate.approvalDecision',original);
  assert.deepEqual(replay,first);
  assert.deepEqual(db.prepare('SELECT status,version FROM policy_approval_requests WHERE tenant_id=? AND id=?').get(tenantId,QUEUE.approval),{status:'rejected',version:2});
  assert.deepEqual(db.prepare('SELECT status,version FROM policy_violations WHERE tenant_id=? AND id=?').get(tenantId,QUEUE.held),{status:'rejected',version:2});
  assert.equal(db.prepare("SELECT COUNT(*) FROM audit_events WHERE tenant_id=? AND action='gate.approval_rejected' AND target_id=?").pluck().get(tenantId,QUEUE.approval),1);
  assert.equal(db.prepare("SELECT COUNT(*) FROM idempotency_records WHERE tenant_id=? AND path='approval-decision:decide' AND idempotency_key=?").pluck().get(tenantId,'deny-exact-replay'),1);db.close();
});

test('approval reasons are normalized and secret-scrubbed before durable storage',async()=>{
  const {db,routes}=queued(),secret='sk-live-abcdefghijklmnop';
  const result=await routes.execute('gate.approvalDecision',{...request(db,{decision:'deny',reason:`  Credential\u0000review:   ${secret}  `}),params:{id:QUEUE.approval}});
  assert.equal(result.status,undefined);
  const stored=db.prepare('SELECT decision_note FROM policy_approval_requests WHERE tenant_id=? AND id=?').pluck().get(tenantId,QUEUE.approval) as string;
  const gateNote=db.prepare('SELECT review_note FROM gate_decisions WHERE tenant_id=? AND id=?').pluck().get(tenantId,QUEUE.gateDecision) as string;
  assert.equal(stored,gateNote);
  assert.equal(stored.includes(secret),false);
  assert.match(stored,/\[REDACTED:/u);
  const metadata=db.prepare("SELECT metadata_json FROM audit_events WHERE tenant_id=? AND action='gate.approval_rejected'").pluck().get(tenantId) as string;
  assert.equal(metadata.includes(secret),false,'audit metadata records a decision code, never the free-form reason');
  db.close();
});

test('an unavailable audit chain rolls back both sides of a denial',async()=>{
  const {db,routes}=queued(),events=(db.prepare('SELECT count(*) count FROM audit_events WHERE tenant_id=?').get(tenantId) as {count:number}).count;
  db.prepare("UPDATE audit_chain_heads SET status='broken' WHERE tenant_id=?").run(tenantId);
  await assert.rejects(routes.execute('gate.approvalDecision',{...request(db,{decision:'deny',reason:'Must not partially commit'}),params:{id:QUEUE.approval}}),/Audit chain is unavailable/);
  assert.deepEqual(db.prepare('SELECT status,version,decision_by_user_id,decision_note FROM policy_approval_requests WHERE tenant_id=? AND id=?').get(tenantId,QUEUE.approval),
    {status:'pending',version:1,decision_by_user_id:null,decision_note:null});
  assert.deepEqual(db.prepare('SELECT status,version FROM policy_violations WHERE tenant_id=? AND id=?').get(tenantId,QUEUE.held),{status:'open',version:1});
  assert.deepEqual(db.prepare('SELECT status,reviewed_by_user_id,reviewed_at,review_note FROM gate_decisions WHERE tenant_id=? AND id=?').get(tenantId,QUEUE.gateDecision),
    {status:'pending_approval',reviewed_by_user_id:null,reviewed_at:null,review_note:null});
  assert.equal((db.prepare('SELECT count(*) count FROM audit_events WHERE tenant_id=?').get(tenantId) as {count:number}).count,events);
  db.close();
});

test('a stale gate decision makes denial conflict and rolls back approval and violation changes',async()=>{
  const {db,routes}=queued();
  db.prepare("UPDATE gate_decisions SET status='final' WHERE tenant_id=? AND id=?").run(tenantId,QUEUE.gateDecision);
  const result=await routes.execute('gate.approvalDecision',{...request(db,{decision:'deny',reason:'Must remain atomic'}),params:{id:QUEUE.approval}});
  assert.equal(result.status,409);
  assert.deepEqual(db.prepare('SELECT status,version,decision_by_user_id FROM policy_approval_requests WHERE tenant_id=? AND id=?').get(tenantId,QUEUE.approval),
    {status:'pending',version:1,decision_by_user_id:null});
  assert.deepEqual(db.prepare('SELECT status,version FROM policy_violations WHERE tenant_id=? AND id=?').get(tenantId,QUEUE.held),{status:'open',version:1});
  assert.equal(db.prepare('SELECT status FROM gate_decisions WHERE tenant_id=? AND id=?').pluck().get(tenantId,QUEUE.gateDecision),'final');
  assert.equal((db.prepare("SELECT count(*) count FROM audit_events WHERE tenant_id=? AND action='gate.approval_rejected'").get(tenantId) as {count:number}).count,0);
  db.close();
});

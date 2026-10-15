import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createAdminAdapter, prepareAdminStatements } from './index.js';
import { prepareConsoleStatements } from './capabilities.js';
import { prepareAnalyticsStatements } from './analytics.js';
import { prepareNudgeStatements } from './nudges.js';
import { createDirectoryReader } from './directory.js';
import { runMigrations } from '../../lib/migrations/index.js';
import { seedDefaultPolicy } from '../../lib/gate/default-policy.js';
import { DefaultGateEngine, deterministicDetectors, StatelessGateVault, resolvePolicy } from '../../lib/gate/index.js';
import type { GateContext, ResolvedRule } from '../../lib/gate/types.js';
import { forTenant, type TenantDb } from '../../lib/db.js';
import type { AuditService } from '../../lib/audit/index.js';
import type { RouteRequest } from '../../routes/types.js';
import type { RequestPrincipal, Role, TenantId } from '../../shared/types.js';

function fixture(failAudit=false) {
  const database=new Database(':memory:'); runMigrations(database);
  const tenantId=randomUUID() as TenantId,userId=randomUUID(),at=1_700_000_000_000;
  database.prepare(`INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,?,'Acme','active',?,?)`).run(tenantId,'acme',at,at);
  database.prepare(`INSERT INTO tenant_settings(tenant_id,updated_at) VALUES(?,?)`).run(tenantId,at);
  database.prepare(`INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,?,'Owner','hash','active',?,?)`).run(userId,tenantId,'owner@acme.test',at,at);
  const events:string[]=[];
  const append=(input:{action:string})=>{if(failAudit)throw new Error('forced audit failure');events.push(input.action);return{id:randomUUID(),tenantId,chainEpoch:1,sequence:events.length,eventHash:'a'.repeat(64),recordedAtMs:at}};
  const audit={append,transact:<T>(work:(tx:{append:typeof append})=>T)=>database.transaction(()=>work({append})).immediate(),enqueue(){throw new Error('unused')}} as unknown as AuditService;
  const adapter=createAdminAdapter({database,statements:prepareAdminStatements(database),console:prepareConsoleStatements(database),analytics:prepareAnalyticsStatements(database),nudges:prepareNudgeStatements(database),directory:createDirectoryReader(database,()=>at),audit,now:()=>at,appOrigin:'https://app.test',idempotencyHmacKey:Buffer.alloc(32,1),invitationResponseEncryptionKey:Buffer.alloc(32,2)});
  // The real thing, not a stand-in that only prepends the tenant id. `forTenant` also refuses a
  // statement whose tenant predicate is not the first placeholder, and that half is exactly what a
  // hand-rolled TenantDb drops — which is how ten admin statements shipped throwing on every real
  // request while this suite stayed green. See writes.test.ts.
  const tenantDb:TenantDb=forTenant({tenantId});
  const request=(operationBody:unknown,roles:Role[]=['owner'],params:Record<string,string>={}):RouteRequest=>{
    const principal:RequestPrincipal={userId,tenantId,membershipId:userId,sessionId:randomUUID(),roles,permissions:new Set()};
    return{tenant:{principal,db:tenantDb,requestId:randomUUID(),now:new Date(at)},requestId:randomUUID(),params,query:{},headers:new Headers(),body:operationBody,rawBody:null};
  };
  return{database,adapter,request,events,tenantId,userId,at};
}

test('group mutation is tenant scoped and writes an admin audit event',async()=>{
  const f=fixture();
  const create=f.request({name:'Engineering',description:'Builders'});create.headers.set('Idempotency-Key','group-create-index');
  const created=await f.adapter.execute('admin.groups.create',create);
  assert.equal(created.status,201); assert.deepEqual(f.events,['admin.group_created']);
  const listed=await f.adapter.execute('admin.groups.list',f.request(null));
  assert.equal((listed.body as {items:unknown[]}).items.length,1);
  f.database.close();
});

test('admin model list identifies API system-prompt eligibility',async()=>{
  const f=fixture(),insert=f.database.prepare("INSERT INTO model_catalog(id,tenant_id,provider_key,model_key,display_name,enabled,context_window,max_output_tokens,input_microusd_per_million,output_microusd_per_million,capabilities_json,created_at,updated_at) VALUES(?,?,?,?,?,1,4096,512,0,0,'[]',?,?)");
  insert.run(randomUUID(),f.tenantId,'anthropic','claude-api','Claude API',f.at,f.at);
  const response=await f.adapter.execute('admin.models.list',f.request(null));
  const items=(response.body as {items:Array<{provider:string;transport:string;systemPromptEligible:boolean}>}).items;
  assert.deepEqual(items.map(({provider,transport,systemPromptEligible})=>({provider,transport,systemPromptEligible})),[
    {provider:'anthropic',transport:'api',systemPromptEligible:true},
  ]);
  f.database.close();
});

test('compliance role cannot mutate groups',async()=>{
  const f=fixture();
  const create=f.request({name:'Forbidden'},['compliance']);create.headers.set('Idempotency-Key','group-create-forbidden');
  const response=await f.adapter.execute('admin.groups.create',create);
  assert.equal(response.status,403); assert.equal(f.events.length,0);
  f.database.close();
});

test('audit append failure rolls back an admin mutation',async()=>{
  const f=fixture(true);
  const create=f.request({name:'Unrecorded'});create.headers.set('Idempotency-Key','group-create-audit-failure');
  await assert.rejects(f.adapter.execute('admin.groups.create',create),/forced audit failure/);
  assert.equal(f.database.prepare('SELECT COUNT(*) count FROM groups').pluck().get(),0);
  f.database.close();
});

test('draft rule test uses the real keyword detector without publishing or auditing',async()=>{
  const f=fixture(),request=f.request({sampleText:'Do not disclose Project Cobalt',rule:{detectorKind:'keyword',action:'block',config:{terms:['Project Cobalt']}}});request.headers.set('Idempotency-Key','draft-rule-test');
  const response=await f.adapter.execute('gate.test',request);
  assert.equal(response.status,undefined);
  const result=response.body as {published:boolean;action:string;matches:unknown[]};
  assert.equal(result.published,false); assert.equal(result.action,'block'); assert.equal(result.matches.length,1);
  assert.equal(f.events.length,0); f.database.close();
});

test('compliance summary resolves strongest enabled in-scope action, direction, coverage, and tallies',async()=>{
  const f=fixture(),enabledPolicy=randomUUID(),disabledPolicy=randomUUID(),groupId=randomUUID();
  f.database.prepare(`INSERT INTO groups(id,tenant_id,name,created_at,updated_at) VALUES(?,?,'Engineering',?,?)`).run(groupId,f.tenantId,f.at,f.at);
  const insertPolicy=f.database.prepare(`INSERT INTO policies(id,tenant_id,name,enabled,priority,created_at,updated_at) VALUES(?,?,?,?,100,?,?)`);
  insertPolicy.run(enabledPolicy,f.tenantId,'Enabled compliance policy',1,f.at,f.at);
  insertPolicy.run(disabledPolicy,f.tenantId,'Disabled compliance policy',0,f.at,f.at);
  const detectorIds={strongest:randomUUID(),layered:randomUUID(),uncovered:randomUUID(),disabled:randomUUID(),direction:randomUUID()};
  const insertDetector=f.database.prepare(`INSERT INTO detector_definitions(id,tenant_id,key,kind,config_json,config_sha256,enabled,builtin,created_at,updated_at) VALUES(?,?,'compliance-'||?,'keyword','{}',?, ?,0,?,?)`);
  for(const [key,id] of Object.entries(detectorIds))insertDetector.run(id,f.tenantId,key,'a'.repeat(64),key==='disabled'?0:1,f.at,f.at);
  const insertRule=f.database.prepare(`INSERT INTO policy_rules(id,tenant_id,policy_id,detector_id,scope_type,scope_id,direction,action,severity,config_json,enabled,priority,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?, 'medium','{}',?,100,?,?)`);
  const rule=(policyId:string,detectorId:string,scopeType:'tenant'|'group',scopeId:string|null,direction:'outbound'|'inbound',action:string,enabled=1)=>insertRule.run(randomUUID(),f.tenantId,policyId,detectorId,scopeType,scopeId,direction,action,enabled,f.at,f.at);
  rule(enabledPolicy,detectorIds.strongest,'tenant',null,'outbound','warn');
  rule(enabledPolicy,detectorIds.strongest,'tenant',null,'outbound','block');
  rule(enabledPolicy,detectorIds.layered,'tenant',null,'outbound','flag');
  rule(enabledPolicy,detectorIds.layered,'group',groupId,'outbound','block');
  rule(disabledPolicy,detectorIds.strongest,'tenant',null,'outbound','require_approval');
  rule(enabledPolicy,detectorIds.strongest,'tenant',null,'outbound','require_approval',0);
  rule(enabledPolicy,detectorIds.disabled,'tenant',null,'outbound','require_approval');
  rule(enabledPolicy,detectorIds.direction,'tenant',null,'inbound','redact');
  const get=async(scopeType:'tenant'|'group',scopeId?:string,direction='outbound')=>f.adapter.execute('admin.compliance.summary',{...f.request(null),query:{scopeType,direction,...(scopeId?{scopeId}:{})}});
  const tenant=(await get('tenant')).body as {detectors:Array<{detectorId:string;effectiveAction:string;covered:boolean;detectorEnabled:boolean;contributingRuleCount:number}>;summary:Record<string,number>;scopes:{groups:Array<{id:string;name:string}>}};
  const byId=(body:typeof tenant,id:string)=>body.detectors.find(row=>row.detectorId===id)!;
  assert.deepEqual(byId(tenant,detectorIds.strongest),{...byId(tenant,detectorIds.strongest),effectiveAction:'block',covered:true,detectorEnabled:true,contributingRuleCount:2});
  assert.equal(byId(tenant,detectorIds.layered).effectiveAction,'flag');
  assert.deepEqual({covered:byId(tenant,detectorIds.uncovered).covered,action:byId(tenant,detectorIds.uncovered).effectiveAction},{covered:false,action:'allow'});
  assert.deepEqual({covered:byId(tenant,detectorIds.disabled).covered,action:byId(tenant,detectorIds.disabled).effectiveAction,enabled:byId(tenant,detectorIds.disabled).detectorEnabled},{covered:false,action:'allow',enabled:false});
  assert.deepEqual({covered:byId(tenant,detectorIds.direction).covered,action:byId(tenant,detectorIds.direction).effectiveAction},{covered:false,action:'allow'});
  assert.deepEqual(tenant.scopes.groups,[{id:groupId,name:'Engineering'}]);
  const group=(await get('group',groupId)).body as typeof tenant;
  assert.equal(byId(group,detectorIds.layered).effectiveAction,'block');
  assert.equal(byId(group,detectorIds.layered).contributingRuleCount,2);
  const inbound=(await get('tenant',undefined,'inbound')).body as typeof tenant;
  assert.equal(byId(inbound,detectorIds.direction).effectiveAction,'redact');
  for(const body of [tenant,group,inbound]){
    const expected={block:0,warn:0,mask:0,redact:0,flag:0,allow:0,notCovered:0,requireApproval:0};
    for(const row of body.detectors)if(!row.covered)expected.notCovered++;else if(row.effectiveAction==='require_approval')expected.requireApproval++;else expected[row.effectiveAction as keyof typeof expected]++;
    assert.deepEqual(body.summary,expected);
  }
  assert.deepEqual(f.events,[],'compliance reads must not emit audit events');
  assert.equal((await get('group',randomUUID())).status,404);
  f.database.close();
});

test('provider list returns only a four-character BYOK suffix',async()=>{
  const f=fixture();
  f.database.prepare(`INSERT INTO provider_config(id,tenant_id,provider_key,enabled,credential_source,credential_ciphertext,key_version,config_json,created_at,updated_at)
    VALUES(?,?,'openai',1,'encrypted','sealed-secret-material',1,'{"maskedSuffix":"too-long-secret"}',?,?)`).run(randomUUID(),f.tenantId,f.at,f.at);
  const response=await f.adapter.execute('admin.providers.list',f.request(null));
  const body=response.body as {items:Array<Record<string,unknown>>};
  assert.equal(body.items[0]!.maskedSuffix,'cret');
  assert.doesNotMatch(JSON.stringify(body),/sealed-secret-material|too-long-secret/);
  f.database.close();
});

test('brand icon upload trusts image bytes, refuses SVG and ZIP, and enforces 512 KB',async()=>{
  const f=fixture(),png=Buffer.alloc(24);Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001','hex').copy(png);
  const upload=(bytes:Uint8Array,name:string,type:string)=>f.adapter.execute('admin.settings.icon',f.request({file:{name,type,arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)}}));
  const accepted=await upload(png,'renamed.svg','image/svg+xml');assert.equal(accepted.status,201);assert.equal((accepted.body as {mimeType:string}).mimeType,'image/png');
  const svg=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');const svgResult=await upload(svg,'icon.png','image/png');assert.equal(svgResult.status,422);assert.match(String((svgResult.body as {error:{message:string}}).error.message),/scripts and external references/);assert.equal((svgResult.body as {error:{details:{reason:string}}}).error.details.reason,'icon_svg_refused');
  const large=Buffer.alloc(2*1024*1024);png.copy(large);assert.equal((await upload(large,'large.png','image/png')).status,413);
  const zip=Buffer.from('504b030414000000','hex');assert.equal((await upload(zip,'lie.png','image/png')).status,422);f.database.close();
});

test('support contact accepts only HTTPS URLs and returns saved optional fields',async()=>{
  const f=fixture(),update=(body:unknown,key:string)=>{const request=f.request(body);request.headers.set('If-Match',`"${f.at}"`);request.headers.set('Idempotency-Key',key);return f.adapter.execute('admin.settings.update',request)};
  for(const [index,url] of ['javascript:alert(1)','http://internal'].entries())assert.equal((await update({supportContactUrl:url},`invalid-support-url-${index}`)).status,422);
  const updated=await update({supportVendorName:'Acme IT',supportContactEmail:'help@acme.example',supportContactUrl:'https://support.acme.example/help'},'valid-support-contact');
  const item=(updated.body as {item:Record<string,unknown>}).item;assert.equal(item.support_vendor_name,'Acme IT');assert.equal(item.support_contact_email,'help@acme.example');assert.equal(item.support_contact_url,'https://support.acme.example/help');f.database.close();
});

test('custom terms bulk writes eval-effective rule configs and moving an action changes the gate verdict',async()=>{
  const f=fixture();seedDefaultPolicy(f.database,{tenantId:f.tenantId,createdByUserId:f.userId,now:f.at});
  const upsert=(body:unknown,key:string)=>{const request=f.request(body);request.headers.set('Idempotency-Key',key);return f.adapter.execute('admin.customTerms.upsert',request)};
  const added=await upsert({terms:['Voyager-7','Voyager-7',' Blue Harbor ','Project Halcyon'],action:'block'},'custom-terms-bulk-block');
  assert.deepEqual((added.body as {counts:Record<string,number>}).counts,{flag:0,warn:0,redact:0,block:3});
  await upsert({terms:['Blue Harbor','Project Halcyon'],action:'redact'},'custom-terms-bulk-redact');
  const stored=()=>f.database.prepare(`SELECT pr.id,pr.action,pr.severity,pr.config_json,pr.enabled,pr.updated_at FROM policy_rules pr JOIN detector_definitions d ON d.id=pr.detector_id WHERE pr.tenant_id=? AND d.key='custom-terms' ORDER BY pr.action`).all(f.tenantId) as Array<Record<string,unknown>>;
  let rows=stored(),block=rows.find(row=>row.action==='block')!,redact=rows.find(row=>row.action==='redact')!;
  assert.deepEqual(JSON.parse(String(block.config_json)),{terms:['Voyager-7'],regexes:[],wholeWord:false,maxMatches:20});
  assert.deepEqual(JSON.parse(String(redact.config_json)),{terms:['Blue Harbor','Project Halcyon'],regexes:[],wholeWord:false,maxMatches:20});
  const vault=new StatelessGateVault();const evaluate=async(row:Record<string,unknown>,text:string)=>{const rule:ResolvedRule={id:String(row.id),revision:Number(row.updated_at),name:'Custom terms',detectorKind:'keyword',action:row.action as ResolvedRule['action'],passMask:'preflight',priority:1000,scopeType:'org',scopeId:f.tenantId,config:JSON.parse(String(row.config_json)) as Record<string,unknown>,failureMode:'closed',sourceOrder:0};const subject={tenantId:f.tenantId,userId:f.userId,groupIds:[],roles:['owner'] as const};const context:GateContext={evaluationId:randomUUID(),requestId:randomUUID(),pass:'preflight',subject,conversationId:null,messageId:null,projectId:null,providerId:'test',modelId:'test',locale:'en',nowMs:f.at,parts:[{id:'prompt',source:'user_prompt',text,mimeType:'text/plain',fileId:null,provenance:{}}],policySnapshot:resolvePolicy({tenantId:f.tenantId,modelId:'test',subject,pass:'preflight',policyVersion:1,rules:[rule],nowMs:f.at}),abortSignal:new AbortController().signal,confirmedWarningToken:null,metadata:{}};return new DefaultGateEngine({detectors:deterministicDetectors(),vault}).evaluate(context)};
  assert.equal((await evaluate(block,'Send Voyager-7 details')).disposition,'blocked');
  const redacted=await evaluate(redact,'Send Blue Harbor details');assert.equal(redacted.action,'redact');assert.match(redacted.providerParts![0]!.text,/⟦REDACTED:POLICY_TERM:/);
  await upsert({terms:['Voyager-7'],action:'warn'},'custom-terms-bulk-warn');rows=stored();block=rows.find(row=>row.action==='block')!;const warn=rows.find(row=>row.action==='warn')!;
  assert.equal(block.enabled,0);assert.equal(configTermsForTest(block).includes('Voyager-7'),false);assert.deepEqual(configTermsForTest(warn),['Voyager-7']);assert.equal((await evaluate(warn,'Send Voyager-7 details')).disposition,'await_user_confirmation');
  assert.deepEqual(f.events,['gate.rule_updated','gate.rule_updated','gate.rule_updated']);f.database.close();
});

test('policy adapter persists mask truthfully, evaluates it, and counts it in compliance',async()=>{
  const f=fixture();seedDefaultPolicy(f.database,{tenantId:f.tenantId,createdByUserId:f.userId,now:f.at});
  const policy=f.database.prepare("SELECT id FROM policies WHERE tenant_id=? AND deleted_at IS NULL ORDER BY priority DESC LIMIT 1").get(f.tenantId) as {id:string};
  const detector={id:randomUUID()};f.database.prepare("INSERT INTO detector_definitions(id,tenant_id,key,kind,config_json,config_sha256,enabled,builtin,created_at,updated_at) VALUES(?,?,?,'keyword','{}',?,1,0,?,?)").run(detector.id,f.tenantId,'mask-company','a'.repeat(64),f.at,f.at);
  const createRequest=f.request({policyId:policy.id,detectorId:detector.id,scopeType:'tenant',direction:'outbound',action:'mask',severity:'high',config:{terms:['Purcell'],regexes:[],wholeWord:true,maxMatches:20,maskReplacement:'a generic company'},enabled:true,priority:2000});
  createRequest.headers.set('Idempotency-Key','mask-policy-rule-create');
  const created=await f.adapter.execute('gate.rules.create',createRequest);
  assert.equal(created.status,201);const row=(created.body as {item:Record<string,unknown>}).item;assert.equal(row.action,'mask');
  const resolved:ResolvedRule={id:String(row.id),revision:Number(row.updated_at),name:'Mask company',detectorKind:'keyword',action:'mask',passMask:'preflight',priority:2000,scopeType:'org',scopeId:f.tenantId,config:JSON.parse(String(row.config_json)) as Record<string,unknown>,failureMode:'closed',sourceOrder:0};
  const subject={tenantId:f.tenantId,userId:f.userId,groupIds:[],roles:['owner'] as const},context:GateContext={evaluationId:randomUUID(),requestId:randomUUID(),pass:'preflight',subject,conversationId:null,messageId:null,projectId:null,providerId:'test',modelId:'test',locale:'en',nowMs:f.at,parts:[{id:'prompt',source:'user_prompt',text:'Ask Purcell',mimeType:'text/plain',fileId:null,provenance:{}}],policySnapshot:resolvePolicy({tenantId:f.tenantId,modelId:'test',subject,pass:'preflight',policyVersion:1,rules:[resolved],nowMs:f.at}),abortSignal:new AbortController().signal,confirmedWarningToken:null,metadata:{}};
  const verdict=await new DefaultGateEngine({detectors:deterministicDetectors()}).evaluate(context);assert.equal(verdict.action,'mask');assert.equal(verdict.providerParts![0]!.text,'Ask a generic company');assert.deepEqual(verdict.redactions,[]);
  const compliance=await f.adapter.execute('admin.compliance.summary',{...f.request(null),query:{scopeType:'tenant',direction:'outbound'}});assert.ok((compliance.body as {summary:{mask:number}}).summary.mask>=1);f.database.close();
});

function configTermsForTest(row:Record<string,unknown>):string[]{return (JSON.parse(String(row.config_json)) as {terms:string[]}).terms}

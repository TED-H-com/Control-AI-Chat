import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { createAuditService } from '../../lib/audit/index.js';
import { forTenant } from '../../lib/db.js';
import { seedDefaultPolicy, defaultPolicy } from '../../lib/gate/default-policy.js';
import { DefaultGateEngine, StatelessGateVault, deterministicDetectors, resolvePolicy } from '../../lib/gate/index.js';
import type { GateContext, GateEngine, ResolvedRule } from '../../lib/gate/index.js';
import type { AppVariables, TenantContext } from '../../lib/http/index.js';
import { runMigrations } from '../../lib/migrations/index.js';
import type { ChatProvider, ChatRequest } from '../../lib/providers/types.js';
import { createChatRoutes, type ChatGateResult, type ChatPipelineServices } from '../../routes/chat.js';
import type { StreamEvent } from '../../shared/api.js';
import type { TenantId } from '../../shared/types.js';
import type { ConfirmRunDependencies, WarnedRunPipeline } from './confirm-run.js';
import { GovernedChatApplication } from './service.js';

const NOW=Date.UTC(2026,8,28,12,0,0),WARNING_SECRET=Buffer.alloc(32,23),MASKED_VALUE='customer account reference four four seven one nine',MASK_REPLACEMENT='[x]';
const EMAIL='alice.route@leak.invalid';
type GateCorruption='none'|'missing-spans'|'wrong-replacement';

interface Fixture {
  readonly app:Hono<{Variables:AppVariables}>;
  readonly database:Database.Database;
  readonly tenantId:TenantId;
  readonly modelId:string;
  readonly context:TenantContext;
  readonly engine:DefaultGateEngine;
  readonly postflightRules:readonly ResolvedRule[];
  readonly service:GovernedChatApplication;
  readonly gateCodePoints:{inbound:number};
}

interface FixtureOptions {
  readonly chunkSize?:number;
  readonly corruption?:GateCorruption;
  readonly failProvider?:boolean;
  readonly inboundBlockTerm?:string;
  readonly maskValue?:string;
  readonly maskReplacement?:string;
  readonly redactPrivateKey?:boolean;
  readonly outboundBlockTerm?:string;
  readonly blockConfirmedOutbound?:boolean;
}

function normalizeTokens(text:string):string {
  return text.replace(/⟦REDACTED:([A-Z0-9_]{2,32}):[0-9A-HJKMNP-TV-Z]{26}:[0-9A-HJKMNP-TV-Z]{8}⟧/gu,'⟦REDACTED:$1:ID⟧');
}

function parseEvents(body:string):StreamEvent[] {
  return body.split('\n\n').flatMap(frame=>{const lines=frame.split('\n'),event=lines.find(item=>item.startsWith('event: ')),data=lines.find(item=>item.startsWith('data: '));return event&&data?[{event:event.slice(7),data:JSON.parse(data.slice(6))} as StreamEvent]:[];});
}

function deltaText(events:readonly StreamEvent[]):string {
  return events.flatMap(event=>event.event==='assistant.delta'?[event.data.text]:[]).join('');
}

function completedMessage(events:readonly StreamEvent[]):Extract<StreamEvent,{event:'run.completed'}>['data']['message'] {
  const completed=events.find((event):event is Extract<StreamEvent,{event:'run.completed'}>=>event.event==='run.completed');
  assert.ok(completed,`run must complete: ${JSON.stringify(events)}`);return completed.data.message;
}

function failedEvent(events:readonly StreamEvent[]):Extract<StreamEvent,{event:'run.failed'}> {
  const failed=events.find((event):event is Extract<StreamEvent,{event:'run.failed'}>=>event.event==='run.failed');
  assert.ok(failed,'run must fail');return failed;
}

function storedAssistantText(f:Fixture):string {
  const stored=f.database.prepare("SELECT COALESCE(p.text_content,'') text FROM messages m LEFT JOIN message_parts p ON p.tenant_id=m.tenant_id AND p.message_id=m.id AND p.ordinal=0 WHERE m.tenant_id=? AND m.role='assistant' ORDER BY m.sequence_no DESC LIMIT 1").get(f.tenantId) as {text:string};
  return stored.text;
}

function textColumnHits(database:Database.Database,tenantId:string,needle:string):string[] {
  const hits:string[]=[];
  const runTables=['audit_events','budget_reservations','conversations','gate_decisions','idempotency_records','messages','message_parts','policy_violations','routing_decisions','usage_records'];
  const existing=new Set(database.prepare("SELECT name FROM sqlite_schema WHERE type='table'").pluck().all().map(String)),tables=runTables.filter(table=>existing.has(table));
  for(const table of tables){
    if(!/^[A-Za-z0-9_]+$/u.test(table))continue;
    const columns=database.prepare(`PRAGMA table_info("${table}")`).all() as Array<{name:string;type:string}>;
    if(!columns.some(column=>column.name==='tenant_id'))continue;
    for(const column of columns.filter(item=>/(TEXT|CHAR|CLOB|JSON)/iu.test(item.type))){
      if(!/^[A-Za-z0-9_]+$/u.test(column.name))continue;
      const found=database.prepare(`SELECT 1 FROM "${table}" WHERE tenant_id=? AND instr(CAST("${column.name}" AS TEXT),?)>0 LIMIT 1`).get(tenantId,needle);
      if(found)hits.push(`${table}.${column.name}`);
    }
  }
  return hits;
}

function assertAbsentEverywhere(f:Fixture,body:string,messageText:string,fragments:readonly string[]):void {
  for(const fragment of fragments){assert.ok(!body.includes(fragment),`SSE contained ${fragment}`);assert.ok(!messageText.includes(fragment),`stored message contained ${fragment}`);assert.deepEqual(textColumnHits(f.database,f.tenantId,fragment),[],`database contained ${fragment}`);}
}

function observedGate(service:GovernedChatApplication,corruption:GateCorruption,gateCodePoints:{inbound:number}):WarnedRunPipeline {
  return new Proxy(service,{get(target,property){
    if(property==='gate')return async(tenant:TenantContext,input:{direction:'outbound'|'inbound'|'file';text:string;runId:string},signal:AbortSignal):Promise<ChatGateResult>=>{
      if(input.direction==='inbound')gateCodePoints.inbound+=Array.from(input.text).length;
      const result=await target.gate(tenant,input,signal);
      if(corruption==='none'||input.direction!=='inbound'||result.effectiveText===input.text)return result;
      if(corruption==='missing-spans'){const {replacements:_replacements,...withoutSpans}=result;return withoutSpans;}
      assert.ok(result.replacements);return{...result,replacements:result.replacements.map((item,index)=>index===0?{...item,replacement:'[disagrees-with-effective-text]'}:item)};
    };
    const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
  }}) as WarnedRunPipeline;
}

function fixture(responseText:string,options:FixtureOptions={}):Fixture {
  const database=new Database(':memory:');database.pragma('foreign_keys=ON');runMigrations(database);
  const tenantId=randomUUID() as TenantId,userId=randomUUID(),groupId=randomUUID(),modelId=randomUUID(),providerConfigId=randomUUID();
  const run=(sql:string,...parameters:unknown[])=>database.prepare(sql).run(...parameters);
  run("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,?,'Stream release','active',?,?)",tenantId,`stream-${tenantId.slice(0,8)}`,NOW,NOW);
  run('INSERT INTO tenant_settings(tenant_id,updated_at) VALUES(?,?)',tenantId,NOW);
  run("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,?,'Owner','x','active',?,?)",userId,tenantId,'owner@fixture.invalid',NOW,NOW);
  run("INSERT INTO groups(id,tenant_id,name,created_at,updated_at) VALUES(?,?,'Members',?,?)",groupId,tenantId,NOW,NOW);
  run("INSERT INTO group_members(tenant_id,group_id,user_id,source,created_at) VALUES(?,?,?,'manual',?)",tenantId,groupId,userId,NOW);
  const platform=database.prepare("SELECT id,model_key FROM platform_model_versions WHERE provider_key='openai' AND model_key='gpt-5.6-sol' AND authoritative=1").get() as {id:string;model_key:string};
  run('UPDATE platform_model_versions SET effective_from=0 WHERE id=?',platform.id);
  run("INSERT INTO model_catalog(id,tenant_id,provider_key,model_key,display_name,enabled,is_default,context_window,max_output_tokens,input_microusd_per_million,output_microusd_per_million,capabilities_json,platform_model_version_id,created_at,updated_at) VALUES(?,?,'openai',?,'Stream model',1,1,8192,4096,1000,2000,'[]',?,?,?)",modelId,tenantId,platform.model_key,platform.id,NOW,NOW);
  run("INSERT INTO provider_config(id,tenant_id,provider_key,enabled,credential_source,credential_ciphertext,key_version,config_json,created_at,updated_at) VALUES(?,?,'openai',1,'encrypted','fixture',1,'{}',?,?)",providerConfigId,tenantId,NOW,NOW);
  run('INSERT INTO group_model_access(group_id,model_catalog_id,enabled) VALUES(?,?,1)',groupId,modelId);
  run('INSERT INTO group_provider_access(group_id,provider_config_id,enabled) VALUES(?,?,1)',groupId,providerConfigId);
  seedDefaultPolicy(database,{tenantId,createdByUserId:userId,now:NOW});
  const privateKeyConfig={categories:['private_key'],minimumTokenLength:20,entropyThresholdBitsPerChar:3.5};
  if(options.redactPrivateKey)run("UPDATE policy_rules SET action='redact',config_json=? WHERE tenant_id=? AND direction='inbound' AND detector_id=(SELECT id FROM detector_definitions WHERE tenant_id=? AND key='default-secrets')",JSON.stringify(privateKeyConfig),tenantId,tenantId);
  const policyId=randomUUID(),detectorId=randomUUID(),maskConfig={terms:[options.maskValue??MASKED_VALUE],regexes:[],wholeWord:false,maxMatches:20,maskReplacement:options.maskReplacement??MASK_REPLACEMENT},maskJson=JSON.stringify(maskConfig);
  run("INSERT INTO policies(id,tenant_id,name,enabled,priority,created_by_user_id,created_at,updated_at) VALUES(?,?,'Short response mask',1,1100,?,?,?)",policyId,tenantId,userId,NOW,NOW);
  run("INSERT INTO detector_definitions(id,tenant_id,key,kind,config_json,config_sha256,enabled,builtin,created_at,updated_at) VALUES(?,?,?,'keyword',?,?,1,0,?,?)",detectorId,tenantId,'short-response-mask',maskJson,createHash('sha256').update(maskJson).digest('hex'),NOW,NOW);
  const maskRuleId=randomUUID();
  run("INSERT INTO policy_rules(id,tenant_id,policy_id,detector_id,scope_type,scope_id,direction,action,severity,config_json,enabled,priority,created_at,updated_at) VALUES(?,?,?,?, 'tenant',NULL,'inbound','mask','high',?,1,1100,?,?)",maskRuleId,tenantId,policyId,detectorId,maskJson,NOW,NOW);
  if(options.outboundBlockTerm){
    const blockDetectorId=randomUUID(),blockConfig=JSON.stringify({terms:[options.outboundBlockTerm],regexes:[],wholeWord:false,maxMatches:20});
    run("INSERT INTO detector_definitions(id,tenant_id,key,kind,config_json,config_sha256,enabled,builtin,created_at,updated_at) VALUES(?,?,?,'keyword',?,?,1,0,?,?)",blockDetectorId,tenantId,'outbound-block',blockConfig,createHash('sha256').update(blockConfig).digest('hex'),NOW,NOW);
    run("INSERT INTO policy_rules(id,tenant_id,policy_id,detector_id,scope_type,scope_id,direction,action,severity,config_json,enabled,priority,created_at,updated_at) VALUES(?,?,?,?, 'tenant',NULL,'outbound','block','high',?,1,1200,?,?)",randomUUID(),tenantId,policyId,blockDetectorId,blockConfig,NOW,NOW);
  }
  if(options.inboundBlockTerm){
    const blockDetectorId=randomUUID(),blockConfig=JSON.stringify({terms:[options.inboundBlockTerm],regexes:[],wholeWord:false,maxMatches:20});
    run("INSERT INTO detector_definitions(id,tenant_id,key,kind,config_json,config_sha256,enabled,builtin,created_at,updated_at) VALUES(?,?,?,'keyword',?,?,1,0,?,?)",blockDetectorId,tenantId,'inbound-block',blockConfig,createHash('sha256').update(blockConfig).digest('hex'),NOW,NOW);
    run("INSERT INTO policy_rules(id,tenant_id,policy_id,detector_id,scope_type,scope_id,direction,action,severity,config_json,enabled,priority,created_at,updated_at) VALUES(?,?,?,?, 'tenant',NULL,'inbound','block','high',?,1,1200,?,?)",randomUUID(),tenantId,policyId,blockDetectorId,blockConfig,NOW,NOW);
  }

  const provider:ChatProvider={id:'openai',protocols:['openai_responses'],configured:true,supports:()=>true,health:()=>({configured:true,circuit:'closed',recentFailureRate:0}),async *stream(request:ChatRequest){
    yield{type:'start',requestId:`provider-${request.context.streamId}`,model:request.model,createdAt:NOW};
    if(options.failProvider)throw Object.assign(new Error('fixture provider failure'),{code:'PROVIDER_UNAVAILABLE'});
    const chunkSize=options.chunkSize??7,points=Array.from(responseText);for(let offset=0;offset<points.length;offset+=chunkSize)yield{type:'text_delta',index:offset/chunkSize,delta:points.slice(offset,offset+chunkSize).join('')};
    yield{type:'usage',usage:{inputTokens:5,outputTokens:10,reasoningTokens:0,cachedInputTokens:0,cacheWriteTokens:0,toolInputTokens:0,totalTokens:15,estimated:false,source:'provider'}};
    yield{type:'finish',reason:'stop'};
  }};
  const audit=createAuditService({database,ipHmacKey:Buffer.alloc(32,4),transcriptKey:()=>Buffer.alloc(32,5),retentionPolicy:id=>({tenantId:id,chatTranscriptDays:90,violationTranscriptDays:365,approvalPayloadDays:30,auditMetadataDays:null,captureTranscripts:false,effectiveAtMs:NOW}),now:()=>NOW});
  const engine=new DefaultGateEngine({detectors:deterministicDetectors(),vault:new StatelessGateVault(),warningSecret:WARNING_SECRET});
  const serviceGate:GateEngine=options.blockConfirmedOutbound?new Proxy(engine,{get(target,property){
    if(property==='evaluate')return async(context:GateContext)=>{const result=await target.evaluate(context);return context.pass==='preflight'&&context.metadata.direction==='outbound'&&Boolean(context.confirmedWarningToken)
      ?{...result,action:'block' as const,disposition:'blocked' as const,providerParts:null,displayParts:null,warningToken:null,approvalRequestId:null}:result;};
    const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
  }}):engine;
  const service=new GovernedChatApplication({database,gate:serviceGate,providers:{get:()=>provider},audit,approvalPayloadKey:Buffer.alloc(32,6),now:()=>NOW});
  const gateCodePoints={inbound:0},chat=observedGate(service,options.corruption??'none',gateCodePoints),context={principal:{tenantId,userId,membershipId:userId,sessionId:randomUUID(),roles:['owner'],permissions:new Set(['chat:use'])},db:forTenant({tenantId}),requestId:randomUUID(),now:new Date(NOW)} as TenantContext;
  const confirmations:ConfirmRunDependencies={database,chat,audit,warningSecret:WARNING_SECRET,policyFingerprint:tenant=>chat.policyFingerprint(tenant),now:()=>NOW};
  const app=new Hono<{Variables:AppVariables}>();app.use('*',async(c,next)=>{c.set('requestId',context.requestId);c.set('principal',context.principal);c.set('tenant',context);await next();});app.route('/',createChatRoutes(chat as ChatPipelineServices,confirmations));
  const pii=defaultPolicy.detectors.find(item=>item.key==='default-pii')!;
  const postflightRules:ResolvedRule[]=[
    {id:'expected-default-pii',revision:1,name:pii.key,detectorKind:'pii',action:'redact',passMask:'postflight',priority:1000,scopeType:'org',scopeId:tenantId,config:pii.config,failureMode:'closed',sourceOrder:1},
    {id:maskRuleId,revision:NOW,name:'Short response mask',detectorKind:'keyword',action:'mask',passMask:'postflight',priority:1100,scopeType:'org',scopeId:tenantId,config:maskConfig,failureMode:'closed',sourceOrder:0},
  ];
  if(options.redactPrivateKey)postflightRules.push({id:'expected-private-key',revision:NOW,name:'Private key redaction',detectorKind:'secret',action:'redact',passMask:'postflight',priority:1000,scopeType:'org',scopeId:tenantId,config:privateKeyConfig,failureMode:'closed',sourceOrder:2});
  return{app,database,tenantId,modelId,context,engine,postflightRules,service,gateCodePoints};
}

async function wholeResponseDisplay(f:Fixture,text:string):Promise<string> {
  const subject={tenantId:f.tenantId,userId:f.context.principal.userId,groupIds:[],roles:['owner'] as const};
  const context:GateContext={evaluationId:randomUUID(),requestId:randomUUID(),pass:'postflight',subject,conversationId:null,messageId:null,projectId:null,providerId:'openai',modelId:f.modelId,locale:'en',nowMs:NOW,parts:[{id:'response',source:'provider_response',text,mimeType:'text/plain',fileId:null,provenance:{}}],policySnapshot:resolvePolicy({tenantId:f.tenantId,modelId:f.modelId,subject,pass:'postflight',policyVersion:1,rules:f.postflightRules,nowMs:NOW}),abortSignal:new AbortController().signal,confirmedWarningToken:null,metadata:{direction:'inbound'}};
  const verdict=await f.engine.evaluate(context);return verdict.displayParts?.[0]?.text??'';
}

function request(modelId:string,content:string):RequestInit {
  return{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':randomUUID()},body:JSON.stringify({content,modelId,mode:'single',clientRequestId:randomUUID()})};
}

function replayPair(events:readonly StreamEvent[]):{notice:Extract<StreamEvent,{event:'gate.notice'}>;failure:Extract<StreamEvent,{event:'run.failed'}>} {
  const notice=events.find((event):event is Extract<StreamEvent,{event:'gate.notice'}>=>event.event==='gate.notice'&&event.data.action==='block');
  const failure=events.find((event):event is Extract<StreamEvent,{event:'run.failed'}>=>event.event==='run.failed');
  assert.ok(notice);assert.ok(failure);return{notice,failure};
}

async function runDirect(f:Fixture):Promise<{body:string;events:StreamEvent[]}> {
  const response=await f.app.request('/chat/runs',request(f.modelId,'Give a safe answer'));assert.equal(response.status,200);const body=await response.text();return{body,events:parseEvents(body)};
}

async function runConfirmed(f:Fixture):Promise<{body:string;events:StreamEvent[]}> {
  const warned=await f.app.request('/chat/runs',request(f.modelId,'Review the company confidential plan'));assert.equal(warned.status,200);const warningEvents=parseEvents(await warned.text());
  const notice=warningEvents.find((event):event is Extract<StreamEvent,{event:'gate.notice'}>=>event.event==='gate.notice'&&event.data.action==='warn');assert.ok(notice&&notice.data.confirmationToken);
  const response=await f.app.request(`/gate/confirmations/${notice.data.confirmationToken}`,{method:'POST'});assert.equal(response.status,200);const body=await response.text();return{body,events:parseEvents(body)};
}

test('chat route releases a real-engine email display without leaking response coordinates',async()=>{
  const raw=`Start ${EMAIL} end ${'safe '.repeat(500)}`,f=fixture(raw);
  try{const expected=await wholeResponseDisplay(f,raw),result=await runDirect(f),message=completedMessage(result.events),streamed=deltaText(result.events);
    assert.equal(normalizeTokens(streamed),normalizeTokens(expected));assert.equal(message.content,streamed);assert.equal(message.gate?.protectedItemCount,1);
    assertAbsentEverywhere(f,result.body,message.content,[EMAIL,'alice.route','@leak.invalid']);
  }finally{f.service.stop();f.database.close();}
});

test('chat route releases a shorter real-engine mask without leaking any original fragment',async()=>{
  const raw=`Before ${MASKED_VALUE} after ${'safe '.repeat(500)}`,f=fixture(raw);
  try{const expected=await wholeResponseDisplay(f,raw),result=await runDirect(f),message=completedMessage(result.events),streamed=deltaText(result.events);
    assert.equal(streamed,expected);assert.match(streamed,/Before \[x\] after/u);assert.equal(message.content,streamed);assert.equal(message.gate?.protectedItemCount,1);
    assertAbsentEverywhere(f,result.body,message.content,[MASKED_VALUE,'customer account','seven one nine']);
  }finally{f.service.stop();f.database.close();}
});

test('confirmed-warning route releases the same real-engine email display without leaking coordinates',async()=>{
  const raw=`Start ${EMAIL} end ${'safe '.repeat(500)}`,f=fixture(raw);
  try{const expected=await wholeResponseDisplay(f,raw),result=await runConfirmed(f),message=completedMessage(result.events),streamed=deltaText(result.events);
    assert.equal(normalizeTokens(streamed),normalizeTokens(expected));assert.equal(message.content,streamed);assert.equal(message.gate?.protectedItemCount,1);
    assertAbsentEverywhere(f,result.body,message.content,[EMAIL,'alice.route','@leak.invalid']);
  }finally{f.service.stop();f.database.close();}
});

test('direct outbound block replays its live notice and null partial id through POST and GET',async()=>{
  const content='route outbound block token',f=fixture('unused',{outboundBlockTerm:content}),key=randomUUID(),clientRequestId=randomUUID(),init:RequestInit={method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify({content,modelId:f.modelId,mode:'single',clientRequestId})};
  try{
    const live=replayPair(parseEvents(await (await f.app.request('/chat/runs',init)).text())),runId=live.failure.data.runId;
    const post=replayPair(parseEvents(await (await f.app.request('/chat/runs',init)).text()));
    const getResponse=await f.app.request(`/chat/runs/${runId}/events`);assert.equal(getResponse.status,200);const get=replayPair(parseEvents(await getResponse.text()));
    assert.deepEqual(post,live);assert.deepEqual(get,live);assert.equal(live.failure.data.partialMessageId,null);
  }finally{f.service.stop();f.database.close();}
});

test('confirmed outbound block replays its live notice and null partial id through POST and GET',async()=>{
  const content='Review the company confidential plan',f=fixture('unused',{blockConfirmedOutbound:true}),key=randomUUID(),clientRequestId=randomUUID(),init:RequestInit={method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify({content,modelId:f.modelId,mode:'single',clientRequestId})};
  try{
    const warningEvents=parseEvents(await (await f.app.request('/chat/runs',init)).text()),warning=warningEvents.find((event):event is Extract<StreamEvent,{event:'gate.notice'}>=>event.event==='gate.notice'&&event.data.action==='warn');assert.ok(warning?.data.confirmationToken);
    const confirmed=await f.app.request(`/gate/confirmations/${warning.data.confirmationToken}`,{method:'POST'});assert.equal(confirmed.status,200);const live=replayPair(parseEvents(await confirmed.text())),runId=live.failure.data.runId;
    const post=replayPair(parseEvents(await (await f.app.request('/chat/runs',init)).text()));
    const getResponse=await f.app.request(`/chat/runs/${runId}/events`);assert.equal(getResponse.status,200);const get=replayPair(parseEvents(await getResponse.text()));
    assert.deepEqual(post,live);assert.deepEqual(get,live);assert.equal(live.failure.data.partialMessageId,null);
  }finally{f.service.stop();f.database.close();}
});

for(const path of ['direct','confirmed'] as const)for(const failure of ['provider','inbound-block'] as const)test(`${path} ${failure} failure replays its live assistant partial id through POST and GET`,async()=>{
  const responseText='provider response blocked by inbound policy',options:FixtureOptions=failure==='provider'?{failProvider:true}:{inboundBlockTerm:responseText},f=fixture(responseText,options),key=randomUUID(),clientRequestId=randomUUID(),content=path==='confirmed'?'Review the company confidential plan':'Give a safe answer',init:RequestInit={method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify({content,modelId:f.modelId,mode:'single',clientRequestId})};
  try{
    let liveEvents:StreamEvent[];
    if(path==='direct')liveEvents=parseEvents(await (await f.app.request('/chat/runs',init)).text());
    else{
      const warningEvents=parseEvents(await (await f.app.request('/chat/runs',init)).text()),warning=warningEvents.find((event):event is Extract<StreamEvent,{event:'gate.notice'}>=>event.event==='gate.notice'&&event.data.action==='warn');assert.ok(warning?.data.confirmationToken);
      const confirmed=await f.app.request(`/gate/confirmations/${warning.data.confirmationToken}`,{method:'POST'});assert.equal(confirmed.status,200);liveEvents=parseEvents(await confirmed.text());
    }
    const live=failedEvent(liveEvents),created=liveEvents.find((event):event is Extract<StreamEvent,{event:'message.created'}>=>event.event==='message.created');assert.ok(created);
    assert.equal(live.data.partialMessageId,created.data.message.id);assert.notEqual(live.data.partialMessageId,null);
    if(failure==='provider')assert.deepEqual({code:live.data.error.code,retryable:live.data.error.retryable},{code:'PROVIDER_UNAVAILABLE',retryable:true});
    else assert.deepEqual({code:live.data.error.code,retryable:live.data.error.retryable},{code:'GATE_BLOCKED',retryable:false});
    const post=failedEvent(parseEvents(await (await f.app.request('/chat/runs',init)).text()));
    const getResponse=await f.app.request(`/chat/runs/${live.data.runId}/events`);assert.equal(getResponse.status,200);const get=failedEvent(parseEvents(await getResponse.text()));
    assert.deepEqual(post,live);assert.deepEqual(get,live);
  }finally{f.service.stop();f.database.close();}
});

for(const path of ['direct','confirmed'] as const)for(const corruption of ['missing-spans','wrong-replacement'] as const)test(`${path} route fails internally when the gate returns ${corruption}`,async()=>{
  const raw=`Start ${EMAIL} end ${'safe '.repeat(500)}`,f=fixture(raw,{corruption});
  try{const result=path==='direct'?await runDirect(f):await runConfirmed(f),failed=failedEvent(result.events);
    assert.equal(failed.data.error.code,'INTERNAL_ERROR');assert.ok(!result.events.some(event=>event.event==='run.completed'));
    assertAbsentEverywhere(f,result.body,storedAssistantText(f),[EMAIL,'alice.route','@leak.invalid']);
  }finally{f.service.stop();f.database.close();}
});

for(const path of ['direct','confirmed'] as const)for(const chunkSize of [1,3])test(`${path} route rejects a prefix-coincident mask without spans in ${chunkSize}-code-point chunks`,async()=>{
  const phone='0912345678',raw=`${phone}${'x'.repeat(2_040)}`,f=fixture(raw,{chunkSize,corruption:'missing-spans',maskValue:phone,maskReplacement:'09XXXXXXXX'});
  try{const expected=await wholeResponseDisplay(f,raw);assert.ok(expected.startsWith('09XXXXXXXX'));
    const result=path==='direct'?await runDirect(f):await runConfirmed(f),failed=failedEvent(result.events);
    assert.equal(failed.data.error.code,'INTERNAL_ERROR');assert.ok(!result.events.some(event=>event.event==='run.completed'));
    assertAbsentEverywhere(f,result.body,storedAssistantText(f),['12345678']);
  }finally{f.service.stop();f.database.close();}
});

test('a growing real-engine email match fails closed with bounded gate input and no email fragment released',async()=>{
  const raw=`Contact a@b${'.cc'.repeat(20_000)}`,plain=Array.from('Plain response. '.repeat(5_000)).slice(0,Array.from(raw).length).join(''),plainFixture=fixture(plain,{chunkSize:64});
  let plainGateCodePoints=0;
  try{const result=await runDirect(plainFixture);completedMessage(result.events);plainGateCodePoints=plainFixture.gateCodePoints.inbound;}
  finally{plainFixture.service.stop();plainFixture.database.close();}
  const f=fixture(raw,{chunkSize:64});
  try{const result=await runDirect(f),failed=failedEvent(result.events);
    assert.equal(failed.data.error.code,'INTERNAL_ERROR');assert.ok(!result.events.some(event=>event.event==='run.completed'));
    assertAbsentEverywhere(f,result.body,storedAssistantText(f),['a@b']);
    assert.ok(f.gateCodePoints.inbound<=plainGateCodePoints*2,`growing match scanned ${f.gateCodePoints.inbound} code points; plain text scanned ${plainGateCodePoints}`);
  }finally{f.service.stop();f.database.close();}
});

test('a complete long private key streams as exactly one redaction token',async()=>{
  const keyLines=Array.from({length:100},(_,index)=>`fixture-private-key-body-line-${String(index).padStart(3,'0')}-${'A'.repeat(24)}`),key=`-----BEGIN PRIVATE KEY-----\n${keyLines.join('\n')}\n-----END PRIVATE KEY-----`,raw=`${key}\n${'Safe follow-up text. '.repeat(150)}`,f=fixture(raw,{chunkSize:64,redactPrivateKey:true});
  try{const expected=await wholeResponseDisplay(f,raw),result=await runDirect(f),message=completedMessage(result.events),streamed=deltaText(result.events),normalized=normalizeTokens(streamed);
    assert.equal(normalized,normalizeTokens(expected));assert.equal(message.content,streamed);assert.equal(message.gate?.protectedItemCount,1);
    assert.equal((normalized.match(/⟦REDACTED:PRIVATE_KEY:ID⟧/gu)??[]).length,1);
    for(const line of keyLines){assert.ok(!streamed.includes(line),`delta contained key line ${line}`);assert.ok(!message.content.includes(line),`stored message contained key line ${line}`);}
    assertAbsentEverywhere(f,result.body,message.content,['fixture-private-key-body-line-']);
  }finally{f.service.stop();f.database.close();}
});

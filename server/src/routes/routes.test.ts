import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Hono } from 'hono';
import { POSTFLIGHT_STREAM_HOLDBACK_CODE_POINTS } from '../lib/gate/engine.js';
import type { AppVariables } from '../lib/http/index.js';
import type { ChatRun, Message, Permission, TenantId, UsageSummary } from '../shared/api.js';
import { routeDefinitions } from './catalog.js';
import type { ChatPipelineServices } from './chat.js';
import { extractUpload, sniffUpload } from './files.js';
import { ROLE_PERMISSIONS } from '../shared/permissions.js';
import { DefaultGateEngine, StatelessGateVault, resolvePolicy } from '../lib/gate/index.js';
import { PiiDetector } from '../lib/gate/detectors/pii.js';
import { defaultPolicy } from '../lib/gate/default-policy.js';
import type { GateContext, ResolvedRule } from '../lib/gate/types.js';

process.env.JWT_SECRET ??='route-test-secret-route-test-secret';
const {createChatRoutes,governedPipelineError}=await import('./chat.js');
const {mountDefinitions}=await import('./http.js');

const permissions=new Set<Permission>(['model:read','project:read','project:write']);
function tenantMiddleware(app:Hono<{Variables:AppVariables}>):void { app.use('*',async(c,next)=>{const tenantId='00000000-0000-4000-8000-000000000001' as TenantId;const principal={tenantId,userId:'u',membershipId:'m',roles:['member'] as const,permissions,sessionId:'s'};c.set('requestId','req');c.set('principal',principal);c.set('tenant',{principal,requestId:'req',now:new Date(),db:{tenantId,get:()=>undefined,all:()=>[],run:()=>({changes:0,lastInsertRowid:0})}});await next();}); }

test('catalog registers every retained contract family and structurally passes tenant context',async()=>{const seen:string[]=[];const app=new Hono<{Variables:AppVariables}>();tenantMiddleware(app);mountDefinitions(app,{async execute(operation,request){seen.push(operation);assert.equal(request.tenant?.principal.userId,'u');return {body:[]};}},routeDefinitions);const response=await app.request('/models');assert.equal(response.status,200);assert.deepEqual(seen,['models.available']);for(const prefix of ['auth.','identity.','conversations.','projects.','skills.','files.','gate.','audit.','budgets.','admin.'])assert.ok(routeDefinitions.some(route=>route.operation.startsWith(prefix)),prefix);});

test('the login route preserves recovery-code strings for identity-service normalization',async()=>{
 const code='  ab_cd - ef-gh  ';let body:unknown;
 const app=new Hono<{Variables:AppVariables}>();mountDefinitions(app,{async execute(operation,request){assert.equal(operation,'auth.login');body=request.body;return{body:{ok:true}};}},routeDefinitions);
 const response=await app.request('/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mfaTicket:'signed-ticket',code})});
 assert.equal(response.status,200);assert.deepEqual(body,{mfaTicket:'signed-ticket',code});
});

test('the MFA delete client contract accepts an empty request body',async()=>{
 let called=false;const app=new Hono<{Variables:AppVariables}>();tenantMiddleware(app);mountDefinitions(app,{async execute(operation,request){called=true;assert.equal(operation,'identity.mfaDelete');assert.equal(request.body,undefined);return{};}},routeDefinitions);
 const response=await app.request('/identity/mfa/totp',{method:'DELETE'});
 assert.equal(response.status,204);assert.equal(called,true);assert.equal(await response.text(),'');
});

test('MFA routes do not claim replay idempotency for one-time secret responses',()=>{
 for(const operation of ['identity.mfaSetup','identity.mfaVerify','identity.mfaDelete']){
  const route=routeDefinitions.find(candidate=>candidate.operation===operation);
  assert.ok(route,operation);assert.equal(route.idempotency,undefined,operation);
 }
});

test('self-serve signup, marketing, platform, and public mirror routes are absent',async()=>{
  assert.equal(routeDefinitions.some(route=>route.path==='/auth/signup'||route.path.startsWith('/marketing/')||route.path.startsWith('/platform/')),false);
  const app=new Hono<{Variables:AppVariables}>(),v1=new Hono<{Variables:AppVariables}>();mountDefinitions(v1,{async execute(){return{body:{unexpected:true}}}},routeDefinitions);app.route('/api/v1',v1);
  assert.equal((await app.request('/api/v1/auth/signup',{method:'POST'})).status,404);
  assert.equal((await app.request('/api/public/demo-registrations',{method:'POST'})).status,404);
});

test('detector analytics is an audit-readable GET operation',()=>{
  assert.deepEqual(routeDefinitions.find(route=>route.operation==='admin.analytics.detectors'),{method:'GET',path:'/admin/analytics/detectors',operation:'admin.analytics.detectors',access:'tenant',permission:'audit:read',body:'none'});
});

test('credential recovery routes expose public non-idempotent reset and protected admin issuance',()=>{
  const forgot=routeDefinitions.find(route=>route.operation==='auth.passwordForgot'),reset=routeDefinitions.find(route=>route.operation==='auth.passwordReset'),admin=routeDefinitions.find(route=>route.operation==='admin.users.credentialLink');
  assert.deepEqual(forgot,{method:'POST',path:'/auth/password/forgot',operation:'auth.passwordForgot',access:'public',body:'json',success:202});
  assert.deepEqual(reset,{method:'POST',path:'/auth/password/reset',operation:'auth.passwordReset',access:'public',body:'json'});
  assert.deepEqual(admin,{method:'POST',path:'/admin/users/:id/credential-link',operation:'admin.users.credentialLink',access:'tenant',permission:'admin:users',body:'json',idempotency:true});
});

// createV1Routes mounts the catalog first, so any path the catalog also declares wins forever and the
// streaming handler beneath it is dead code that still typechecks and still passes its own unit tests.
// gate.confirm shipped that way. Compare the two tables instead of trusting the reading order.
test('the sign-in screen can reach the deployment brand and its icon without a session',()=>{
  const routes=Object.fromEntries(routeDefinitions.map(route=>[`${route.method} ${route.path}`,route]));
  for(const key of ['GET /deployment','GET /deployment/icon']){
    const route=routes[key];assert.ok(route,`${key} must exist`);
    assert.equal(route!.access,'public',`${key} is rendered before anyone has authenticated`);
  }
  // Who maintains the installation is a different question. A phone number and a free-text note
  // are sensitive support details, so they stay behind a session.
  const support=routes['GET /deployment/support'];
  assert.ok(support,'GET /deployment/support must exist');
  assert.equal(support!.access,'tenant');
});

test('no streaming route is shadowed by a catalog definition',()=>{
  const stub={} as unknown as Parameters<typeof createChatRoutes>[1];
  const streamed=createChatRoutes({} as unknown as ChatPipelineServices,stub).routes;
  assert.ok(streamed.some(route=>route.path==='/gate/confirmations/:token'),'confirmation route is not registered');
  const catalog=new Set(routeDefinitions.map(route=>`${route.method} ${route.path}`));
  for(const route of streamed)assert.ok(!catalog.has(`${route.method} ${route.path}`),`${route.method} ${route.path} is shadowed by the catalog`);
});

// The same failure one level down: /budgets/me was declared after GET /budgets/:id, so it resolved
// to budgets.get with id='me' and answered 404 for every caller. A literal path is unreachable if any
// earlier route of the same method already matches it, and only the earlier one is ever invoked.
test('no literal route is shadowed by an earlier parameterised one',()=>{
  const matches=(pattern:string,path:string):boolean=>{
    const a=pattern.split('/'),b=path.split('/');
    return a.length===b.length&&a.every((segment,index)=>segment.startsWith(':')||segment===b[index]);
  };
  for(const [index,route] of routeDefinitions.entries()){
    if(route.path.includes(':'))continue;
    const shadow=routeDefinitions.slice(0,index).find(earlier=>earlier.method===route.method&&matches(earlier.path,route.path));
    assert.ok(!shadow,`${route.method} ${route.path} (${route.operation}) is unreachable: ${shadow?.path} (${shadow?.operation}) is declared first and matches it`);
  }
});

test('preconditions and permissions fail before service invocation',async()=>{let called=false;const app=new Hono<{Variables:AppVariables}>();tenantMiddleware(app);mountDefinitions(app,{async execute(){called=true;return{};}},routeDefinitions);const response=await app.request('/projects/x',{method:'PATCH',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(response.status,428);assert.equal(called,false);});

test('separation-of-duties routes reject administrators and admit compliance reviewers',async()=>{
  const cases=[
    {operation:'gate.approvalDecision',path:'/gate/approvals/approval-id/decision',body:{decision:'deny',reason:'Policy review'},ifMatch:true},
    {operation:'admin.violationStatus',path:'/admin/violations/violation-id/status',body:{status:'in_review'},ifMatch:true},
    {operation:'audit.createExport',path:'/audit/exports',body:{format:'json'},ifMatch:false},
  ] as const;
  for(const entry of cases){
    const route=routeDefinitions.find(definition=>definition.operation===entry.operation);assert.ok(route,entry.operation);
    for(const role of ['admin','compliance'] as const){
      let called=false;const app=new Hono<{Variables:AppVariables}>();
      app.use('*',async(c,next)=>{const tenantId='00000000-0000-4000-8000-000000000001' as TenantId,principal={tenantId,userId:'u',membershipId:'m',roles:[role],permissions:new Set(ROLE_PERMISSIONS[role]),sessionId:'s'};c.set('requestId','req');c.set('principal',principal);c.set('tenant',{principal,requestId:'req',now:new Date(),db:{tenantId,get:()=>undefined,all:()=>[],run:()=>({changes:0,lastInsertRowid:0})}});await next()});
      mountDefinitions(app,{async execute(){called=true;return{status:204}}},[route]);
      const response=await app.request(entry.path,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':`${entry.operation}-${role}`,...(entry.ifMatch?{'If-Match':'"1"'}:{})},body:JSON.stringify(entry.body)});
      assert.equal(response.status,role==='admin'?403:204,`${entry.operation}:${role}`);assert.equal(called,role==='compliance',`${entry.operation}:${role}`);
    }
  }
});

test('legal-hold writes admit owners and compliance reviewers only, while administrators may list',async()=>{
  for(const operation of ['admin.legalHolds.create','admin.legalHolds.release'] as const){
    const route=routeDefinitions.find(definition=>definition.operation===operation);assert.ok(route);
    for(const role of ['owner','compliance','admin','member'] as const){
      let called=false;const app=new Hono<{Variables:AppVariables}>();
      app.use('*',async(c,next)=>{const tenantId='00000000-0000-4000-8000-000000000001' as TenantId,principal={tenantId,userId:'u',membershipId:'m',roles:[role],permissions:new Set(ROLE_PERMISSIONS[role]),sessionId:'s'};c.set('requestId','req');c.set('principal',principal);c.set('tenant',{principal,requestId:'req',now:new Date(),db:{tenantId,get:()=>undefined,all:()=>[],run:()=>({changes:0,lastInsertRowid:0})}});await next()});
      mountDefinitions(app,{async execute(){called=true;return{status:204}}},[route]);
      const path=operation.endsWith('release')?'/admin/legal-holds/hold-id/release':'/admin/legal-holds';
      const response=await app.request(path,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':`${operation}-${role}`},body:JSON.stringify({reason:'Matter'})});
      assert.equal(response.status,role==='owner'||role==='compliance'?204:403,`${operation}:${role}`);assert.equal(called,role==='owner'||role==='compliance');
    }
  }
  const list=routeDefinitions.find(definition=>definition.operation==='admin.legalHolds.list');assert.ok(list);
  let called=false;const app=new Hono<{Variables:AppVariables}>();const tenantId='00000000-0000-4000-8000-000000000001' as TenantId,principal={tenantId,userId:'u',membershipId:'m',roles:['admin'] as const,permissions:new Set(ROLE_PERMISSIONS.admin),sessionId:'s'};
  app.use('*',async(c,next)=>{c.set('requestId','req');c.set('principal',principal);c.set('tenant',{principal,requestId:'req',now:new Date(),db:{tenantId,get:()=>undefined,all:()=>[],run:()=>({changes:0,lastInsertRowid:0})}});await next()});mountDefinitions(app,{async execute(){called=true;return{body:{items:[]}}}},[list]);
  assert.equal((await app.request('/admin/legal-holds')).status,200);assert.equal(called,true);
});

test('retention reads admit compliance reviewers and reject members',async()=>{
  const routes=['admin.retention.list','admin.legalHolds.list','admin.legalHolds.users'].map(operation=>{const route=routeDefinitions.find(definition=>definition.operation===operation);assert.ok(route,operation);return route});
  for(const role of ['compliance','member'] as const){let calls=0;const app=new Hono<{Variables:AppVariables}>(),tenantId='00000000-0000-4000-8000-000000000001' as TenantId,principal={tenantId,userId:'u',membershipId:'m',roles:[role],permissions:new Set(ROLE_PERMISSIONS[role]),sessionId:'s'};
    app.use('*',async(c,next)=>{c.set('requestId','req');c.set('principal',principal);c.set('tenant',{principal,requestId:'req',now:new Date(),db:{tenantId,get:()=>undefined,all:()=>[],run:()=>({changes:0,lastInsertRowid:0})}});await next()});mountDefinitions(app,{async execute(){calls++;return{body:{items:[],nextCursor:null}}}},routes);
    for(const path of ['/admin/retention','/admin/legal-holds','/admin/legal-hold-users'])assert.equal((await app.request(path)).status,role==='compliance'?200:403,`${role}:${path}`);
    assert.equal(calls,role==='compliance'?3:0);
  }
});

test('group-provider PUT rejects a missing relationship version before service invocation',async()=>{
  const route=routeDefinitions.find(definition=>definition.operation==='admin.providers.setGroupAccess');
  assert.ok(route,'the group-provider write route must be registered');let called=false;permissions.add('model:write');
  try{const app=new Hono<{Variables:AppVariables}>();tenantMiddleware(app);mountDefinitions(app,{async execute(){called=true;return{};}},[route]);
    const response=await app.request('/admin/groups/group-id/providers/openai',{method:'PUT',headers:{'Content-Type':'application/json','Idempotency-Key':'group-provider-precondition'},body:JSON.stringify({enabled:true})});
    assert.equal(response.status,428);assert.equal(((await response.json()) as {error:{code:string}}).error.code,'PRECONDITION_REQUIRED');assert.equal(called,false);
  }finally{permissions.delete('model:write')}
  assert.equal(route.ifMatch,true);
});

test('text uploads are sniffed and decoded while executables fail closed',()=>{const bytes=new TextEncoder().encode('a,b\n1,2');assert.equal(sniffUpload(bytes,'text/csv'),'text/csv');assert.equal(extractUpload(bytes,'text/csv').text,'a,b\n1,2');assert.equal(sniffUpload(Uint8Array.from([0x4d,0x5a]),'text/plain'),null);});

test('chat stream preserves gate, budget, provider, settlement, audit order',async()=>{const order:string[]=[];const run:ChatRun={id:'r',conversationId:'c',userMessageId:'u',assistantMessageId:'a',status:'queued',streamUrl:'/r',createdAt:new Date().toISOString()};const message:Message={id:'a',conversationId:'c',parentMessageId:null,role:'assistant',content:'',modelId:'m',provider:'openai',createdAt:new Date().toISOString(),inputTokens:null,outputTokens:null,costUsd:null,gate:null,attachments:[],version:1};const usage:UsageSummary={inputTokens:1,outputTokens:1,totalTokens:2,costUsd:.01,modelId:'m',provider:'openai',budgetWarnings:[]};
  const service:ChatPipelineServices={async createRun(){order.push('create');return{run,assistant:message,providerRequest:{},outboundText:'hi'};},async gate(_t,input){order.push(`gate:${input.direction}`);return{decisionId:'d',action:'allow',protectedItemCount:0,effectiveText:input.text,message:''};},async reserveBudget(){order.push('reserve');return{id:'b'};},async dispatchStarted(){order.push('dispatch');},async *streamProvider(){order.push('provider');yield{type:'text',text:'ok'};yield{type:'usage',inputTokens:1,outputTokens:1,costUsd:.01};},async persistEvent(){},async complete(){order.push('settle');return{...message,content:'ok'};},async fail(){order.push('fail');},async audit(){order.push('audit');},async getRun(){return run;},async *replay(){},async cancel(){return'terminal';}};
  const app=new Hono<{Variables:AppVariables}>();permissions.add('chat:use');tenantMiddleware(app);app.route('/',createChatRoutes(service));const response=await app.request('/chat/runs',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'k'},body:JSON.stringify({content:'hi',modelId:'m',clientRequestId:'x'})});assert.equal(response.status,200);const body=await response.text();assert.match(body,/event: run.created/);assert.match(body,/event: run.completed/);assert.deepEqual(order,['create','gate:outbound','reserve','dispatch','provider','gate:inbound','gate:inbound','settle','audit']);});

test('chat stream reports redact counts while allow and flag remain quiet',async()=>{
  const stream=async(outbound:'allow'|'flag'|'redact',inbound:'allow'|'redact')=>{const run:ChatRun={id:`run-${outbound}-${inbound}`,conversationId:'c',userMessageId:'u',assistantMessageId:'a',status:'queued',streamUrl:'/r',createdAt:new Date().toISOString()},message:Message={id:'a',conversationId:'c',parentMessageId:'u',role:'assistant',content:'',modelId:'m',provider:'openai',createdAt:new Date().toISOString(),inputTokens:null,outputTokens:null,costUsd:null,gate:null,attachments:[],version:1};const service:ChatPipelineServices={async createRun(){return{run,assistant:message,providerRequest:{},outboundText:'three addresses'};},async gate(_tenant,input){const action=input.direction==='outbound'?outbound:inbound,isInboundRedaction=input.direction==='inbound'&&action==='redact',replacements=isInboundRedaction?[{originalSpan:{start:0,end:1},replacement:'[A]'},{originalSpan:{start:1,end:2},replacement:'[B]'}]:[];return{decisionId:`decision-${input.direction}`,direction:input.direction,action,protectedItemCount:action==='redact'?(input.direction==='outbound'?3:2):0,effectiveText:isInboundRedaction?`[A][B]${Array.from(input.text).slice(2).join('')}`:input.text,replacements,message:''};},async reserveBudget(){return{id:'budget'};},async dispatchStarted(){},async *streamProvider(){yield{type:'text',text:'safe response'};yield{type:'usage',inputTokens:1,outputTokens:2,costUsd:.01};},async persistEvent(){},async complete(){return{...message,content:'safe response'};},async fail(){},async audit(){},async getRun(){return run;},async *replay(){},async cancel(){return'terminal';}};const app=new Hono<{Variables:AppVariables}>();tenantMiddleware(app);app.route('/',createChatRoutes(service));const response=await app.request('/chat/runs',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':`key-${outbound}-${inbound}`},body:JSON.stringify({content:'hi',modelId:'m',clientRequestId:'x'})});assert.equal(response.status,200);return response.text();};
  const redacted=await stream('redact','allow');assert.equal((redacted.match(/event: gate\.notice/g)??[]).length,1);assert.match(redacted,/"action":"redact"/);assert.match(redacted,/"protectedItemCount":3/);
  for(const action of ['allow','flag'] as const)assert.doesNotMatch(await stream(action,'allow'),/event: gate\.notice/,`${action} must not emit a gate notice`);
  const responseRedacted=await stream('allow','redact');assert.match(responseRedacted,/event: gate\.notice/);assert.match(responseRedacted,/"direction":"inbound"/);assert.match(responseRedacted,/"protectedItemCount":2/);
});

test('chat route rejects an unsupported reasoning effort before creating a run',async()=>{
  let called=false;
  const service={async createRun(){called=true;throw new Error('must not be called');}} as unknown as ChatPipelineServices;
  const app=new Hono<{Variables:AppVariables}>();permissions.add('chat:use');tenantMiddleware(app);app.route('/',createChatRoutes(service));
  const response=await app.request('/chat/runs',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'bad-effort'},body:JSON.stringify({content:'hi',modelId:'m',reasoningEffort:'extreme'})});
  assert.equal(response.status,422);assert.equal(called,false);const body=await response.json() as {error:{message:string;details:{reason:string}}};assert.equal(body.error.message,'reasoningEffort must be low, medium, or high');assert.equal(body.error.details.reason,'chat_option_invalid');
});

test('chat route rejects an unknown tone key before creating a run',async()=>{
  let called=false;const service={async createRun(){called=true;throw new Error('must not be called');}} as unknown as ChatPipelineServices;
  const app=new Hono<{Variables:AppVariables}>();permissions.add('chat:use');tenantMiddleware(app);app.route('/',createChatRoutes(service));
  const response=await app.request('/chat/runs',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'bad-tone'},body:JSON.stringify({content:'hi',modelId:'m',tone:'sarcastic'})});
  assert.equal(response.status,422);assert.equal(called,false);assert.match(await response.text(),/tone must be default, concise, detailed, formal, or friendly/);
});

test('chat route rejects an unknown role key before creating a run',async()=>{
  let called=false;const service={async createRun(){called=true;throw new Error('must not be called');}} as unknown as ChatPipelineServices;
  const app=new Hono<{Variables:AppVariables}>();permissions.add('chat:use');tenantMiddleware(app);app.route('/',createChatRoutes(service));
  const response=await app.request('/chat/runs',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'bad-role'},body:JSON.stringify({content:'hi',modelId:'m',role:'oracle'})});
  assert.equal(response.status,422);assert.equal(called,false);assert.match(await response.text(),/role must be default, coach, creative, critic, debate, or support/);
});

test('chat route validates independent routing mode and provider controls and rejects the removed family field',async()=>{
  let called=0;
  const service={async createRun(){called++;throw new Error('must not be called');}} as unknown as ChatPipelineServices;
  const app=new Hono<{Variables:AppVariables}>();permissions.add('chat:use');tenantMiddleware(app);app.route('/',createChatRoutes(service));
  const send=(body:unknown,key:string)=>app.request('/chat/runs',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify(body)});
  assert.equal((await send({content:'hi',mode:'single'},'missing-route')).status,422);
  assert.equal((await send({content:'hi',mode:'multi_model',provider:'anthropic'},'multi-provider')).status,422);
  assert.equal((await send({content:'hi',mode:'turbo'},'bad-mode')).status,422);
  const unknown=await send({content:'hi',mode:'auto',provider:'other'},'bad-provider');
  assert.equal(unknown.status,422);assert.match(await unknown.text(),/provider must be openai, anthropic, google, or xai/);
  const legacy=await send({content:'hi',mode:'auto',family:'openai'},'legacy-family');
  assert.equal(legacy.status,422);assert.match(await legacy.text(),/family is not a valid field/);
  assert.equal(called,0);
});

test('chat route accepts file-only input but rejects empty and malformed attachment sets before run creation',async()=>{
  let called=0;const missing=Object.assign(new Error('Attachment was not found'),{code:'RESOURCE_NOT_FOUND'});
  const service={async createRun(){called++;throw missing;}} as unknown as ChatPipelineServices;
  const app=new Hono<{Variables:AppVariables}>();permissions.add('chat:use');tenantMiddleware(app);app.route('/',createChatRoutes(service));
  const send=(body:unknown,key:string)=>app.request('/chat/runs',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify(body)});
  assert.equal((await send({content:'',modelId:'m',fileIds:['file-1']},'file-only')).status,404,'file-only input must reach ownership validation');
  assert.equal(called,1);
  const reason=async(response:Response)=>(await response.json() as {error:{details:{reason:string}}}).error.details.reason;
  assert.equal((await send({content:'  ',modelId:'m',fileIds:[]},'empty')).status,422);
  assert.equal(await reason(await send({content:'x',modelId:'m',fileIds:['same','same']},'duplicate')),'chat_attachments_invalid');
  assert.equal(await reason(await send({content:'x',modelId:'m',fileIds:Array.from({length:11},(_,index)=>`file-${index}`)},'many')),'chat_too_many_attachments');
  assert.equal(called,1,'invalid file arrays must not reach the service');
});

test('chat route preserves every machine refusal reason without reading exception messages',async()=>{
  const cases=[
    {code:'VALIDATION_FAILED',reason:'chat_attachment_text_too_large'},
    {code:'VALIDATION_FAILED',reason:'chat_attachment_project_mismatch'},
    {code:'RESOURCE_NOT_FOUND',reason:'chat_project_unavailable'},
    {code:'RESOURCE_NOT_FOUND',reason:'chat_attachment_unavailable'},
    {code:'VALIDATION_FAILED',reason:'chat_context_too_large'},
    {code:'model_not_allowed',reason:'chat_model_not_allowed'},
    {code:'provider_not_allowed',reason:'chat_provider_not_allowed'},
    {code:'no_models_available',reason:'chat_no_models_available'},
    {code:'no_models_available',reason:'chat_multi_model_unavailable',mode:'multi_model'},
  ] as const;
  for(const [index,item] of cases.entries()){
    const service={async createRun(){throw Object.assign(new Error(`unrelated text ${index}`),{code:item.code,reason:item.reason});}} as unknown as ChatPipelineServices;
    const app=new Hono<{Variables:AppVariables}>();permissions.add('chat:use');tenantMiddleware(app);app.route('/',createChatRoutes(service));
    const response=await app.request('/chat/runs',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':`reason-${index}`},body:JSON.stringify({content:'hi',...('mode' in item?{mode:item.mode}:{modelId:'m'})})});
    const body=await response.json() as {error:{details:{reason:string}}};
    assert.equal(body.error.details.reason,item.reason,`${item.code}:${'mode' in item?item.mode:'single'}`);
  }
});

test('chat route does not invent attachment reasons for reason-less service refusals',async()=>{
  for(const [code,status] of [['RESOURCE_NOT_FOUND',404],['VALIDATION_FAILED',422]] as const){
    const service={async createRun(){throw Object.assign(new Error('SERVER-TEXT-SENTINEL'),{code});}} as unknown as ChatPipelineServices;
    const app=new Hono<{Variables:AppVariables}>();permissions.add('chat:use');tenantMiddleware(app);app.route('/',createChatRoutes(service));
    const response=await app.request('/chat/runs',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':`reasonless-${code}`},body:JSON.stringify({content:'hi',mode:'auto',clientRequestId:`reasonless-${code}`})});
    assert.equal(response.status,status);
    const body=await response.json() as {error:{code:string;details?:{reason?:string}}};
    assert.equal(body.error.code,code);assert.equal(body.error.details?.reason,undefined);
  }
});

test('streamed governance failures select a true reason from the code and request mode',()=>{
  const cases=[
    {code:'model_not_allowed',mode:'single',reason:'chat_model_not_allowed'},
    {code:'provider_not_allowed',mode:'auto',reason:'chat_provider_not_allowed'},
    {code:'no_models_available',mode:'auto',reason:'chat_no_models_available'},
    {code:'no_models_available',mode:'multi_model',reason:'chat_multi_model_unavailable'},
  ] as const;
  for(const item of cases){
    const mapped=governedPipelineError(Object.assign(new Error('SERVER-TEXT-SENTINEL'),{code:item.code}),'request-id',false,item.mode);
    assert.equal(mapped.details?.reason,item.reason,`${item.code}:${item.mode}`);
  }
  const refused=governedPipelineError(Object.assign(new Error('SERVER-TEXT-SENTINEL'),{code:'provider_not_allowed'}),'request-id',false,'auto');
  assert.equal(refused.code,'PROVIDER_UNAVAILABLE');assert.equal(refused.retryable,false);assert.equal(refused.details?.reason,'chat_provider_not_allowed');
  const outage=governedPipelineError(Object.assign(new Error('SERVER-TEXT-SENTINEL'),{code:'PROVIDER_UNAVAILABLE'}),'request-id',false,'auto');
  assert.equal(outage.code,'PROVIDER_UNAVAILABLE');assert.equal(outage.retryable,true);assert.equal(outage.details,undefined);
});

test('chat route releases no secret prefix when a blocked token spans provider chunks',async()=>{const run:ChatRun={id:'r2',conversationId:'c',userMessageId:'u',assistantMessageId:'a',status:'queued',streamUrl:'/r2',createdAt:new Date().toISOString()};const message:Message={id:'a',conversationId:'c',parentMessageId:null,role:'assistant',content:'',modelId:'m',provider:'openai',createdAt:new Date().toISOString(),inputTokens:null,outputTokens:null,costUsd:null,gate:null,attachments:[],version:1};const secret='ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890',prefix='Use credential ghp_ABCDEFGHIJKLMNOP';
  const service:ChatPipelineServices={async createRun(){return{run,assistant:message,providerRequest:{},outboundText:'hi'};},async gate(_t,input){const blocked=input.direction==='inbound'&&input.text.includes(secret);return{decisionId:'d',action:blocked?'block':'allow',protectedItemCount:0,effectiveText:input.text,message:''};},async reserveBudget(){return{id:'b'};},async dispatchStarted(){},async *streamProvider(){yield{type:'text',text:prefix};yield{type:'text',text:'QRSTUVWXYZ1234567890 now'};yield{type:'usage',inputTokens:1,outputTokens:1,costUsd:.01};},async persistEvent(){},async complete(){return message;},async fail(){},async audit(){},async getRun(){return run;},async *replay(){},async cancel(){return'terminal';}};
  const app=new Hono<{Variables:AppVariables}>();permissions.add('chat:use');tenantMiddleware(app);app.route('/',createChatRoutes(service));const response=await app.request('/chat/runs',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'k'},body:JSON.stringify({content:'hi',modelId:'m',clientRequestId:'split-secret'})});const body=await response.text();assert.doesNotMatch(body,/event: assistant\.delta/);assert.doesNotMatch(body,/ghp_ABCDEFGHIJKLMNOP/);assert.match(body,/event: run.failed/);
});

// Named for what it proves. It streams 15 characters, which never leave the 2048-code-point
// holdback, so no delta is emitted regardless of the audit. It does NOT show that a failed audit
// withholds output -- see the test below, which is the case this one used to be read as covering.
test('chat route withholds a short response entirely when the completion audit fails',async()=>{const run:ChatRun={id:'r3',conversationId:'c',userMessageId:'u',assistantMessageId:'a',status:'queued',streamUrl:'/r3',createdAt:new Date().toISOString()};const message:Message={id:'a',conversationId:'c',parentMessageId:null,role:'assistant',content:'',modelId:'m',provider:'openai',createdAt:new Date().toISOString(),inputTokens:null,outputTokens:null,costUsd:null,gate:null,attachments:[],version:1};let audits=0;
  const service:ChatPipelineServices={async createRun(){return{run,assistant:message,providerRequest:{},outboundText:'hi'};},async gate(_t,input){return{decisionId:'d',action:'allow',protectedItemCount:0,effectiveText:input.text,message:''};},async reserveBudget(){return{id:'b'};},async dispatchStarted(){},async *streamProvider(){yield{type:'text',text:'governed output'};yield{type:'usage',inputTokens:1,outputTokens:1,costUsd:.01};},async persistEvent(){},async complete(){return{...message,content:'governed output'};},async fail(){},async audit(){audits++;throw new Error('audit unavailable');},async getRun(){return run;},async *replay(){},async cancel(){return'terminal';}};
  const app=new Hono<{Variables:AppVariables}>();permissions.add('chat:use');tenantMiddleware(app);app.route('/',createChatRoutes(service));const response=await app.request('/chat/runs',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'k'},body:JSON.stringify({content:'hi',modelId:'m',clientRequestId:'audit-failure'})});const body=await response.text();assert.equal(audits,2);assert.doesNotMatch(body,/event: assistant\.delta/);assert.doesNotMatch(body,/governed output/);assert.match(body,/event: run.failed/);
});

test('chat route releases finalized segments before provider completion',async()=>{const run:ChatRun={id:'r4',conversationId:'c',userMessageId:'u',assistantMessageId:'a',status:'queued',streamUrl:'/r4',createdAt:new Date().toISOString()};const message:Message={id:'a',conversationId:'c',parentMessageId:null,role:'assistant',content:'',modelId:'m',provider:'openai',createdAt:new Date().toISOString(),inputTokens:null,outputTokens:null,costUsd:null,gate:null,attachments:[],version:1};let finishProvider!:()=>void;const providerPaused=new Promise<void>(resolve=>{finishProvider=resolve});
  const service:ChatPipelineServices={async createRun(){return{run,assistant:message,providerRequest:{},outboundText:'hi'};},async gate(_t,input){return{decisionId:'d',action:'allow',protectedItemCount:0,effectiveText:input.text,message:''};},async reserveBudget(){return{id:'b'};},async dispatchStarted(){},async *streamProvider(){yield{type:'text',text:'a'.repeat(POSTFLIGHT_STREAM_HOLDBACK_CODE_POINTS+1)};await providerPaused;yield{type:'usage',inputTokens:1,outputTokens:1,costUsd:.01};},async persistEvent(){},async complete(){return message;},async fail(){},async audit(){},async getRun(){return run;},async *replay(){},async cancel(){return'terminal';}};
  const app=new Hono<{Variables:AppVariables}>();permissions.add('chat:use');tenantMiddleware(app);app.route('/',createChatRoutes(service));const response=await app.request('/chat/runs',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'stream-now'},body:JSON.stringify({content:'hi',modelId:'m'})});const reader=response.body!.getReader(),decoder=new TextDecoder();let received='';while(!received.includes('event: assistant.delta')){const next=await Promise.race([reader.read(),new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('delta was not streamed')),250))]);if(next.done)break;received+=decoder.decode(next.value,{stream:true});}assert.match(received,/event: assistant\.delta/);finishProvider();while(!(await reader.read()).done){}
});

test('chat inbound scans stay bounded across many tiny provider chunks',async()=>{const run:ChatRun={id:'r5',conversationId:'c',userMessageId:'u',assistantMessageId:'a',status:'queued',streamUrl:'/r5',createdAt:new Date().toISOString()};const message:Message={id:'a',conversationId:'c',parentMessageId:null,role:'assistant',content:'',modelId:'m',provider:'openai',createdAt:new Date().toISOString(),inputTokens:null,outputTokens:null,costUsd:null,gate:null,attachments:[],version:1};let largest=0,total=0;
  const service:ChatPipelineServices={async createRun(){return{run,assistant:message,providerRequest:{},outboundText:'hi'};},async gate(_t,input){if(input.direction==='inbound'){largest=Math.max(largest,Array.from(input.text).length);total+=Array.from(input.text).length;}return{decisionId:'d',action:'allow',protectedItemCount:0,effectiveText:input.text,message:''};},async reserveBudget(){return{id:'b'};},async dispatchStarted(){},async *streamProvider(){for(let i=0;i<12_000;i++)yield{type:'text',text:'x'};yield{type:'usage',inputTokens:1,outputTokens:12_000,costUsd:.01};},async persistEvent(){},async complete(){return message;},async fail(){},async audit(){},async getRun(){return run;},async *replay(){},async cancel(){return'terminal';}};
  const app=new Hono<{Variables:AppVariables}>();permissions.add('chat:use');tenantMiddleware(app);app.route('/',createChatRoutes(service));const response=await app.request('/chat/runs',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'many-chunks'},body:JSON.stringify({content:'hi',modelId:'m'})});assert.equal(response.status,200);await response.text();assert.ok(largest<=POSTFLIGHT_STREAM_HOLDBACK_CODE_POINTS+1,`largest scan was ${largest}`);assert.ok(total<30_000_000,`scanned ${total} code points`);
});

test('chat route completes a three-redaction response with the same live running total',async()=>{
  const tenantId='00000000-0000-4000-8000-000000000001',userId='u',now=Date.now(),definition=defaultPolicy.detectors.find(item=>item.key==='default-pii')!,rule:ResolvedRule={id:randomUUID(),revision:1,name:definition.key,detectorKind:'pii',action:'redact',passMask:'postflight',priority:1000,scopeType:'org',scopeId:tenantId,config:definition.config,failureMode:'closed',sourceOrder:0},subject={tenantId,userId,groupIds:[],roles:['member'] as const},policySnapshot=resolvePolicy({tenantId,modelId:'m',subject,pass:'postflight',policyVersion:1,rules:[rule],nowMs:now}),engine=new DefaultGateEngine({detectors:[new PiiDetector()],vault:new StatelessGateVault()}),raw=`a@corp.invalid ${'x'.repeat(2_100)} b@corp.invalid ${'y'.repeat(2_100)} c@corp.invalid ${'z'.repeat(2_100)}`;
  const run:ChatRun={id:'real-gate-run',conversationId:'c',userMessageId:'u',assistantMessageId:'a',status:'queued',streamUrl:'/real-gate-run',createdAt:new Date().toISOString()},message:Message={id:'a',conversationId:'c',parentMessageId:'u',role:'assistant',content:'',modelId:'m',provider:'openai',createdAt:new Date().toISOString(),inputTokens:null,outputTokens:null,costUsd:null,gate:null,attachments:[],version:1};let stored='',storedCount=-1,lastDecision='';
  const service:ChatPipelineServices={async createRun(){return{run,assistant:message,providerRequest:{},outboundText:'clean prompt'};},async gate(_tenant,input){if(input.direction==='outbound')return{decisionId:'outbound',action:'allow',protectedItemCount:0,effectiveText:input.text,replacements:[],message:''};const context:GateContext={evaluationId:randomUUID(),requestId:randomUUID(),pass:'postflight',subject,conversationId:'c',messageId:'a',projectId:null,providerId:'test',modelId:'m',locale:'en',nowMs:now,parts:[{id:'a',source:'provider_response',text:input.text,mimeType:'text/plain',fileId:null,provenance:{}}],policySnapshot,abortSignal:new AbortController().signal,confirmedWarningToken:null,metadata:{direction:'inbound'}},verdict=await engine.evaluate(context);lastDecision=verdict.evaluationId;return{decisionId:verdict.evaluationId,direction:'inbound',action:verdict.action,protectedItemCount:verdict.redactions.length+verdict.masks.length,effectiveText:verdict.displayParts?.[0]?.text??'',replacements:[...verdict.redactions.map(item=>({originalSpan:item.originalSpan,replacement:item.token})),...verdict.masks.map(item=>({originalSpan:item.originalSpan,replacement:item.replacement}))],message:''};},async reserveBudget(){return{id:'b'};},async dispatchStarted(){},async *streamProvider(){const points=Array.from(raw);for(let offset=0;offset<points.length;offset+=7)yield{type:'text',text:points.slice(offset,offset+7).join('')};yield{type:'usage',inputTokens:1,outputTokens:1,costUsd:.01};},async persistEvent(){},async complete(_tenant,_run,_assistant,text,_usage,_reservation,count){stored=text;storedCount=count;return{...message,content:text,gate:{decisionId:lastDecision,action:'redact',direction:'inbound',detectorCount:1,protectedItemCount:count,approvalId:null,userNotice:null}};},async fail(){},async audit(){},async getRun(){return run;},async *replay(){},async cancel(){return'terminal';}};
  const app=new Hono<{Variables:AppVariables}>();permissions.add('chat:use');tenantMiddleware(app);app.route('/',createChatRoutes(service));const response=await app.request('/chat/runs',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'three-real-redactions'},body:JSON.stringify({content:'clean prompt',modelId:'m'})}),body=await response.text();
  assert.equal(response.status,200);assert.equal(storedCount,3);assert.equal((stored.match(/⟦REDACTED:EMAIL:/gu)??[]).length,3);assert.doesNotMatch(stored,/[abc]@corp\.invalid/u);assert.match(body,/event: run\.completed/);assert.match(body,/"protectedItemCount":3/);const noticeCounts=[...body.matchAll(/event: gate\.notice\ndata: (\{[^\n]+\})/gu)].map(match=>(JSON.parse(match[1]!) as {protectedItemCount:number}).protectedItemCount);assert.ok(noticeCounts.length<10,`saw ${noticeCounts.length} gate notices`);assert.equal(noticeCounts.at(-1),3);assert.ok(noticeCounts.every((count,index)=>index===0||count>=noticeCounts[index-1]!));
});

test('chat route reports an audit gap when a long response was already streamed',async()=>{
  // Streaming cannot audit a completion before it completes, so everything past the holdback is
  // already on the wire when the completion append is attempted. If that append fails the failure
  // append is the last durable trace, and it used to be discarded by a bare `catch{}` -- leaving a
  // run that had delivered text to a user recorded in neither the audit chain nor `messages`.
  const run:ChatRun={id:'r5',conversationId:'c',userMessageId:'u',assistantMessageId:'a',status:'queued',streamUrl:'/r5',createdAt:new Date().toISOString()};
  const message:Message={id:'a',conversationId:'c',parentMessageId:null,role:'assistant',content:'',modelId:'m',provider:'openai',createdAt:new Date().toISOString(),inputTokens:null,outputTokens:null,costUsd:null,gate:null,attachments:[],version:1};
  const body='x'.repeat(POSTFLIGHT_STREAM_HOLDBACK_CODE_POINTS+50);
  const service:ChatPipelineServices={async createRun(){return{run,assistant:message,providerRequest:{},outboundText:'hi'};},async gate(_t,input){return{decisionId:'d',action:'allow',protectedItemCount:0,effectiveText:input.text,message:''};},async reserveBudget(){return{id:'b'};},async dispatchStarted(){},async *streamProvider(){yield{type:'text',text:body};yield{type:'usage',inputTokens:1,outputTokens:1,costUsd:.01};},async persistEvent(){},async complete(){return{...message,content:body};},async fail(){},async audit(){throw new Error('audit unavailable');},async getRun(){return run;},async *replay(){},async cancel(){return'terminal';}};
  const errors:string[]=[];const original=console.error;console.error=(...args:unknown[])=>{errors.push(String(args[0]));};
  try {
    const app=new Hono<{Variables:AppVariables}>();permissions.add('chat:use');tenantMiddleware(app);app.route('/',createChatRoutes(service));
    const response=await app.request('/chat/runs',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'gap'},body:JSON.stringify({content:'hi',modelId:'m',clientRequestId:'audit-gap'})});
    const text=await response.text();
    assert.match(text,/event: assistant\.delta/,'a response longer than the holdback is streamed before the completion audit runs');
    assert.match(text,/event: run.failed/);
  } finally { console.error=original; }
  assert.ok(errors.some(line=>/AUDIT GAP/.test(line)&&/deliveredCodePoints=50/.test(line)),`the audit gap must be reported with the delivered size, saw ${JSON.stringify(errors)}`);
});

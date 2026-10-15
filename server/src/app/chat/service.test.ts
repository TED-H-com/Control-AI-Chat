import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import Database from 'better-sqlite3';
import {Hono} from 'hono';
import { runMigrations } from '../../lib/migrations/index.js';
import { loadRoutingCandidates } from '../../lib/governance/router.js';
import { createAuditService, type AuditAppendInput, type AuditService } from '../../lib/audit/index.js';
import type { GateContext, GateEngine, GateVerdict } from '../../lib/gate/index.js';
import { DefaultGateEngine, StatelessGateVault, deterministicDetectors, resolvePolicy } from '../../lib/gate/index.js';
import { defaultPolicy } from '../../lib/gate/default-policy.js';
import type { ResolvedRule } from '../../lib/gate/types.js';
import type { ChatProvider, ChatRequest, ModelCatalogEntry } from '../../lib/providers/types.js';
import type {AppVariables,TenantContext} from '../../lib/http/index.js';
import { forTenant } from '../../lib/db.js';
import type { TenantId } from '../../shared/types.js';
import type {ApiError,StreamEvent} from '../../shared/api.js';
import { estimateModelCostMicrousd } from '../../lib/governance/billing.js';
import { MessageRepository } from '../repositories/messages.js';
import { estimateChatInputTokens, GovernedChatApplication, protectedPromptItemCount } from './service.js';
import {createChatRoutes} from '../../routes/chat.js';

test('chat input token estimates stay conservative without charging every UTF-8 byte as a token',()=>{
  assert.equal(estimateChatInputTokens('abcdefghijkl'),4);
  assert.equal(estimateChatInputTokens('\u8cc7\u6599\u6cbb\u7406'),4);
  assert.equal(estimateChatInputTokens('\ud83d\udd10'),2);
  const multilingual='Policy \u653f\u7b56 \ud83d\udd10 const enabled = true;';
  assert.equal(estimateChatInputTokens(multilingual),Math.ceil(Buffer.byteLength(multilingual,'utf8')/3));
  assert.ok(estimateChatInputTokens(multilingual)<Buffer.byteLength(multilingual,'utf8'));
});

test('the context-window refusal carries its stable reason at the throw site',()=>{
  const source=readFileSync(new URL('./service.ts',import.meta.url),'utf8');
  assert.match(source,/exceed the selected model context window'[\s\S]{0,160}reason:'chat_context_too_large'/u);
});

test('prompt protected-item counts include only the current prompt and attachments under the default policy',async()=>{
  const tenantId=randomUUID(),userId=randomUUID(),now=Date.now(),definition=defaultPolicy.detectors.find(item=>item.key==='default-pii')!,rule:ResolvedRule={id:randomUUID(),revision:1,name:definition.key,detectorKind:'pii',action:'redact',passMask:'preflight',priority:1000,scopeType:'org',scopeId:tenantId,config:definition.config,failureMode:'closed',sourceOrder:0},subject={tenantId,userId,groupIds:[],roles:['member'] as const},policySnapshot=resolvePolicy({tenantId,modelId:'model',subject,pass:'preflight',policyVersion:1,rules:[rule],nowMs:now}),engine=new DefaultGateEngine({detectors:deterministicDetectors(),vault:new StatelessGateVault()});
  const evaluate=(parts:GateContext['parts'])=>engine.evaluate({evaluationId:randomUUID(),requestId:randomUUID(),pass:'preflight',subject,conversationId:null,messageId:null,projectId:null,providerId:'test',modelId:'model',locale:'en',nowMs:now,parts,policySnapshot,abortSignal:new AbortController().signal,confirmedWarningToken:null,metadata:{direction:'outbound'}});
  const clean=await evaluate([{id:'message:0',source:'conversation_history',text:'History old@corp.invalid',mimeType:'text/plain',fileId:null,provenance:{}},{id:'message:1',source:'user_prompt',text:'Clean prompt',mimeType:'text/plain',fileId:null,provenance:{}},{id:'system:assistant',source:'system_persona',text:'Contact assistant@corp.invalid',mimeType:'text/plain',fileId:null,provenance:{}}]);
  assert.equal(protectedPromptItemCount([clean],'message:1',new Set()),0);
  const prompt=await evaluate([{id:'message:0',source:'conversation_history',text:'History old@corp.invalid',mimeType:'text/plain',fileId:null,provenance:{}},{id:'message:1',source:'user_prompt',text:'Send a@corp.invalid and b@corp.invalid',mimeType:'text/plain',fileId:null,provenance:{}},{id:'system:assistant',source:'system_persona',text:'Contact assistant@corp.invalid',mimeType:'text/plain',fileId:null,provenance:{}}]),file=await evaluate([{id:'file:file-1',source:'file_extraction',text:'Attachment c@corp.invalid',mimeType:'text/plain',fileId:'file-1',provenance:{}}]);
  assert.equal(protectedPromptItemCount([prompt],'message:1',new Set()),2);assert.equal(protectedPromptItemCount([prompt,file],'message:1',new Set(['file:file-1'])),3);
});

test('only preflight-redacted text reaches the provider, including a retry',async t=>{
  const database=new Database(':memory:');database.pragma('foreign_keys=ON');runMigrations(database);const now=1_800_000_000_000;
  const tenantId=randomUUID() as TenantId,userId=randomUUID(),groupId=randomUUID(),modelId=randomUUID(),providerConfigId=randomUUID();
  database.prepare("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,?,'Test','active',?,?)").run(tenantId,`test-${tenantId.slice(0,8)}`,now,now);
  database.prepare('INSERT INTO tenant_settings(tenant_id,updated_at) VALUES(?,?)').run(tenantId,now);
  database.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,?,'User','x','active',?,?)").run(userId,tenantId,'u@example.test',now,now);
  database.prepare("INSERT INTO groups(id,tenant_id,name,created_at,updated_at) VALUES(?,?, 'Members',?,?)").run(groupId,tenantId,now,now);
  database.prepare("INSERT INTO group_members(tenant_id,group_id,user_id,source,created_at) VALUES(?,?,?,'manual',?)").run(tenantId,groupId,userId,now);
  const platformVersion=database.prepare("SELECT id,model_key FROM platform_model_versions WHERE provider_key='openai' AND model_key='gpt-5.6-sol' AND authoritative=1").get() as {id:string;model_key:string};
  database.prepare('UPDATE platform_model_versions SET effective_from=0 WHERE id=?').run(platformVersion.id);
  // The tenant's own price is the only price. Leave the pin in place but move the platform ledger's
  // price far away from the catalogue's, so a settlement that reads the wrong source is off by
  // orders of magnitude rather than by a rounding step.
  database.prepare('UPDATE platform_model_versions SET input_microusd_per_million=?,output_microusd_per_million=?,cached_input_microusd_per_million=? WHERE id=?').run(9_000_000,9_000_000,9_000_000,platformVersion.id);
  database.prepare("INSERT INTO model_catalog(id,tenant_id,provider_key,model_key,display_name,enabled,is_default,context_window,max_output_tokens,input_microusd_per_million,output_microusd_per_million,capabilities_json,platform_model_version_id,created_at,updated_at) VALUES(?,?,'openai',?,'Test',1,1,4096,128,1000,2000,'[\"reasoning\"]',?,?,?)").run(modelId,tenantId,platformVersion.model_key,platformVersion.id,now,now);
  database.prepare("INSERT INTO provider_config(id,tenant_id,provider_key,enabled,credential_source,credential_ciphertext,key_version,created_at,updated_at) VALUES(?,?,'openai',1,'encrypted','fixture',1,?,?)").run(providerConfigId,tenantId,now,now);
  database.prepare('INSERT INTO group_model_access(group_id,model_catalog_id,enabled) VALUES(?,?,1)').run(groupId,modelId);
  database.prepare('INSERT INTO group_provider_access(group_id,provider_config_id,enabled) VALUES(?,?,1)').run(groupId,providerConfigId);

  const emails=['alice@example.test','bob@example.test','carol@example.test'];
  const original=`Contact ${emails.join(', ')}`;const redacted='Contact [EMAIL_1], [EMAIL_2], [EMAIL_3]';const seen:string[]=[],efforts:string[]=[];let providerCalls=0,failAfterDelta=false;
  const tonePersona='Respond concisely. Lead with the answer, keep it brief and well-structured, and omit unnecessary preamble.';
  const criticPersona="Act as a critical reviewer. Rigorously evaluate the user's work or ideas, identify weaknesses, risks, and gaps, and give specific, honest, constructive criticism.";
  const persona=`${criticPersona}\n\n${tonePersona}`,providerRequests:ChatRequest[]=[];
  const provider:ChatProvider={id:'openai',protocols:['openai_responses'],configured:true,supports:()=>true,health:()=>({configured:true,circuit:'closed',recentFailureRate:0}),async *stream(request:ChatRequest){providerCalls++;providerRequests.push(request);seen.push(text(request));efforts.push(request.reasoningEffort);/* retry sees the identical governed request */seen.push(text(request));yield{type:'start',requestId:'r',model:request.model,createdAt:now};yield{type:'text_delta',index:0,delta:'safe reply'};if(failAfterDelta)throw new Error('provider disconnected');yield{type:'usage',usage:{inputTokens:7,outputTokens:2,reasoningTokens:0,cachedInputTokens:0,cacheWriteTokens:0,toolInputTokens:0,totalTokens:9,estimated:false,source:'provider'}};yield{type:'finish',reason:'stop'};}};
  let block=false,mask=false,inboundRedact=false,redactAssistant=false;const preflightContexts:string[][]=[],preflightSources:string[][]=[];
  const gate:GateEngine={async evaluate(context:GateContext):Promise<GateVerdict>{const pre=context.pass==='preflight',blocked=pre&&block,action:GateVerdict['action']=blocked?'block':pre?(mask?'mask':'redact'):(inboundRedact?'redact':'allow');if(pre){preflightContexts.push(context.parts.map(part=>part.text));preflightSources.push(context.parts.map(part=>part.source));}const count=action==='redact'?(pre?3:2):action==='mask'?2:0;const matches=Array.from({length:count},(_,index)=>({matchId:`match-${context.evaluationId}-${index}`,detectorId:'email-detector',detectorKind:'pii' as const,ruleId:'email-rule',ruleRevision:1,partId:context.parts[0]?.id??'part',category:'email',action,confidence:'high' as const,span:null,normalizedFingerprint:`email-${index}`,safeExcerpt:'[EMAIL]',replacementLabel:'EMAIL',metadata:{}}));const redactions=action==='redact'?Array.from({length:count},(_,index)=>({token:`[EMAIL_${index+1}]`,label:'EMAIL',partId:context.parts[0]?.id??'part',originalSpan:{start:index,end:index+1},ruleIds:['email-rule']})):[];const masks=action==='mask'?Array.from({length:count},(_,index)=>({label:'EMAIL',partId:context.parts[0]?.id??'part',originalSpan:{start:index,end:index+1},replacement:`email-${index+1}@example.invalid`,ruleIds:['email-rule']})):[];return{evaluationId:context.evaluationId,pass:context.pass,action,disposition:blocked?'blocked':pre?'allow_provider_call':'release_to_user',matches,providerParts:pre&&!blocked?context.parts.filter(part=>!redactAssistant||part.id!=='system:assistant').map((part,index)=>index===0?{...part,text:redacted}:part):null,displayParts:pre?null:context.parts,redactions,masks,warningToken:null,approvalRequestId:null,policySnapshotId:context.policySnapshot.snapshotId,policyFingerprint:'x',degraded:false,failureCodes:[],timings:{resolveUs:0,normalizeUs:0,deterministicUs:1,semanticUs:0,vaultUs:0,totalUs:1}};},createPostflightStream(){throw new Error('unused');}};
  const auditStore=createAuditService({database,ipHmacKey:Buffer.alloc(32,1),transcriptKey:()=>Buffer.alloc(32,2),
    retentionPolicy:id=>({tenantId:id,chatTranscriptDays:90,violationTranscriptDays:365,approvalPayloadDays:30,auditMetadataDays:null,captureTranscripts:false,effectiveAtMs:now}),now:()=>now});
  const completedAudits:AuditAppendInput<'chat.message_completed'>[]=[];
  const captureCompleted=(input:AuditAppendInput)=>{if(input.action==='chat.message_completed')completedAudits.push(input as AuditAppendInput<'chat.message_completed'>);};
  const audit:AuditService={append(input){captureCompleted(input);return auditStore.append(input);},enqueue:auditStore.enqueue,transact(work){return auditStore.transact(tx=>work({append(input){captureCompleted(input);return tx.append(input);}}));}};
  const app=new GovernedChatApplication({database,gate,providers:{get:()=>provider},audit,approvalPayloadKey:Buffer.alloc(32,3),now:()=>now});
  const tenantDb=forTenant({tenantId});
  const tenant={principal:{tenantId,userId,membershipId:userId,sessionId:randomUUID(),roles:['owner'],permissions:new Set(['chat:use'])},db:tenantDb,requestId:randomUUID(),now:new Date(now)} as TenantContext;
  const foreignUserId=randomUUID(),foreignConversationId=randomUUID(),foreignMessageId=randomUUID();
  database.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,?,'Other','x','active',?,?)").run(foreignUserId,tenantId,`other-${foreignUserId.slice(0,8)}@example.test`,now,now);
  database.prepare("INSERT INTO conversations(id,tenant_id,owner_user_id,title,status,created_at,updated_at) VALUES(?,?,?,'Other conversation','active',?,?)").run(foreignConversationId,tenantId,foreignUserId,now,now);
  database.prepare("INSERT INTO messages(id,tenant_id,conversation_id,parent_message_id,author_user_id,role,status,sequence_no,created_at) VALUES(?,?,?,NULL,?,'user','complete',0,?)").run(foreignMessageId,tenantId,foreignConversationId,foreignUserId,now);
  database.prepare("INSERT INTO message_parts(id,tenant_id,message_id,ordinal,kind,text_content,metadata_json,created_at) VALUES(?,?,?,0,'text','foreign','{}',?)").run(randomUUID(),tenantId,foreignMessageId,now);
  const ownedConversationId=randomUUID(),ownedUserMessageId=randomUUID();
  database.prepare("INSERT INTO conversations(id,tenant_id,owner_user_id,title,status,created_at,updated_at) VALUES(?,?,?,'Owned conversation','active',?,?)").run(ownedConversationId,tenantId,userId,now,now);
  database.prepare("INSERT INTO messages(id,tenant_id,conversation_id,parent_message_id,author_user_id,role,status,sequence_no,created_at) VALUES(?,?,?,NULL,?,'user','complete',0,?)").run(ownedUserMessageId,tenantId,ownedConversationId,userId,now);
  database.prepare("INSERT INTO message_parts(id,tenant_id,message_id,ordinal,kind,text_content,metadata_json,created_at) VALUES(?,?,?,0,'text','owned','{}',?)").run(randomUUID(),tenantId,ownedUserMessageId,now);
  const http=new Hono<{Variables:AppVariables}>();http.use('*',async(c,next)=>{c.set('requestId',tenant.requestId);c.set('principal',tenant.principal);c.set('tenant',tenant);await next();});http.route('/',createChatRoutes(app));
  await t.test('the real chat service hides missing and cross-owner source records behind reason-less 404s',async()=>{
    const ownershipCases=[
      ['/chat/runs/regenerate',{messageId:randomUUID(),mode:'auto',clientRequestId:randomUUID()}],
      ['/chat/runs/edit-resend',{messageId:foreignMessageId,content:'edit',mode:'auto',clientRequestId:randomUUID()}],
      ['/chat/runs',{conversationId:foreignConversationId,content:'send',mode:'auto',clientRequestId:randomUUID()}],
      ['/chat/runs',{conversationId:ownedConversationId,parentMessageId:randomUUID(),content:'missing parent',mode:'auto',clientRequestId:randomUUID()}],
      ['/chat/runs',{conversationId:ownedConversationId,parentMessageId:foreignMessageId,content:'cross-owner parent',mode:'auto',clientRequestId:randomUUID()}],
      ['/chat/runs',{conversationId:ownedConversationId,parentMessageId:ownedUserMessageId,content:'non-assistant parent',mode:'auto',clientRequestId:randomUUID()}],
    ] as const;
    for(const [path,body] of ownershipCases){const response=await http.request(path,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':body.clientRequestId},body:JSON.stringify(body)});assert.equal(response.status,404,path);const envelope=(await response.json() as ApiError).error;assert.equal(envelope.code,'RESOURCE_NOT_FOUND');assert.equal(envelope.details?.reason,undefined);}
  });
  const firstInput={content:original,modelId,clientRequestId:randomUUID(),reasoningEffort:'high' as const,tone:'concise' as const,role:'critic' as const},claim={key:'first',requestHash:'a'.repeat(64),method:'POST',path:'/chat/runs'};const prepared=await app.createRun(tenant,firstInput,'create',claim);const replay=await app.createRun(tenant,firstInput,'create',claim);assert.equal(replay.replay,true);assert.equal(replay.run.id,prepared.run.id);await assert.rejects(app.createRun(tenant,{...firstInput,content:'different'},'create',{...claim,requestHash:'c'.repeat(64)}),/IDEMPOTENCY_KEY_REUSED/);
  const routing=database.prepare('SELECT vendor_jurisdiction_constraint vendor,processing_region_constraint processing,route_reason_json reasons FROM routing_decisions WHERE tenant_id=? AND run_id=?').get(tenantId,prepared.run.id) as {vendor:string;processing:string;reasons:string};
  assert.deepEqual({vendor:routing.vendor,processing:routing.processing},{vendor:'any',processing:'any'});assert.ok((JSON.parse(routing.reasons) as string[]).includes('vendor:any'));assert.ok((JSON.parse(routing.reasons) as string[]).includes('processing:any'));
  const liveReplay=app.replay(tenant,prepared.run.id,0,new AbortController().signal),firstEvent=liveReplay.next();let replaySettled=false;void firstEvent.then(()=>{replaySettled=true});await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(replaySettled,false,'an active replay must wait for future events instead of ending at the current buffer');
  await app.persistEvent(tenant,prepared.run.id,1,{event:'run.status',data:{runId:prepared.run.id,status:'gating'}});assert.equal((await firstEvent).value?.event.event,'run.status');
  const boundary=liveReplay.next();await app.persistEvent(tenant,prepared.run.id,2,{event:'run.status',data:{runId:prepared.run.id,status:'awaiting_confirmation'}});assert.equal((await boundary).value?.event.event,'run.status');assert.equal((await liveReplay.next()).done,true,'a replay closes only at a real stream boundary');
  const abort=new AbortController(),abortedReplay=app.replay(tenant,prepared.run.id,2,abort.signal),aborted=abortedReplay.next();abort.abort();assert.equal((await aborted).done,true,'disconnecting a replay releases its event waiter');
  const storedRequestDigest=database.prepare('SELECT request_sha256 FROM idempotency_records WHERE tenant_id=? AND idempotency_key=?').pluck().get(tenantId,claim.key) as string;
  assert.match(storedRequestDigest,/^[0-9a-f]{64}$/);assert.notEqual(storedRequestDigest,claim.requestHash,'the bare deterministic request hash must never be persisted');
  assert.equal((database.prepare('SELECT COUNT(*) count FROM message_parts WHERE tenant_id=? AND text_content=?').get(tenantId,original) as {count:number}).count,0);
  const verdict=await app.gate(tenant,{direction:'outbound',text:original,runId:prepared.run.id},new AbortController().signal);
  const redactionMetadata=JSON.parse(database.prepare("SELECT metadata_json FROM audit_events WHERE tenant_id=? AND action='gate.content_redacted' AND message_id=?").pluck().get(tenantId,prepared.run.userMessageId) as string) as Record<string,unknown>;
  assert.equal(redactionMetadata.placeholderCount,3);assert.equal(Object.hasOwn(redactionMetadata,'mappingId'),false,'a stateless redaction must not advertise a mapping that cannot be retrieved');
  const protectedOutbound=database.prepare('SELECT protected_item_count,matched_detector_keys_json FROM gate_decisions WHERE tenant_id=? AND message_id=?').get(tenantId,prepared.run.userMessageId) as {protected_item_count:number;matched_detector_keys_json:string};
  assert.equal(protectedOutbound.protected_item_count,3);assert.deepEqual(JSON.parse(protectedOutbound.matched_detector_keys_json),['pii']);assert.equal(verdict.protectedItemCount,3);
  const reloadedPrompt=new MessageRepository(database).all(tenant,prepared.run.conversationId).find(message=>message.id===prepared.run.userMessageId);
  assert.equal(reloadedPrompt?.gate?.protectedItemCount,3,'the prompt count read by the repository comes from the message');
  const persisted=database.prepare('SELECT c.title,p.text_content,d.content_sha256 FROM conversations c JOIN messages m ON m.conversation_id=c.id AND m.role=\'user\' JOIN message_parts p ON p.message_id=m.id JOIN gate_decisions d ON d.message_id=m.id WHERE c.id=?').get(prepared.run.conversationId) as {title:string;text_content:string;content_sha256:string};
  assert.equal(persisted.title,redacted);assert.equal(persisted.text_content,redacted);assert.match(persisted.content_sha256,/^[0-9a-f]{64}$/);
  const tables=database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").pluck().all() as string[];
  for(const table of tables){
    const columns=(database.prepare(`PRAGMA table_info("${table.replaceAll('"','""')}")`).all() as Array<{name:string;type:string}>).filter(column=>/TEXT/i.test(column.type));
    for(const column of columns){const identifier=column.name.replaceAll('"','""'),found=database.prepare(`SELECT 1 FROM "${table.replaceAll('"','""')}" WHERE instr(COALESCE("${identifier}",''),?)>0 LIMIT 1`).get(original);assert.equal(found,undefined,`${table}.${column.name} retained the redacted original`);}
  }
  assert.notEqual(persisted.content_sha256,createHash('sha256').update(redacted).digest('hex'));
  assert.notEqual(persisted.content_sha256,createHash('sha256').update(original).digest('hex'));
  const reservation=await app.reserveBudget(tenant,prepared.run);
  const reservationMetadata=JSON.parse(database.prepare('SELECT metadata_json FROM budget_reservations WHERE tenant_id=? AND id=?').pluck().get(tenantId,reservation.id) as string) as {input:number};
  assert.equal(reservationMetadata.input,estimateChatInputTokens(`${persona}\n${redacted}`),'the governed persona and multilingual prompt are both reserved');
  await app.dispatchStarted(tenant,prepared.run,reservation);
  let streamedCostUsd:number|null=null;for await(const chunk of app.streamProvider(tenant,prepared.providerRequest,{preflightDecisionId:verdict.decisionId,reservationId:reservation.id,effectiveText:verdict.effectiveText},new AbortController().signal)){if(chunk.type==='usage')streamedCostUsd=chunk.costUsd;}
  assert.notEqual(streamedCostUsd,null);inboundRedact=true;const inboundVerdict=await app.gate(tenant,{direction:'inbound',text:'reply with alice@example.test and bob@example.test',runId:prepared.run.id},new AbortController().signal);inboundRedact=false;assert.equal(inboundVerdict.protectedItemCount,2);await app.gate(tenant,{direction:'inbound',text:'safe tail',runId:prepared.run.id},new AbortController().signal);const completed=await app.complete(tenant,prepared.run,prepared.assistant,'safe reply',{inputTokens:7,outputTokens:2,totalTokens:9,costUsd:streamedCostUsd!,modelId,provider:'openai',budgetWarnings:[]},reservation);assert.equal(completed.gate?.action,'redact');assert.equal(completed.gate?.protectedItemCount,2);await app.audit(tenant,prepared.run,'success',{inputTokens:7,outputTokens:2,costUsdMicros:Math.round(streamedCostUsd!*1_000_000)});const providerCostMicrousd=estimateModelCostMicrousd({inputTokens:7,outputTokens:2,inputMicrousdPerMillion:1000,outputMicrousdPerMillion:2000});assert.ok(providerCostMicrousd>0);assert.equal(completedAudits.at(-1)?.metadata.costUsdMicros,providerCostMicrousd);assert.equal(providerCalls,1);assert.deepEqual(efforts,['high']);assert.equal((database.prepare('SELECT count(*) count FROM messages WHERE conversation_id=?').get(prepared.run.conversationId) as {count:number}).count,2);assert.deepEqual(database.prepare('SELECT conversation_id,message_id FROM usage_records WHERE tenant_id=?').get(tenantId),{conversation_id:prepared.run.conversationId,message_id:prepared.assistant.id});assert.deepEqual(seen,[redacted,redacted]);assert.ok(seen.every(value=>emails.every(email=>!value.includes(email))));
  const reloaded=new MessageRepository(database).all(tenant,prepared.run.conversationId).find(message=>message.id===prepared.assistant.id);assert.equal(reloaded?.gate?.protectedItemCount,2);
  assert.ok(preflightSources[0]?.includes('system_persona'));assert.ok(preflightContexts[0]?.includes(persona));assert.deepEqual(providerRequests[0]?.messages[0],{role:'system',content:[{type:'text',text:persona}]});assert.ok(persona.indexOf(criticPersona)<persona.indexOf(tonePersona));assert.deepEqual(database.prepare('SELECT tone,role FROM conversations WHERE id=?').get(prepared.run.conversationId),{tone:'concise',role:'critic'});
  const regenerated=await app.createRun(tenant,{messageId:prepared.assistant.id,mode:'single',provider:'openai',clientRequestId:randomUUID()},'regenerate',{key:'owned-regenerate',requestHash:'6'.repeat(64),method:'POST',path:'/chat/runs/regenerate'});
  assert.equal(regenerated.run.conversationId,prepared.run.conversationId);assert.equal(regenerated.outboundText,redacted,'regenerate must reuse the governed parent prompt, not submit the old assistant answer as a new prompt');
  await app.gate(tenant,{direction:'outbound',text:regenerated.outboundText,runId:regenerated.run.id},new AbortController().signal);
  assert.deepEqual(preflightContexts.at(-1),[redacted,persona],'a historical regenerate keeps only its parent prompt plus the dedicated persisted persona part');
  const edited=await app.createRun(tenant,{messageId:prepared.run.userMessageId,content:'revised safe prompt',mode:'single',provider:'openai',clientRequestId:randomUUID()},'edit-resend',{key:'owned-edit',requestHash:'7'.repeat(64),method:'POST',path:'/chat/runs/edit-resend'});
  assert.equal(edited.run.conversationId,prepared.run.conversationId);assert.equal(edited.outboundText,'revised safe prompt');
  for(const runId of [regenerated.run.id,edited.run.id])assert.deepEqual(
    database.prepare('SELECT mode,requested_provider,requested_model_catalog_id FROM routing_decisions WHERE tenant_id=? AND run_id=?').get(tenantId,runId),
    {mode:'single',requested_provider:'openai',requested_model_catalog_id:null},
    'regenerate and edit-resend preserve an explicit provider pin without exposing a model id',
  );
  const autoRegenerated=await app.createRun(tenant,{messageId:prepared.assistant.id,mode:'auto',clientRequestId:randomUUID()},'regenerate',{key:'auto-regenerate',requestHash:'d'.repeat(64),method:'POST',path:'/chat/runs/regenerate'});
  const autoEdited=await app.createRun(tenant,{messageId:prepared.run.userMessageId,content:'Reclassify this revised question',mode:'auto',clientRequestId:randomUUID()},'edit-resend',{key:'auto-edit',requestHash:'f'.repeat(64),method:'POST',path:'/chat/runs/edit-resend'});
  for(const runId of [autoRegenerated.run.id,autoEdited.run.id])assert.deepEqual(
    database.prepare('SELECT mode,requested_model_catalog_id FROM routing_decisions WHERE tenant_id=? AND run_id=?').get(tenantId,runId),
    {mode:'auto',requested_model_catalog_id:null},
    'explicit auto must reclassify edit and regenerate prompts instead of inheriting the old exact model',
  );
  const continued=await app.createRun(tenant,{conversationId:prepared.run.conversationId,parentMessageId:prepared.assistant.id,content:'continue safely',modelId,clientRequestId:randomUUID()},'create',{key:'owned-parent',requestHash:'0'.repeat(64),method:'POST',path:'/chat/runs'});
  assert.equal(continued.run.conversationId,prepared.run.conversationId);
  await assert.rejects(app.createRun(tenant,{messageId:prepared.run.userMessageId,modelId,clientRequestId:randomUUID()},'regenerate',{key:'wrong-regenerate-role',requestHash:'8'.repeat(64),method:'POST',path:'/chat/runs/regenerate'}),/Source message was not found/);
  await assert.rejects(app.createRun(tenant,{messageId:prepared.assistant.id,content:'wrong role',modelId,clientRequestId:randomUUID()},'edit-resend',{key:'wrong-edit-role',requestHash:'9'.repeat(64),method:'POST',path:'/chat/runs/edit-resend'}),/Source message was not found/);
  const otherConversation=randomUUID(),otherAssistant=randomUUID();
  database.prepare("INSERT INTO conversations(id,tenant_id,owner_user_id,title,status,created_at,updated_at) VALUES(?,?,?,'Other','active',?,?)").run(otherConversation,tenantId,userId,now,now);
  database.prepare("INSERT INTO messages(id,tenant_id,conversation_id,author_user_id,role,status,sequence_no,created_at,completed_at) VALUES(?,?,?,?, 'assistant','complete',0,?,?)").run(otherAssistant,tenantId,otherConversation,userId,now,now);
  database.prepare("INSERT INTO message_parts(id,tenant_id,message_id,ordinal,kind,text_content,metadata_json,created_at) VALUES(?,?,?,?, 'text','other answer','{}',?)").run(randomUUID(),tenantId,otherAssistant,0,now);
  await assert.rejects(app.createRun(tenant,{conversationId:prepared.run.conversationId,parentMessageId:otherAssistant,content:'cross conversation',modelId,clientRequestId:randomUUID()},'create',{key:'other-conversation-parent',requestHash:'1'.repeat(64),method:'POST',path:'/chat/runs'}),/Parent message was not found/);
  await assert.rejects(app.createRun(tenant,{parentMessageId:prepared.assistant.id,content:'new conversation cannot inherit',modelId,clientRequestId:randomUUID()},'create',{key:'new-conversation-parent',requestHash:'2'.repeat(64),method:'POST',path:'/chat/runs'}),/Parent message was not found/);
  const colleagueId=randomUUID();
  database.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,?,'Colleague','x','active',?,?)").run(colleagueId,tenantId,'colleague@example.test',now,now);
  const colleagueConversation=randomUUID(),colleagueAssistant=randomUUID();
  database.prepare("INSERT INTO conversations(id,tenant_id,owner_user_id,title,status,created_at,updated_at) VALUES(?,?,?,'Colleague','active',?,?)").run(colleagueConversation,tenantId,colleagueId,now,now);
  database.prepare("INSERT INTO messages(id,tenant_id,conversation_id,author_user_id,role,status,sequence_no,created_at,completed_at) VALUES(?,?,?,?, 'assistant','complete',0,?,?)").run(colleagueAssistant,tenantId,colleagueConversation,colleagueId,now,now);
  database.prepare("INSERT INTO message_parts(id,tenant_id,message_id,ordinal,kind,text_content,metadata_json,created_at) VALUES(?,?,?,?, 'text','colleague answer','{}',?)").run(randomUUID(),tenantId,colleagueAssistant,0,now);
  const colleague={...tenant,principal:{...tenant.principal,userId:colleagueId,membershipId:colleagueId,sessionId:randomUUID()},db:forTenant({tenantId}),requestId:randomUUID()} as TenantContext;
  await assert.rejects(app.createRun(tenant,{conversationId:prepared.run.conversationId,parentMessageId:colleagueAssistant,content:'foreign colleague parent',modelId,clientRequestId:randomUUID()},'create',{key:'colleague-parent',requestHash:'3'.repeat(64),method:'POST',path:'/chat/runs'}),/Parent message was not found/);
  await assert.rejects(app.createRun(colleague,{messageId:prepared.assistant.id,modelId,clientRequestId:randomUUID()},'regenerate',{key:'foreign-regenerate',requestHash:'e'.repeat(64),method:'POST',path:'/chat/runs/regenerate'}),/Source message was not found/);
  await assert.rejects(app.createRun(colleague,{messageId:prepared.run.userMessageId,content:'steal history',modelId,clientRequestId:randomUUID()},'edit-resend',{key:'foreign-edit',requestHash:'f'.repeat(64),method:'POST',path:'/chat/runs/edit-resend'}),/Source message was not found/);
  assert.equal(await app.getRun(colleague,prepared.run.id),null);
  await assert.rejects(async()=>{for await(const _ of app.replay(colleague,prepared.run.id,0,new AbortController().signal)){}},/Chat run was not found/);
  assert.equal(await app.cancel(colleague,prepared.run.id),'missing');
  await assert.rejects(app.gate(colleague,{direction:'outbound',text:'foreign run',runId:prepared.run.id},new AbortController().signal),/Chat run was not found/);
  const foreignTenant=randomUUID() as TenantId,foreignUser=randomUUID(),foreignConversation=randomUUID(),foreignAssistant=randomUUID();
  database.prepare("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,?,'Foreign','active',?,?)").run(foreignTenant,`foreign-${foreignTenant.slice(0,8)}`,now,now);
  database.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,?,'Foreign','x','active',?,?)").run(foreignUser,foreignTenant,'foreign@example.test',now,now);
  database.prepare("INSERT INTO conversations(id,tenant_id,owner_user_id,title,status,created_at,updated_at) VALUES(?,?,?,'Foreign','active',?,?)").run(foreignConversation,foreignTenant,foreignUser,now,now);
  database.prepare("INSERT INTO messages(id,tenant_id,conversation_id,author_user_id,role,status,sequence_no,created_at,completed_at) VALUES(?,?,?,?, 'assistant','complete',0,?,?)").run(foreignAssistant,foreignTenant,foreignConversation,foreignUser,now,now);
  await assert.rejects(app.createRun(tenant,{conversationId:prepared.run.conversationId,parentMessageId:foreignAssistant,content:'cross tenant parent',modelId,clientRequestId:randomUUID()},'create',{key:'foreign-tenant-parent',requestHash:'4'.repeat(64),method:'POST',path:'/chat/runs'}),/Parent message was not found/);
  const coachPersona='Act as a supportive coach and mentor. Ask clarifying questions when useful, encourage the user, and guide them toward their own solutions with constructive, actionable feedback.';
  const coached=await app.createRun(tenant,{content:'coach this',modelId,role:'coach',tone:'default',clientRequestId:randomUUID()},'create',{key:'coach-role',requestHash:'b'.repeat(64),method:'POST',path:'/chat/runs'});
  const coachedVerdict=await app.gate(tenant,{direction:'outbound',text:coached.outboundText,runId:coached.run.id},new AbortController().signal),coachedReservation=await app.reserveBudget(tenant,coached.run);await app.dispatchStarted(tenant,coached.run,coachedReservation);for await(const _ of app.streamProvider(tenant,coached.providerRequest,{preflightDecisionId:coachedVerdict.decisionId,reservationId:coachedReservation.id,effectiveText:coachedVerdict.effectiveText},new AbortController().signal)){}
  assert.ok(preflightContexts.at(-1)?.includes(coachPersona));assert.deepEqual(providerRequests.at(-1)?.messages[0],{role:'system',content:[{type:'text',text:coachPersona}]});
  const governedAssistantId=randomUUID(),governedAssistantPrompt='Use the server-resolved governed assistant prompt.';
  database.prepare('INSERT INTO assistants(id,tenant_id,name,system_prompt,model_catalog_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(governedAssistantId,tenantId,'Governed assistant',governedAssistantPrompt,modelId,now,now);
  const assisted=await app.createRun(tenant,{content:'assistant request',provider:'xai',assistantId:governedAssistantId,clientRequestId:randomUUID()},'create',{key:'assistant-governed',requestHash:'a'.repeat(64),method:'POST',path:'/chat/runs'});
  const assistedVerdict=await app.gate(tenant,{direction:'outbound',text:assisted.outboundText,runId:assisted.run.id},new AbortController().signal),assistedReservation=await app.reserveBudget(tenant,assisted.run);await app.dispatchStarted(tenant,assisted.run,assistedReservation);for await(const _ of app.streamProvider(tenant,assisted.providerRequest,{preflightDecisionId:assistedVerdict.decisionId,reservationId:assistedReservation.id,effectiveText:assistedVerdict.effectiveText},new AbortController().signal)){}
  assert.ok(preflightContexts.at(-1)?.includes(governedAssistantPrompt));assert.equal(preflightSources.at(-1)?.at(-1),'system_persona');assert.deepEqual(providerRequests.at(-1)?.messages[0],{role:'system',content:[{type:'text',text:governedAssistantPrompt}]});assert.equal(database.prepare('SELECT assistant_id FROM conversations WHERE id=?').pluck().get(assisted.run.conversationId),governedAssistantId);
  redactAssistant=true;const inheritedAssistant=await app.createRun(tenant,{conversationId:assisted.run.conversationId,content:'inherited assistant request',clientRequestId:randomUUID()},'create',{key:'assistant-inherited',requestHash:'e'.repeat(64),method:'POST',path:'/chat/runs'}),inheritedVerdict=await app.gate(tenant,{direction:'outbound',text:inheritedAssistant.outboundText,runId:inheritedAssistant.run.id},new AbortController().signal),inheritedReservation=await app.reserveBudget(tenant,inheritedAssistant.run);await app.dispatchStarted(tenant,inheritedAssistant.run,inheritedReservation);for await(const _ of app.streamProvider(tenant,inheritedAssistant.providerRequest,{preflightDecisionId:inheritedVerdict.decisionId,reservationId:inheritedReservation.id,effectiveText:inheritedVerdict.effectiveText},new AbortController().signal)){}
  assert.ok(preflightContexts.at(-1)?.includes(governedAssistantPrompt),'a later run inherits the conversation assistant binding');assert.equal(providerRequests.at(-1)?.messages.some(message=>message.role==='system'),false,'a gate-redacted assistant part is not prepended');redactAssistant=false;
  const unboundAssistant=await app.createRun(tenant,{conversationId:assisted.run.conversationId,content:'explicitly unbound assistant request',assistantId:null,clientRequestId:randomUUID()},'create',{key:'assistant-unbound',requestHash:'1'.repeat(64),method:'POST',path:'/chat/runs'}),unboundVerdict=await app.gate(tenant,{direction:'outbound',text:unboundAssistant.outboundText,runId:unboundAssistant.run.id},new AbortController().signal),unboundReservation=await app.reserveBudget(tenant,unboundAssistant.run);await app.dispatchStarted(tenant,unboundAssistant.run,unboundReservation);for await(const _ of app.streamProvider(tenant,unboundAssistant.providerRequest,{preflightDecisionId:unboundVerdict.decisionId,reservationId:unboundReservation.id,effectiveText:unboundVerdict.effectiveText},new AbortController().signal)){}
  assert.equal(database.prepare('SELECT assistant_id FROM conversations WHERE id=?').pluck().get(assisted.run.conversationId),null,'an explicit null assistantId clears the conversation binding');assert.equal(providerRequests.at(-1)?.messages.some(message=>message.role==='system'),false,'an explicitly unbound run must not inject the old assistant prompt');
  failAfterDelta=true;
  const partialInput={content:'bill partial provider output',modelId,role:'default' as const,tone:'default' as const,clientRequestId:randomUUID()},partialClaim={key:'partial-provider-failure',requestHash:'5'.repeat(64),method:'POST',path:'/chat/runs'};
  const partial=await app.createRun(tenant,partialInput,'create',partialClaim);
  const partialVerdict=await app.gate(tenant,{direction:'outbound',text:partial.outboundText,runId:partial.run.id},new AbortController().signal),partialReservation=await app.reserveBudget(tenant,partial.run);
  await app.dispatchStarted(tenant,partial.run,partialReservation);
  await assert.rejects(async()=>{for await(const _ of app.streamProvider(tenant,partial.providerRequest,{preflightDecisionId:partialVerdict.decisionId,reservationId:partialReservation.id,effectiveText:partialVerdict.effectiveText},new AbortController().signal)){}},/provider disconnected/);
  assert.equal(providerRequests.at(-1)?.messages.some(message=>message.role==='system'),false,'default role and tone must not inject a system message');
  await app.fail(tenant,partial.run,partialReservation,{code:'INTERNAL_ERROR',message:'The model request failed',requestId:tenant.requestId,retryable:true},{partialMessageId:partial.assistant.id});await app.audit(tenant,partial.run,'failure',{});failAfterDelta=false;
  const callsAfterFailure=providerCalls,sameKey=await app.createRun(tenant,partialInput,'create',partialClaim);assert.equal(sameKey.replay,true);
  const replayedFailure:StreamEvent[]=[];for await(const item of app.replay(tenant,partial.run.id,0,new AbortController().signal))replayedFailure.push(item.event);const replayTerminal=replayedFailure.at(-1);assert.deepEqual(replayTerminal?.event==='run.failed'?{code:replayTerminal.data.error.code,retryable:replayTerminal.data.error.retryable}:null,{code:'INTERNAL_ERROR',retryable:true});assert.equal(providerCalls,callsAfterFailure,'same-key replay must not call the provider');
  const retry=await app.createRun(tenant,{messageId:partial.assistant.id,modelId,clientRequestId:randomUUID()},'regenerate',{key:'partial-provider-regenerate',requestHash:'3'.repeat(64),method:'POST',path:'/chat/runs/regenerate'}),retryVerdict=await app.gate(tenant,{direction:'outbound',text:retry.outboundText,runId:retry.run.id},new AbortController().signal),retryReservation=await app.reserveBudget(tenant,retry.run);await app.dispatchStarted(tenant,retry.run,retryReservation);let retryText='',retryUsage:{inputTokens:number;outputTokens:number;costUsd:number}|null=null;for await(const chunk of app.streamProvider(tenant,retry.providerRequest,{preflightDecisionId:retryVerdict.decisionId,reservationId:retryReservation.id,effectiveText:retryVerdict.effectiveText},new AbortController().signal)){if(chunk.type==='text')retryText+=chunk.text;else if(chunk.type==='usage')retryUsage=chunk;}assert.ok(retryUsage);await app.complete(tenant,retry.run,retry.assistant,retryText,{...retryUsage,totalTokens:retryUsage.inputTokens+retryUsage.outputTokens,modelId,provider:'openai',budgetWarnings:[]},retryReservation);await app.audit(tenant,retry.run,'success',{});assert.equal(providerCalls,callsAfterFailure+1);assert.equal((await app.getRun(tenant,retry.run.id))?.status,'completed');
  const partialUsage=database.prepare('SELECT provider_cost_microusd,customer_charge_microusd,input_tokens,output_tokens,status FROM usage_records WHERE tenant_id=? AND message_id=?').get(tenantId,partial.assistant.id) as {provider_cost_microusd:number;customer_charge_microusd:number;input_tokens:number;output_tokens:number;status:string};
  assert.ok(partialUsage.input_tokens>0&&partialUsage.output_tokens>0);assert.ok(partialUsage.provider_cost_microusd>0);assert.equal(partialUsage.customer_charge_microusd,0);assert.equal(partialUsage.status,'cancelled');
  assert.equal(partialUsage.provider_cost_microusd,estimateModelCostMicrousd({inputTokens:partialUsage.input_tokens,outputTokens:partialUsage.output_tokens,
    inputMicrousdPerMillion:1000,outputMicrousdPerMillion:2000}),'settlement must price from the tenant catalogue, not the pinned platform version');
  // Unpinned enterprise models remain visible to routing and use tenant-owned prices.
  const legacyOpenAi=randomUUID(),legacyOpenRouter=randomUUID(),openRouterConfig=randomUUID();
  database.prepare("INSERT INTO model_catalog(id,tenant_id,provider_key,model_key,display_name,enabled,is_default,context_window,max_output_tokens,input_microusd_per_million,output_microusd_per_million,capabilities_json,created_at,updated_at) VALUES(?,?,'openai','tenant-zero-openai','Zero OpenAI',1,0,4096,128,0,0,'[\"text\"]',?,?)").run(legacyOpenAi,tenantId,now,now);
  database.prepare("INSERT INTO model_catalog(id,tenant_id,provider_key,model_key,display_name,enabled,is_default,context_window,max_output_tokens,input_microusd_per_million,output_microusd_per_million,capabilities_json,created_at,updated_at) VALUES(?,?,'openrouter','tenant-zero-openrouter','Zero OpenRouter',1,0,4096,128,0,0,'[\"text\"]',?,?)").run(legacyOpenRouter,tenantId,now,now);
  database.prepare("INSERT INTO provider_config(id,tenant_id,provider_key,enabled,credential_source,credential_ciphertext,key_version,created_at,updated_at) VALUES(?,?,'openrouter',1,'encrypted','fixture',1,?,?)").run(openRouterConfig,tenantId,now,now);
  for(const legacyId of [legacyOpenAi,legacyOpenRouter])database.prepare('INSERT INTO group_model_access(group_id,model_catalog_id,enabled) VALUES(?,?,1)').run(groupId,legacyId);
  database.prepare('INSERT INTO group_provider_access(group_id,provider_config_id,enabled) VALUES(?,?,1)').run(groupId,openRouterConfig);
  const unpinned=loadRoutingCandidates(database,{tenantId,userId,inputTokens:100,outputTokens:100,now});
  assert.ok(unpinned.some(candidate=>candidate.tenantModelId===legacyOpenAi&&candidate.platformModelVersionId===null));
  mask=true;
  const masked=await app.createRun(tenant,{content:'mask two addresses',modelId,clientRequestId:randomUUID()},'create',{key:'masked',requestHash:'2'.repeat(64),method:'POST',path:'/chat/runs'});
  const maskedVerdict=await app.gate(tenant,{direction:'outbound',text:'mask two addresses',runId:masked.run.id},new AbortController().signal);
  assert.equal(maskedVerdict.action,'mask');assert.equal(maskedVerdict.protectedItemCount,2);assert.equal(database.prepare('SELECT protected_item_count FROM gate_decisions WHERE tenant_id=? AND message_id=?').pluck().get(tenantId,masked.run.userMessageId),2);
  mask=false;
  block=true;
  const blockedOriginal='SSN 123-45-6789';
  const blocked=await app.createRun(tenant,{content:blockedOriginal,modelId,clientRequestId:randomUUID()},'create',{key:'blocked',requestHash:'b'.repeat(64),method:'POST',path:'/chat/runs'});
  await app.gate(tenant,{direction:'outbound',text:blockedOriginal,runId:blocked.run.id},new AbortController().signal);
  const denied=database.prepare('SELECT c.title,p.text_content,d.content_sha256,d.protected_item_count FROM conversations c JOIN messages m ON m.conversation_id=c.id AND m.role=\'user\' JOIN message_parts p ON p.message_id=m.id JOIN gate_decisions d ON d.message_id=m.id WHERE c.id=?').get(blocked.run.conversationId) as {title:string;text_content:string;content_sha256:string;protected_item_count:number};
  assert.equal(denied.title,'Blocked by policy');assert.equal(denied.text_content,'Blocked by policy');assert.match(denied.content_sha256,/^[0-9a-f]{64}$/);
  assert.notEqual(denied.content_sha256,createHash('sha256').update('Blocked by policy').digest('hex'));
  assert.equal((database.prepare('SELECT (SELECT COUNT(*) FROM message_parts WHERE text_content LIKE ?)+(SELECT COUNT(*) FROM conversations WHERE title LIKE ?) count').get('%123-45-6789%','%123-45-6789%') as {count:number}).count,0);
  assert.notEqual(denied.content_sha256,createHash('sha256').update(blockedOriginal).digest('hex'));
  assert.equal(denied.protected_item_count,0);
  database.close();
});

function text(request:ChatRequest):string{return request.messages.at(-1)?.content.map(part=>part.type==='text'?part.text:'').join('')??'';}

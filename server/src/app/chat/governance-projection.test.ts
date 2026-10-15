import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createAuditService } from '../../lib/audit/index.js';
import { forTenant } from '../../lib/db.js';
import type { GateContext, GateEngine, GateVerdict } from '../../lib/gate/index.js';
import type { TenantContext } from '../../lib/http/index.js';
import { runMigrations } from '../../lib/migrations/index.js';
import type { ChatProvider } from '../../lib/providers/types.js';
import type { GateAction } from '../../shared/api.js';
import type { TenantId } from '../../shared/types.js';
import { openApprovalEnvelope } from './approval-envelope.js';
import { GovernedChatApplication } from './service.js';

const NOW=Date.UTC(2026,7,9,12,0,0),APPROVAL_KEY=Buffer.alloc(32,7);
const ACTIONS=['allow','flag','redact','mask','warn','block','require_approval'] as const;
const SEVERITY={flag:'low',redact:'medium',mask:'medium',warn:'medium',block:'high',require_approval:'critical'} as const;
const AUDIT_ACTION={flag:'gate.content_flagged',redact:'gate.content_redacted',mask:'gate.content_masked',warn:'gate.warning_presented',block:'gate.content_blocked',require_approval:'gate.approval_requested'} as const;
type NonAllow=Exclude<GateAction,'allow'>;

interface SeededTenant { tenantId:TenantId;userId:string;groupId:string;modelId:string;policyId:string;context:TenantContext;rules:Record<NonAllow,string>;detectorId:string }

function seedTenant(database:Database.Database,label:string):SeededTenant {
  const tenantId=randomUUID() as TenantId,userId=randomUUID(),groupId=randomUUID(),modelId=randomUUID(),providerConfigId=randomUUID(),policyId=randomUUID(),detectorId=randomUUID();
  const platform=database.prepare<[],{id:string;provider_key:string;model_key:string;display_name:string;context_window:number;max_output_tokens:number;input_microusd_per_million:number;output_microusd_per_million:number;capabilities_json:string}>(`SELECT id,provider_key,model_key,display_name,context_window,max_output_tokens,
    input_microusd_per_million,output_microusd_per_million,capabilities_json FROM platform_model_versions
    WHERE provider_key='openai' AND model_key='gpt-5.6-luna' AND authoritative=1`).get();
  assert.ok(platform);database.prepare('UPDATE platform_model_versions SET effective_from=0 WHERE id=?').run(platform.id);
  database.prepare("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,?,?,'active',?,?)").run(tenantId,`${label}-${tenantId.slice(0,8)}`,label,NOW,NOW);
  database.prepare('INSERT INTO tenant_settings(tenant_id,updated_at) VALUES(?,?)').run(tenantId,NOW);
  database.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,'active',?,?)").run(userId,tenantId,`${label}@example.test`,label,'x',NOW,NOW);
  database.prepare('INSERT INTO groups(id,tenant_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run(groupId,tenantId,'Members',NOW,NOW);
  database.prepare("INSERT INTO group_members(tenant_id,group_id,user_id,source,created_at) VALUES(?,?,?,'manual',?)").run(tenantId,groupId,userId,NOW);
  database.prepare(`INSERT INTO model_catalog(id,tenant_id,provider_key,model_key,display_name,enabled,is_default,context_window,max_output_tokens,
    input_microusd_per_million,output_microusd_per_million,capabilities_json,platform_model_version_id,created_at,updated_at)
    VALUES(?,?,?,?,?,1,1,?,?,?,?,?,?,?,?)`).run(modelId,tenantId,platform.provider_key,platform.model_key,platform.display_name,
    platform.context_window,platform.max_output_tokens,platform.input_microusd_per_million,platform.output_microusd_per_million,
    platform.capabilities_json,platform.id,NOW,NOW);
  database.prepare("INSERT INTO provider_config(id,tenant_id,provider_key,enabled,credential_source,credential_ciphertext,key_version,config_json,created_at,updated_at) VALUES(?,?,?,1,'encrypted','fixture',1,'{}',?,?)").run(providerConfigId,tenantId,platform.provider_key,NOW,NOW);
  database.prepare('INSERT INTO group_model_access(group_id,model_catalog_id,enabled) VALUES(?,?,1)').run(groupId,modelId);
  database.prepare('INSERT INTO group_provider_access(group_id,provider_config_id,enabled) VALUES(?,?,1)').run(groupId,providerConfigId);
  database.prepare('INSERT INTO policies(id,tenant_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run(policyId,tenantId,'Projection policy',NOW,NOW);
  database.prepare("INSERT INTO detector_definitions(id,tenant_id,key,kind,config_json,config_sha256,created_at,updated_at) VALUES(?,?,?,'keyword','{}',?,?,?)").run(detectorId,tenantId,`projection-${label}`,'a'.repeat(64),NOW,NOW);
  const rules={} as Record<NonAllow,string>;
  for(const action of ACTIONS.filter((item):item is NonAllow=>item!=='allow')){
    const id=randomUUID();rules[action]=id;
    database.prepare("INSERT INTO policy_rules(id,tenant_id,policy_id,detector_id,scope_type,scope_id,direction,action,severity,config_json,enabled,priority,created_at,updated_at) VALUES(?,?,?,?,'group',?,'outbound',?,?,'{}',1,100,?,?)")
      .run(id,tenantId,policyId,detectorId,groupId,action,SEVERITY[action],NOW,NOW);
  }
  const context={principal:{tenantId,userId,membershipId:userId,sessionId:randomUUID(),roles:['owner'],permissions:new Set(['chat:use'])},
    db:forTenant({tenantId}),requestId:randomUUID(),now:new Date(NOW)} as TenantContext;
  return {tenantId,userId,groupId,modelId,policyId,context,rules,detectorId};
}

function fixture(){
  const database=new Database(':memory:');database.pragma('foreign_keys=ON');runMigrations(database);
  const tenants=new Map<TenantId,SeededTenant>(),forcedActions=new Map<TenantId,GateAction>(),snapshots=new Map<TenantId,GateContext['policySnapshot']>();
  const gate:GateEngine={async evaluate(context:GateContext):Promise<GateVerdict>{
    const raw=context.parts.at(-1)?.text??'',tenantId=context.subject.tenantId as TenantId;
    snapshots.set(tenantId,context.policySnapshot);
    const action=forcedActions.get(tenantId)??raw.slice(0,raw.indexOf(':')) as GateAction,seed=tenants.get(tenantId);
    if(!ACTIONS.includes(action as typeof ACTIONS[number])||!seed)throw new Error('bad test action');
    const warningConfirmed=action==='warn'&&context.confirmedWarningToken==='warning-token';
    const allowed=action==='allow'||action==='flag'||action==='redact'||action==='mask'||warningConfirmed,approvalId=context.pass==='preflight'&&action==='require_approval'?randomUUID():null;
    const matches=action==='allow'?[]:[{matchId:randomUUID(),detectorId:seed.detectorId,detectorKind:'keyword' as const,ruleId:seed.rules[action as NonAllow],ruleRevision:7,
      partId:context.parts.at(-1)!.id,category:'restricted_term',action,confidence:'high' as const,span:{start:0,end:1},normalizedFingerprint:'internal-only',
      safeExcerpt:'[AWS_KEY] sk-live-adjacent-secret',replacementLabel:'POLICY_TERM',metadata:{}}];
    const providerParts=!allowed?null:action==='redact'?context.parts.map(part=>({...part,text:'sanitized request'})):action==='mask'?context.parts.map(part=>({...part,text:'generic replacement'})):context.parts;
    return {evaluationId:context.evaluationId,pass:context.pass,action,
      disposition:context.pass==='postflight'?(allowed?'release_to_user':'blocked')
        :action==='warn'&&!warningConfirmed?'await_user_confirmation':action==='block'?'blocked':action==='require_approval'?'pending_approval':'allow_provider_call',
      matches,providerParts,displayParts:null,redactions:[],masks:[],warningToken:action==='warn'&&!warningConfirmed?'warning-token':null,approvalRequestId:approvalId,
      policySnapshotId:context.policySnapshot.snapshotId,policyFingerprint:context.policySnapshot.fingerprint,degraded:false,failureCodes:[],
      timings:{resolveUs:0,normalizeUs:0,deterministicUs:1,semanticUs:0,vaultUs:0,totalUs:1}};
  },createPostflightStream(){throw new Error('unused');}};
  const audit=createAuditService({database,ipHmacKey:Buffer.alloc(32,1),transcriptKey:()=>Buffer.alloc(32,2),
    retentionPolicy:tenantId=>({tenantId,chatTranscriptDays:90,violationTranscriptDays:365,approvalPayloadDays:30,auditMetadataDays:null,captureTranscripts:false,effectiveAtMs:NOW}),now:()=>NOW});
  const provider={id:'openai'} as unknown as ChatProvider;
  const app=new GovernedChatApplication({database,gate,providers:{get:()=>provider},audit,approvalPayloadKey:APPROVAL_KEY,now:()=>NOW});
  const add=(label:string)=>{const seeded=seedTenant(database,label);tenants.set(seeded.tenantId,seeded);return seeded;};
  const force=(tenant:SeededTenant,action:GateAction)=>forcedActions.set(tenant.tenantId,action);
  return {database,audit,app,add,force,snapshots};
}

async function evaluate(app:GovernedChatApplication,tenant:SeededTenant,action:GateAction){
  const raw=`${action}:employee-only-${action}`;
  const prepared=await app.createRun(tenant.context,{content:raw,modelId:tenant.modelId,clientRequestId:randomUUID()},'create',
    {key:randomUUID(),requestHash:createHash('sha256').update(raw).digest('hex'),method:'POST',path:'/chat/runs'});
  const result=await app.gate(tenant.context,{direction:'outbound',text:raw,runId:prepared.run.id},new AbortController().signal);
  return {raw,prepared,result};
}

test('projects every non-allow verdict and seals a linked preflight approval envelope',async()=>{
  const f=fixture(),a=f.add('tenant-a');
  const evaluated=[];
  for(const action of ACTIONS)evaluated.push(await evaluate(f.app,a,action));

  const decisions=f.database.prepare('SELECT id,final_action,content_sha256,redacted_excerpt FROM gate_decisions WHERE tenant_id=? ORDER BY decided_at,id').all(a.tenantId) as Array<{id:string;final_action:GateAction;content_sha256:string;redacted_excerpt:string|null}>;
  assert.equal(decisions.length,ACTIONS.length);
  for(const item of evaluated){
    const decision=decisions.find(row=>row.id===item.result.decisionId)!;
    assert.match(decision.content_sha256,/^[0-9a-f]{64}$/);
    assert.notEqual(decision.content_sha256,createHash('sha256').update(item.raw).digest('hex'),'read surface must not expose a guessable plaintext digest');
    assert.equal(decision.redacted_excerpt,null,'decision rows must not persist match-local context');
  }

  const violations=f.database.prepare(`SELECT v.*,e.action audit_action,e.metadata_json audit_metadata_json FROM policy_violations v JOIN audit_events e ON e.tenant_id=v.tenant_id AND e.id=v.audit_event_id WHERE v.tenant_id=? ORDER BY v.gate_action`).all(a.tenantId) as Array<Record<string,unknown>>;
  assert.deepEqual(violations.map(row=>row.gate_action).sort(),['block','flag','mask','redact','require_approval','warn']);
  assert.equal(violations.every(row=>row.redacted_excerpt===`[${String(row.gate_action).toUpperCase()}]`),true);
  assert.doesNotMatch(JSON.stringify(violations),/sk-live-adjacent-secret/,
    'an adjacent match must never survive in the violations read model');
  for(const row of violations){
    const action=row.gate_action as NonAllow,raw=evaluated.find(item=>item.result.action===action)!.raw;
    assert.equal(row.audit_action,AUDIT_ACTION[action]);
    assert.equal(row.severity,SEVERITY[action]);
    const metadata=JSON.parse(String(row.audit_metadata_json)) as Record<string,unknown>;
    assert.equal(metadata.violationId,row.id);assert.equal(metadata.direction,'outbound');
    assert.deepEqual(metadata.ruleIds,[a.rules[action]]);
    if(action==='block')assert.equal(metadata.reasonCode,'projection-tenant-a');
    if(action==='require_approval'){assert.equal(metadata.approvalId,row.approval_id);assert.equal(metadata.expiresAtMs,NOW+24*60*60_000);}
    assert.notEqual(row.content_digest,createHash('sha256').update(raw).digest('hex'));
    assert.doesNotMatch(JSON.stringify(row),new RegExp(raw));
  }
  assert.equal((f.database.prepare('SELECT count(*) count FROM policy_violations WHERE tenant_id=? AND gate_action=?').get(a.tenantId,'allow') as {count:number}).count,0);

  const approval=f.database.prepare('SELECT * FROM policy_approval_requests WHERE tenant_id=?').get(a.tenantId) as Record<string,unknown>;
  const approvalViolation=violations.find(row=>row.gate_action==='require_approval')!;
  const approvalEvaluation=evaluated.find(item=>item.result.action==='require_approval')!;
  assert.equal(approval.id,approvalEvaluation.result.approvalId);
  assert.equal(approval.violation_id,approvalViolation.id);assert.equal(approvalViolation.approval_id,approval.id);
  assert.equal(approval.gate_decision_id,approvalEvaluation.result.decisionId);
  assert.equal(approval.status,'pending');assert.equal(approval.key_version,2);assert.equal(approval.policy_revision,7);
  assert.equal(approval.payload_crypto_scheme,'dek_v2');assert.equal(approval.payload_crypto_state,'available');
  assert.equal((approval.payload_wrapped_dek as Buffer).length,48);assert.equal((approval.payload_wrap_nonce as Buffer).length,12);assert.equal(approval.payload_kek_version,1);
  assert.equal((approval.payload_nonce as Buffer).length,12);assert.ok((approval.payload_ciphertext as Buffer).length>16);
  assert.equal((approval.payload_ciphertext as Buffer).includes(Buffer.from(approvalEvaluation.raw)),false);
  const opened=openApprovalEnvelope(APPROVAL_KEY,{tenantId:a.tenantId,approvalId:String(approval.id),violationId:String(approval.violation_id),
    ciphertext:approval.payload_ciphertext as Buffer,nonce:approval.payload_nonce as Buffer,keyVersion:Number(approval.key_version),cryptoScheme:'dek_v2',wrappedDek:approval.payload_wrapped_dek as Buffer,wrapNonce:approval.payload_wrap_nonce as Buffer,kekVersion:Number(approval.payload_kek_version)});
  assert.equal(createHash('sha256').update(approval.payload_ciphertext as Buffer).digest('hex'),approval.payload_digest);
  assert.notEqual(createHash('sha256').update(JSON.stringify(opened)).digest('hex'),approval.payload_digest);
  assert.throws(()=>openApprovalEnvelope(APPROVAL_KEY,{tenantId:a.tenantId,approvalId:String(approval.id),violationId:randomUUID(),
    ciphertext:approval.payload_ciphertext as Buffer,nonce:approval.payload_nonce as Buffer,keyVersion:Number(approval.key_version),cryptoScheme:'dek_v2',wrappedDek:approval.payload_wrapped_dek as Buffer,wrapNonce:approval.payload_wrap_nonce as Buffer,kekVersion:Number(approval.payload_kek_version)}));
  assert.equal(opened.evaluationId,approvalEvaluation.result.decisionId);assert.equal(opened.runId,approvalEvaluation.prepared.run.id);
  assert.deepEqual(opened.attachments,[],'new envelopes explicitly distinguish no attachments from legacy omission');
  assert.equal(opened.messages.at(-1)?.content[0]?.type,'text');assert.equal((opened.messages.at(-1)?.content[0] as {text:string}).text,approvalEvaluation.raw);
  assert.equal(opened.model.catalogId,a.modelId);assert.equal(opened.model.reasoningEffort,'medium');assert.equal(opened.policy.revision,7);
  assert.match(opened.policy.fingerprint,/^[0-9a-f]{64}$/);assert.equal(opened.policy.fingerprint,f.snapshots.get(a.tenantId)?.fingerprint);
  assert.notEqual(opened.policy.fingerprint,'runtime-policy');
  f.database.close();
});

test('real TenantDb keeps projections isolated between tenants',async()=>{
  const f=fixture(),a=f.add('tenant-a'),b=f.add('tenant-b');
  const av=await evaluate(f.app,a,'block'),bv=await evaluate(f.app,b,'block');
  const select=f.database.prepare<[TenantId,string],{id:string}>('SELECT id FROM policy_violations WHERE tenant_id=? AND message_id=?');
  assert.ok(a.context.db.get(select,av.prepared.run.userMessageId));assert.equal(a.context.db.get(select,bv.prepared.run.userMessageId),undefined);
  assert.ok(b.context.db.get(select,bv.prepared.run.userMessageId));assert.equal(b.context.db.get(select,av.prepared.run.userMessageId),undefined);
  assert.equal((f.database.prepare('SELECT count(DISTINCT tenant_id) count FROM policy_violations').get() as {count:number}).count,2);
  const fingerprints=f.database.prepare('SELECT request_sha256 FROM idempotency_records WHERE tenant_id IN (?,?) ORDER BY tenant_id').pluck().all(a.tenantId,b.tenantId) as string[];
  assert.equal(fingerprints.length,2);assert.notEqual(fingerprints[0],fingerprints[1],'the same request hash must be tenant-keyed before storage');
  f.database.close();
});

test('policy resolution includes only tenant, current-user, and current-group rules',async()=>{
  const f=fixture(),a=f.add('tenant-a'),foreignGroup=randomUUID(),foreignUser=randomUUID();
  const ids={tenant:randomUUID(),currentUser:randomUUID(),foreignGroup:randomUUID(),foreignUser:randomUUID()};
  const insert=f.database.prepare("INSERT INTO policy_rules(id,tenant_id,policy_id,detector_id,scope_type,scope_id,direction,action,severity,config_json,enabled,priority,created_at,updated_at) VALUES(?,?,?,?,?,?,'outbound','flag','low','{}',1,10,?,?)");
  insert.run(ids.tenant,a.tenantId,a.policyId,a.detectorId,'tenant',null,NOW,NOW);
  insert.run(ids.currentUser,a.tenantId,a.policyId,a.detectorId,'user',a.userId,NOW,NOW);
  insert.run(ids.foreignGroup,a.tenantId,a.policyId,a.detectorId,'group',foreignGroup,NOW,NOW);
  insert.run(ids.foreignUser,a.tenantId,a.policyId,a.detectorId,'user',foreignUser,NOW,NOW);

  await evaluate(f.app,a,'allow');
  const resolved=f.snapshots.get(a.tenantId)?.rules??[];
  assert.ok(resolved.some(rule=>rule.id===ids.tenant&&rule.scopeType==='org'&&rule.scopeId===a.tenantId));
  assert.ok(resolved.some(rule=>rule.id===ids.currentUser&&rule.scopeType==='user'&&rule.scopeId===a.userId));
  assert.ok(resolved.some(rule=>rule.scopeType==='group'&&rule.scopeId===a.groupId),'the member\'s group rules must remain active');
  assert.equal(resolved.some(rule=>rule.id===ids.foreignGroup),false,'another group\'s policy leaked into this user\'s snapshot');
  assert.equal(resolved.some(rule=>rule.id===ids.foreignUser),false,'another user\'s policy leaked into this user\'s snapshot');
  f.database.close();
});

test('runtime policy and its fingerprint include an enabled global detector rule',async()=>{
  const f=fixture(),a=f.add('tenant-a');
  await evaluate(f.app,a,'allow');
  const before=f.snapshots.get(a.tenantId)!.fingerprint;
  const detectorId=randomUUID(),ruleId=randomUUID();
  f.database.prepare("INSERT INTO detector_definitions(id,tenant_id,key,kind,config_json,config_sha256,enabled,builtin,created_at,updated_at) VALUES(?,NULL,'builtin-secret','secret','{}',?,1,1,?,?)")
    .run(detectorId,'b'.repeat(64),NOW,NOW);
  f.database.prepare("INSERT INTO policy_rules(id,tenant_id,policy_id,detector_id,scope_type,scope_id,direction,action,severity,config_json,enabled,priority,created_at,updated_at) VALUES(?,?,?,?, 'tenant',NULL,'outbound','warn','high','{}',1,900,?,?)")
    .run(ruleId,a.tenantId,a.policyId,detectorId,NOW,NOW+1);

  await evaluate(f.app,a,'allow');
  const after=f.snapshots.get(a.tenantId)!;
  assert.ok(after.rules.some(rule=>rule.id===ruleId&&rule.detectorKind==='secret'));
  assert.notEqual(after.fingerprint,before,'adding a global-detector rule must invalidate warning confirmations');
  f.database.close();
});

test('postflight verdicts retain one strongest violation and never create approval requests',async()=>{
  const f=fixture(),a=f.add('tenant-a');
  const prepared=(await evaluate(f.app,a,'allow')).prepared;
  for(const action of ['block','require_approval'] as const){
    const raw=`${action}:provider-only-${action}`;
    const result=await f.app.gate(a.context,{direction:'inbound',text:raw,runId:prepared.run.id},new AbortController().signal);
    assert.equal(result.action,action);assert.equal(result.approvalId,undefined);
  }
  const rows=f.database.prepare("SELECT direction,gate_action,message_id FROM policy_violations WHERE tenant_id=? AND direction='inbound' ORDER BY gate_action").all(a.tenantId) as Array<{direction:string;gate_action:string;message_id:string}>;
  assert.deepEqual(rows.map(row=>row.gate_action),['require_approval']);assert.ok(rows.every(row=>row.message_id===prepared.assistant.id));
  assert.equal((f.database.prepare('SELECT count(*) count FROM policy_approval_requests WHERE tenant_id=?').get(a.tenantId) as {count:number}).count,0);
  f.database.close();
});

test('overlapping postflight scans project one queue incident per message and direction',async()=>{
  const f=fixture(),a=f.add('tenant-a'),prepared=(await evaluate(f.app,a,'allow')).prepared;
  for(let index=0;index<3;index++)await f.app.gate(a.context,{direction:'inbound',text:'flag:repeated provider window',runId:prepared.run.id},new AbortController().signal);
  assert.equal((f.database.prepare("SELECT count(*) count FROM gate_decisions WHERE tenant_id=? AND message_id=? AND direction='inbound'").get(a.tenantId,prepared.assistant.id) as {count:number}).count,3);
  assert.equal((f.database.prepare("SELECT count(*) count FROM policy_violations WHERE tenant_id=? AND message_id=? AND direction='inbound' AND gate_action='flag'").get(a.tenantId,prepared.assistant.id) as {count:number}).count,1);
  assert.equal((f.database.prepare("SELECT count(*) count FROM audit_events WHERE tenant_id=? AND message_id=? AND action='gate.content_flagged'").get(a.tenantId,prepared.assistant.id) as {count:number}).count,1);
  f.database.close();
});

test('confirming an unchanged warning resolves its original incident instead of creating another',async()=>{
  const f=fixture(),a=f.add('tenant-a'),first=await evaluate(f.app,a,'warn');
  assert.ok(await f.app.authorizeWarnedRun(a.context,first.result.decisionId,
    {token:'warning-token',policyFingerprint:f.snapshots.get(a.tenantId)!.fingerprint}));
  const confirmed=await f.app.gate(a.context,{direction:'outbound',text:first.raw,runId:first.prepared.run.id},new AbortController().signal);
  assert.equal(confirmed.action,'warn');
  const rows=f.database.prepare("SELECT status,version FROM policy_violations WHERE tenant_id=? AND message_id=? AND gate_action='warn'").all(a.tenantId,first.prepared.run.userMessageId) as Array<{status:string;version:number}>;
  assert.deepEqual(rows,[{status:'resolved',version:2}]);
  f.database.close();
});

test('a re-evaluated submitted run strengthens its existing incident',async()=>{
  const f=fixture(),a=f.add('tenant-a'),first=await evaluate(f.app,a,'warn');
  f.force(a,'block');
  const second=await f.app.gate(a.context,{direction:'outbound',text:first.raw,runId:first.prepared.run.id},new AbortController().signal);
  assert.equal(second.action,'block');
  assert.deepEqual((f.database.prepare('SELECT final_action FROM gate_decisions WHERE tenant_id=? AND message_id=? ORDER BY rowid').all(a.tenantId,first.prepared.run.userMessageId) as Array<{final_action:string}>).map(row=>row.final_action),['warn','block']);
  assert.deepEqual((f.database.prepare('SELECT gate_action FROM policy_violations WHERE tenant_id=? AND message_id=? ORDER BY rowid').all(a.tenantId,first.prepared.run.userMessageId) as Array<{gate_action:string}>).map(row=>row.gate_action),['block']);
  assert.equal((f.database.prepare('SELECT count(*) count FROM messages WHERE tenant_id=? AND conversation_id=?').get(a.tenantId,first.prepared.run.conversationId) as {count:number}).count,2,'re-evaluation must not duplicate chat rows');
  f.database.close();
});

test('an unavailable audit chain rolls back decision, violation, approval, and chat rows together',async()=>{
  const f=fixture(),a=f.add('tenant-a');
  f.audit.append({tenantId:a.tenantId,action:'chat.message_submitted',actor:{type:'user',id:a.userId,sessionId:null,ip:null,userAgent:null,authMethod:null},
    target:{type:'message',id:null},outcome:'success',context:{requestId:'initialize-chain',traceId:null,source:'http'},metadata:{}});
  f.database.prepare("UPDATE audit_chain_heads SET status='broken' WHERE tenant_id=?").run(a.tenantId);
  const raw='require_approval:must-not-commit',prepared=await f.app.createRun(a.context,{content:raw,modelId:a.modelId,clientRequestId:randomUUID()},'create',
    {key:randomUUID(),requestHash:'f'.repeat(64),method:'POST',path:'/chat/runs'});
  await assert.rejects(f.app.gate(a.context,{direction:'outbound',text:raw,runId:prepared.run.id},new AbortController().signal),/Audit chain is unavailable/);
  for(const table of ['gate_decisions','policy_violations','policy_approval_requests','conversations','messages','message_parts'])
    assert.equal((f.database.prepare(`SELECT count(*) count FROM ${table} WHERE tenant_id=?`).get(a.tenantId) as {count:number}).count,0,table);
  f.database.close();
});

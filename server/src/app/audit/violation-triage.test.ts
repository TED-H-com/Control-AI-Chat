import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { CRYPTO_NAMESPACE } from '../../shared/crypto.js';
import test from 'node:test';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { createAuditService, verifyAuditChain } from '../../lib/audit/index.js';
import { forTenant } from '../../lib/db.js';
import type { AppVariables } from '../../lib/http/index.js';
import { runMigrations } from '../../lib/migrations/index.js';
import { routeDefinitions } from '../../routes/catalog.js';
import { mountDefinitions } from '../../routes/http.js';
import type { RouteRequest } from '../../routes/types.js';
import type { TenantId } from '../../shared/types.js';
import { createViolationTriageAdapter } from './violation-triage.js';

const AT=1_800_000_000_000;
const primary='11111111-1111-4111-8111-111111111111' as TenantId;
const foreign='22222222-2222-4222-8222-222222222222' as TenantId;
const actor='33333333-3333-4333-8333-333333333333';
const teammate='44444444-4444-4444-8444-444444444444';
const outsider='55555555-5555-4555-8555-555555555555';

function fixture(){
  const database=new Database(':memory:');database.pragma('foreign_keys=ON');runMigrations(database);
  const run=(sql:string,...params:unknown[])=>database.prepare(sql).run(...params);
  for(const [tenant,slug] of [[primary,'primary'],[foreign,'foreign']] as const){
    run("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,?,?,'active',?,?)",tenant,slug,slug,AT,AT);
    run('INSERT INTO tenant_settings(tenant_id,updated_at) VALUES(?,?)',tenant,AT);
  }
  for(const [id,tenant,email,name] of [[actor,primary,'owner@primary.test','Owner'],[teammate,primary,'reviewer@primary.test','Reviewer'],[outsider,foreign,'outside@foreign.test','Outside']] as const)
    run("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,'active',?,?)",id,tenant,email,name,'test-hash',AT,AT);
  const project=randomUUID();
  run("INSERT INTO projects(id,tenant_id,owner_user_id,name,created_at,updated_at) VALUES(?,?,?,'Vendor Review',?,?)",project,primary,actor,AT,AT);
  const audit=createAuditService({database,ipHmacKey:Buffer.alloc(32,1),transcriptKey:()=>Buffer.alloc(32,2),
    retentionPolicy:tenantId=>({tenantId,chatTranscriptDays:1,violationTranscriptDays:1,approvalPayloadDays:1,auditMetadataDays:null,captureTranscripts:false,effectiveAtMs:AT}),now:()=>AT});
  const append=(tenantId:TenantId,id:string)=>audit.append({tenantId,action:'gate.content_blocked',actor:{type:'user',id:tenantId===primary?actor:outsider,sessionId:null,ip:null,userAgent:null,authMethod:'password'},target:{type:'message',id:null},outcome:'denied',context:{requestId:`event-${id}`,traceId:null,source:'http',occurredAtMs:AT},projectId:tenantId===primary?project:null,gateAction:'block',detector:'secret',metadata:{}});
  const violation=randomUUID(),second=randomUUID(),approvalViolation=randomUUID(),foreignViolation=randomUUID();
  const insert=database.prepare(`INSERT INTO policy_violations(id,tenant_id,audit_event_id,subject_user_id,direction,detector,gate_action,severity,status,rule_ids_json,redacted_excerpt,content_digest,created_at_ms,updated_at_ms)
    VALUES(?,?,?,?,'outbound','secret','block','high',?,'[]','[BLOCK]',?, ?,?)`);
  insert.run(violation,primary,append(primary,violation).id,actor,'open','a'.repeat(64),AT,AT);
  insert.run(second,primary,append(primary,second).id,actor,'open','b'.repeat(64),AT,AT);
  insert.run(approvalViolation,primary,append(primary,approvalViolation).id,actor,'open','c'.repeat(64),AT,AT);
  insert.run(foreignViolation,foreign,append(foreign,foreignViolation).id,outsider,'open','d'.repeat(64),AT,AT);
  const approval=randomUUID();
  run(`INSERT INTO policy_approval_requests(id,tenant_id,violation_id,requesting_user_id,status,payload_ciphertext,payload_nonce,key_version,payload_digest,policy_revision,expires_at_ms,created_at_ms)
    VALUES(?,?,?,?,'pending',?,?,1,?,1,?,?)`,approval,primary,approvalViolation,actor,Buffer.from('cipher'),Buffer.alloc(12),'e'.repeat(64),AT+86_400_000,AT);
  run('UPDATE policy_violations SET approval_id=? WHERE tenant_id=? AND id=?',approval,primary,approvalViolation);
  const adapter=createViolationTriageAdapter({database,audit,idempotencyHmacKey:Buffer.alloc(32,7),now:()=>AT});
  const request=(id:string,body:unknown,version=1,tenantId=primary,userId=actor,idempotencyKey:string=randomUUID()):RouteRequest=>({tenant:{principal:{tenantId,userId,membershipId:userId,sessionId:'session',roles:['owner'],permissions:new Set(['approval:read','approval:decide'])},db:forTenant({tenantId}),requestId:'request',now:new Date(AT)},requestId:'request',params:{id},query:{},headers:new Headers({'If-Match':`"${version}"`,'Idempotency-Key':idempotencyKey}),body,rawBody:null});
  return {database,audit,adapter,request,violation,second,approvalViolation,foreignViolation,project};
}

const item=(result:{body?:unknown})=>(result.body as {item:Record<string,unknown>}).item;
const code=(result:{body?:unknown})=>(result.body as {error:{code:string}}).error.code;

test('detail GET is complete without hydrating it from the queue response',async()=>{
  const f=fixture();
  const detail=item(await f.adapter.execute('admin.violation',f.request(f.violation,null)));
  assert.deepEqual({
    severity:detail.severity,action:detail.action,detector:detail.detector,direction:detail.direction,
    user:detail.user,userId:detail.userId,project:detail.project,projectId:detail.projectId,
    redactedExcerpt:detail.redactedExcerpt,status:detail.status,version:detail.version,
  },{
    severity:'high',action:'block',detector:'secret',direction:'outbound',
    user:'Owner',userId:actor,project:'Vendor Review',projectId:f.project,
    redactedExcerpt:'[BLOCK]',status:'open',version:1,
  });
  assert.equal(Object.hasOwn(detail,'contentDigest'),false);
  assert.equal(Object.hasOwn(detail,'tenantId'),false);
  assert.deepEqual(detail.comments,[]);
  f.database.close();
});

test('detail GET exposes only the sanitized approval release projection',async()=>{
  const f=fixture(),messageId=randomUUID();
  f.database.prepare(`UPDATE policy_approval_requests SET status='releasing',release_phase='result_checkpointed',
    release_error_code='raw provider stack with bearer secret',release_message_id=?,release_attempts=3
    WHERE tenant_id=? AND violation_id=?`).run(messageId,primary,f.approvalViolation);
  const detail=item(await f.adapter.execute('admin.violation',f.request(f.approvalViolation,null)));
  assert.deepEqual({
    approvalStatus:detail.approvalStatus,releaseStatus:detail.releaseStatus,releaseErrorCode:detail.releaseErrorCode,
    releaseMessageId:detail.releaseMessageId,releaseAttempts:detail.releaseAttempts,
  },{approvalStatus:'releasing',releaseStatus:'finalizing',releaseErrorCode:'release_failed',releaseMessageId:messageId,releaseAttempts:3});
  for(const internal of ['approvalReleasePhase','releasePhase','release_error_code','releaseReservationId','providerStartedAtMs','resultDigest'])
    assert.equal(Object.hasOwn(detail,internal),false,`${internal} must stay inside the worker`);
  f.database.close();
});

test('assign and unassign are tenant-bound, versioned, and audited',async()=>{
  const f=fixture();
  const assignees=await f.adapter.execute('admin.violationAssignees',f.request(f.violation,null));
  assert.deepEqual((assignees.body as {items:Array<{id:string}>}).items.map(entry=>entry.id).sort(),[actor,teammate].sort());
  const foreignAssignee=await f.adapter.execute('admin.violationAssign',f.request(f.violation,{assigneeUserId:outsider}));
  assert.equal(foreignAssignee.status,422);assert.equal(code(foreignAssignee),'VALIDATION_FAILED');
  const assigned=await f.adapter.execute('admin.violationAssign',f.request(f.violation,{assigneeUserId:teammate}));
  assert.deepEqual({assigneeId:item(assigned).assigneeId,assignee:item(assigned).assignee,version:item(assigned).version},{assigneeId:teammate,assignee:'Reviewer',version:2});
  const stale=await f.adapter.execute('admin.violationAssign',f.request(f.violation,{assigneeUserId:null},1));
  assert.equal(stale.status,412);assert.equal(code(stale),'PRECONDITION_FAILED');
  const unassigned=await f.adapter.execute('admin.violationAssign',f.request(f.violation,{assigneeUserId:null},2));
  assert.deepEqual({assigneeId:item(unassigned).assigneeId,version:item(unassigned).version},{assigneeId:null,version:3});
  const actions=f.database.prepare("SELECT action FROM audit_events WHERE tenant_id=? AND action='admin.violation_assigned' ORDER BY sequence").pluck().all(primary);
  assert.deepEqual(actions,['admin.violation_assigned','admin.violation_assigned']);assert.equal(verifyAuditChain(f.database,primary).valid,true);
  const foreignRead=await f.adapter.execute('admin.violation',f.request(f.foreignViolation,null));
  assert.equal(foreignRead.status,404);
  f.database.close();
});

test('individual mutations replay one completed response and reject key reuse with any changed request field',async()=>{
  const f=fixture(),key='assign-exact-replay',body={assigneeUserId:teammate};
  const first=await f.adapter.execute('admin.violationAssign',f.request(f.violation,body,1,primary,actor,key));
  const replay=await f.adapter.execute('admin.violationAssign',f.request(f.violation,body,1,primary,actor,key));
  assert.deepEqual(replay,first);
  assert.deepEqual(f.database.prepare('SELECT assignee_user_id,version FROM policy_violations WHERE tenant_id=? AND id=?').get(primary,f.violation),{assignee_user_id:teammate,version:2});
  assert.equal(f.database.prepare("SELECT count(*) FROM audit_events WHERE tenant_id=? AND action='admin.violation_assigned'").pluck().get(primary),1);

  const row=f.database.prepare(`SELECT request_sha256,status,response_json FROM idempotency_records
    WHERE tenant_id=? AND actor_user_id=? AND path=? AND idempotency_key=?`).get(primary,actor,'violation-triage:admin.violationAssign',key) as {request_sha256:string;status:string;response_json:string};
  const canonical=`{"actorUserId":${JSON.stringify(actor)},"body":{"assigneeUserId":${JSON.stringify(teammate)}},"ifMatch":"\\"1\\"","method":"POST","namespace":"violation-triage","operation":"admin.violationAssign","params":{"id":${JSON.stringify(f.violation)}},"query":{},"tenantId":${JSON.stringify(primary)}}`;
  const expected=createHmac('sha256',Buffer.alloc(32,7)).update(`${CRYPTO_NAMESPACE}:durable-mutation-request:v1\0`).update(canonical).digest('hex');
  assert.deepEqual({digest:row.request_sha256,status:row.status},{digest:expected,status:'completed'});
  assert.notEqual(row.request_sha256,createHash('sha256').update(canonical).digest('hex'),'the durable request fingerprint must not be an offline-guessable bare SHA');
  assert.deepEqual(JSON.parse(row.response_json),{status:null,body:first.body});

  for(const changedRequest of [
    f.request(f.violation,{assigneeUserId:null},1,primary,actor,key),
    f.request(f.second,body,1,primary,actor,key),
    f.request(f.violation,body,2,primary,actor,key),
  ]){
    const conflict=await f.adapter.execute('admin.violationAssign',changedRequest);
    assert.equal(conflict.status,409);assert.equal(code(conflict),'IDEMPOTENCY_CONFLICT');
  }
  assert.equal(f.database.prepare('SELECT count(*) FROM idempotency_records WHERE tenant_id=? AND idempotency_key=?').pluck().get(primary,key),1);
  f.database.close();
});

test('validation and optimistic-concurrency failures never leave an idempotency claim',async()=>{
  const f=fixture(),invalidKey='invalid-assignee',staleKey='stale-version',bulkKey='bulk-conflict';
  const invalid=await f.adapter.execute('admin.violationAssign',f.request(f.violation,{assigneeUserId:outsider},1,primary,actor,invalidKey));
  assert.equal(invalid.status,422);
  f.database.prepare('UPDATE policy_violations SET version=2 WHERE tenant_id=? AND id=?').run(primary,f.second);
  const stale=await f.adapter.execute('admin.violationAssign',f.request(f.second,{assigneeUserId:teammate},1,primary,actor,staleKey));
  assert.equal(stale.status,412);
  const bulk=await f.adapter.execute('admin.violationsBulk',{...f.request('',{items:[{id:f.violation,version:1},{id:f.second,version:1}],command:'acknowledge',parameters:{},dryRun:false},1,primary,actor,bulkKey),params:{}});
  assert.equal(bulk.status,409);
  assert.deepEqual(f.database.prepare('SELECT idempotency_key FROM idempotency_records WHERE tenant_id=? AND idempotency_key IN (?,?,?)').all(primary,invalidKey,staleKey,bulkKey),[]);
  f.database.close();
});

test('the same idempotency key is independently scoped to tenant and actor',async()=>{
  const f=fixture(),key='scoped-replay-key';
  const primaryResult=await f.adapter.execute('admin.violationAcknowledge',f.request(f.violation,{},1,primary,actor,key));
  const teammateResult=await f.adapter.execute('admin.violationAcknowledge',f.request(f.second,{},1,primary,teammate,key));
  const foreignResult=await f.adapter.execute('admin.violationAcknowledge',f.request(f.foreignViolation,{},1,foreign,outsider,key));
  for(const result of [primaryResult,teammateResult,foreignResult])assert.equal(item(result).status,'triaged');
  assert.deepEqual(f.database.prepare(`SELECT tenant_id,actor_user_id FROM idempotency_records WHERE idempotency_key=?
    ORDER BY tenant_id,actor_user_id`).all(key),[
    {tenant_id:primary,actor_user_id:actor},{tenant_id:primary,actor_user_id:teammate},{tenant_id:foreign,actor_user_id:outsider},
  ]);
  f.database.close();
});

test('status transitions require scrubbed reasons and cannot bypass a linked approval',async()=>{
  const f=fixture();
  const missing=await f.adapter.execute('admin.violationStatus',f.request(f.violation,{status:'resolved',reason:'123456789'}));
  assert.equal(missing.status,422);
  const resolved=await f.adapter.execute('admin.violationStatus',f.request(f.violation,{status:'resolved',reason:'password=supersecret\u0000 Remediated'}));
  assert.equal(item(resolved).status,'resolved');assert.equal(item(resolved).resolutionReason,'[REDACTED:credential] Remediated');
  assert.equal(item(resolved).resolvedById,actor,'the resolver always comes from the authenticated principal, never the body');
  const event=f.database.prepare("SELECT metadata_json FROM audit_events WHERE tenant_id=? AND action='admin.violation_status_changed' ORDER BY sequence DESC LIMIT 1").pluck().get(primary) as string;
  assert.doesNotMatch(event,/supersecret|Remediated|resolutionReason|"reason"/);assert.match(event,/reasonCharacters/);
  const reopened=await f.adapter.execute('admin.violationStatus',f.request(f.violation,{status:'open',resolvedByUserId:outsider},2));
  assert.deepEqual({status:item(reopened).status,resolutionReason:item(reopened).resolutionReason,resolvedById:item(reopened).resolvedById},{status:'open',resolutionReason:null,resolvedById:null});

  const bypass=await f.adapter.execute('admin.violationDismiss',f.request(f.approvalViolation,{reason:'False positive evidence'}));
  assert.equal(bypass.status,409);assert.match(JSON.stringify(bypass.body),/active approval/);
  f.database.prepare("UPDATE policy_approval_requests SET status='release_failed' WHERE tenant_id=? AND violation_id=?").run(primary,f.approvalViolation);
  const retryOwned=await f.adapter.execute('admin.violationDismiss',f.request(f.approvalViolation,{reason:'Close during worker retry'}));
  assert.equal(retryOwned.status,409,'a retryable worker failure still owns terminal state');
  const acknowledged=await f.adapter.execute('admin.violationAcknowledge',f.request(f.approvalViolation,{}));
  assert.equal(item(acknowledged).status,'triaged');
  f.database.prepare("UPDATE policy_approval_requests SET status='release_indeterminate' WHERE tenant_id=? AND violation_id=?").run(primary,f.approvalViolation);
  const humanClosed=await f.adapter.execute('admin.violationDismiss',f.request(f.approvalViolation,{reason:'Investigated indeterminate release'},2));
  assert.equal(item(humanClosed).status,'dismissed','an indeterminate terminal release must remain manually triageable');
  f.database.prepare("UPDATE policy_approval_requests SET status='pending' WHERE tenant_id=? AND violation_id=?").run(primary,f.approvalViolation);
  const reopenBehindApproval=await f.adapter.execute('admin.violationStatus',f.request(f.approvalViolation,{status:'open'},3));
  assert.equal(reopenBehindApproval.status,409);
  f.database.prepare("UPDATE policy_approval_requests SET status='released' WHERE tenant_id=? AND violation_id=?").run(primary,f.approvalViolation);
  const reopenedAfterTerminal=await f.adapter.execute('admin.violationStatus',f.request(f.approvalViolation,{status:'open'},3));
  assert.equal(item(reopenedAfterTerminal).status,'open');
  f.database.prepare("UPDATE policy_violations SET status='approved',version=version+1 WHERE tenant_id=? AND id=?").run(primary,f.approvalViolation);
  const completed=await f.adapter.execute('admin.violationStatus',f.request(f.approvalViolation,{status:'resolved',reason:'Released content review complete'},5));
  assert.equal(item(completed).status,'resolved','a successfully released approval must still support human completion');
  f.database.close();
});

test('due dates and scrubbed notes commit with audit or roll back together',async()=>{
  const f=fixture(),dueAt=new Date(AT+3_600_000).toISOString();
  const invalidDue=await f.adapter.execute('admin.violationDue',f.request(f.violation,{dueAt:8_640_000_000_000_001}));
  assert.equal(invalidDue.status,422);assert.match(JSON.stringify(invalidDue.body),/supported Date range/);
  const due=await f.adapter.execute('admin.violationDue',f.request(f.violation,{dueAt}));
  assert.equal(item(due).dueAt,dueAt);
  const noted=await f.adapter.execute('admin.violationNote',f.request(f.violation,{note:'Authorization: Bearer raw-token\u0001\nReviewed safely'},2));
  assert.equal(noted.status,201);
  const comment=(item(noted).comments as Array<{body:string}>)[0]!;
  assert.equal(comment.body,'[REDACTED:credential]\nReviewed safely');
  const auditMetadata=f.database.prepare("SELECT metadata_json FROM audit_events WHERE tenant_id=? AND action='admin.violation_comment_added'").pluck().get(primary) as string;
  assert.doesNotMatch(auditMetadata,/raw-token|Reviewed safely/);
  const add=f.database.prepare('INSERT INTO policy_violation_comments(tenant_id,id,violation_id,author_user_id,body,created_at_ms) VALUES(?,?,?,?,?,?)');
  f.database.transaction(()=>{for(let index=0;index<=500;index++)add.run(primary,`cap-${String(index).padStart(3,'0')}`,f.violation,actor,`bounded ${index}`,AT+index+1);}).immediate();
  const bounded=await f.adapter.execute('admin.violation',f.request(f.violation,null,3));
  const comments=item(bounded).comments as Array<{id:string}>;
  assert.equal(comments.length,500);assert.equal(comments[0]?.id,'cap-500');assert.equal(comments.some(entry=>entry.id==='cap-000'),false);
  const cleared=await f.adapter.execute('admin.violationDue',f.request(f.violation,{dueAt:null},3));
  assert.equal(item(cleared).dueAt,null);

  f.database.prepare("UPDATE audit_chain_heads SET status='broken' WHERE tenant_id=?").run(primary);
  await assert.rejects(f.adapter.execute('admin.violationAssign',f.request(f.second,{assigneeUserId:teammate})),/Audit chain is unavailable/);
  assert.deepEqual(f.database.prepare('SELECT assignee_user_id,version FROM policy_violations WHERE tenant_id=? AND id=?').get(primary,f.second),{assignee_user_id:null,version:1});
  f.database.close();
});

test('bulk dry-run reports stale rows and execution is all-or-nothing',async()=>{
  const f=fixture(),items=[{id:f.violation,version:1},{id:f.second,version:1}];
  const preview=await f.adapter.execute('admin.violationsBulk',{...f.request('',{items,command:'acknowledge',parameters:{},dryRun:true}),params:{}});
  assert.deepEqual(preview.body,{affected:2,skipped:0,errors:[],snapshot:items});
  f.database.prepare('UPDATE policy_violations SET version=2 WHERE tenant_id=? AND id=?').run(primary,f.second);
  const refused=await f.adapter.execute('admin.violationsBulk',{...f.request('',{items,command:'acknowledge',parameters:{},dryRun:false}),params:{}});
  assert.equal(refused.status,409);
  assert.deepEqual(f.database.prepare('SELECT id,status,version FROM policy_violations WHERE tenant_id=? AND id IN (?,?) ORDER BY id').all(primary,f.violation,f.second).map(row=>({...(row as object)})),
    [f.violation,f.second].sort().map(id=>({id,status:'open',version:id===f.second?2:1})));
  const current=[{id:f.violation,version:1},{id:f.second,version:2}];
  const applied=await f.adapter.execute('admin.violationsBulk',{...f.request('',{items:current,command:'acknowledge',parameters:{},dryRun:false}),params:{}});
  assert.deepEqual(applied.body,{affected:2,skipped:0,errors:[],items:current.map(entry=>({id:entry.id,version:entry.version+1}))});
  assert.equal(f.database.prepare("SELECT count(*) FROM policy_violations WHERE tenant_id=? AND id IN (?,?) AND status='triaged'").pluck().get(primary,f.violation,f.second),2);
  assert.equal(f.database.prepare("SELECT count(*) FROM audit_events WHERE tenant_id=? AND action='admin.violation_status_changed'").pluck().get(primary),2);
  f.database.close();
});

test('bulk execution neither crosses tenants nor survives an audit failure',async()=>{
  const f=fixture();
  const crossTenant=await f.adapter.execute('admin.violationsBulk',{...f.request('',{
    items:[{id:f.violation,version:1},{id:f.foreignViolation,version:1}],command:'acknowledge',parameters:{},dryRun:false,
  }),params:{}});
  assert.equal(crossTenant.status,409);
  assert.deepEqual(f.database.prepare('SELECT id,status,version FROM policy_violations WHERE id IN (?,?) ORDER BY id').all(f.violation,f.foreignViolation).map(row=>({...(row as object)})),
    [f.violation,f.foreignViolation].sort().map(id=>({id,status:'open',version:1})));

  f.database.prepare("UPDATE audit_chain_heads SET status='broken' WHERE tenant_id=?").run(primary);
  await assert.rejects(f.adapter.execute('admin.violationsBulk',{...f.request('',{
    items:[{id:f.violation,version:1},{id:f.second,version:1}],command:'acknowledge',parameters:{},dryRun:false,
  }),params:{}}),/Audit chain is unavailable/);
  assert.deepEqual(f.database.prepare('SELECT id,status,version FROM policy_violations WHERE tenant_id=? AND id IN (?,?) ORDER BY id').all(primary,f.violation,f.second).map(row=>({...(row as object)})),
    [f.violation,f.second].sort().map(id=>({id,status:'open',version:1})));
  assert.equal(f.database.prepare("SELECT count(*) FROM audit_events WHERE tenant_id=? AND action='admin.violation_status_changed'").pluck().get(primary),0);
  f.database.close();
});

test('bulk due dates and notes use the same version and audit guarantees as individual changes',async()=>{
  const f=fixture(),first=[{id:f.violation,version:1},{id:f.second,version:1}],dueAt=new Date(AT+7_200_000).toISOString();
  const due=await f.adapter.execute('admin.violationsBulk',{...f.request('',{items:first,command:'due',parameters:{dueAt},dryRun:false}),params:{}});
  assert.equal((due.body as {affected:number}).affected,2);
  const second=first.map(item=>({...item,version:2}));
  const notes=await f.adapter.execute('admin.violationsBulk',{...f.request('',{items:second,command:'note',parameters:{note:'Authorization: Bearer raw-bulk-token\nReviewed together'},dryRun:false}),params:{}});
  assert.equal((notes.body as {affected:number}).affected,2);
  const rows=f.database.prepare('SELECT id,due_at_ms,version FROM policy_violations WHERE tenant_id=? AND id IN (?,?) ORDER BY id').all(primary,f.violation,f.second) as Array<{id:string;due_at_ms:number;version:number}>;
  assert.deepEqual(rows.map(row=>({dueAt:row.due_at_ms,version:row.version})),[{dueAt:Date.parse(dueAt),version:3},{dueAt:Date.parse(dueAt),version:3}]);
  const bodies=f.database.prepare('SELECT body FROM policy_violation_comments WHERE tenant_id=? ORDER BY violation_id').pluck().all(primary) as string[];
  assert.deepEqual(bodies,['[REDACTED:credential]\nReviewed together','[REDACTED:credential]\nReviewed together']);
  assert.equal(f.database.prepare("SELECT count(*) FROM audit_events WHERE tenant_id=? AND action IN ('admin.violation_due_changed','admin.violation_comment_added')").pluck().get(primary),4);
  f.database.close();
});

test('bulk exact replay never duplicates notes, versions, or audit events',async()=>{
  const f=fixture(),key='bulk-note-exact-replay',body={
    items:[{id:f.violation,version:1},{id:f.second,version:1}],command:'note',parameters:{note:'Reviewed once for the durable replay test'},dryRun:false,
  };
  const request=()=>({...f.request('',body,1,primary,actor,key),params:{}});
  const first=await f.adapter.execute('admin.violationsBulk',request());
  const replay=await f.adapter.execute('admin.violationsBulk',request());
  assert.deepEqual(replay,first);
  assert.deepEqual(f.database.prepare('SELECT id,version FROM policy_violations WHERE tenant_id=? AND id IN (?,?) ORDER BY id').all(primary,f.violation,f.second),
    [f.violation,f.second].sort().map(id=>({id,version:2})));
  assert.equal(f.database.prepare('SELECT count(*) FROM policy_violation_comments WHERE tenant_id=? AND violation_id IN (?,?)').pluck().get(primary,f.violation,f.second),2);
  assert.equal(f.database.prepare("SELECT count(*) FROM audit_events WHERE tenant_id=? AND action='admin.violation_comment_added'").pluck().get(primary),2);
  assert.equal(f.database.prepare("SELECT count(*) FROM idempotency_records WHERE tenant_id=? AND actor_user_id=? AND path='violation-triage:admin.violationsBulk' AND idempotency_key=?").pluck().get(primary,actor,key),1);

  const changed=await f.adapter.execute('admin.violationsBulk',{...f.request('',{...body,parameters:{note:'A different note must conflict'}},1,primary,actor,key),params:{}});
  assert.equal(changed.status,409);assert.equal(code(changed),'IDEMPOTENCY_CONFLICT');
  assert.equal(f.database.prepare('SELECT count(*) FROM policy_violation_comments WHERE tenant_id=?').pluck().get(primary),2);
  f.database.close();
});

test('bulk triage can resolve a released approval violation from approved state',async()=>{
  const f=fixture();
  f.database.prepare("UPDATE policy_approval_requests SET status='released' WHERE tenant_id=? AND violation_id=?").run(primary,f.approvalViolation);
  f.database.prepare("UPDATE policy_violations SET status='approved',version=2 WHERE tenant_id=? AND id=?").run(primary,f.approvalViolation);
  const items=[{id:f.approvalViolation,version:2}],body={items,command:'status',parameters:{status:'resolved'},reason:'Released content review complete'};
  const preview=await f.adapter.execute('admin.violationsBulk',{...f.request('',{...body,dryRun:true}),params:{}});
  assert.deepEqual(preview.body,{affected:1,skipped:0,errors:[],snapshot:items});
  const applied=await f.adapter.execute('admin.violationsBulk',{...f.request('',{...body,dryRun:false}),params:{}});
  assert.equal((applied.body as {affected:number}).affected,1);
  assert.deepEqual(f.database.prepare('SELECT status,resolution_reason,version FROM policy_violations WHERE tenant_id=? AND id=?').get(primary,f.approvalViolation),
    {status:'resolved',resolution_reason:'Released content review complete',version:3});
  f.database.close();
});

test('all-matching bulk selection uses queue filters and returns an immutable execution snapshot',async()=>{
  const f=fixture();
  const preview=await f.adapter.execute('admin.violationsBulk',{...f.request('',{
    allMatching:{filter:{status:['open'],approvalOnly:'false'},excludedIds:[f.second]},
    command:'acknowledge',parameters:{},dryRun:true,
  }),params:{}});
  assert.deepEqual(preview.body,{affected:1,skipped:0,errors:[],snapshot:[{id:f.violation,version:1}]});

  const refused=await f.adapter.execute('admin.violationsBulk',{...f.request('',{
    allMatching:{filter:{status:'open'},excludedIds:[]},command:'acknowledge',parameters:{},dryRun:false,
  }),params:{}});
  assert.equal(refused.status,422);assert.match(JSON.stringify(refused.body),/converted to its returned explicit snapshot/);
  const unknown=await f.adapter.execute('admin.violationsBulk',{...f.request('',{
    allMatching:{filter:{ignoredFilter:'anything'},excludedIds:[]},command:'acknowledge',parameters:{},dryRun:true,
  }),params:{}});
  assert.equal(unknown.status,422);assert.match(JSON.stringify(unknown.body),/Unsupported allMatching filter/);
  f.database.close();
});

test('all-matching bulk selection refuses an unbounded result set',async()=>{
  const f=fixture();
  const insert=f.database.prepare(`INSERT INTO policy_violations(id,tenant_id,audit_event_id,subject_user_id,direction,detector,gate_action,severity,status,rule_ids_json,redacted_excerpt,content_digest,created_at_ms,updated_at_ms)
    VALUES(?,?,?,?,'outbound','secret','block','high','open','[]','[BLOCK]',?, ?,?)`);
  for(let index=0;index<499;index++){
    const id=`bulk-${String(index).padStart(3,'0')}`;
    const event=f.audit.append({tenantId:primary,action:'gate.content_blocked',actor:{type:'user',id:actor,sessionId:null,ip:null,userAgent:null,authMethod:'password'},target:{type:'message',id:null},outcome:'denied',context:{requestId:`event-${id}`,traceId:null,source:'http',occurredAtMs:AT},gateAction:'block',detector:'secret',metadata:{}});
    insert.run(id,primary,event.id,actor,String(index).padStart(64,'0'),AT,AT);
  }
  const result=await f.adapter.execute('admin.violationsBulk',{...f.request('',{
    allMatching:{filter:{approvalOnly:'false'},excludedIds:[]},command:'acknowledge',parameters:{},dryRun:true,
  }),params:{}});
  assert.equal(result.status,422);assert.match(JSON.stringify(result.body),/more than 500/);
  f.database.close();
});

test('route catalogue applies read and decision permissions plus concurrency headers',()=>{
  const routes=routeDefinitions.filter(route=>route.path.startsWith('/admin/violations'));
  for(const route of routes){
    assert.equal(route.permission,route.method==='GET'?'approval:read':'approval:decide',`${route.method} ${route.path}`);
    if(route.method!=='GET'&&route.path!=='/admin/violations/bulk'){assert.equal(route.ifMatch,true);assert.equal(route.idempotency,true);}
  }
});

test('HTTP retries replay the original mutation while conflicting and oversized keys fail before another write',async()=>{
  const f=fixture(),app=new Hono<{Variables:AppVariables}>(),tenant=f.request(f.violation,null).tenant!;
  app.use('*',async(c,next)=>{
    c.set('requestId','http-triage-request');c.set('verifiedClientIp','203.0.113.9');c.set('principal',tenant.principal);
    c.set('tenant',{...tenant,requestId:'http-triage-request',db:forTenant({tenantId:primary})});await next();
  });
  mountDefinitions(app,{execute:(operation,request)=>f.adapter.execute(operation,request)},routeDefinitions.filter(route=>route.path.startsWith('/admin/violations')));
  const post=(id:string,note:string,key?:string)=>app.request(`/admin/violations/${id}/notes`,{method:'POST',headers:{
    'Content-Type':'application/json','If-Match':'"1"',...(key===undefined?{}:{'Idempotency-Key':key}),
  },body:JSON.stringify({note})});

  const key='http-note-retry',first=await post(f.violation,'One HTTP note only',key),firstBody=await first.json();
  const replay=await post(f.violation,'One HTTP note only',key),replayBody=await replay.json();
  assert.equal(first.status,201);assert.equal(replay.status,201);assert.deepEqual(replayBody,firstBody);
  const conflict=await post(f.violation,'Different HTTP note',key);
  assert.equal(conflict.status,409);assert.equal(((await conflict.json()) as {error:{code:string}}).error.code,'IDEMPOTENCY_CONFLICT');
  assert.equal(f.database.prepare('SELECT count(*) FROM policy_violation_comments WHERE tenant_id=? AND violation_id=?').pluck().get(primary,f.violation),1);
  assert.equal(f.database.prepare("SELECT count(*) FROM audit_events WHERE tenant_id=? AND action='admin.violation_comment_added'").pluck().get(primary),1);

  const bulkBody={items:[{id:f.second,version:1},{id:f.approvalViolation,version:1}],command:'note',parameters:{note:'One bulk HTTP note per row'},dryRun:false};
  const postBulk=()=>app.request('/admin/violations/bulk',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'http-bulk-retry'},body:JSON.stringify(bulkBody)});
  const bulkFirst=await postBulk(),bulkFirstBody=await bulkFirst.json();
  const bulkReplay=await postBulk(),bulkReplayBody=await bulkReplay.json();
  assert.equal(bulkFirst.status,200);assert.equal(bulkReplay.status,200);assert.deepEqual(bulkReplayBody,bulkFirstBody);
  assert.equal(f.database.prepare('SELECT count(*) FROM policy_violation_comments WHERE tenant_id=? AND violation_id IN (?,?)').pluck().get(primary,f.second,f.approvalViolation),2);
  assert.equal(f.database.prepare("SELECT count(*) FROM audit_events WHERE tenant_id=? AND action='admin.violation_comment_added'").pluck().get(primary),3);

  assert.equal((await post(f.foreignViolation,'Missing key')).status,400,'the catalogue must reject a missing key before the adapter');
  assert.equal((await post(f.foreignViolation,'Boundary key','x'.repeat(128))).status,404,'the full published key range must reach the adapter');
  assert.equal((await post(f.foreignViolation,'Oversized key','x'.repeat(129))).status,400,'the adapter must enforce the published key bound');
  assert.deepEqual(f.database.prepare('SELECT version FROM policy_violations WHERE tenant_id=? AND id=?').get(foreign,f.foreignViolation),{version:1});
  f.database.close();
});

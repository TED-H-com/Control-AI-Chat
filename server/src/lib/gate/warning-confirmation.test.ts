import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3';
import { forTenant } from '../db.js';
import { runMigrations } from '../migrations/index.js';
import { DefaultGateEngine } from './engine.js';
import { redeemWarningConfirmation, verifyWarningToken, WARNING_CONFIRMATION_NOTE } from './warning-confirmation.js';
import type { GateContext } from './types.js';
import type { TenantId } from '../../shared/types.js';

/**
 * The tokens under test are minted by the real engine, not hand-rolled here: a verifier that agrees
 * with a local re-implementation of the format and not with `warningToken` is worth nothing.
 */
const SECRET=Buffer.alloc(32,7),OTHER_SECRET=Buffer.alloc(32,9),NOW=Date.UTC(2026,7,9,12,0,0),FINGERPRINT='policy-fingerprint-v1';
const engine=new DefaultGateEngine({detectors:[],warningSecret:SECRET});

function context(input:{tenantId:string;userId:string;evaluationId:string;fingerprint?:string}):GateContext {
  const subject={tenantId:input.tenantId,userId:input.userId,groupIds:[],roles:['member'] as const};
  return {evaluationId:input.evaluationId,requestId:randomUUID(),pass:'preflight',subject,conversationId:null,messageId:null,
    projectId:null,providerId:'openai',modelId:'model',locale:'en',nowMs:NOW,
    parts:[{id:'part',source:'user_prompt',text:'company confidential roadmap',mimeType:'text/plain',fileId:null,provenance:{}}],
    policySnapshot:{snapshotId:randomUUID(),tenantId:input.tenantId,policyVersion:1,fingerprint:input.fingerprint??FINGERPRINT,rules:[],createdAtMs:NOW},
    abortSignal:new AbortController().signal,confirmedWarningToken:null,metadata:{}};
}

function seed() {
  const database=new Database(':memory:');database.pragma('foreign_keys=ON');runMigrations(database);
  const tenantId=randomUUID() as TenantId,otherTenantId=randomUUID() as TenantId;
  const userId=randomUUID(),otherUserId=randomUUID(),conversationId=randomUUID(),messageId=randomUUID(),evaluationId=randomUUID(),otherEvaluationId=randomUUID();
  const tenant=database.prepare("INSERT INTO tenants(id,slug,name,status,created_at,updated_at) VALUES(?,?,'Test','active',?,?)");
  const user=database.prepare("INSERT INTO users(id,tenant_id,email,display_name,password_hash,status,created_at,updated_at) VALUES(?,?,?,'User','x','active',?,?)");
  const decision=database.prepare("INSERT INTO gate_decisions(id,tenant_id,user_id,conversation_id,message_id,direction,final_action,status,content_sha256,matched_rule_ids_json,matched_detector_keys_json,redacted_excerpt,latency_ms,cache_hit,decided_at) VALUES(?,?,?,?,?,'outbound','warn','awaiting_confirmation',?,?,?,'company ███',3,0,?)");
  tenant.run(tenantId,`t-${tenantId.slice(0,8)}`,NOW,NOW);tenant.run(otherTenantId,`t-${otherTenantId.slice(0,8)}`,NOW,NOW);
  user.run(userId,tenantId,`owner-${userId.slice(0,8)}@example.test`,NOW,NOW);user.run(otherUserId,tenantId,`other-${otherUserId.slice(0,8)}@example.test`,NOW,NOW);
  database.prepare("INSERT INTO conversations(id,tenant_id,owner_user_id,title,status,created_at,updated_at) VALUES(?,?,?,'Warned','active',?,?)").run(conversationId,tenantId,userId,NOW,NOW);
  database.prepare("INSERT INTO messages(id,tenant_id,conversation_id,parent_message_id,author_user_id,role,status,sequence_no,created_at) VALUES(?,?,?,NULL,?,'user','complete',0,?)").run(messageId,tenantId,conversationId,userId,NOW);
  decision.run(evaluationId,tenantId,userId,conversationId,messageId,'a'.repeat(64),JSON.stringify(['rule-terms']),JSON.stringify(['keyword']),NOW);
  decision.run(otherEvaluationId,tenantId,otherUserId,conversationId,messageId,'b'.repeat(64),'[]','[]',NOW);
  return {database,tenantId,otherTenantId,userId,otherUserId,conversationId,messageId,evaluationId,otherEvaluationId};
}
const redeem=(s:ReturnType<typeof seed>,token:string,userId=s.userId,tenantId=s.tenantId,nowMs=NOW)=>
  redeemWarningConfirmation(s.database,{db:forTenant({tenantId}),userId},{token,secret:SECRET,policyFingerprint:FINGERPRINT,nowMs});
const statusOf=(s:ReturnType<typeof seed>,id:string)=>s.database.prepare('SELECT status,reviewed_by_user_id,reviewed_at,review_note FROM gate_decisions WHERE id=?').get(id) as {status:string;reviewed_by_user_id:string|null;reviewed_at:number|null;review_note:string|null};

test('a token the engine minted verifies, and its claims round-trip',()=>{
  const evaluationId=randomUUID(),userId=randomUUID();
  const token=engine.warningToken(context({tenantId:randomUUID(),userId,evaluationId}));
  const result=verifyWarningToken(token,{secret:SECRET,userId,policyFingerprint:FINGERPRINT,nowMs:NOW});
  assert.deepEqual(result,{ok:true,claims:{evaluationId,userId,policyFingerprint:FINGERPRINT,expiresAtMs:NOW+600_000}});
});

test('a payload edited after signing, or signed with another secret, is refused',()=>{
  const userId=randomUUID(),token=engine.warningToken(context({tenantId:randomUUID(),userId,evaluationId:randomUUID()}));
  const [payload,signature]=token.split('.') as [string,string];
  const claims=JSON.parse(Buffer.from(payload,'base64url').toString('utf8')) as Record<string,unknown>;
  const extended=`${Buffer.from(JSON.stringify({...claims,x:NOW+86_400_000})).toString('base64url')}.${signature}`;
  assert.deepEqual(verifyWarningToken(extended,{secret:SECRET,userId,policyFingerprint:FINGERPRINT,nowMs:NOW}),{ok:false,reason:'forged'});
  assert.deepEqual(verifyWarningToken(token,{secret:OTHER_SECRET,userId,policyFingerprint:FINGERPRINT,nowMs:NOW}),{ok:false,reason:'forged'});
});

test('a token is refused once expired, and refused before it expires only for the wrong user or a changed policy',()=>{
  const userId=randomUUID(),token=engine.warningToken(context({tenantId:randomUUID(),userId,evaluationId:randomUUID()}));
  assert.deepEqual(verifyWarningToken(token,{secret:SECRET,userId,policyFingerprint:FINGERPRINT,nowMs:NOW+600_000}),{ok:false,reason:'expired'});
  assert.deepEqual(verifyWarningToken(token,{secret:SECRET,userId:randomUUID(),policyFingerprint:FINGERPRINT,nowMs:NOW}),{ok:false,reason:'wrong_user'});
  // A warning accepted under the old policy must not authorize the send once the rule was tightened.
  assert.deepEqual(verifyWarningToken(token,{secret:SECRET,userId,policyFingerprint:'policy-fingerprint-v2',nowMs:NOW}),{ok:false,reason:'policy_changed'});
});

test('an unsigned or unreadable token is refused rather than thrown on',()=>{
  const unsigned=new DefaultGateEngine({detectors:[]}).warningToken(context({tenantId:randomUUID(),userId:randomUUID(),evaluationId:randomUUID()}));
  const check=(token:string)=>verifyWarningToken(token,{secret:SECRET,userId:'u',policyFingerprint:FINGERPRINT,nowMs:NOW});
  // An engine with no warning secret mints a bare UUID; trusting it would authorize any send.
  assert.deepEqual(check(unsigned),{ok:false,reason:'malformed'});
  for (const token of ['','.','a.','.a','a.b.c','not-a-token']) assert.equal(check(token).ok,false,token);
  const payload=Buffer.from('not json').toString('base64url');
  const signed=`${payload}.${engine.warningToken(context({tenantId:'t',userId:'u',evaluationId:'e'})).split('.')[1]!}`;
  assert.equal(check(signed).ok,false,'a validly shaped token whose payload is not the signed one is refused');
});

test('a confirmation can be spent exactly once',()=>{
  const s=seed(),token=engine.warningToken(context({tenantId:s.tenantId,userId:s.userId,evaluationId:s.evaluationId}));
  const first=redeem(s,token);
  assert.equal(first.ok,true);
  assert.deepEqual(first.ok?{...first.confirmation}:null,{evaluationId:s.evaluationId,userId:s.userId,policyFingerprint:FINGERPRINT,expiresAtMs:NOW+600_000,
    conversationId:s.conversationId,messageId:s.messageId,ruleIds:['rule-terms'],detectors:['keyword'],excerpt:'company ███'});
  assert.deepEqual(statusOf(s,s.evaluationId),{status:'approved',reviewed_by_user_id:s.userId,reviewed_at:NOW,review_note:WARNING_CONFIRMATION_NOTE});
  // Replaying the token is the whole reason single use lives on the row and not in the token.
  assert.deepEqual(redeem(s,token),{ok:false,reason:'already_confirmed'});
  s.database.close();
});

test('a decision cannot be spent from another tenant, or by a token minted for another user',()=>{
  const s=seed();
  const token=engine.warningToken(context({tenantId:s.tenantId,userId:s.userId,evaluationId:s.evaluationId}));
  assert.deepEqual(redeem(s,token,s.userId,s.otherTenantId),{ok:false,reason:'unknown_decision'});
  // The token names an evaluation, so it also has to be the caller's own warning, not a colleague's.
  const borrowed=engine.warningToken(context({tenantId:s.tenantId,userId:s.userId,evaluationId:s.otherEvaluationId}));
  assert.deepEqual(redeem(s,borrowed),{ok:false,reason:'wrong_user'});
  const unknown=engine.warningToken(context({tenantId:s.tenantId,userId:s.userId,evaluationId:randomUUID()}));
  assert.deepEqual(redeem(s,unknown),{ok:false,reason:'unknown_decision'});
  assert.equal(statusOf(s,s.evaluationId).status,'awaiting_confirmation','a refused redemption must not spend the decision');
  assert.equal(statusOf(s,s.otherEvaluationId).status,'awaiting_confirmation');
  s.database.close();
});

import { createHmac, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { TenantDb } from '../db.js';
import type { TenantId } from '../../shared/types.js';

/**
 * The counterpart to `DefaultGateEngine.warningToken`. The engine minted confirmations that nothing
 * could verify, so `gate.confirm` answered 501 and the "send anyway" button on the warning dialog
 * did nothing at all — with eight `warn` rules live, that is the whole override path.
 *
 * A confirmation is a one-shot authorization to spend one gate evaluation, not a credential that
 * says "this user may ignore warnings". It is bound to the evaluation, to the user who was shown
 * the warning, and to the policy fingerprint it was minted under; and it is redeemed against the
 * decision row, so replaying the same token cannot authorize a second send.
 */
export interface WarningTokenClaims {
  readonly evaluationId:string; readonly userId:string;
  readonly policyFingerprint:string; readonly expiresAtMs:number;
}
export type WarningRejection='malformed'|'forged'|'expired'|'wrong_user'|'policy_changed'|'unknown_decision'|'already_confirmed';
export type WarningTokenResult={readonly ok:true;readonly claims:WarningTokenClaims}|{readonly ok:false;readonly reason:WarningRejection};
export interface WarningConfirmation extends WarningTokenClaims {
  readonly conversationId:string|null; readonly messageId:string|null;
  readonly ruleIds:readonly string[]; readonly detectors:readonly string[]; readonly excerpt:string|null;
}
export type WarningConfirmationResult={readonly ok:true;readonly confirmation:WarningConfirmation}|{readonly ok:false;readonly reason:WarningRejection};

interface DecisionRow { user_id:string|null; conversation_id:string|null; message_id:string|null; matched_rule_ids_json:string; matched_detector_keys_json:string; redacted_excerpt:string|null }

const SELECT_DECISION='SELECT user_id,conversation_id,message_id,matched_rule_ids_json,matched_detector_keys_json,redacted_excerpt FROM gate_decisions WHERE tenant_id=? AND id=?';
// The SET clause cannot come before the tenant binding, so this takes the `tenant_scope` prefix that
// `forTenant` accepts (see the comment on `assertTenantFirst`).
const CLAIM_DECISION="WITH tenant_scope(id) AS (VALUES (?)) UPDATE gate_decisions SET status='approved',reviewed_by_user_id=?,reviewed_at=?,review_note=? WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND status='awaiting_confirmation'";
export const WARNING_CONFIRMATION_NOTE='Sender was shown the policy warning and confirmed the send.';

function stringList(json:string):readonly string[] {
  try { const value=JSON.parse(json) as unknown; return Array.isArray(value)?value.filter((entry):entry is string=>typeof entry==='string'):[]; }
  catch { return []; }
}

/** Pure: no database, no clock of its own, and never throws — an unreadable token is a result, not an exception. */
export function verifyWarningToken(token:string,expected:{secret:Uint8Array;userId:string;policyFingerprint:string;nowMs:number}):WarningTokenResult {
  const dot=token.indexOf('.');
  // An engine booted without a warning secret mints a bare UUID instead of a signed token. It has no
  // dot, so it lands here and is refused: an unsigned confirmation must never authorize a send.
  if (dot<1||dot>=token.length-1||token.includes('.',dot+1)) return {ok:false,reason:'malformed'};
  const payload=token.slice(0,dot),signature=Buffer.from(token.slice(dot+1),'base64url');
  const expectedSignature=createHmac('sha256',expected.secret).update(payload).digest();
  // Authenticate before parsing: the payload is attacker-controlled until the MAC says otherwise,
  // and timingSafeEqual throws on a length mismatch rather than returning false.
  if (signature.length!==expectedSignature.length||!timingSafeEqual(signature,expectedSignature)) return {ok:false,reason:'forged'};
  let claims:{e?:unknown;u?:unknown;p?:unknown;x?:unknown};
  try { claims=JSON.parse(Buffer.from(payload,'base64url').toString('utf8')) as typeof claims; } catch { return {ok:false,reason:'malformed'}; }
  const {e,u,p,x}=claims??{};
  if (typeof e!=='string'||typeof u!=='string'||typeof p!=='string'||typeof x!=='number'||!Number.isFinite(x)) return {ok:false,reason:'malformed'};
  if (x<=expected.nowMs) return {ok:false,reason:'expired'};
  if (u!==expected.userId) return {ok:false,reason:'wrong_user'};
  // Consent given under the policy as it stood is not consent under a policy that has since been
  // tightened, so a stale fingerprint fails instead of acting as a bypass of the newer rule.
  if (p!==expected.policyFingerprint) return {ok:false,reason:'policy_changed'};
  return {ok:true,claims:{evaluationId:e,userId:u,policyFingerprint:p,expiresAtMs:x}};
}

/**
 * Verifies and spends the token in one step. Single use is enforced by the decision row rather than
 * by anything in the token: the claim only matches a decision still `awaiting_confirmation`, so a
 * replay loses the update and is refused. Immediate mode takes the write lock up front, so two
 * clicks cannot both read the pending row and both decide they won.
 */
export function redeemWarningConfirmation(database:Database.Database,tenant:{db:TenantDb;userId:string},input:{token:string;secret:Uint8Array;policyFingerprint:string;nowMs:number}):WarningConfirmationResult {
  const verified=verifyWarningToken(input.token,{secret:input.secret,userId:tenant.userId,policyFingerprint:input.policyFingerprint,nowMs:input.nowMs});
  if (!verified.ok) return verified;
  const select=database.prepare<[TenantId,...unknown[]],DecisionRow>(SELECT_DECISION);
  const claim=database.prepare(CLAIM_DECISION) as Database.Statement<[TenantId,...unknown[]]>;
  return database.transaction(():WarningConfirmationResult=>{
    const row=tenant.db.get(select,verified.claims.evaluationId);
    if (!row) return {ok:false,reason:'unknown_decision'};
    // The token is signed for a user, but the decision it names belongs to one too: a token minted
    // for the caller must not be able to spend a warning raised against somebody else's message.
    if (row.user_id!==tenant.userId) return {ok:false,reason:'wrong_user'};
    if (tenant.db.run(claim,tenant.userId,input.nowMs,WARNING_CONFIRMATION_NOTE,verified.claims.evaluationId).changes!==1) return {ok:false,reason:'already_confirmed'};
    return {ok:true,confirmation:{...verified.claims,conversationId:row.conversation_id,messageId:row.message_id,
      ruleIds:stringList(row.matched_rule_ids_json),detectors:stringList(row.matched_detector_keys_json),excerpt:row.redacted_excerpt}};
  }).immediate();
}

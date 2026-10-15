import type Database from 'better-sqlite3';
import type { AuditService } from '../../lib/audit/index.js';
import { redeemWarningConfirmation, verifyWarningToken, type WarningConfirmation, type WarningRejection } from '../../lib/gate/warning-confirmation.js';
import { errorEnvelope, type TenantContext } from '../../lib/http/index.js';
import type { ChatPipelineServices, ChatReservation } from '../../routes/chat.js';
import type { ChatRun, ErrorCode, Message, StreamEvent, UsageSummary } from '../../shared/api.js';
import { planStreamRelease, StreamProtectionAccumulator } from './stream-release.js';
import {governedPipelineError} from './pipeline-error.js';

/**
 * Resumes a run that the pre-flight gate stopped at `await_user_confirmation`. The warning dialog's
 * "send anyway" button posts the confirmation token here; without this the run sat stalled forever.
 *
 * The confirmed run re-enters the same pipeline the three /chat/runs modes use — gate, reserve,
 * dispatch, stream with the post-flight scan, complete, audit — against the same run id, so no
 * second conversation, message pair or idempotency claim is created. A warning already accepted for
 * one direction no longer stops that direction; a distinct file or prompt warning still does.
 * Everything else is re-decided from scratch because a confirmation authorizes one evaluation.
 */
export interface PreparedRun { readonly run:ChatRun; readonly assistant:Message; readonly providerRequest:unknown; readonly outboundText:string; readonly mode?:'auto'|'single'|'multi_model' }

/** `ChatPipelineServices` plus the one lookup only the service can do: warned runs live in its run map. */
export interface WarnedRunPipeline extends ChatPipelineServices {
  authorizeWarnedRun(tenant:TenantContext,evaluationId:string,confirmation:{token:string;policyFingerprint:string}):Promise<PreparedRun|null>;
  policyFingerprint(tenant:TenantContext):string;
}

export interface ConfirmRunDependencies {
  readonly database:Database.Database;
  readonly chat:WarnedRunPipeline;
  readonly audit:AuditService;
  readonly warningSecret:Uint8Array;
  /** Must return the fingerprint of the policy snapshot the gate would resolve *now*, from the same
   *  source that minted the token — a fingerprint computed any other way rejects every confirmation. */
  readonly policyFingerprint:(tenant:TenantContext)=>string;
  readonly now?:()=>number;
}

export type ConfirmationRefusal=WarningRejection|'run_expired';
export interface RefusedConfirmation { readonly ok:false; readonly reason:ConfirmationRefusal; readonly status:400|403|404|409; readonly code:ErrorCode; readonly message:string }
export type ConfirmationOutcome={readonly ok:true;readonly prepared:PreparedRun;readonly confirmation:WarningConfirmation}|RefusedConfirmation;

const REFUSALS:Readonly<Record<ConfirmationRefusal,{status:400|403|404|409;code:ErrorCode;message:string}>>={
  malformed:{status:400,code:'INVALID_REQUEST',message:'The confirmation is not readable'},
  forged:{status:403,code:'FORBIDDEN',message:'The confirmation is not valid'},
  expired:{status:409,code:'CONFLICT',message:'The confirmation expired. Send the message again'},
  wrong_user:{status:403,code:'FORBIDDEN',message:'The confirmation belongs to a different user'},
  policy_changed:{status:409,code:'CONFLICT',message:'Policy changed after the warning. Send the message again'},
  unknown_decision:{status:404,code:'RESOURCE_NOT_FOUND',message:'The policy decision was not found'},
  already_confirmed:{status:409,code:'CONFLICT',message:'This confirmation was already used'},
  run_expired:{status:409,code:'CONFLICT',message:'The warned message is no longer waiting to be sent. Send it again'},
};
/**
 * Verifies the token, spends it once, records the override, and hands the warned run its
 * confirmation. Order matters: the run is claimed before the token is, so a confirmation the process
 * can no longer act on does not leave a spent token and an audit trail that reads like a send.
 */
export async function beginWarningConfirmation(deps:ConfirmRunDependencies,tenant:TenantContext,token:string):Promise<ConfirmationOutcome> {
  const now=(deps.now??Date.now)(),fingerprint=deps.policyFingerprint(tenant);
  const verified=verifyWarningToken(token,{secret:deps.warningSecret,userId:tenant.principal.userId,policyFingerprint:fingerprint,nowMs:now});
  if (!verified.ok) return {ok:false,...REFUSALS[verified.reason],reason:verified.reason};
  const prepared=await deps.chat.authorizeWarnedRun(tenant,verified.claims.evaluationId,
    {token,policyFingerprint:verified.claims.policyFingerprint});
  if (!prepared) return {ok:false,...REFUSALS.run_expired,reason:'run_expired'};
  // The claim and the audit record commit together: an override nobody can search for later is the
  // one event a compliance officer needs, so failing to write it must also undo the confirmation.
  const redeemed=deps.audit.transact(tx=>{
    const result=redeemWarningConfirmation(deps.database,{db:tenant.db,userId:tenant.principal.userId},{token,secret:deps.warningSecret,policyFingerprint:fingerprint,nowMs:now});
    if (result.ok) tx.append({tenantId:tenant.principal.tenantId,action:'gate.warning_confirmed',
      actor:{type:'user',id:tenant.principal.userId,sessionId:tenant.principal.sessionId,ip:null,userAgent:null,authMethod:null},
      target:{type:'message',id:result.confirmation.messageId},outcome:'success',
      context:{requestId:tenant.requestId,traceId:null,source:'http',occurredAtMs:now},
      subjectUserId:tenant.principal.userId,conversationId:result.confirmation.conversationId,messageId:result.confirmation.messageId,
      gateAction:'warn',
      // `detector` is the indexed column a violation search filters on and holds one value; the full
      // set of rules and detectors that fired rides along so the record is still complete.
      detector:result.confirmation.detectors[0]??null,
      metadata:{evaluationId:result.confirmation.evaluationId,runId:prepared.run.id,
        ruleIds:[...result.confirmation.ruleIds],detectors:[...result.confirmation.detectors]}});
    return result;
  });
  if (!redeemed.ok) return {ok:false,...REFUSALS[redeemed.reason],reason:redeemed.reason};
  return {ok:true,prepared,confirmation:redeemed.confirmation};
}

/** Streams the resumed run. Mirrors the /chat/runs pipeline event for event; the caller frames and persists. */
export async function* resumeConfirmedRun(deps:ConfirmRunDependencies,tenant:TenantContext,prepared:PreparedRun,signal:AbortSignal):AsyncGenerator<StreamEvent> {
  const services=deps.chat,runId=prepared.run.id,messageId=prepared.assistant.id;
  let reservation:ChatReservation|null=null,delivered=0;
  try {
    yield {event:'run.created',data:{run:prepared.run}};
    yield {event:'run.status',data:{runId,status:'gating'}};
    const pre=await services.gate(tenant,{direction:'outbound',text:prepared.outboundText,runId},signal);
    // The service only supplies the confirmation to a snapshot with the exact fingerprint that was
    // accepted. If policy changed after beginWarningConfirmation verified the token, this evaluation
    // is an unconfirmed warning again and returns a fresh token instead of inheriting stale consent.
    if (pre.action==='warn'&&pre.confirmationToken) {
      yield {event:'gate.notice',data:{runId,direction:pre.direction??'outbound',action:pre.action,decisionId:pre.decisionId,
        protectedItemCount:pre.protectedItemCount,message:pre.message,confirmationToken:pre.confirmationToken}};
      yield {event:'run.status',data:{runId,status:'awaiting_confirmation'}};
      return;
    }
    // Re-evaluated, not skipped: a rule that now blocks or demands an approver still stops the send.
    if (pre.action==='block'||pre.action==='require_approval') {
      const notice:Extract<StreamEvent,{event:'gate.notice'}>={event:'gate.notice',data:{runId,direction:pre.direction??'outbound',action:pre.action,decisionId:pre.decisionId,protectedItemCount:pre.protectedItemCount,message:pre.message,...(pre.approvalId?{approvalId:pre.approvalId}:{})}};
      yield notice;
      if (pre.action==='require_approval') { yield {event:'run.status',data:{runId,status:'awaiting_approval'}}; return; }
      const error=errorEnvelope('GATE_BLOCKED','The request was blocked by policy',tenant.requestId).error;
      await services.fail(tenant,prepared.run,null,error,{partialMessageId:null,gateNotice:notice.data});
      await services.audit(tenant,prepared.run,'denied',{decisionId:pre.decisionId,confirmedWarning:true});
      yield {event:'run.failed',data:{runId,error,partialMessageId:null}};
      return;
    }
    if(pre.action==='redact'||pre.action==='mask')yield {event:'gate.notice',data:{runId,direction:pre.direction??'outbound',action:pre.action,decisionId:pre.decisionId,protectedItemCount:pre.protectedItemCount,message:pre.message}};
    reservation=await services.reserveBudget(tenant,prepared.run);
    await services.dispatchStarted(tenant,prepared.run,reservation);
    yield {event:'run.status',data:{runId,status:'streaming'}};
    yield {event:'message.created',data:{runId,message:prepared.assistant}};
    let rawTail='',text='',index=0,lastType:'text'|'reasoning'='text',usage:UsageSummary|null=null;const protection=new StreamProtectionAccumulator<Awaited<ReturnType<typeof services.gate>>>();
    const notice=(result:Awaited<ReturnType<typeof services.gate>>,releasedCount:number):StreamEvent|null=>{
      const effective=protection.observe(result,releasedCount);return effective?{event:'gate.notice',data:{runId,direction:effective.direction??'inbound',action:effective.action,decisionId:effective.decisionId,protectedItemCount:effective.protectedItemCount,message:effective.message}}:null;
    };
    for await (const chunk of services.streamProvider(tenant,prepared.providerRequest,{preflightDecisionId:pre.decisionId,reservationId:reservation.id,effectiveText:pre.effectiveText},signal)) {
      if (chunk.type==='usage') { usage={inputTokens:chunk.inputTokens,outputTokens:chunk.outputTokens,totalTokens:chunk.inputTokens+chunk.outputTokens,costUsd:chunk.costUsd,modelId:prepared.assistant.modelId!,provider:prepared.assistant.provider!,budgetWarnings:[]}; continue; }
      // The same seam as the unconfirmed pipeline in routes/chat.ts: one holdback buffer served both
      // kinds, so reasoning and answer were concatenated and then cut by code-point count instead of
      // at the boundary between them, and the model's chain-of-thought was persisted as its reply.
      if (chunk.type!==lastType&&rawTail) {
        const boundary=await services.gate(tenant,{direction:'inbound',text:rawTail,runId},signal);
        if (boundary.action==='block'||boundary.action==='require_approval'||boundary.action==='warn'){const gateNotice=notice(boundary,0);if(gateNotice)yield gateNotice;throw Object.assign(new Error('Inbound response blocked'),{code:'GATE_BLOCKED'});}
        const release=planStreamRelease(rawTail,boundary,true),gateNotice=notice(boundary,release.protectedItemCount);if(gateNotice)yield gateNotice;
        if (release.displayText) { if(lastType==='text')text+=release.displayText; delivered+=Array.from(release.displayText).length; yield delta(lastType,runId,messageId,index++,release.displayText); }
        rawTail=release.rawTail;
      }
      rawTail+=chunk.text; lastType=chunk.type;
      const scanned=await services.gate(tenant,{direction:'inbound',text:rawTail,runId},signal);
      if (scanned.action==='block'||scanned.action==='require_approval'||scanned.action==='warn'){const gateNotice=notice(scanned,0);if(gateNotice)yield gateNotice;throw Object.assign(new Error('Inbound response blocked'),{code:'GATE_BLOCKED'});}
      const release=planStreamRelease(rawTail,scanned),gateNotice=notice(scanned,release.protectedItemCount);if(gateNotice)yield gateNotice;
      if (release.displayText) { if(chunk.type==='text')text+=release.displayText; delivered+=Array.from(release.displayText).length; yield delta(lastType,runId,messageId,index++,release.displayText); }
      rawTail=release.rawTail;
    }
    if (!usage) throw new Error('Provider ended without usage');
    const finalScan=await services.gate(tenant,{direction:'inbound',text:rawTail,runId},signal);
    if (finalScan.action==='block'||finalScan.action==='require_approval'||finalScan.action==='warn'){const gateNotice=notice(finalScan,0);if(gateNotice)yield gateNotice;throw Object.assign(new Error('Inbound response blocked'),{code:'GATE_BLOCKED'});}
    const release=planStreamRelease(rawTail,finalScan,true),tail=release.displayText,gateNotice=notice(finalScan,release.protectedItemCount);if(gateNotice)yield gateNotice;if(lastType==='text')text+=tail;
    const completed=await services.complete(tenant,prepared.run,prepared.assistant,text,usage,reservation,protection.protectedItemCount);
    await services.audit(tenant,prepared.run,'success',{inputTokens:usage.inputTokens,outputTokens:usage.outputTokens,costUsdMicros:Math.round(usage.costUsd*1_000_000),confirmedWarning:true});
    if (tail) yield delta(lastType,runId,messageId,index++,tail);
    yield {event:'usage.summary',data:{runId,usage}};
    yield {event:'run.completed',data:{runId,conversationId:prepared.run.conversationId,message:completed,usage}};
  } catch (error) {
    const cancelled=signal.aborted,api=governedPipelineError(error,tenant.requestId,cancelled,prepared.mode??'auto');
    await services.fail(tenant,prepared.run,reservation,api,{partialMessageId:messageId});
    // Same trap as the /chat/runs pipeline: deltas reach the user before any completion record can be
    // written, so if this append also fails the run has no durable trace at all. Log it loudly.
    try { await services.audit(tenant,prepared.run,'failure',{cancelled,confirmedWarning:true}); }
    catch (auditError) { console.error(`AUDIT GAP run=${runId} tenant=${tenant.principal.tenantId} deliveredCodePoints=${delivered}: the confirmed run streamed output but no completion or failure record could be written`,auditError); }
    if (cancelled) yield {event:'run.cancelled',data:{runId,partialMessageId:messageId,usage:null}};
    else yield {event:'run.failed',data:{runId,error:api,partialMessageId:messageId}};
  }
}

function delta(kind:'text'|'reasoning',runId:string,messageId:string,index:number,text:string):StreamEvent {
  return kind==='text'?{event:'assistant.delta',data:{runId,messageId,index,text}}:{event:'reasoning.delta',data:{runId,messageId,index,text,visibility:'user'}};
}

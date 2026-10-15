import type Database from 'better-sqlite3';
import type { AuditService } from '../../lib/audit/index.js';
import type { RouteRequest, RouteResult } from '../../routes/types.js';
import type { GateAction, GateDirection } from '../../shared/api.js';
import type { TenantId } from '../../shared/types.js';

interface Row {
  id:string; user_id:string|null; conversation_id:string|null; message_id:string|null; project_file_id:string|null;
  direction:GateDirection; final_action:GateAction; status:string; content_sha256:string;
  matched_rule_ids_json:string; matched_detector_keys_json:string; redacted_excerpt:string|null;
  latency_ms:number; cache_hit:number; decided_at:number;
  reviewed_by_user_id:string|null; reviewed_at:number|null; review_note:string|null;
  approval_id:string|null;
}

/**
 * What the gate did to one piece of content, for the "why was this blocked?" link on a gate notice.
 *
 * The shared contract used to promise per-rule `redactedExcerpt` and `matchCount`. Neither is stored:
 * `gate_decisions` keeps one excerpt for the whole decision and no per-rule counts, so those fields
 * could only ever have been the same excerpt repeated and a hardcoded 1. They are gone rather than
 * filled in, on the same principle as the assets screen's dropped `policies` column.
 */
export interface GateDecisionDetail {
  decisionId:string; direction:GateDirection; action:GateAction;
  status:'final'|'awaiting_confirmation'|'pending_approval'|'approved'|'denied';
  detectors:string[]; ruleIds:string[]; redactedExcerpt:string|null; contentSha256:string;
  conversationId:string|null; messageId:string|null; fileId:string|null; approvalId:string|null;
  durationMs:number; cacheHit:boolean; decidedAt:string;
  review:{ byUserId:string; at:string; note:string|null }|null;
}

// Approvals point directly at the evaluation that created them. The message correlation remains as
// a compatibility fallback for a nullable relation; joining on `content_digest` could match every
// earlier evaluation of the same text.
const SELECT=`SELECT d.id,d.user_id,d.conversation_id,d.message_id,d.project_file_id,d.direction,d.final_action,d.status,
  d.content_sha256,d.matched_rule_ids_json,d.matched_detector_keys_json,d.redacted_excerpt,d.latency_ms,d.cache_hit,
  d.decided_at,d.reviewed_by_user_id,d.reviewed_at,d.review_note,
  COALESCE(
    (SELECT a.id FROM policy_approval_requests a WHERE a.tenant_id=d.tenant_id AND a.gate_decision_id=d.id LIMIT 1),
    (SELECT v.approval_id FROM policy_violations v
      JOIN policy_approval_requests a ON a.tenant_id=v.tenant_id AND a.id=v.approval_id AND a.gate_decision_id IS NULL
      WHERE v.tenant_id=d.tenant_id AND d.message_id IS NOT NULL
        AND v.message_id=d.message_id AND v.direction=d.direction ORDER BY v.created_at_ms DESC LIMIT 1)
  ) approval_id
  FROM gate_decisions d WHERE d.tenant_id=? AND d.id=?`;

const list=(value:string):string[]=>{const parsed=JSON.parse(value) as unknown;return Array.isArray(parsed)?parsed.filter((x):x is string=>typeof x==='string'):[]};
const iso=(ms:number):string=>new Date(ms).toISOString();

export interface GateDecisionDependencies { readonly database:Database.Database; readonly audit:AuditService }

export function createGateDecisionReader(deps:GateDecisionDependencies):{supports(operation:string):boolean;execute(operation:string,request:RouteRequest):RouteResult} {
  const statement=deps.database.prepare(SELECT) as unknown as Database.Statement<[TenantId,string],Row>;
  return {
    supports:operation=>operation==='gate.decision',
    execute(_operation,request){
      const tenant=request.tenant;
      if(!tenant)return {status:401,body:{error:{code:'UNAUTHENTICATED',message:'Authentication required',requestId:request.requestId,retryable:false}}};
      const row=tenant.db.get(statement,request.params.id??'');
      // The catalog puts no permission on this route because the ordinary case is a user asking why
      // their own message was stopped. Somebody else's decision needs `audit:read`, and the refusal is
      // a 404: a 403 would confirm the id, which is the one fact a prober wants from a decision they
      // cannot read.
      const own=row?.user_id===tenant.principal.userId;
      if(!row||(!own&&!tenant.principal.permissions.has('audit:read')))
        return {status:404,body:{error:{code:'RESOURCE_NOT_FOUND',message:'Decision not found',requestId:request.requestId,retryable:false}}};
      // Reading your own decision is not an event; the gate already logged the evaluation. Reading
      // someone else's is a compliance officer opening an excerpt of a colleague's content, which is
      // exactly what an audit trail is for.
      // Targeted at the content, not at the decision: `TargetType` has no `gate_decision` member, and
      // inventing one would widen a union the audit schema validates against. The decision id travels
      // in metadata, where it is still searchable.
      if(!own)deps.audit.append({tenantId:tenant.principal.tenantId,action:'admin.audit_event_viewed',
        actor:{type:'user',id:tenant.principal.userId,sessionId:tenant.principal.sessionId,ip:null,userAgent:null,authMethod:null},
        target:row.message_id?{type:'message',id:row.message_id}:row.project_file_id?{type:'file',id:row.project_file_id}:{type:'none',id:null},
        outcome:'success',subjectUserId:row.user_id,
        context:{requestId:request.requestId,traceId:null,source:'http'},
        metadata:{gateDecisionId:row.id,finalAction:row.final_action,excerptReleased:row.redacted_excerpt!==null}});
      const detail:GateDecisionDetail={
        decisionId:row.id,direction:row.direction,action:row.final_action,status:row.status as GateDecisionDetail['status'],
        detectors:list(row.matched_detector_keys_json),ruleIds:list(row.matched_rule_ids_json),
        redactedExcerpt:row.redacted_excerpt,contentSha256:row.content_sha256,
        conversationId:row.conversation_id,messageId:row.message_id,fileId:row.project_file_id,approvalId:row.approval_id,
        durationMs:row.latency_ms,cacheHit:row.cache_hit===1,decidedAt:iso(row.decided_at),
        review:row.reviewed_at===null||row.reviewed_by_user_id===null?null
          :{byUserId:row.reviewed_by_user_id,at:iso(row.reviewed_at),note:row.review_note},
      };
      return {body:detail};
    },
  };
}

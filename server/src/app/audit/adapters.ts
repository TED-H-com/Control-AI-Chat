import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { RouteRequest, RouteResult } from '../../routes/types.js';
import type { ApprovalReleaseStatus, ApprovalStatus } from '../../shared/api.js';
import type { TenantId } from '../../shared/types.js';
import type { TenantDb } from '../../lib/db.js';
import { decodeCursor, encodeCursor } from '../../lib/http/pagination.js';
import { AUDIT_EXPORT_FIELDS, AuditSearch, actorIpHmac, auditHashObject, eventHash, scrubSecrets, streamAuditExport, validateAuditExportFields, verifyAuditChain, ViolationChangedError, type AuditExportField, type AuditExportFormat, type AuditSearchQuery, type AuditSearchRow, type AuditService, type JsonValue } from '../../lib/audit/index.js';
import { terminalApprovalRun } from '../chat/approval-run-lifecycle.js';
import { createDurableMutationIdempotency, MutationIdempotencyError } from '../idempotency/mutation.js';
import { localToUtc } from '../../lib/governance/windows.js';
import { APPROVAL_RELEASE_ERROR_CODES } from '../../shared/approval-release-errors.js';

/**
 * One audit_events row, plus the two hashes that decide whether this row's link in the chain holds:
 * the predecessor's `event_hash` and, for the first event of an epoch, that epoch's genesis hash.
 */
interface EventRow extends Record<string,unknown> { id:string; tenant_id:string; chain_epoch:number; sequence:number; occurred_at_ms:number; recorded_at_ms:number; action:string; category:string; outcome:string; severity:string; actor_type:string; actor_id:string|null; actor_session_id:string|null; actor_ip_hmac:string|null; actor_user_agent:string|null; subject_user_id:string|null; group_id:string|null; project_id:string|null; conversation_id:string|null; message_id:string|null; target_type:string; target_id:string|null; model_id:string|null; provider_id:string|null; gate_action:string|null; detector:string|null; request_id:string; trace_id:string|null; source:string; metadata_json:string; metadata_text:string; transcript_id:string|null; transcript_digest:string|null; prev_hash:string; event_hash:string; hash_version:number; prev_event_hash:string|null; genesis_hash:string|null }
interface LabelRow { kind:string; id:string; label:string|null; fallback:string|null }
interface EntityRow { kind:string; id:string }
interface MessagePartRow { text_content:string; kind:'text'|'redacted_text' }
interface ExportRow { id:string; format:AuditExportFormat; fields_json:string|null; status:string; storage_path:string|null; sha256:string|null; row_count:number|null; byte_count:number|null; error_code:string|null; created_at_ms:number; completed_at_ms:number|null; expires_at_ms:number }
/**
 * One violation, already widened with what the queue's columns need and `policy_violations` does not
 * hold: the model, provider and project belong to the audit event the violation was raised from, and
 * `occurred_at_ms` is that event's time rather than the moment the row happened to be written.
 */
interface ViolationRow { id:string; audit_event_id:string; approval_id:string|null; direction:string; detector:string; gate_action:string; severity:string; status:string; rule_ids_json:string; redacted_excerpt:string; version:number; due_at_ms:number|null; created_at_ms:number; updated_at_ms:number; conversation_id:string|null; message_id:string|null; user_id:string|null; group_id:string|null; assignee_user_id:string|null; occurred_at_ms:number; model_id:string|null; provider_id:string|null; project_id:string|null; approval_status:ApprovalStatus|null; approval_version:number|null; approval_expires_at_ms:number|null; approval_release_phase:string|null; approval_release_error_code:string|null; approval_release_message_id:string|null; approval_release_attempts:number|null }
interface ApprovalRow { id:string; violation_id:string; requesting_user_id:string; status:ApprovalStatus; assignee_user_id:string|null; decision_by_user_id:string|null; decision_reason_code:string|null; decision_note:string|null; release_message_id:string|null; release_attempts:number; release_phase:string|null; release_error_code:string|null; version:number; expires_at_ms:number; created_at_ms:number; decided_at_ms:number|null; released_at_ms:number|null; detector:string; gate_action:string; severity:string; direction:string; violation_status:string; redacted_excerpt:string; rule_ids_json:string; due_at_ms:number|null; audit_event_id:string; conversation_id:string|null; message_id:string|null; user_id:string|null; group_id:string|null; model_id:string|null; provider_id:string|null; project_id:string|null; occurred_at_ms:number }
interface DecisionRow { id:string; violation_id:string; gate_decision_id:string|null; requesting_user_id:string; status:string; version:number; expires_at_ms:number; violation_version:number; violation_status:string; group_id:string|null; conversation_id:string|null; message_id:string|null; detector:string }
interface ExpiryStatements {
  due:Database.Statement<[TenantId,...unknown[]],DecisionRow>;
  byId:Database.Statement<[TenantId,...unknown[]],DecisionRow>;
  expireApproval:Database.Statement<[TenantId,...unknown[]]>;
  expireViolation:Database.Statement<[TenantId,...unknown[]]>;
  expireGateDecision:Database.Statement<[TenantId,...unknown[]]>;
}

export interface AuditAdapterDependencies {
  database:Database.Database;
  cursorKey:Uint8Array;
  /** The same key the store hashes client addresses with; the `ip` filter cannot work without it. */
  ipHmacKey:Uint8Array;
  exportDirectory:string;
  /** Approval decisions and their linked queue state commit in the same hash-chain transaction. */
  audit:Pick<AuditService,'transact'>;
  /** Independent HMAC domain for durable approval-decision request fingerprints. */
  idempotencyHmacKey:Uint8Array;
  /** False keeps approve fail-closed before any status is claimed while release orchestration is absent. */
  approvalReleaseAvailable:boolean;
  /** Wakes the durable worker after the approval decision transaction commits. */
  approvalReleaseQueue?:{wake():void};
  logger?:Pick<Console,'error'>;
  now?:()=>number;
}

export interface AuditRouteAdapter { supports(operation:string):boolean; execute(operation:string,request:RouteRequest):Promise<RouteResult> }

const operations=new Set(['audit.events','audit.event','audit.integrity','audit.createExport','audit.export','audit.download','admin.violations','gate.approvals','gate.approval','gate.approvalDecision']);
const EXPIRABLE_APPROVAL_SQL=`SELECT a.id,a.violation_id,a.gate_decision_id,a.requesting_user_id,a.status,a.version,a.expires_at_ms,
  v.version violation_version,v.status violation_status,v.group_id,v.conversation_id,v.message_id,v.detector
  FROM policy_approval_requests a JOIN policy_violations v ON v.tenant_id=a.tenant_id AND v.id=a.violation_id
  WHERE a.tenant_id=? AND a.status IN ('pending','claimed','release_failed')`;

/**
 * The page the audit screen reads, keyed by id, with the neighbouring hash each row's integrity is
 * judged against. Fetching the full row again after the search is deliberate: the search projection
 * is also the export projection, and widening it would put `actor_ip_hmac` and `actor_user_agent`
 * into every JSON export as a side effect of drawing a table.
 */
const EVENTS_SQL=`SELECT e.*,(SELECT p.event_hash FROM audit_events p WHERE p.tenant_id=e.tenant_id AND p.chain_epoch=e.chain_epoch AND p.sequence=e.sequence-1) prev_event_hash,(SELECT c.genesis_hash FROM audit_chain_epochs c WHERE c.tenant_id=e.tenant_id AND c.chain_epoch=e.chain_epoch) genesis_hash FROM audit_events e WHERE e.tenant_id=? AND e.id IN (SELECT value FROM json_each(:ids))`;
/**
 * Names for the ids on a page. Deleted rows are included on purpose: an audit record of what a since
 * deprovisioned employee did is the record most likely to be read, and blanking the name because the
 * account is gone is how the log stops answering the question it exists for.
 */
const DIRECTORY_SQL=`WITH scope(tenant_id) AS (VALUES (?)),wanted(id) AS (SELECT value FROM json_each(:ids))
SELECT 'user' kind,u.id id,u.display_name label,u.email fallback FROM users u,scope WHERE u.tenant_id=scope.tenant_id AND u.id IN (SELECT id FROM wanted)
UNION ALL SELECT 'group',g.id,g.name,NULL FROM groups g,scope WHERE g.tenant_id=scope.tenant_id AND g.id IN (SELECT id FROM wanted)
UNION ALL SELECT 'project',p.id,p.name,NULL FROM projects p,scope WHERE p.tenant_id=scope.tenant_id AND p.id IN (SELECT id FROM wanted)
UNION ALL SELECT 'model',m.id,m.display_name,m.model_key FROM model_catalog m,scope WHERE m.tenant_id=scope.tenant_id AND m.id IN (SELECT id FROM wanted)
UNION ALL SELECT 'provider',c.provider_key,c.provider_key,NULL FROM provider_config c,scope WHERE c.tenant_id=scope.tenant_id AND c.provider_key IN (SELECT id FROM wanted)
UNION ALL SELECT 'conversation',v.id,v.title,NULL FROM conversations v,scope WHERE v.tenant_id=scope.tenant_id AND v.id IN (SELECT id FROM wanted)
UNION ALL SELECT 'tenant',t.id,t.name,NULL FROM tenants t,scope WHERE t.id=scope.tenant_id AND t.id IN (SELECT id FROM wanted)
-- A policy_rule has no name of its own; what a reviewer calls "the rule" is the policy it belongs to,
-- which is the only name in this schema a violation's rule_ids_json can be resolved to.
UNION ALL SELECT 'rule',r.id,p.name,NULL FROM policy_rules r,scope LEFT JOIN policies p ON p.tenant_id=r.tenant_id AND p.id=r.policy_id WHERE r.tenant_id=scope.tenant_id AND r.id IN (SELECT id FROM wanted)`;
/**
 * The inverse: the ids an entity filter means. The console's filters are text boxes next to columns
 * that show names, so what arrives is a name, an email or a pasted id, and `audit_events` stores only
 * ids. Resolving here keeps the id columns indexed and the join off the hot path.
 */
const ENTITY_SQL=`WITH scope(tenant_id) AS (VALUES (?))
SELECT 'user' kind,u.id id FROM users u,scope WHERE u.tenant_id=scope.tenant_id AND (u.id=:value OR u.email=:value OR u.display_name LIKE :pattern ESCAPE '\\')
UNION ALL SELECT 'group',g.id FROM groups g,scope WHERE g.tenant_id=scope.tenant_id AND (g.id=:value OR g.name LIKE :pattern ESCAPE '\\')
UNION ALL SELECT 'project',p.id FROM projects p,scope WHERE p.tenant_id=scope.tenant_id AND (p.id=:value OR p.name LIKE :pattern ESCAPE '\\')
UNION ALL SELECT 'model',m.id FROM model_catalog m,scope WHERE m.tenant_id=scope.tenant_id AND (m.id=:value OR m.model_key=:value OR m.display_name LIKE :pattern ESCAPE '\\')
UNION ALL SELECT 'provider',c.provider_key FROM provider_config c,scope WHERE c.tenant_id=scope.tenant_id AND (c.id=:value OR c.provider_key LIKE :pattern ESCAPE '\\')
UNION ALL SELECT 'conversation',v.id FROM conversations v,scope WHERE v.tenant_id=scope.tenant_id AND (v.id=:value OR v.title LIKE :pattern ESCAPE '\\')
UNION ALL SELECT 'tenant',t.id FROM tenants t,scope WHERE t.id=scope.tenant_id AND (t.id=:value OR t.name LIKE :pattern ESCAPE '\\')
UNION ALL SELECT 'rule',r.id FROM policy_rules r,scope LEFT JOIN policies p ON p.tenant_id=r.tenant_id AND p.id=r.policy_id WHERE r.tenant_id=scope.tenant_id AND (r.id=:value OR p.name LIKE :pattern ESCAPE '\\')
LIMIT 400`;
const MESSAGE_PART_SQL="SELECT text_content,kind FROM message_parts WHERE tenant_id=? AND message_id=? AND kind IN ('text','redacted_text') ORDER BY ordinal LIMIT 1";

interface ReadStatements { events:Database.Statement<[TenantId,...unknown[]],EventRow>; directory:Database.Statement<[TenantId,...unknown[]],LabelRow>; entities:Database.Statement<[TenantId,...unknown[]],EntityRow>; messagePart:Database.Statement<[TenantId,...unknown[]],MessagePartRow> }
interface ReadContext { database:Database.Database; db:TenantDb; tenantId:TenantId; ipHmacKey:Uint8Array; statements:ReadStatements }

export function createAuditRouteAdapter(deps:AuditAdapterDependencies):AuditRouteAdapter {
  const now=deps.now??Date.now;
  const releaseAvailable=deps.approvalReleaseAvailable&&deps.approvalReleaseQueue!==undefined;
  const search=new AuditSearch(deps.database,deps.cursorKey,now);
  const decisionIdempotency=createDurableMutationIdempotency({database:deps.database,audit:deps.audit,hmacKey:deps.idempotencyHmacKey,
    namespace:'approval-decision',...(deps.now===undefined?{}:{now:deps.now})});
  const statements:ReadStatements={events:deps.database.prepare(EVENTS_SQL),directory:deps.database.prepare(DIRECTORY_SQL),entities:deps.database.prepare(ENTITY_SQL),
    messagePart:deps.database.prepare(MESSAGE_PART_SQL)};
  const expiry:ExpiryStatements={
    due:deps.database.prepare(`${EXPIRABLE_APPROVAL_SQL} AND a.expires_at_ms<=? ORDER BY a.expires_at_ms,a.id`) as ExpiryStatements['due'],
    byId:deps.database.prepare(`${EXPIRABLE_APPROVAL_SQL} AND a.id=? AND a.expires_at_ms<=?`) as ExpiryStatements['byId'],
    expireApproval:deps.database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE policy_approval_requests
      SET status='expired',decision_by_user_id=NULL,decision_reason_code='expired',decision_note=NULL,decided_at_ms=?,payload_terminal_at_ms=?,
        result_ciphertext=NULL,result_nonce=NULL,result_digest=NULL,version=version+1
      WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND expires_at_ms<=? AND status IN ('pending','claimed','release_failed')`) as ExpiryStatements['expireApproval'],
    expireViolation:deps.database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE policy_violations
      SET status='expired',updated_at_ms=?,version=version+1
      WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND approval_id=? AND status IN ('open','triaged','in_review')`) as ExpiryStatements['expireViolation'],
    expireGateDecision:deps.database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE gate_decisions
      SET status='denied'
      WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND status IN ('pending_approval','approved')`) as ExpiryStatements['expireGateDecision'],
  };
  const exportById=deps.database.prepare<[TenantId,string],ExportRow>('SELECT id,format,fields_json,status,storage_path,sha256,row_count,byte_count,error_code,created_at_ms,completed_at_ms,expires_at_ms FROM audit_exports WHERE tenant_id=? AND id=?');
  return {supports:operation=>operations.has(operation),async execute(operation,request){
    const tenant=request.tenant;
    if(!tenant) return error(request,401,'UNAUTHENTICATED','Authentication required');
    const tenantId=tenant.principal.tenantId;
    const context:ReadContext={database:deps.database,db:tenant.db,tenantId,ipHmacKey:deps.ipHmacKey,statements};
    try {
      if(operation==='audit.events') { const started=now(),found=search.search(tenantId,role(tenant.principal.roles),query(context,request.query),tenant.db),body={items:events(context,found.rows.map(row=>row.id)),nextCursor:found.nextCursor,hasMore:found.hasMore};append(deps,request,'admin.audit_searched','tenant',tenantId,'success',{filterNames:filterNames(request.query),resultCount:body.items.length,elapsedMs:now()-started},now());return {body}; }
      if(operation==='audit.event') { const id=required(request.params.id),eventRow=context.db.get(context.statements.events,{ids:JSON.stringify([id])});if(!eventRow)return error(request,404,'NOT_FOUND','Audit event not found');const body=eventDetail(context,eventRow);if(body.detail.cleansedPrompt!==null)append(deps,request,'admin.transcript_viewed','tenant',tenantId,'success',{eventId:id},now());return {body}; }
      if(operation==='audit.integrity') {const epoch=optionalInt(request.query.epoch),mode=epoch===undefined?'full':'epoch';append(deps,request,'admin.chain_verification_started','tenant',tenantId,'pending',{mode,epoch:epoch??null,fromSequence:null},now());const started=now(),body=verifyAuditChain(deps.database,tenantId,epoch);append(deps,request,'admin.chain_verification_completed','tenant',tenantId,body.valid?'success':'failure',{mode,checkedRows:body.checkedRows,elapsedMs:now()-started,breakAtSequence:body.breakAtSequence},now());return {body};}
      if(operation==='admin.violations') { expireApprovals(deps,request,expiry,now()); return {body:listViolations(context,request.query,releaseAvailable)}; }
      if(operation==='gate.approvals') { expireApprovals(deps,request,expiry,now()); return {body:listApprovals(context,request.query,releaseAvailable)}; }
      if(operation==='gate.approval') { const id=required(request.params.id);expireApprovals(deps,request,expiry,now(),id);const [row]=listApprovals(context,{id,limit:'1'},releaseAvailable).items; return row?{body:row}:error(request,404,'NOT_FOUND','Approval not found'); }
      if(operation==='gate.approvalDecision') {
        let newlyQueued=false;
        const result=decisionIdempotency.execute('decide',request,(tx,at)=>decide(deps,request,expiry,at,tx,()=>{newlyQueued=true;}));
        if(newlyQueued)deps.approvalReleaseQueue!.wake();
        return result;
      }
      if(operation==='audit.createExport') return await createExport(deps,search,context,request,now(),now);
      if(operation==='audit.export') { const row=tenant.db.get(exportById,required(request.params.id)); return row?{body:exportView(row)}:error(request,404,'NOT_FOUND','Export not found'); }
      if(operation==='audit.download') { const row=tenant.db.get(exportById,required(request.params.id)); if(!row)return error(request,404,'NOT_FOUND','Export not found'); if(row.status!=='completed'||!row.storage_path)return error(request,409,'CONFLICT','Export is not ready'); if(row.expires_at_ms<=now())return error(request,404,'NOT_FOUND','Export expired'); const bytes=await readFile(row.storage_path); return {body:new Uint8Array(bytes),headers:{'Content-Type':contentType(row.format),'Content-Disposition':`attachment; filename="audit-${row.id}.${extension(row.format)}"`}}; }
      throw new Error(`NotImplemented: audit operation ${operation}`);
    } catch(e){ if(e instanceof MutationIdempotencyError)return error(request,e.status,e.code,e.message); if(e instanceof TypeError)return error(request,422,'VALIDATION_FAILED',e.message); if(e instanceof ViolationChangedError)return error(request,409,'CONFLICT','Approval changed; refresh and retry'); throw e; }
  }};
}

/**
 * The audit screen's filters, in its own vocabulary (web/src/admin/catalog.ts). Each one narrows the
 * result set; there is no key here that the server accepts and ignores, and no control on the screen
 * that is missing from this table. `search` is last because it is the free-text index lookup.
 *
 * `actor` is who acted, `user` is the person the event is about (`subject_user_id`), and `subject` is
 * the thing acted on (`target_type`/`target_id`) — three different columns, three different filters.
 */
const LIST_FILTERS=[['action','actions'],['category','categories'],['outcome','outcomes'],['severity','severities'],['verdict','gateActions'],['gateAction','gateActions'],['detector','detectors']] as const;
const ENTITY_FILTERS=[['actor','actorId','user'],['user','subjectUserId','user'],['group','groupId','group'],['model','modelId','model'],['provider','providerId','provider'],['project','projectId','project'],['subject','targetId',null]] as const;
const ID_FILTERS=['actorId','subjectUserId','groupId','projectId','conversationId','messageId','modelId','providerId','targetId','targetType','requestId','violationStatus'] as const;
const SEARCH_CONTROLS=new Set(['cursor','limit','sort','order','direction']);
function filterNames(values:Readonly<Record<string,string>>):string[]{return Object.keys(values).filter(key=>!SEARCH_CONTROLS.has(key)&&text(values[key])!==undefined).sort();}

function append(deps:AuditAdapterDependencies,request:RouteRequest,action:Parameters<AuditService['append']>[0]['action'],targetType:Parameters<AuditService['append']>[0]['target']['type'],targetId:string|null,outcome:Parameters<AuditService['append']>[0]['outcome'],metadata:Parameters<AuditService['append']>[0]['metadata'],at:number):void{
  const principal=request.tenant!.principal;
  deps.audit.transact(tx=>tx.append({tenantId:principal.tenantId,action,actor:{type:'user',id:principal.userId,sessionId:principal.sessionId,ip:null,userAgent:null,authMethod:null},target:{type:targetType,id:targetId},outcome,context:{requestId:request.requestId,traceId:null,source:'http',occurredAtMs:at},metadata}));
}

function query(context:ReadContext,q:Readonly<Record<string,string>>):AuditSearchQuery {
  const values:Record<string,unknown>={};
  setNum(values,'fromMs',q.from??q.fromMs);setNum(values,'toMs',q.to??q.toMs);setNum(values,'limit',q.limit);
  if(q.cursor)values.cursor=q.cursor;
  // The table sorts by clicking a header, which sends the column key. `occurredAt` is the only column
  // the (tenant_id,occurred_at_ms,id) index can order by, and the cursor is built from that order.
  if(q.sort==='oldest'||q.sort==='newest')values.sort=q.sort;
  else if(q.sort==='occurredAt')values.sort=(q.order??q.direction)==='asc'?'oldest':'newest';
  for(const [source,target] of LIST_FILTERS){const value=text(q[source]);if(value!==undefined)values[target]=value.split(',').filter(Boolean);}
  for(const key of ID_FILTERS){const value=text(q[key]);if(value!==undefined)values[key]=value;}
  for(const [source,target,kind] of ENTITY_FILTERS){const value=text(q[source]);if(value!==undefined)values[target]=entities(context,value,kind);}
  // `q` is the API name and `search` is the console name; AuditSearch applies the same bounded,
  // literal FTS query to either one.
  const free=text(q.search)??text(q.q);if(free!==undefined)values.text=free;
  // Last, so that a picked day wins over a from/to window an API caller also sent, rather than
  // intersecting into an empty range that would read as "no events that day".
  const day=text(q.date);if(day!==undefined)Object.assign(values,dayRange(day,workspaceTimeZone(context)));
  const ip=text(q.ip);if(ip!==undefined)values.actorIpHmac=actorIpHmac(context.ipHmacKey,context.tenantId,ip);
  if(q.hasTranscript)values.hasTranscript=q.hasTranscript==='true';
  return values as unknown as AuditSearchQuery;
}
/** A cleared filter arrives as an empty string; treating it as a value matches nothing at all. */
function text(value:string|undefined):string|undefined { const trimmed=value?.trim(); return trimmed?trimmed:undefined; }
function setNum(target:Record<string,unknown>,key:string,value:string|undefined):void { if(value!==undefined){const n=Number(value);if(!Number.isSafeInteger(n))throw new TypeError(`${key} must be an integer`);target[key]=n;} }
/** A calendar day the user picked, as the half-open millisecond range the column is stored in. */
function dayRange(value:string,timeZone:string):{fromMs:number;toMs:number} {
  const parsed=/^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const nominal=parsed?Date.UTC(Number(parsed[1]),Number(parsed[2])-1,Number(parsed[3])):NaN;
  if(!Number.isSafeInteger(nominal)||new Date(nominal).toISOString().slice(0,10)!==value)throw new TypeError('date must be a calendar date, as YYYY-MM-DD');
  const next=new Date(nominal);next.setUTCDate(next.getUTCDate()+1);
  return {fromMs:localToUtc(Number(parsed![1]),Number(parsed![2]),Number(parsed![3]),timeZone),toMs:localToUtc(next.getUTCFullYear(),next.getUTCMonth()+1,next.getUTCDate(),timeZone)};
}
function workspaceTimeZone(context:ReadContext):string {
  const statement=context.database.prepare<[TenantId],{timezone:string}>('SELECT timezone FROM tenant_settings WHERE tenant_id=?');
  return context.db.get(statement)?.timezone??'UTC';
}
/**
 * The ids an entity filter names. The typed value is always one of them: it may be an id pasted from
 * another screen, a provider key, or the id of an actor that is not a user at all, none of which the
 * directory can resolve. Keeping it also means an unmatched name yields a list that matches no row,
 * instead of an empty list that some later `IN ()` would have to special-case into "no filter".
 */
function entities(context:ReadContext,value:string,kind:string|null):string[] {
  const pattern=`%${likePattern(value)}%`;
  const ids=new Set<string>([value]);
  for(const row of context.db.all(context.statements.entities,{value,pattern}))if(kind===null||row.kind===kind)ids.add(row.id);
  return [...ids];
}
/**
 * A name for every id on one page, in one query, whatever the page is made of. Called once per page
 * and never per row: the queue screens each show a hundred rows carrying six or seven foreign keys,
 * and resolving them row by row is a hundred round trips to draw one table.
 */
function labels(context:ReadContext,ids:ReadonlyArray<string|null>):Map<string,string> {
  const names=new Map<string,string>();
  const wanted=[...new Set(ids.filter((id):id is string=>id!==null))];
  if(!wanted.length)return names;
  for(const entry of context.db.all(context.statements.directory,{ids:JSON.stringify(wanted)}))names.set(entry.id,entry.label||entry.fallback||entry.id);
  return names;
}

/** The rows named by `ids`, in that order, as the screen's columns. */
function events(context:ReadContext,ids:readonly string[]):EventView[] {
  if(!ids.length)return [];
  const rows=new Map(context.db.all(context.statements.events,{ids:JSON.stringify(ids)}).map(row=>[row.id,row] as const));
  const names=labels(context,[...rows.values()].flatMap(row=>[row.actor_id,row.subject_user_id,row.group_id,row.project_id,row.model_id,row.provider_id,row.target_id]));
  return ids.map(id=>rows.get(id)).filter((row):row is EventRow=>row!==undefined).map(row=>event(row,names));
}
interface EventView { id:string; occurredAt:string; recordedAt:string; category:string; action:string; outcome:string; severity:string; actor:string; actorId:string|null; actorType:string; subject:string; subjectType:string; subjectId:string|null; user:string|null; userId:string|null; group:string|null; groupId:string|null; model:string|null; modelId:string|null; provider:string|null; providerId:string|null; project:string|null; projectId:string|null; conversationId:string|null; verdict:string|null; detector:string|null; requestId:string; source:string; transcriptId:string|null; chainEpoch:number; sequence:number; chainStatus:ChainStatus; metadata:unknown }
interface EventDetail { messageId:string|null; policiesApplied:Array<{ruleId:string;ruleName:string;detector:string|null;action:string|null}>; matchCount:number; ruleCount:number; cleansedPrompt:{text:string;transformed:boolean}|null }
const PROMPT_LIMIT=4000;
function eventDetail(context:ReadContext,row:EventRow):EventView&{detail:EventDetail} {
  const metadata=JSON.parse(row.metadata_json) as Record<string,unknown>;
  const ruleIds=Array.isArray(metadata.ruleIds)?metadata.ruleIds.filter((id):id is string=>typeof id==='string'):[];
  const ruleNames=labels(context,ruleIds);
  const part=row.message_id===null?undefined:context.db.get(context.statements.messagePart,row.message_id);
  return {...event(row,labels(context,[row.actor_id,row.subject_user_id,row.group_id,row.project_id,row.model_id,row.provider_id,row.target_id])),detail:{
    messageId:row.message_id,
    policiesApplied:ruleIds.map(ruleId=>({ruleId,ruleName:ruleNames.get(ruleId)??ruleId,detector:row.detector,action:row.gate_action})),
    matchCount:count(metadata.matchCount),ruleCount:count(metadata.ruleCount),
    cleansedPrompt:part?{text:elide(part.text_content),transformed:part.kind==='redacted_text'||row.gate_action==='redact'||row.gate_action==='mask'}:null,
  }};
}
function count(value:unknown):number{return typeof value==='number'&&Number.isFinite(value)?value:0;}
function elide(value:string):string {const points=Array.from(value);return points.length<=PROMPT_LIMIT?value:`${points.slice(0,PROMPT_LIMIT).join('')}\n… [elided]`;}
/**
 * `tenant_id`, `prev_hash` and `event_hash` are deliberately absent. They were being emitted as
 * ordinary columns, which is a tenant id echoed back to its own tenant and two hashes no reader can
 * do anything with; what a reader needs from them is the verdict, which is `chainStatus`.
 */
function event(row:EventRow,labels:ReadonlyMap<string,string>):EventView {
  const named=(id:string|null):string|null=>id===null?null:labels.get(id)??id;
  return {
    id:row.id,occurredAt:iso(row.occurred_at_ms),recordedAt:iso(row.recorded_at_ms),
    category:row.category,action:row.action,outcome:row.outcome,severity:row.severity,
    // A service or an anonymous caller has no id to name, so the actor is what kind of caller it was.
    actor:named(row.actor_id)??row.actor_type,actorId:row.actor_id,actorType:row.actor_type,
    subject:(row.target_id===null?null:named(row.target_id))??row.target_type,subjectType:row.target_type,subjectId:row.target_id,
    user:named(row.subject_user_id),userId:row.subject_user_id,
    group:named(row.group_id),groupId:row.group_id,
    model:named(row.model_id),modelId:row.model_id,
    provider:named(row.provider_id),providerId:row.provider_id,
    project:named(row.project_id),projectId:row.project_id,
    conversationId:row.conversation_id,
    verdict:row.gate_action,detector:row.detector,requestId:row.request_id,source:row.source,transcriptId:row.transcript_id,
    chainEpoch:row.chain_epoch,sequence:row.sequence,chainStatus:chainStatus(row),
    metadata:JSON.parse(row.metadata_json) as unknown,
  };
}
type ChainStatus='verified'|'broken';
/**
 * Per-row tamper evidence: the row still hashes to the `event_hash` it was stored with, and that hash
 * is anchored — its `prev_hash` is the predecessor's `event_hash`, or the epoch's genesis hash for the
 * first event. Checking only the links would call an edited row verified, since editing a column does
 * not disturb the neighbours' hashes; that is the exact failure this screen exists to surface.
 * A deleted row is caught too, on the successor whose predecessor has gone missing.
 */
function chainStatus(row:EventRow):ChainStatus {
  try {
    const metadata=JSON.parse(row.metadata_json) as JsonValue;
    if(eventHash(auditHashObject(row,metadata))!==row.event_hash)return 'broken';
  } catch { return 'broken'; }
  const expected=row.sequence===1?row.genesis_hash:row.prev_event_hash;
  return expected!==null&&expected===row.prev_hash?'verified':'broken';
}
function iso(value:number):string { return new Date(value).toISOString(); }
function role(roles:readonly string[]):string{return [...roles].sort().join(',');}
function required(value:string|undefined):string{if(!value)throw new TypeError('Missing identifier');return value;}
function optionalInt(value:string|undefined):number|undefined{if(value===undefined)return undefined;const n=Number(value);if(!Number.isSafeInteger(n)||n<1)throw new TypeError('epoch must be a positive integer');return n;}

/**
 * The violation queue and the approval queue, in the same terms as the audit log above: the columns
 * the console declares (web/src/admin/catalog.ts), camelCased, with every foreign key resolved to a
 * name through one directory query per page.
 *
 * `policy_violations` carries neither the model, the provider, the project nor the time the content
 * was actually sent — those live on the audit event the violation was raised from, which is why both
 * queries join it. The join is LEFT, not INNER: `audit_event_id` has a foreign key but the reference
 * is to `audit_events(id)` alone, with no tenant in it, so a row whose event is missing or belongs to
 * another tenant must lose three columns rather than vanish from a queue someone is working through.
 */
const OCCURRED='COALESCE(e.occurred_at_ms,v.created_at_ms)';
// Each of these is both what the column shows and what the filter beside it searches. Splitting them
// — filtering three columns while displaying the first non-null of the three — is how a row comes
// back for a name it does not display, which reads as a wrong answer rather than a narrow one.
const SUBJECT='COALESCE(v.subject_user_id,e.subject_user_id,e.actor_id)';
const GROUP='COALESCE(v.group_id,e.group_id)';
const VIOLATION_SQL=`SELECT v.id,v.audit_event_id,v.approval_id,v.direction,v.detector,v.gate_action,v.severity,v.status,v.rule_ids_json,v.redacted_excerpt,v.version,v.due_at_ms,v.created_at_ms,v.updated_at_ms,v.conversation_id,v.message_id,
${SUBJECT} user_id,${GROUP} group_id,v.assignee_user_id assignee_user_id,${OCCURRED} occurred_at_ms,
e.model_id,e.provider_id,e.project_id,a.status approval_status,a.version approval_version,a.expires_at_ms approval_expires_at_ms,
a.release_phase approval_release_phase,a.release_error_code approval_release_error_code,a.release_message_id approval_release_message_id,a.release_attempts approval_release_attempts
FROM policy_violations v
LEFT JOIN policy_approval_requests a ON a.tenant_id=v.tenant_id AND a.id=v.approval_id
LEFT JOIN audit_events e ON e.tenant_id=v.tenant_id AND e.id=v.audit_event_id
WHERE v.tenant_id=?`;
const APPROVAL_SQL=`SELECT a.id,a.violation_id,a.requesting_user_id,a.status,COALESCE(a.assignee_user_id,v.assignee_user_id) assignee_user_id,a.decision_by_user_id,a.decision_reason_code,a.decision_note,a.release_message_id,a.release_attempts,a.release_phase,a.release_error_code,a.version,a.expires_at_ms,a.created_at_ms,a.decided_at_ms,a.released_at_ms,
v.detector,v.gate_action,v.severity,v.direction,v.status violation_status,v.redacted_excerpt,v.rule_ids_json,v.due_at_ms,v.audit_event_id,v.conversation_id,v.message_id,
${SUBJECT} user_id,${GROUP} group_id,e.model_id,e.provider_id,e.project_id,${OCCURRED} occurred_at_ms
FROM policy_approval_requests a
JOIN policy_violations v ON v.tenant_id=a.tenant_id AND v.id=a.violation_id
LEFT JOIN audit_events e ON e.tenant_id=v.tenant_id AND e.id=v.audit_event_id
WHERE a.tenant_id=?`;

/**
 * Every filter the violations screen declares, in its own vocabulary. `action` is the gate's verdict
 * on this screen (the console's column of the same name renders `gate_action`), not the audit action;
 * `gateAction` is kept beside it because that is the only name the previous implementation read and
 * an API caller may still be sending it.
 */
const VIOLATION_LISTS=[['status','v.status'],['severity','v.severity'],['action','v.gate_action'],['gateAction','v.gate_action'],['detector','v.detector'],['direction','v.direction']] as const;
const VIOLATION_ENTITIES=[['user',[SUBJECT],'user'],['assignee',['v.assignee_user_id'],'user'],['group',[GROUP],'group'],['model',['e.model_id'],'model'],['provider',['e.provider_id'],'provider'],['project',['e.project_id'],'project']] as const;
const VIOLATION_TEXT=['v.id','v.detector','v.redacted_excerpt','e.request_id'] as const;
/**
 * The approval queue is the violation queue seen from the held request, so it answers the same
 * vocabulary plus the three people only an approval has: who asked, who holds it, and who decided.
 */
const APPROVAL_LISTS=[['status','a.status'],['violationStatus','v.status'],['severity','v.severity'],['action','v.gate_action'],['gateAction','v.gate_action'],['detector','v.detector'],['direction','v.direction']] as const;
const APPROVAL_ENTITIES=[['user',[SUBJECT],'user'],['requester',['a.requesting_user_id'],'user'],['assignee',['COALESCE(a.assignee_user_id,v.assignee_user_id)'],'user'],['decidedBy',['a.decision_by_user_id'],'user'],['group',[GROUP],'group'],['model',['e.model_id'],'model'],['provider',['e.provider_id'],'provider'],['project',['e.project_id'],'project']] as const;
const APPROVAL_TEXT=['a.id','a.violation_id','v.detector','v.redacted_excerpt','e.request_id'] as const;

interface Page<T> { items:T[]; nextCursor:string|null; hasMore:boolean }
interface QueueCursor { v:1; resource:'violations'|'approvals'; order:'asc'|'desc'; at:number; id:string }
function listViolations(context:ReadContext,q:Readonly<Record<string,string>>,releaseAvailable:boolean):Page<ViolationView> {
  const filter=where(context,q,VIOLATION_LISTS,VIOLATION_ENTITIES,VIOLATION_TEXT,OCCURRED,'v.rule_ids_json');
  // The one filter with no column behind it: an approval request either exists for this violation or
  // it does not, which is what "approval only" asks and what the reviewer's queue is filtered down to.
  const only=flag('approvalOnly',q.approvalOnly);
  if(only!==undefined)filter.where.push(only?'v.approval_id IS NOT NULL':'v.approval_id IS NULL');
  const paging=queuePaging(q,'violations','occurredAt');
  addCursor(filter,paging,OCCURRED,'v.id');
  const rows=run<ViolationRow>(context,`${VIOLATION_SQL} AND ${filter.where.join(' AND ')} ORDER BY ${OCCURRED} ${paging.order.toUpperCase()},v.id ${paging.order.toUpperCase()} LIMIT ?`,filter.params,q.limit);
  const ruleIds=rows.items.map(row=>jsonIds(row.rule_ids_json));
  const names=labels(context,rows.items.flatMap((row,index)=>[row.user_id,row.group_id,row.assignee_user_id,row.model_id,row.provider_id,row.project_id,...ruleIds[index]??[]]));
  const last=rows.items.at(-1);
  return {items:rows.items.map((row,index)=>violation(row,ruleIds[index]??[],names,releaseAvailable)),nextCursor:rows.hasMore&&last?queueCursor(paging,last.occurred_at_ms,last.id):null,hasMore:rows.hasMore};
}

/**
 * Resolves the exact same filter vocabulary as the violation table into a bounded version snapshot.
 * A bulk confirmation operates on this returned snapshot, never by evaluating the filters again.
 */
export function selectViolationVersions(database:Database.Database,db:TenantDb,tenantId:TenantId,q:Readonly<Record<string,string|string[]>>):Array<{id:string;version:number}> {
  const query=Object.fromEntries(Object.entries(q).map(([key,value])=>[key,Array.isArray(value)?value.join(','):value]));
  const context:ReadContext={database,db,tenantId,ipHmacKey:Buffer.alloc(32),statements:{events:database.prepare(EVENTS_SQL),directory:database.prepare(DIRECTORY_SQL),entities:database.prepare(ENTITY_SQL),messagePart:database.prepare(MESSAGE_PART_SQL)}};
  const filter=where(context,query,VIOLATION_LISTS,VIOLATION_ENTITIES,VIOLATION_TEXT,OCCURRED,'v.rule_ids_json');
  const only=flag('approvalOnly',query.approvalOnly);
  if(only!==undefined)filter.where.push(only?'v.approval_id IS NOT NULL':'v.approval_id IS NULL');
  const statement=database.prepare(`${VIOLATION_SQL} AND ${filter.where.join(' AND ')} ORDER BY ${OCCURRED} DESC,v.id DESC LIMIT 501`) as Database.Statement<[TenantId,...unknown[]],ViolationRow>;
  const rows=db.all(statement,...filter.params);
  if(rows.length>500)throw new TypeError('allMatching selects more than 500 violations; narrow the filters');
  return rows.map(row=>({id:row.id,version:row.version}));
}

/** Loads the same complete, redacted projection as the queue for a direct detail request. */
export function selectViolationById(database:Database.Database,db:TenantDb,tenantId:TenantId,id:string,releaseAvailable=false):ViolationView|null {
  const context:ReadContext={database,db,tenantId,ipHmacKey:Buffer.alloc(32),statements:{events:database.prepare(EVENTS_SQL),directory:database.prepare(DIRECTORY_SQL),entities:database.prepare(ENTITY_SQL),messagePart:database.prepare(MESSAGE_PART_SQL)}};
  const statement=database.prepare(`${VIOLATION_SQL} AND v.id=? LIMIT 1`) as Database.Statement<[TenantId,string],ViolationRow>;
  const row=db.get(statement,id);
  if(!row)return null;
  const ruleIds=jsonIds(row.rule_ids_json);
  const names=labels(context,[row.user_id,row.group_id,row.assignee_user_id,row.model_id,row.provider_id,row.project_id,...ruleIds]);
  return violation(row,ruleIds,names,releaseAvailable);
}
function listApprovals(context:ReadContext,q:Readonly<Record<string,string>>,releaseAvailable:boolean):Page<ApprovalView> {
  const filter=where(context,q,APPROVAL_LISTS,APPROVAL_ENTITIES,APPROVAL_TEXT,'a.created_at_ms','v.rule_ids_json');
  const id=text(q.id);if(id!==undefined){filter.where.push('a.id=?');filter.params.push(id);}
  const violationId=text(q.violationId);if(violationId!==undefined){filter.where.push('a.violation_id=?');filter.params.push(violationId);}
  const paging=queuePaging(q,'approvals','createdAt');
  addCursor(filter,paging,'a.created_at_ms','a.id');
  const rows=run<ApprovalRow>(context,`${APPROVAL_SQL} AND ${filter.where.join(' AND ')} ORDER BY a.created_at_ms ${paging.order.toUpperCase()},a.id ${paging.order.toUpperCase()} LIMIT ?`,filter.params,q.limit);
  const ruleIds=rows.items.map(row=>jsonIds(row.rule_ids_json));
  const names=labels(context,rows.items.flatMap((row,index)=>[row.requesting_user_id,row.assignee_user_id,row.decision_by_user_id,row.user_id,row.group_id,row.model_id,row.provider_id,row.project_id,...ruleIds[index]??[]]));
  const last=rows.items.at(-1);
  return {items:rows.items.map((row,index)=>approval(row,ruleIds[index]??[],names,releaseAvailable)),nextCursor:rows.hasMore&&last?queueCursor(paging,last.created_at_ms,last.id):null,hasMore:rows.hasMore};
}
interface Filter { where:string[]; params:unknown[] }
type ListFilters=ReadonlyArray<readonly [string,string]>;
type EntityFilters=ReadonlyArray<readonly [string,readonly string[],string]>;
/**
 * The clauses one query string of filters means, to be appended to a statement that already ends in
 * its tenant predicate. Everything here lands after that `?`, so the tenant id stays the first bound
 * parameter — which is the property `forTenant` reads the SQL to check before it will run it, and
 * which a clause built ahead of the tenant predicate would silently cost.
 */
function where(context:ReadContext,q:Readonly<Record<string,string>>,lists:ListFilters,entityFilters:EntityFilters,textColumns:readonly string[],occurred:string,ruleColumn:string):Filter {
  const filter:Filter={where:['1'],params:[]};
  for(const [key,column] of lists){const values=commas(q[key]);if(values!==undefined)anyOf(filter,[column],values);}
  for(const [key,columns,kind] of entityFilters){const value=text(q[key]);if(value!==undefined)anyOf(filter,columns,entities(context,value,kind));}
  // A rule is one entry of a JSON array, so it is the one filter that cannot be an equality. The
  // `json_valid` guard is not defensive dressing: rule_ids_json has no CHECK constraint, and one
  // malformed row would otherwise abort the whole query and empty the queue.
  const rule=text(q.rule);
  if(rule!==undefined){const ids=entities(context,rule,'rule');filter.where.push(ids.length?`(json_valid(${ruleColumn}) AND EXISTS(SELECT 1 FROM json_each(${ruleColumn}) WHERE value IN (${ids.map(()=>'?').join(',')})))`:'0');filter.params.push(...ids);}
  const free=text(q.search)??text(q.q);
  if(free!==undefined){const pattern=`%${likePattern(free)}%`;filter.where.push(`(${textColumns.map(column=>`${column} LIKE ? ESCAPE '\\'`).join(' OR ')})`);filter.params.push(...textColumns.map(()=>pattern));}
  const day=text(q.date);
  if(day!==undefined){const range=dayRange(day,workspaceTimeZone(context));filter.where.push(`${occurred}>=? AND ${occurred}<?`);filter.params.push(range.fromMs,range.toMs);}
  return filter;
}
function queuePaging(q:Readonly<Record<string,string>>,resource:QueueCursor['resource'],supportedSort:'occurredAt'|'createdAt'):Pick<QueueCursor,'resource'|'order'> & {cursor:QueueCursor|null} {
  const sort=text(q.sort);
  if(sort!==undefined&&sort!==supportedSort)throw new TypeError(`sort must be ${supportedSort}`);
  const order=text(q.order)??'desc';
  if(order!=='asc'&&order!=='desc')throw new TypeError('order must be asc or desc');
  if(!q.cursor)return {resource,order,cursor:null};
  let cursor:QueueCursor;
  try{cursor=decodeCursor<QueueCursor>(q.cursor);}catch{throw new TypeError('Invalid cursor');}
  if(cursor?.v!==1||cursor.resource!==resource||cursor.order!==order||!Number.isSafeInteger(cursor.at)||cursor.at<0||typeof cursor.id!=='string'||!cursor.id)throw new TypeError('Invalid cursor');
  return {resource,order,cursor};
}
function addCursor(filter:Filter,paging:ReturnType<typeof queuePaging>,atColumn:string,idColumn:string):void {
  if(!paging.cursor)return;
  const operator=paging.order==='desc'?'<':'>';
  filter.where.push(`(${atColumn}${operator}? OR (${atColumn}=? AND ${idColumn}${operator}?))`);
  filter.params.push(paging.cursor.at,paging.cursor.at,paging.cursor.id);
}
function queueCursor(paging:ReturnType<typeof queuePaging>,at:number,id:string):string {
  return encodeCursor({v:1,resource:paging.resource,order:paging.order,at,id});
}
/** A filter whose value resolved to no entity matched nothing; `0` says so, an absent clause does not. */
function anyOf(filter:Filter,columns:readonly string[],values:readonly string[]):void {
  if(!values.length){filter.where.push('0');return;}
  const marks=values.map(()=>'?').join(',');
  filter.where.push(`(${columns.map(column=>`${column} IN (${marks})`).join(' OR ')})`);
  for(const _ of columns)filter.params.push(...values);
}
function commas(value:string|undefined):string[]|undefined { const trimmed=text(value); return trimmed===undefined?undefined:trimmed.split(',').map(part=>part.trim()).filter(Boolean); }
const TRUTHY=new Set(['true','1','yes','on','only']),FALSEY=new Set(['false','0','no','off']);
/** A checkbox rendered as a text box (see FilterBar), so an administrator types the word. */
function flag(key:string,value:string|undefined):boolean|undefined {
  const trimmed=text(value)?.toLowerCase();
  if(trimmed===undefined)return undefined;
  if(TRUTHY.has(trimmed))return true;
  if(FALSEY.has(trimmed))return false;
  throw new TypeError(`${key} must be true or false`);
}
function likePattern(value:string):string { return value.replace(/[\\%_]/gu,character=>`\\${character}`); }
function run<Row>(context:ReadContext,sql:string,params:readonly unknown[],limit:string|undefined):{items:Row[];hasMore:boolean} {
  const size=bounded(limit,100);
  const statement=context.database.prepare(sql) as Database.Statement<[TenantId,...unknown[]],Row>;
  const rows=context.db.all(statement,...params,size+1);
  const hasMore=rows.length>size;
  if(hasMore)rows.pop();
  return {items:rows,hasMore};
}
function jsonIds(value:string):string[] { try { const parsed=JSON.parse(value) as unknown; return Array.isArray(parsed)?parsed.filter((entry):entry is string=>typeof entry==='string'):[]; } catch { return []; } }

export interface ViolationView { id:string; occurredAt:string; severity:string; user:string|null; userId:string|null; groups:string[]; groupIds:string[]; detector:string; rule:string[]; ruleIds:string[]; direction:string; action:string; status:string; redactedExcerpt:string; assignee:string|null; assigneeId:string|null; dueAt:string|null; model:string|null; modelId:string|null; provider:string|null; providerId:string|null; project:string|null; projectId:string|null; conversationId:string|null; messageId:string|null; auditEventId:string; version:number; createdAt:string; updatedAt:string; approvalId:string|null; approvalStatus:ApprovalStatus|null; approvalVersion:number|null; approvalExpiresAt:string|null; releaseStatus:ApprovalReleaseStatus|null; releaseErrorCode:string|null; releaseMessageId:string|null; releaseAttempts:number|null; releaseAvailable:boolean }
/**
 * `tenant_id` and `content_digest` are gone: one is a tenant id echoed back to its own tenant, the
 * other a hash of the unredacted content that no reviewer can use and that would let anyone holding
 * the response confirm a guess at what was typed.
 */
function violation(row:ViolationRow,ruleIds:readonly string[],names:ReadonlyMap<string,string>,releaseAvailable:boolean):ViolationView {
  const named=(id:string|null):string|null=>id===null?null:names.get(id)??id;
  return {
    id:row.id,occurredAt:iso(row.occurred_at_ms),severity:row.severity,
    user:named(row.user_id),userId:row.user_id,
    // The group the violation was raised in, not every group its subject belongs to: the column has
    // to answer the same question as the `group` filter beside it or one of them is lying.
    groups:row.group_id===null?[]:[named(row.group_id) as string],groupIds:row.group_id===null?[]:[row.group_id],
    detector:row.detector,rule:ruleIds.map(id=>named(id) as string),ruleIds:[...ruleIds],
    direction:row.direction,action:row.gate_action,status:row.status,redactedExcerpt:row.redacted_excerpt,
    assignee:named(row.assignee_user_id),assigneeId:row.assignee_user_id,dueAt:row.due_at_ms===null?null:iso(row.due_at_ms),
    model:named(row.model_id),modelId:row.model_id,provider:named(row.provider_id),providerId:row.provider_id,
    project:named(row.project_id),projectId:row.project_id,
    conversationId:row.conversation_id,messageId:row.message_id,auditEventId:row.audit_event_id,version:row.version,
    createdAt:iso(row.created_at_ms),updatedAt:iso(row.updated_at_ms),
    approvalId:row.approval_id,approvalStatus:row.approval_status,approvalVersion:row.approval_version,
    approvalExpiresAt:row.approval_expires_at_ms===null?null:iso(row.approval_expires_at_ms),
    releaseStatus:approvalReleaseStatus(row.approval_status,row.approval_release_phase),
    releaseErrorCode:safeApprovalReleaseError(row.approval_release_error_code),
    releaseMessageId:row.approval_release_message_id,releaseAttempts:row.approval_release_attempts,
    releaseAvailable:releaseAvailable&&(row.approval_status==='pending'||row.approval_status==='claimed'),
  };
}
interface ApprovalView { id:string; violationId:string; status:ApprovalStatus; releaseStatus:ApprovalReleaseStatus; releaseErrorCode:string|null; requester:string; requesterId:string; assignee:string|null; assigneeId:string|null; decidedBy:string|null; decidedById:string|null; decisionReasonCode:string|null; decisionNote:string|null; releaseMessageId:string|null; releaseAttempts:number; version:number; expiresAt:string; createdAt:string; decidedAt:string|null; releasedAt:string|null; occurredAt:string; severity:string; detector:string; direction:string; action:string; violationStatus:string; redactedExcerpt:string; rule:string[]; ruleIds:string[]; user:string|null; userId:string|null; groups:string[]; groupIds:string[]; model:string|null; modelId:string|null; provider:string|null; providerId:string|null; project:string|null; projectId:string|null; dueAt:string|null; auditEventId:string; conversationId:string|null; messageId:string|null; releaseAvailable:boolean }
export function approvalReleaseStatus(status:ApprovalStatus|null,phase:string|null):ApprovalReleaseStatus|null {
  if(status===null)return null;
  if(status==='pending'||status==='claimed')return'pending_review';
  if(status==='approved')return'queued';
  if(status==='releasing')return phase==='result_checkpointed'?'finalizing':'releasing';
  if(status==='released')return'released';
  if(status==='release_failed')return'failed';
  if(status==='release_indeterminate')return'indeterminate';
  return'terminal';
}
const SAFE_RELEASE_ERRORS=new Set<string>(APPROVAL_RELEASE_ERROR_CODES);
export function safeApprovalReleaseError(code:string|null):string|null{return code===null?null:SAFE_RELEASE_ERRORS.has(code)?code:'release_failed';}
/** The held request, with the violation that caused it; `payload_ciphertext` and its key material never leave the store. */
function approval(row:ApprovalRow,ruleIds:readonly string[],names:ReadonlyMap<string,string>,releaseAvailable:boolean):ApprovalView {
  const named=(id:string|null):string|null=>id===null?null:names.get(id)??id;
  return {
    id:row.id,violationId:row.violation_id,status:row.status,releaseStatus:approvalReleaseStatus(row.status,row.release_phase)!,releaseErrorCode:safeApprovalReleaseError(row.release_error_code),
    requester:named(row.requesting_user_id) as string,requesterId:row.requesting_user_id,
    assignee:named(row.assignee_user_id),assigneeId:row.assignee_user_id,
    decidedBy:named(row.decision_by_user_id),decidedById:row.decision_by_user_id,
    decisionReasonCode:row.decision_reason_code,decisionNote:row.decision_note,
    releaseMessageId:row.release_message_id,releaseAttempts:row.release_attempts,version:row.version,
    expiresAt:iso(row.expires_at_ms),createdAt:iso(row.created_at_ms),
    decidedAt:row.decided_at_ms===null?null:iso(row.decided_at_ms),releasedAt:row.released_at_ms===null?null:iso(row.released_at_ms),
    occurredAt:iso(row.occurred_at_ms),severity:row.severity,detector:row.detector,direction:row.direction,
    action:row.gate_action,violationStatus:row.violation_status,redactedExcerpt:row.redacted_excerpt,
    rule:ruleIds.map(id=>named(id) as string),ruleIds:[...ruleIds],
    user:named(row.user_id),userId:row.user_id,
    groups:row.group_id===null?[]:[named(row.group_id) as string],groupIds:row.group_id===null?[]:[row.group_id],
    model:named(row.model_id),modelId:row.model_id,provider:named(row.provider_id),providerId:row.provider_id,
    project:named(row.project_id),projectId:row.project_id,
    dueAt:row.due_at_ms===null?null:iso(row.due_at_ms),auditEventId:row.audit_event_id,
    conversationId:row.conversation_id,messageId:row.message_id,
    releaseAvailable:releaseAvailable&&(row.status==='pending'||row.status==='claimed'),
  };
}
function bounded(value:string|undefined,fallback:number):number{const n=value===undefined?fallback:Number(value);if(!Number.isInteger(n)||n<1||n>500)throw new TypeError('limit must be 1..500');return n;}

/**
 * Until the minute worker exists, a queue read is also the expiry clock. Each row is compare-and-set
 * before its event is appended, so simultaneous readers produce one transition and one audit event.
 */
function expireApprovals(deps:AuditAdapterDependencies,request:RouteRequest,statements:ExpiryStatements,nowMs:number,targetId?:string):Set<string> {
  const tenant=request.tenant!;
  const candidates=targetId===undefined
    ? tenant.db.all(statements.due,nowMs)
    : (()=>{const row=tenant.db.get(statements.byId,targetId,nowMs);return row?[row]:[]})();
  if(candidates.length===0)return new Set();
  return deps.audit.transact(tx=>expireApprovalCandidates(deps,request,statements,nowMs,candidates,tx));
}

function expireApprovalCandidates(deps:AuditAdapterDependencies,request:RouteRequest,statements:ExpiryStatements,nowMs:number,candidates:readonly DecisionRow[],tx:import('../../lib/audit/index.js').AuditTransaction):Set<string> {
  const tenant=request.tenant!,expired=new Set<string>();
  for(const row of candidates){
      const changed=tenant.db.run(statements.expireApproval,nowMs,nowMs,row.id,nowMs);
      if(changed.changes!==1)continue;
      const violation=tenant.db.run(statements.expireViolation,nowMs,row.violation_id,row.id);
      if(violation.changes!==1)throw new ViolationChangedError();
      if(row.gate_decision_id!==null){
        const decision=tenant.db.run(statements.expireGateDecision,row.gate_decision_id);
        if(decision.changes!==1)throw new ViolationChangedError();
      }
      terminalApprovalRun({database:deps.database,db:tenant.db,tenantId:tenant.principal.tenantId,requestingUserId:row.requesting_user_id,sourceMessageId:row.message_id??'',approvalId:row.id,gateDecisionId:row.gate_decision_id,errorCode:'APPROVAL_EXPIRED',now:nowMs,cancelled:true});
      tx.append({tenantId:tenant.principal.tenantId,action:'gate.approval_expired',
        actor:{type:'service',id:'approval-expiry',sessionId:null,ip:null,userAgent:null,authMethod:'system'},
        target:{type:'approval',id:row.id},outcome:'cancelled',context:{requestId:request.requestId,traceId:null,source:'http',occurredAtMs:nowMs},
        subjectUserId:row.requesting_user_id,groupId:row.group_id,conversationId:row.conversation_id,messageId:row.message_id,
        gateAction:'require_approval',detector:row.detector,
        metadata:{approvalId:row.id,violationId:row.violation_id,expiresAtMs:row.expires_at_ms,approvalVersion:row.version}});
      expired.add(row.id);
  }
  return expired;
}

function decide(deps:AuditAdapterDependencies,request:RouteRequest,expiry:ExpiryStatements,nowMs:number,tx:import('../../lib/audit/index.js').AuditTransaction,newlyQueued:()=>void):RouteResult{
  const t=request.tenant!,input=object(request.body),decision=typeof input.decision==='string'?input.decision:'',reason=approvalDecisionReason(input.reason??input.note),version=Number(input.version??etag(request.headers.get('If-Match')));
  if(!['approve','deny'].includes(decision))throw new TypeError('decision must be approve or deny');
  if(!Number.isSafeInteger(version)||version<1)throw new TypeError('A valid approval version is required');
  const id=required(request.params.id);
  const expirable=t.db.get(expiry.byId,id,nowMs);if(expirable)expireApprovalCandidates(deps,request,expiry,nowMs,[expirable],tx);
  const row=t.db.get(deps.database.prepare<[TenantId,string],DecisionRow>(`SELECT a.id,a.violation_id,a.gate_decision_id,a.requesting_user_id,a.status,a.version,a.expires_at_ms,
    v.version violation_version,v.status violation_status,v.group_id,v.conversation_id,v.message_id,v.detector
    FROM policy_approval_requests a JOIN policy_violations v ON v.tenant_id=a.tenant_id AND v.id=a.violation_id
    WHERE a.tenant_id=? AND a.id=?`),id);
  if(!row)return error(request,404,'NOT_FOUND','Approval not found');
  if(row.status==='expired')return error(request,409,'APPROVAL_EXPIRED','Approval expired; refresh the queue');
  if(decision==='approve'){
    if(!deps.approvalReleaseAvailable||!deps.approvalReleaseQueue)return error(request,503,'SERVICE_UNAVAILABLE','Approval release is not available; the request remains pending');
    if(!t.principal.roles.some(role=>role==='owner'||role==='compliance'))return error(request,403,'FORBIDDEN','Only an owner or compliance reviewer may release approved content');
    const session=t.db.get(deps.database.prepare(`WITH tenant_scope(id,now_ms) AS (VALUES (?,?)) SELECT s.auth_method,s.created_at,s.mfa_verified_at_ms,u.totp_enabled_at
      FROM sessions s JOIN users u ON u.tenant_id=s.tenant_id AND u.id=s.user_id
      WHERE s.tenant_id=(SELECT id FROM tenant_scope) AND s.id=? AND s.user_id=? AND s.revoked_at IS NULL AND s.expires_at>(SELECT now_ms FROM tenant_scope)`) as Database.Statement<[TenantId,...unknown[]],{auth_method:string;created_at:number;mfa_verified_at_ms:number|null;totp_enabled_at:number|null}>,nowMs,t.principal.sessionId,t.principal.userId);
    const mfaFresh=session?.totp_enabled_at!==null&&session?.auth_method==='mfa'&&session.mfa_verified_at_ms!==null&&session.mfa_verified_at_ms>=nowMs-15*60_000;
    if(!mfaFresh)return error(request,403,'MFA_REQUIRED','Enable MFA, then sign in again to release approved content');
    const releaseRunId=randomUUID(),releaseUserMessageId=randomUUID(),releaseMessageId=randomUUID();
    const violation=t.db.run(deps.database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE policy_violations
        SET updated_at_ms=updated_at_ms
        WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND approval_id=? AND version=? AND status IN ('open','triaged','in_review')`) as Database.Statement<[TenantId,...unknown[]]>,row.violation_id,id,row.violation_version);
    if(violation.changes!==1)throw new ViolationChangedError();
    const approval=t.db.run(deps.database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE policy_approval_requests
        SET status='approved',decision_by_user_id=?,decision_reason_code='approved',decision_note=?,decided_at_ms=?,
          release_next_attempt_at_ms=?,release_phase='queued',release_error_code=NULL,
          release_run_id=COALESCE(release_run_id,?),release_user_message_id=COALESCE(release_user_message_id,?),release_message_id=COALESCE(release_message_id,?),version=version+1
        WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND version=? AND expires_at_ms>? AND status IN ('pending','claimed')`) as Database.Statement<[TenantId,...unknown[]]>,t.principal.userId,reason,nowMs,nowMs,releaseRunId,releaseUserMessageId,releaseMessageId,id,version,nowMs);
    if(approval.changes!==1)throw new ViolationChangedError();
    if(row.gate_decision_id!==null){
      const gateDecision=t.db.run(deps.database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE gate_decisions
          SET status='approved',reviewed_by_user_id=?,reviewed_at=?,review_note=?
          WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND status='pending_approval'`) as Database.Statement<[TenantId,...unknown[]]>,t.principal.userId,nowMs,reason,row.gate_decision_id);
      if(gateDecision.changes!==1)throw new ViolationChangedError();
    }
    tx.append({tenantId:t.principal.tenantId,action:'gate.approval_claimed',
        actor:{type:'user',id:t.principal.userId,sessionId:t.principal.sessionId,ip:null,userAgent:null,authMethod:'mfa'},
        target:{type:'approval',id},outcome:'pending',context:{requestId:request.requestId,traceId:null,source:'http',occurredAtMs:nowMs},
        subjectUserId:row.requesting_user_id,groupId:row.group_id,conversationId:row.conversation_id,messageId:row.message_id,
        gateAction:'require_approval',detector:row.detector,metadata:{approvalId:id,previousAssigneeId:null,approvalVersion:version,reasonCode:'approved',reviewNoteLength:Array.from(reason).length}});
    newlyQueued();
    return {status:202,body:{id,status:'approved',releaseStatus:'queued',reason}};
  }
  const approval=t.db.run(deps.database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE policy_approval_requests
      SET status='rejected',decision_by_user_id=?,decision_reason_code='rejected',decision_note=?,decided_at_ms=?,payload_terminal_at_ms=?,
        result_ciphertext=NULL,result_nonce=NULL,result_digest=NULL,version=version+1
      WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND version=? AND expires_at_ms>? AND status IN ('pending','claimed','release_failed')`) as Database.Statement<[TenantId,...unknown[]]>,t.principal.userId,reason,nowMs,nowMs,id,version,nowMs);
  if(approval.changes!==1)throw new ViolationChangedError();
  const violation=t.db.run(deps.database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE policy_violations
      SET status='rejected',updated_at_ms=?,version=version+1
      WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND approval_id=? AND version=? AND status IN ('open','triaged','in_review')`) as Database.Statement<[TenantId,...unknown[]]>,nowMs,row.violation_id,id,row.violation_version);
  if(violation.changes!==1)throw new ViolationChangedError();
  if(row.gate_decision_id!==null){
    const gateDecision=t.db.run(deps.database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE gate_decisions
        SET status='denied',reviewed_by_user_id=?,reviewed_at=?,review_note=?
        WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND status IN ('pending_approval','approved')`) as Database.Statement<[TenantId,...unknown[]]>,t.principal.userId,nowMs,reason,row.gate_decision_id);
    if(gateDecision.changes!==1)throw new ViolationChangedError();
  }
  terminalApprovalRun({database:deps.database,db:t.db,tenantId:t.principal.tenantId,requestingUserId:row.requesting_user_id,sourceMessageId:row.message_id??'',approvalId:id,gateDecisionId:row.gate_decision_id,errorCode:'APPROVAL_REJECTED',now:nowMs,cancelled:false});
  tx.append({tenantId:t.principal.tenantId,action:'gate.approval_rejected',
      actor:{type:'user',id:t.principal.userId,sessionId:t.principal.sessionId,ip:null,userAgent:null,authMethod:null},
      target:{type:'approval',id},outcome:'denied',context:{requestId:request.requestId,traceId:null,source:'http',occurredAtMs:nowMs},
      subjectUserId:row.requesting_user_id,groupId:row.group_id,conversationId:row.conversation_id,messageId:row.message_id,
      gateAction:'require_approval',detector:row.detector,metadata:{approvalId:id,violationId:row.violation_id,decision:'deny',reasonCode:'rejected',reviewNoteLength:Array.from(reason).length,approvalVersion:version}});
  return {body:{id,status:'rejected',reason}};
}

function approvalDecisionReason(value:unknown):string{
  if(typeof value!=='string')throw new TypeError('A written reason of 10 to 1000 characters is required');
  const reason=value.normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f]/gu,' ').replace(/\s+/gu,' ').trim(),length=Array.from(reason).length;
  if(length<10||length>1000)throw new TypeError('A written reason of 10 to 1000 characters is required');
  return scrubSecrets(reason);
}

async function createExport(deps:AuditAdapterDependencies,search:AuditSearch,context:ReadContext,request:RouteRequest,nowMs:number,now:()=>number):Promise<RouteResult>{const t=request.tenant!,input=object(request.body),format=String(input.format??'');if(!['csv','json','ndjson'].includes(format))throw new TypeError('format must be csv, json, or ndjson');const fields=validateAuditExportFields(input.fields),fieldsJson=fields.length===AUDIT_EXPORT_FIELDS.length?null:JSON.stringify(fields);const rawFilters=object(input.filters??{}),filterInput=Object.fromEntries(Object.entries(rawFilters).map(([key,value])=>[key,String(value)])),filters=query(context,filterInput),id=randomUUID(),expires=nowMs+24*60*60_000;await mkdir(deps.exportDirectory,{recursive:true});deps.audit.transact(tx=>{t.db.run(deps.database.prepare("INSERT INTO audit_exports(tenant_id,id,requested_by_user_id,format,include_content,filters_json,fields_json,status,created_at_ms,expires_at_ms) VALUES(?,?,?,?,0,?,?,'pending',?,?)") as Database.Statement<[TenantId,...unknown[]]>,id,t.principal.userId,format,JSON.stringify(filters),fieldsJson,nowMs,expires);tx.append({tenantId:t.principal.tenantId,action:'admin.audit_export_requested',actor:{type:'user',id:t.principal.userId,sessionId:t.principal.sessionId,ip:null,userAgent:null,authMethod:null},target:{type:'tenant',id:t.principal.tenantId},outcome:'pending',context:{requestId:request.requestId,traceId:null,source:'http',occurredAtMs:nowMs},metadata:{exportId:id,format,filterNames:filterNames(filterInput),includeContent:false}})});void generate(deps,search,request,id,format as AuditExportFormat,filters,fields,now).catch(()=>undefined);return {status:202,body:{id,format,status:'pending',createdAt:new Date(nowMs).toISOString(),expiresAt:new Date(expires).toISOString()}};}
async function generate(deps:AuditAdapterDependencies,search:AuditSearch,request:RouteRequest,id:string,format:AuditExportFormat,filters:AuditSearchQuery,fields:readonly AuditExportField[],now:()=>number):Promise<void>{
  const tenantId=request.tenant!.principal.tenantId,temp=join(deps.exportDirectory,`.${id}.tmp`),dest=join(deps.exportDirectory,`${id}.${extension(format)}`);
  let rows:AuditSearchRow[]=[],byteCount=0,digest:string|null=null;
  try{
    let cursor:string|undefined;
    do{
      const base={...filters,limit:500},page=search.search(tenantId,role(request.tenant!.principal.roles),cursor?{...base,cursor}:base);
      rows.push(...page.rows);cursor=page.nextCursor??undefined;
      if(rows.length>100_000)throw Object.assign(new Error('Audit export row cap exceeded'),{code:'EXPORT_TOO_LARGE'});
      await new Promise<void>(resolve=>setImmediate(resolve));
    }while(cursor);
    const chunks:Uint8Array[]=[];for await(const chunk of streamAuditExport(rows,format,fields))chunks.push(chunk);
    const bytes=Buffer.concat(chunks);byteCount=bytes.length;await writeFile(temp,bytes,{flag:'wx'});await rename(temp,dest);digest=(await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');
    deps.audit.transact(tx=>{deps.database.prepare("UPDATE audit_exports SET status='completed',storage_path=?,sha256=?,row_count=?,byte_count=?,started_at_ms=created_at_ms,completed_at_ms=? WHERE tenant_id=? AND id=? AND status='pending'").run(dest,digest,rows.length,byteCount,now(),tenantId,id);tx.append(auditExportCompletion(request,id,'success',rows.length,byteCount,digest,now()))});
  }catch(error){
    const code=typeof error==='object'&&error!==null&&'code' in error&&error.code==='EXPORT_TOO_LARGE'?'EXPORT_TOO_LARGE':'EXPORT_FAILED';
    (deps.logger??console).error(`Audit export ${id} failed`,error);
    deps.audit.transact(tx=>{deps.database.prepare("UPDATE audit_exports SET status='failed',error_code=?,completed_at_ms=? WHERE tenant_id=? AND id=? AND status='pending'").run(code,now(),tenantId,id);tx.append(auditExportCompletion(request,id,'failure',rows.length,byteCount,digest,now()))});
  }
}
function auditExportCompletion(request:RouteRequest,id:string,outcome:'success'|'failure',rowCount:number,byteCount:number,sha256:string|null,at:number):Parameters<AuditService['append']>[0]{const principal=request.tenant!.principal;return {tenantId:principal.tenantId,action:'admin.audit_export_completed',actor:{type:'user',id:principal.userId,sessionId:principal.sessionId,ip:null,userAgent:null,authMethod:null},target:{type:'tenant',id:principal.tenantId},outcome,context:{requestId:request.requestId,traceId:null,source:'worker',occurredAtMs:at},metadata:{exportId:id,rowCount,byteCount,sha256}};}
function object(value:unknown):Record<string,unknown>{if(typeof value!=='object'||value===null||Array.isArray(value))throw new TypeError('JSON object required');return value as Record<string,unknown>;}
function etag(value:string|null):number{if(!value)return NaN;return Number(value.replace(/^W\//,'').replaceAll('"',''));}
function exportView(row:ExportRow){const errorCode=row.error_code===null?null:row.error_code==='EXPORT_TOO_LARGE'?'EXPORT_TOO_LARGE':'EXPORT_FAILED';return {id:row.id,format:row.format,status:row.status,rowCount:row.row_count,byteCount:row.byte_count,sha256:row.sha256,fields:row.fields_json===null?AUDIT_EXPORT_FIELDS:validateAuditExportFields(JSON.parse(row.fields_json) as unknown),createdAt:iso(row.created_at_ms),completedAt:row.completed_at_ms===null?null:iso(row.completed_at_ms),expiresAt:iso(row.expires_at_ms),errorCode};}
function extension(format:AuditExportFormat):string{return format==='ndjson'?'ndjson':format;}
function contentType(format:AuditExportFormat):string{return format==='csv'?'text/csv; charset=utf-8':format==='ndjson'?'application/x-ndjson':'application/json';}
function error(request:RouteRequest,status:number,code:string,message:string):RouteResult{return {status,body:{error:{code,message,requestId:request.requestId,retryable:false}}};}

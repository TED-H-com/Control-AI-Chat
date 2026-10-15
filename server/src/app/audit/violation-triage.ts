import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { AuditService, AuditTransaction } from '../../lib/audit/index.js';
import { scrubSecrets } from '../../lib/audit/audit-secret.js';
import type { TenantDb } from '../../lib/db.js';
import {VIOLATION_TRIAGE_STATUSES,type ErrorCode, type TenantId } from '../../shared/types.js';
import type { RouteRequest, RouteResult } from '../../routes/types.js';
import { createDurableMutationIdempotency, MutationIdempotencyError } from '../idempotency/mutation.js';
import { selectViolationById, selectViolationVersions } from './adapters.js';

export {VIOLATION_TRIAGE_STATUSES};
export type ViolationTriageStatus = (typeof VIOLATION_TRIAGE_STATUSES)[number];

const TRANSITIONS:Readonly<Record<ViolationTriageStatus,readonly ViolationTriageStatus[]>> = {
  open:['triaged','in_review','resolved','dismissed'],
  triaged:['open','in_review','resolved','dismissed'],
  in_review:['open','triaged','resolved','dismissed'],
  approved:['resolved'],
  resolved:['open'],
  dismissed:['open'],
};

export function allowedViolationTransitions(status:unknown):readonly ViolationTriageStatus[] {
  return typeof status === 'string' && status in TRANSITIONS ? TRANSITIONS[status as ViolationTriageStatus] : [];
}

interface ViolationRow {
  id:string;
  status:string;
  version:number;
  assignee_user_id:string|null;
  assignee_name:string|null;
  assignee_email:string|null;
  due_at_ms:number|null;
  resolution_reason:string|null;
  resolved_by_user_id:string|null;
  resolved_by_name:string|null;
  resolved_by_email:string|null;
  resolved_at_ms:number|null;
  approval_id:string|null;
  approval_status:string|null;
  subject_user_id:string|null;
  group_id:string|null;
  conversation_id:string|null;
  message_id:string|null;
  gate_action:string;
  detector:string;
  updated_at_ms:number;
}
interface UserRow { id:string; display_name:string; email:string }
interface CommentRow { id:string; author_user_id:string; body:string; created_at_ms:number; display_name:string|null; email:string|null }

interface Statements {
  violation:Database.Statement<[TenantId,string],ViolationRow>;
  activeUser:Database.Statement<[TenantId,string],UserRow>;
  assignees:Database.Statement<[TenantId],UserRow>;
  comments:Database.Statement<[TenantId,string],CommentRow>;
  assign:Database.Statement<[TenantId,...unknown[]]>;
  status:Database.Statement<[TenantId,...unknown[]]>;
  due:Database.Statement<[TenantId,...unknown[]]>;
  touchForComment:Database.Statement<[TenantId,...unknown[]]>;
  insertComment:Database.Statement<[TenantId,...unknown[]]>;
}

export interface ViolationTriageDependencies {
  database:Database.Database;
  audit:Pick<AuditService,'transact'>;
  idempotencyHmacKey:Uint8Array;
  approvalReleaseAvailable?:boolean;
  now?:()=>number;
}
export interface ViolationTriageAdapter {
  supports(operation:string):boolean;
  execute(operation:string,request:RouteRequest):Promise<RouteResult>;
}

const OPERATIONS=new Set([
  'admin.violation','admin.violationAssignees','admin.violationAssign',
  'admin.violationStatus','admin.violationAcknowledge','admin.violationDismiss',
  'admin.violationDue','admin.violationNote','admin.violationsBulk',
]);
const ACTIVE=new Set<string>(['open','triaged','in_review']);
const BLOCKING_APPROVAL=new Set<string>(['pending','claimed','approved','releasing','release_failed']);

class TriageError extends Error {
  constructor(readonly status:number,readonly code:ErrorCode,message:string){super(message);this.name='TriageError';}
}

export function createViolationTriageAdapter(deps:ViolationTriageDependencies):ViolationTriageAdapter {
  const idempotency=createDurableMutationIdempotency({database:deps.database,audit:deps.audit,hmacKey:deps.idempotencyHmacKey,
    namespace:'violation-triage',...(deps.now===undefined?{}:{now:deps.now})});
  const statements:Statements={
    violation:deps.database.prepare(`SELECT v.id,v.status,v.version,v.assignee_user_id,assigned.display_name assignee_name,assigned.email assignee_email,
      v.due_at_ms,v.resolution_reason,v.resolved_by_user_id,resolver.display_name resolved_by_name,resolver.email resolved_by_email,v.resolved_at_ms,
      v.approval_id,a.status approval_status,v.subject_user_id,v.group_id,v.conversation_id,v.message_id,v.gate_action,v.detector,v.updated_at_ms
      FROM policy_violations v
      LEFT JOIN users assigned ON assigned.tenant_id=v.tenant_id AND assigned.id=v.assignee_user_id
      LEFT JOIN users resolver ON resolver.tenant_id=v.tenant_id AND resolver.id=v.resolved_by_user_id
      LEFT JOIN policy_approval_requests a ON a.tenant_id=v.tenant_id AND a.id=v.approval_id
      WHERE v.tenant_id=? AND v.id=?`) as Statements['violation'],
    activeUser:deps.database.prepare("SELECT id,display_name,email FROM users WHERE tenant_id=? AND id=? AND status='active' AND deleted_at IS NULL") as Statements['activeUser'],
    assignees:deps.database.prepare("SELECT id,display_name,email FROM users WHERE tenant_id=? AND status='active' AND deleted_at IS NULL ORDER BY display_name COLLATE NOCASE,email COLLATE NOCASE,id LIMIT 500") as Statements['assignees'],
    comments:deps.database.prepare(`SELECT c.id,c.author_user_id,c.body,c.created_at_ms,u.display_name,u.email
      FROM policy_violation_comments c LEFT JOIN users u ON u.tenant_id=c.tenant_id AND u.id=c.author_user_id
      WHERE c.tenant_id=? AND c.violation_id=? ORDER BY c.created_at_ms DESC,c.id DESC LIMIT 500`) as Statements['comments'],
    assign:deps.database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE policy_violations
      SET assignee_user_id=?,updated_at_ms=?,version=version+1
      WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND version=? AND status IN ('open','triaged','in_review')`) as Statements['assign'],
    status:deps.database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE policy_violations
      SET status=?,resolution_reason=?,resolved_by_user_id=?,resolved_at_ms=?,
        due_at_ms=CASE WHEN ? IN ('resolved','dismissed') THEN NULL ELSE due_at_ms END,
        updated_at_ms=?,version=version+1
      WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND version=? AND status=?`) as Statements['status'],
    due:deps.database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE policy_violations
      SET due_at_ms=?,updated_at_ms=?,version=version+1
      WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND version=? AND status IN ('open','triaged','in_review')`) as Statements['due'],
    touchForComment:deps.database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE policy_violations
      SET updated_at_ms=?,version=version+1
      WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND version=?`) as Statements['touchForComment'],
    insertComment:deps.database.prepare('INSERT INTO policy_violation_comments(tenant_id,id,violation_id,author_user_id,body,created_at_ms) VALUES(?,?,?,?,?,?)') as Statements['insertComment'],
  };

  const current=(tenant:TenantDb,id:string):ViolationRow=>{
    const row=tenant.get(statements.violation,id);
    if(!row)throw new TriageError(404,'RESOURCE_NOT_FOUND','Policy violation was not found');
    return row;
  };
  const detail=(tenant:TenantDb,id:string)=>{
    const row=current(tenant,id);
    const base=selectViolationById(deps.database,tenant,tenant.tenantId,id,deps.approvalReleaseAvailable);
    if(!base)throw new TriageError(404,'RESOURCE_NOT_FOUND','Policy violation was not found');
    return {...base,...view(row,tenant.all(statements.comments,id))};
  };

  return {
    supports:operation=>OPERATIONS.has(operation),
    async execute(operation,request){
      if(!request.tenant)return failure(request,401,'UNAUTHENTICATED','Authentication required');
      const {db,principal}=request.tenant;
      try {
        if(operation==='admin.violation')return {body:{item:detail(db,requiredId(request))}};
        if(operation==='admin.violationAssignees')return {body:{items:db.all(statements.assignees).map(user=>({id:user.id,name:user.display_name,email:user.email})),nextCursor:null,hasMore:false}};
        if(operation==='admin.violationsBulk')return idempotency.execute(operation,request,(tx,at)=>bulk(deps,statements,request,at,tx));
        const id=requiredId(request),expected=expectedVersion(request);
        return idempotency.execute(operation,request,(tx,at)=>{
          const input=object(request.body),row=current(db,id);
          if(operation==='admin.violationAssign'){
            if(!ACTIVE.has(row.status))throw new TriageError(409,'CONFLICT','Only an active violation can be assigned');
            const assigneeId=nullableId(input.assigneeUserId);
            if(assigneeId!==null&&!db.get(statements.activeUser,assigneeId))throw new TriageError(422,'VALIDATION_FAILED','Assignee must be an active user in this tenant');
            changed(db.run(statements.assign,assigneeId,at,id,expected));
            tx.append(auditInput(request,row,'admin.violation_assigned',at,{violationId:id,fromAssigneeUserId:row.assignee_user_id,toAssigneeUserId:assigneeId,violationVersion:expected}));
            return {body:{item:detail(db,id)}};
          }
          if(operation==='admin.violationStatus'||operation==='admin.violationAcknowledge'||operation==='admin.violationDismiss'){
            const status=operation==='admin.violationAcknowledge'?'triaged':operation==='admin.violationDismiss'?'dismissed':triageStatus(input.status);
            if(!allowedViolationTransitions(row.status).includes(status))throw new TriageError(409,'CONFLICT',`Violation cannot move from ${row.status} to ${status}`);
            if(row.approval_status!==null&&BLOCKING_APPROVAL.has(row.approval_status)&&((status==='resolved'||status==='dismissed')||row.status==='resolved'||row.status==='dismissed'))
              throw new TriageError(409,'CONFLICT','The active approval owns terminal state for this violation');
            const closing=status==='resolved'||status==='dismissed';
            const reason=closing?writtenReason(input.reason):null;
            changed(db.run(statements.status,status,reason,closing?principal.userId:null,closing?at:null,status,at,id,expected,row.status));
            tx.append(auditInput(request,row,'admin.violation_status_changed',at,{violationId:id,fromStatus:row.status,toStatus:status,reasonCharacters:reason===null?null:[...reason].length,violationVersion:expected}));
            return {body:{item:detail(db,id)}};
          }
          if(operation==='admin.violationDue'){
            if(!ACTIVE.has(row.status))throw new TriageError(409,'CONFLICT','Only an active violation can have a due date');
            const dueAt=due(input);
            changed(db.run(statements.due,dueAt,at,id,expected));
            tx.append(auditInput(request,row,'admin.violation_due_changed',at,{violationId:id,fromDueAtMs:row.due_at_ms,toDueAtMs:dueAt,violationVersion:expected}));
            return {body:{item:detail(db,id)}};
          }
          if(operation==='admin.violationNote'){
            const note=boundedText(input.note,'note',3,2000),commentId=randomUUID();
            changed(db.run(statements.touchForComment,at,id,expected));
            db.run(statements.insertComment,commentId,id,principal.userId,note,at);
            tx.append(auditInput(request,row,'admin.violation_comment_added',at,{violationId:id,commentId,characters:[...note].length,violationVersion:expected}));
            return {status:201,body:{item:detail(db,id)}};
          }
          throw new Error(`NotImplemented: violation triage operation ${operation}`);
        });
      } catch(error) {
        if(error instanceof MutationIdempotencyError)return failure(request,error.status,error.code,error.message);
        if(error instanceof TriageError)return failure(request,error.status,error.code,error.message);
        if(error instanceof TypeError)return failure(request,422,'VALIDATION_FAILED',error.message);
        throw error;
      }
    },
  };
}

type BulkCommand='assign'|'acknowledge'|'status'|'dismiss'|'due'|'note';
interface BulkItem { id:string; version:number }
interface BulkPlan { item:BulkItem; row:ViolationRow; status?:ViolationTriageStatus; assigneeId?:string|null; dueAt?:number|null; text?:string }

function bulk(deps:ViolationTriageDependencies,statements:Statements,request:RouteRequest,at:number,tx:AuditTransaction):RouteResult {
  const tenant=request.tenant!,input=object(request.body),dryRun=input.dryRun;
  if(typeof dryRun!=='boolean')throw new TypeError('dryRun must be a boolean');
  const command=bulkCommand(input.command),parameters=input.parameters===undefined?{}:object(input.parameters);
  const items=bulkItems(deps,input,dryRun,tenant.db,tenant.principal.tenantId);
  if(items.length<1||items.length>500)throw new TypeError('Bulk operations require 1..500 explicit violations');
  const assigneeId=command==='assign'?nullableId(parameters.assigneeUserId):undefined;
  if(assigneeId!==undefined&&assigneeId!==null&&!tenant.db.get(statements.activeUser,assigneeId))
    throw new TriageError(422,'VALIDATION_FAILED','Assignee must be an active user in this tenant');
  const requestedStatus=command==='acknowledge'?'triaged':command==='dismiss'?'dismissed':command==='status'?triageStatus(parameters.status):undefined;
  const text=command==='dismiss'||(command==='status'&&(requestedStatus==='resolved'||requestedStatus==='dismissed'))
    ?writtenReason(input.reason):command==='note'?boundedText(parameters.note,'note',3,2000):undefined;
  const requestedDue=command==='due'?due(parameters):undefined;
  const plans:BulkPlan[]=[],errors:Array<{id:string;code:string;message:string;currentVersion?:number}>=[];
  for(const item of items){
    const row=tenant.db.get(statements.violation,item.id);
    if(!row){errors.push({id:item.id,code:'RESOURCE_NOT_FOUND',message:'Policy violation was not found'});continue;}
    if(row.version!==item.version){errors.push({id:item.id,code:'PRECONDITION_FAILED',message:'The violation changed since it was read',currentVersion:row.version});continue;}
    if(command==='assign'&&!ACTIVE.has(row.status)){errors.push({id:item.id,code:'CONFLICT',message:'Only an active violation can be assigned'});continue;}
    if(command==='due'&&!ACTIVE.has(row.status)){errors.push({id:item.id,code:'CONFLICT',message:'Only an active violation can have a due date'});continue;}
    if(requestedStatus!==undefined){
      if(!allowedViolationTransitions(row.status).includes(requestedStatus)){errors.push({id:item.id,code:'CONFLICT',message:`Violation cannot move from ${row.status} to ${requestedStatus}`});continue;}
      if(row.approval_status!==null&&BLOCKING_APPROVAL.has(row.approval_status)&&((requestedStatus==='resolved'||requestedStatus==='dismissed')||row.status==='resolved'||row.status==='dismissed')){
        errors.push({id:item.id,code:'CONFLICT',message:'The active approval owns terminal state for this violation'});continue;
      }
    }
    plans.push({item,row,...(requestedStatus===undefined?{}:{status:requestedStatus}),...(assigneeId===undefined?{}:{assigneeId}),...(requestedDue===undefined?{}:{dueAt:requestedDue}),...(text===undefined?{}:{text})});
  }
  const preview={affected:plans.length,skipped:errors.length,errors,snapshot:plans.map(plan=>plan.item)};
  if(dryRun)return {body:preview};
  if(errors.length)return {status:409,body:{error:{code:'CONFLICT',message:'Bulk validation failed; no violations were changed',requestId:request.requestId,retryable:false,details:preview}}};
  for(const plan of plans){
    const {row,item}=plan;
    if(command==='assign'){
      changed(tenant.db.run(statements.assign,plan.assigneeId!,at,item.id,item.version));
      tx.append(auditInput(request,row,'admin.violation_assigned',at,{violationId:item.id,fromAssigneeUserId:row.assignee_user_id,toAssigneeUserId:plan.assigneeId!,violationVersion:item.version,bulk:true}));
    } else if(command==='due'){
      changed(tenant.db.run(statements.due,plan.dueAt!,at,item.id,item.version));
      tx.append(auditInput(request,row,'admin.violation_due_changed',at,{violationId:item.id,fromDueAtMs:row.due_at_ms,toDueAtMs:plan.dueAt!,violationVersion:item.version,bulk:true}));
    } else if(command==='note'){
      const commentId=randomUUID();
      changed(tenant.db.run(statements.touchForComment,at,item.id,item.version));
      tenant.db.run(statements.insertComment,commentId,item.id,tenant.principal.userId,plan.text!,at);
      tx.append(auditInput(request,row,'admin.violation_comment_added',at,{violationId:item.id,commentId,characters:[...plan.text!].length,violationVersion:item.version,bulk:true}));
    } else {
      const closing=plan.status==='resolved'||plan.status==='dismissed',reason=closing?plan.text!:null;
      changed(tenant.db.run(statements.status,plan.status!,reason,closing?tenant.principal.userId:null,closing?at:null,plan.status!,at,item.id,item.version,row.status));
      tx.append(auditInput(request,row,'admin.violation_status_changed',at,{violationId:item.id,fromStatus:row.status,toStatus:plan.status!,reasonCharacters:reason===null?null:[...reason].length,violationVersion:item.version,bulk:true}));
    }
  }
  return {body:{affected:plans.length,skipped:0,errors:[],items:plans.map(plan=>({id:plan.item.id,version:plan.item.version+1}))}};
}

function bulkCommand(value:unknown):BulkCommand {
  const commands:readonly string[]=['assign','acknowledge','status','dismiss','due','note'];
  if(typeof value!=='string'||!commands.includes(value))throw new TypeError(`command must be one of ${commands.join(', ')}`);
  return value as BulkCommand;
}
const BULK_LIST_FILTERS=new Set(['status','severity','action','gateAction','detector','direction']);
const BULK_SINGLE_FILTERS=new Set(['approvalOnly','rule','user','assignee','group','model','provider','project','date','search','q']);
function bulkItems(deps:ViolationTriageDependencies,input:Record<string,unknown>,dryRun:boolean,db:TenantDb,tenantId:TenantId):BulkItem[] {
  const modes=Number(Array.isArray(input.items))+Number(Array.isArray(input.ids))+Number(input.allMatching!==undefined);
  if(modes!==1)throw new TypeError('Exactly one of items, ids with expectedVersions, or allMatching is required');
  if(Array.isArray(input.items)){
    if(input.items.length<1||input.items.length>500)throw new TypeError('Bulk operations require 1..500 explicit violations');
    const seen=new Set<string>();
    return input.items.map((entry,index)=>{
      const item=object(entry),id=typeof item.id==='string'?item.id.trim():'',version=Number(item.version);
      if(!id||id.length>200||!Number.isSafeInteger(version)||version<1)throw new TypeError(`items[${index}] must contain a valid id and version`);
      if(seen.has(id))throw new TypeError(`items contains duplicate id ${id}`);seen.add(id);return{id,version};
    });
  }
  if(Array.isArray(input.ids)&&typeof input.expectedVersions==='object'&&input.expectedVersions!==null&&!Array.isArray(input.expectedVersions)){
    if(input.ids.length<1||input.ids.length>500)throw new TypeError('Bulk operations require 1..500 explicit violations');
    const versions=input.expectedVersions as Record<string,unknown>;
    return bulkItems(deps,{items:input.ids.map(id=>({id,version:typeof id==='string'?versions[id]:undefined}))},dryRun,db,tenantId);
  }
  if(!dryRun)throw new TypeError('allMatching must be dry-run and converted to its returned explicit snapshot before execution');
  const matching=object(input.allMatching),rawFilter=matching.filter===undefined?{}:object(matching.filter);
  for(const key of Object.keys(matching))if(key!=='filter'&&key!=='excludedIds')throw new TypeError(`Unsupported allMatching property ${key}`);
  const filter:Record<string,string|string[]>={};
  let bytes=0;
  for(const [key,value] of Object.entries(rawFilter)){
    if(!BULK_LIST_FILTERS.has(key)&&!BULK_SINGLE_FILTERS.has(key))throw new TypeError(`Unsupported allMatching filter ${key}`);
    const values=Array.isArray(value)?value:[value];
    if(!values.length||values.some(entry=>typeof entry!=='string'||!entry.trim()||entry.length>500))throw new TypeError(`allMatching filter ${key} must contain non-empty strings of at most 500 characters`);
    if(Array.isArray(value)&&!BULK_LIST_FILTERS.has(key))throw new TypeError(`allMatching filter ${key} accepts one value`);
    bytes+=values.reduce((total,entry)=>total+Buffer.byteLength(entry as string),0);
    filter[key]=Array.isArray(value)?(value as string[]).map(entry=>entry.trim()):(value as string).trim();
  }
  if(bytes>8_000)throw new TypeError('allMatching filters exceed 8000 UTF-8 bytes');
  const excluded=matching.excludedIds===undefined?[]:matching.excludedIds;
  if(!Array.isArray(excluded)||excluded.length>500)throw new TypeError('allMatching.excludedIds must contain at most 500 ids');
  const excludedIds=new Set(excluded.map((value,index)=>{
    if(typeof value!=='string'||!value.trim()||value.length>200)throw new TypeError(`allMatching.excludedIds[${index}] must be a valid id`);
    return value.trim();
  }));
  return selectViolationVersions(deps.database,db,tenantId,filter).filter(item=>!excludedIds.has(item.id));
}

function auditInput(request:RouteRequest,row:ViolationRow,action:'admin.violation_assigned'|'admin.violation_status_changed'|'admin.violation_due_changed'|'admin.violation_comment_added',occurredAtMs:number,metadata:Record<string,string|number|boolean|null>){
  const principal=request.tenant!.principal;
  return {tenantId:principal.tenantId,action,actor:{type:'user' as const,id:principal.userId,sessionId:principal.sessionId,ip:null,userAgent:null,authMethod:null},
    target:{type:'violation' as const,id:row.id},outcome:'success' as const,context:{requestId:request.requestId,traceId:null,source:'http' as const,occurredAtMs},
    subjectUserId:row.subject_user_id,groupId:row.group_id,conversationId:row.conversation_id,messageId:row.message_id,
    gateAction:row.gate_action as 'allow'|'flag'|'redact'|'mask'|'warn'|'block'|'require_approval',detector:row.detector,metadata};
}

function view(row:ViolationRow,comments:readonly CommentRow[]){
  return {
    id:row.id,status:row.status,version:row.version,
    assignee:row.assignee_user_id===null?null:(row.assignee_name??row.assignee_email??row.assignee_user_id),assigneeId:row.assignee_user_id,
    dueAt:iso(row.due_at_ms),resolutionReason:row.resolution_reason,
    resolvedBy:row.resolved_by_user_id===null?null:(row.resolved_by_name??row.resolved_by_email??row.resolved_by_user_id),
    resolvedById:row.resolved_by_user_id,resolvedAt:iso(row.resolved_at_ms),updatedAt:iso(row.updated_at_ms),
    allowedTransitions:[...allowedViolationTransitions(row.status)],
    comments:comments.map(comment=>({id:comment.id,author:comment.display_name??comment.email??comment.author_user_id,authorId:comment.author_user_id,body:comment.body,createdAt:iso(comment.created_at_ms)})),
  };
}
function object(value:unknown):Record<string,unknown>{if(typeof value!=='object'||value===null||Array.isArray(value))throw new TypeError('JSON object required');return value as Record<string,unknown>;}
function requiredId(request:RouteRequest):string {const value=request.params.id?.trim();if(!value||value.length>200)throw new TypeError('A valid violation id is required');return value;}
function nullableId(value:unknown):string|null {if(value===null||value==='')return null;if(typeof value!=='string'||!value.trim()||value.length>200)throw new TypeError('assigneeUserId must be a user id or null');return value.trim();}
function expectedVersion(request:RouteRequest):number {const raw=request.headers.get('If-Match');if(!raw)throw new TriageError(428,'PRECONDITION_REQUIRED','If-Match is required');const parsed=Number(raw.replace(/^W\//u,'').replaceAll('"',''));if(!Number.isSafeInteger(parsed)||parsed<1)throw new TriageError(412,'PRECONDITION_FAILED','A valid violation version is required');return parsed;}
function triageStatus(value:unknown):ViolationTriageStatus {if(typeof value!=='string'||!(VIOLATION_TRIAGE_STATUSES as readonly string[]).includes(value))throw new TypeError(`status must be one of ${VIOLATION_TRIAGE_STATUSES.join(', ')}`);return value as ViolationTriageStatus;}
function writtenReason(value:unknown):string{return boundedText(value,'reason',10,1000,8000);}
function boundedText(value:unknown,name:string,min:number,max:number,maxBytes=16_000):string {
  if(typeof value!=='string')throw new TypeError(`${name} must be text`);
  const normalized=value.normalize('NFC').replace(/\r\n?/gu,'\n')
    .replace(/(?:authorization|proxy-authorization)\s*[:=][^\n]*/giu,'[REDACTED:credential]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu,' ');
  const text=scrubSecrets(normalized).replace(/[^\S\n]+/gu,' ').trim();
  const length=[...text].length,bytes=Buffer.byteLength(text);
  if(length<min||length>max||bytes>maxBytes)throw new TypeError(`${name} must be ${min}..${max} characters and at most ${maxBytes} UTF-8 bytes`);
  return text;
}
function due(input:Record<string,unknown>):number|null {if(!Object.hasOwn(input,'dueAt'))throw new TypeError('dueAt is required and may be null');if(input.dueAt===null||input.dueAt==='')return null;const parsed=typeof input.dueAt==='number'?input.dueAt:typeof input.dueAt==='string'?Date.parse(input.dueAt):NaN;if(!Number.isSafeInteger(parsed)||parsed<0||parsed>8_640_000_000_000_000)throw new TypeError('dueAt must be an ISO date-time within the supported Date range or null');return parsed;}
function changed(result:Database.RunResult):void {if(result.changes!==1)throw new TriageError(412,'PRECONDITION_FAILED','The violation changed since it was read');}
function iso(value:number|null):string|null {return value===null?null:new Date(value).toISOString();}
function failure(request:RouteRequest,status:number,code:ErrorCode,message:string):RouteResult{return {status,body:{error:{code,message,requestId:request.requestId,retryable:false}}};}

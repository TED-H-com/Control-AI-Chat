import { DEFAULT_CONVERSATION_RETENTION_DAYS } from '../../lib/audit/tenant-retention-policy.js';
import type Database from 'better-sqlite3';
import type { TenantDb } from '../../lib/db.js';
import type { TenantId } from '../../shared/types.js';

type Row = Record<string, unknown>;
type Statement = Database.Statement<[TenantId, ...unknown[]], Row>;

export type DirectoryQuery = Readonly<Record<string, string|undefined>>;
export interface DirectoryPage<T> { readonly items:readonly T[]; readonly nextCursor:string|null }
export type DataClass = 'conversations'|'messages'|'audit_events'|'files';

/** Screen `roles`. `status` is always null: the roles table has no lifecycle column to read it from. */
export interface RoleRow { name:string; type:'system'|'custom'; permissionCount:number; assignedUsers:number; lastChangedBy:string|null; updatedAt:number; status:null }
export interface RetentionRow { dataClass:DataClass; retentionDays:number|null; minimumDays:number|null; maximumDays:number|null; legalHolds:number; nextPurgeAt:number|null; estimatedRows:number; estimatedBytes:number }
/**
 * Screen `assets`. `members` is the distinct set of people who have put a conversation in the
 * project, plus its owner — there is no project_members table, and this is the real answer to who
 * works in a project rather than a fabricated one. The screen also asked for a `policies` count;
 * `policy_rules.scope_type` is CHECKed to ('tenant','group','user'), so a rule cannot be scoped to a
 * project at all and the column has been dropped rather than filled with zeroes.
 */
export interface ProjectRow { id:string; name:string; owner:string|null; members:number; conversations:number; files:number; bytes:number; lastActivityAt:number; status:'active'|'archived' }

export interface DirectoryStatements {
  readonly roles:Statement;
  readonly retentionSettings:Statement; readonly retentionConversations:Statement; readonly retentionMessages:Statement; readonly retentionAudit:Statement; readonly retentionFiles:Statement; readonly legalHolds:Statement;
  readonly projects:Statement;
}

/** Preparation is deliberately separate from request execution; execution always uses TenantDb. */
export function prepareDirectoryStatements(database:Database.Database):DirectoryStatements {
  // TenantDb binds parameters positionally and binds the tenant id first, while better-sqlite3
  // refuses positional binding for ?NNN placeholders. Statements that need a value in more than one
  // place therefore hoist their whole parameter list into a one-row `q` CTE — tenant id first — and
  // read it by name, which also keeps the tenant predicate impossible to bind past.
  const p=(sql:string):Statement => database.prepare(sql) as Statement;
  return {
    // roles has no updated_at/updated_by pair, so `last change` is the newest grant of the role
    // (the only role mutation this schema records), falling back to creation for never-granted roles.
    // Global roles (tenant_id IS NULL) are assignable inside a tenant, so they list here too, but
    // their counts stay tenant-scoped through user_roles.tenant_id.
    roles:p(`WITH q(tenant_id,q_search,q_kind,q_permission) AS (VALUES(?,?,?,?))
      SELECT r.name,r.is_system,r.created_at,
      (SELECT COUNT(*) FROM role_permissions rp WHERE rp.role_id=r.id) permission_count,
      (SELECT COUNT(*) FROM user_roles ur JOIN users u ON u.tenant_id=ur.tenant_id AND u.id=ur.user_id WHERE ur.tenant_id=q.tenant_id AND ur.role_id=r.id AND u.deleted_at IS NULL) assigned_users,
      (SELECT MAX(ur.created_at) FROM user_roles ur WHERE ur.tenant_id=q.tenant_id AND ur.role_id=r.id) last_granted_at,
      (SELECT u.display_name FROM user_roles ur LEFT JOIN users u ON u.tenant_id=ur.tenant_id AND u.id=ur.granted_by_user_id WHERE ur.tenant_id=q.tenant_id AND ur.role_id=r.id ORDER BY ur.created_at DESC,ur.user_id DESC LIMIT 1) last_granted_by
      FROM roles r,q WHERE (r.tenant_id=q.tenant_id OR r.tenant_id IS NULL)
      AND (q.q_search IS NULL OR instr(lower(r.name),q.q_search)>0 OR instr(lower(r.key),q.q_search)>0)
      AND (q.q_kind IS NULL OR (r.is_system=1)=(q.q_kind='system'))
      AND (q.q_permission IS NULL OR EXISTS(SELECT 1 FROM role_permissions rp WHERE rp.role_id=r.id AND rp.permission_key=q.q_permission))
      ORDER BY r.is_system DESC,r.name,r.id`),
    retentionSettings:p(`SELECT conversation_retention_days,audit_retention_days FROM tenant_settings WHERE tenant_id=?`),
    // Rows and bytes count what is still stored; `oldest` ignores already-purged rows because the
    // unpurged ones are what a purge would next act on — the predicate behind ix_conversations_purge.
    retentionConversations:p(`SELECT COUNT(*) row_count,COALESCE(SUM(length(CAST(title AS BLOB))),0) byte_count,MIN(CASE WHEN content_purged_at IS NULL THEN updated_at END) oldest FROM conversations WHERE tenant_id=?`),
    retentionMessages:p(`WITH q(tenant_id) AS (VALUES(?)) SELECT (SELECT COUNT(*) FROM messages m WHERE m.tenant_id=q.tenant_id) row_count,(SELECT COALESCE(SUM(length(CAST(p.text_content AS BLOB))),0) FROM message_parts p WHERE p.tenant_id=q.tenant_id) byte_count FROM q`),
    retentionAudit:p(`SELECT COUNT(*) row_count,COALESCE(SUM(length(CAST(metadata_json AS BLOB))+length(CAST(metadata_text AS BLOB))),0) byte_count FROM audit_events WHERE tenant_id=?`),
    retentionFiles:p(`SELECT COUNT(*) row_count,COALESCE(SUM(CASE WHEN content_purged_at IS NULL THEN byte_size ELSE 0 END),0) byte_count,MIN(CASE WHEN content_purged_at IS NULL THEN created_at END) oldest FROM project_files WHERE tenant_id=?`),
    legalHolds:p(`SELECT scope_type,COUNT(*) held FROM audit_legal_holds WHERE tenant_id=? AND released_at_ms IS NULL GROUP BY scope_type`),
    // The only screen here that is not bounded by construction, so it pages. Keyset on
    // (last_activity_at, id) rather than an offset: the sort key is activity, which moves while an
    // administrator reads, and an offset would then skip or repeat rows.
    // Deleted projects are excluded outright — this screen governs live assets, and a purge worker,
    // not an administrator, is what finishes a deletion.
    projects:p(`WITH q(tenant_id,q_search,q_owner,q_status,q_inactive_before,q_cursor_activity,q_cursor_id) AS (VALUES(?,?,?,?,?,?,?))
      SELECT * FROM (
      SELECT p.id,p.name,u.display_name owner,
        (SELECT COUNT(DISTINCT c.owner_user_id) FROM project_conversations pc JOIN conversations c ON c.id=pc.conversation_id
          WHERE pc.project_id=p.id AND c.tenant_id=q.tenant_id AND c.deleted_at IS NULL AND c.owner_user_id IS NOT NULL AND c.owner_user_id<>COALESCE(p.owner_user_id,'')) collaborators,
        (SELECT COUNT(*) FROM project_conversations pc JOIN conversations c ON c.id=pc.conversation_id
          WHERE pc.project_id=p.id AND c.tenant_id=q.tenant_id AND c.deleted_at IS NULL) conversations,
        (SELECT COUNT(*) FROM project_files f WHERE f.tenant_id=q.tenant_id AND f.project_id=p.id AND f.deleted_at IS NULL) files,
        (SELECT COALESCE(SUM(CASE WHEN f.content_purged_at IS NULL THEN f.byte_size ELSE 0 END),0) FROM project_files f WHERE f.tenant_id=q.tenant_id AND f.project_id=p.id AND f.deleted_at IS NULL) bytes,
        MAX(p.updated_at,COALESCE((SELECT MAX(c.updated_at) FROM project_conversations pc JOIN conversations c ON c.id=pc.conversation_id WHERE pc.project_id=p.id AND c.tenant_id=q.tenant_id AND c.deleted_at IS NULL),0)) last_activity_at,
        p.archived_at
      FROM projects p,q LEFT JOIN users u ON u.tenant_id=q.tenant_id AND u.id=p.owner_user_id
      WHERE p.tenant_id=q.tenant_id AND p.deleted_at IS NULL
      AND (q.q_search IS NULL OR instr(lower(p.name),q.q_search)>0)
      AND (q.q_owner IS NULL OR p.owner_user_id=q.q_owner)
      AND (q.q_status IS NULL OR (p.archived_at IS NULL)=(q.q_status='active'))
      )
      -- last_activity_at is a maximum computed over another table, so both the inactivity filter and
      -- the keyset comparison have to run outside the projection that defines it. The limit stays a
      -- trailing positional parameter: SQLite will not accept a column reference in LIMIT.
      WHERE ((SELECT q_inactive_before FROM q) IS NULL OR last_activity_at<(SELECT q_inactive_before FROM q))
      AND ((SELECT q_cursor_activity FROM q) IS NULL OR last_activity_at<(SELECT q_cursor_activity FROM q)
           OR (last_activity_at=(SELECT q_cursor_activity FROM q) AND id<(SELECT q_cursor_id FROM q)))
      ORDER BY last_activity_at DESC,id DESC LIMIT ?`),
  };
}

// Mirrors the tenant setting bounds. Files share the conversation window until their own setting
// exists, so their displayed bound and projection must match the worker's effective policy.
const BOUNDS:Record<DataClass,{minimumDays:number|null;maximumDays:number|null}> = {conversations:{minimumDays:1,maximumDays:3650},messages:{minimumDays:1,maximumDays:3650},audit_events:{minimumDays:365,maximumDays:null},files:{minimumDays:1,maximumDays:3650}};
// Legal holds are scoped by subject, not by data class; this maps each scope to the classes it can
// block, matching purgeExpiredConversations and purgeExpiredProjectFiles in audit-retention.ts.
const HOLD_SCOPES:Record<DataClass,readonly string[]> = {conversations:['tenant','user','conversation','project','date_range'],messages:['tenant','user','conversation','project','date_range'],audit_events:['tenant','user','conversation','project','date_range'],files:['tenant','user','conversation','project','date_range']};
const DAY_MS=86_400_000;
const RANGES:Record<string,number> = {'24h':DAY_MS,'7d':7*DAY_MS,'30d':30*DAY_MS,'90d':90*DAY_MS};

const text=(value:string|undefined):string|null => {const trimmed=value?.trim();return trimmed?trimmed:null};
const lower=(value:string|undefined):string|null => text(value)?.toLowerCase()??null;
const exact=(value:string|undefined,allowed:readonly string[]):string|null => {const found=text(value);return found&&allowed.includes(found)?found:null};
const truthy=(value:string|undefined):boolean => value==='true'||value==='1'||value==='yes';
const since=(value:string|undefined,now:number):number|null => {const span=RANGES[text(value)??''];return span===undefined?null:now-span};
const int=(value:unknown):number => typeof value==='number'?value:0;
const nullableInt=(value:unknown):number|null => typeof value==='number'?value:null;
const nullableText=(value:unknown):string|null => typeof value==='string'?value:null;
const booleanOrNull=(value:unknown):boolean|null => value===1?true:value===0?false:null;
const stringList=(value:unknown):readonly string[] => {try{const parsed=JSON.parse(String(value));return Array.isArray(parsed)?parsed.filter((item):item is string=>typeof item==='string'):[]}catch{return []}};
const jsonObject=(value:unknown):Readonly<Record<string,unknown>>|null => {try{const parsed=JSON.parse(String(value));return typeof parsed==='object'&&parsed!==null&&!Array.isArray(parsed)?parsed as Readonly<Record<string,unknown>>:null}catch{return null}};

// The projects cursor carries the sort key it resumes from, so it is meaningless against a different
// sort and self-evidently so. Unsigned: it addresses rows inside an already tenant-scoped and
// permission-checked query, so forging one reaches nothing the same request would not return anyway.
const PROJECT_PAGE=50;
interface ProjectCursor { readonly activity:number; readonly id:string }
const encodeProjectCursor=(row:ProjectCursor):string => Buffer.from(JSON.stringify({v:1,a:row.activity,i:row.id})).toString('base64url');
function decodeProjectCursor(value:string|undefined):ProjectCursor|null {
  if(value===undefined)return null;
  try { const parsed=JSON.parse(Buffer.from(value,'base64url').toString()) as {v?:unknown;a?:unknown;i?:unknown};
    if(parsed.v===1&&Number.isInteger(parsed.a)&&typeof parsed.i==='string')return {activity:Number(parsed.a),id:parsed.i}; } catch { /* falls through to the shared rejection */ }
  throw new TypeError('cursor is not a valid projects cursor');
}

export interface DirectoryReader {
  listRoles(tenant:TenantDb,query:DirectoryQuery):DirectoryPage<RoleRow>;
  listRetention(tenant:TenantDb,query:DirectoryQuery):DirectoryPage<RetentionRow>;
  listProjects(tenant:TenantDb,query:DirectoryQuery):DirectoryPage<ProjectRow>;
}

export function createDirectoryReader(database:Database.Database,now:()=>number=Date.now):DirectoryReader {
  const statements=prepareDirectoryStatements(database);
  // These screens are bounded by construction — a tenant has a handful of roles and four data
  // classes — so there is nothing to page through and nextCursor is always null. Projects are the
  // exception and page for real; see listProjects.
  const page=<T>(items:readonly T[]):DirectoryPage<T> => ({items,nextCursor:null});

  function listRoles(tenant:TenantDb,query:DirectoryQuery):DirectoryPage<RoleRow> {
    // Permission keys are stored with a dot (see shared/permissions.ts#toStorageKey); accept the
    // wire form too so the filter works with the value the UI already renders.
    const permission=text(query.permission)?.replace(':','.')??null;
    const rows=tenant.all(statements.roles,lower(query.search),exact(query.type,['system','custom']),permission);
    return page(rows.map(row=>({name:String(row.name),type:row.is_system===1?'system':'custom',permissionCount:int(row.permission_count),assignedUsers:int(row.assigned_users),lastChangedBy:nullableText(row.last_granted_by),updatedAt:nullableInt(row.last_granted_at)??int(row.created_at),status:null} as const)));
  }

  function listRetention(tenant:TenantDb,query:DirectoryQuery):DirectoryPage<RetentionRow> {
    const settings=tenant.get(statements.retentionSettings),at=now();
    const conversations=tenant.get(statements.retentionConversations),messages=tenant.get(statements.retentionMessages);
    const audit=tenant.get(statements.retentionAudit),files=tenant.get(statements.retentionFiles);
    const conversationDays=nullableInt(settings?.conversation_retention_days)??DEFAULT_CONVERSATION_RETENTION_DAYS;
    const holds=tenant.all(statements.legalHolds);
    const held=(dataClass:DataClass):number => holds.reduce((total,row)=>total+(HOLD_SCOPES[dataClass].includes(String(row.scope_type))?int(row.held):0),0);
    // Conversations and their messages die together (messages.conversation_id cascades), so both
    // classes read the same setting and the same next-purge instant.
    const oldestConversation=nullableInt(conversations?.oldest);
    const conversationPurge=oldestConversation!==null&&conversationDays!==null?oldestConversation+conversationDays*DAY_MS:null;
    const rows:RetentionRow[]=[
      {dataClass:'conversations',retentionDays:conversationDays,...BOUNDS.conversations,legalHolds:held('conversations'),nextPurgeAt:conversationPurge,estimatedRows:int(conversations?.row_count),estimatedBytes:int(conversations?.byte_count)},
      {dataClass:'messages',retentionDays:conversationDays,...BOUNDS.messages,legalHolds:held('messages'),nextPurgeAt:conversationPurge,estimatedRows:int(messages?.row_count),estimatedBytes:int(messages?.byte_count)},
      // Audit-event deletion is deliberately offline-only. Do not imply that the stored legacy
      // column is an active online policy when this process cannot lawfully enforce it.
      {dataClass:'audit_events',retentionDays:null,...BOUNDS.audit_events,legalHolds:held('audit_events'),nextPurgeAt:null,estimatedRows:int(audit?.row_count),estimatedBytes:int(audit?.byte_count)},
      {dataClass:'files',retentionDays:conversationDays,...BOUNDS.files,legalHolds:held('files'),nextPurgeAt:files?.oldest===null||conversationDays===null?null:int(files?.oldest)+conversationDays*DAY_MS,estimatedRows:int(files?.row_count),estimatedBytes:int(files?.byte_count)},
    ];
    const dataClass=exact(query.dataClass,['conversations','messages','audit_events','files']),search=lower(query.search);
    return page(rows.filter(row=>(dataClass===null||row.dataClass===dataClass)&&(search===null||row.dataClass.includes(search))
      &&(!truthy(query.legalHold)||row.legalHolds>0)&&(!truthy(query.purgeDue)||(row.nextPurgeAt!==null&&row.nextPurgeAt<=at))));
  }

  function listProjects(tenant:TenantDb,query:DirectoryQuery):DirectoryPage<ProjectRow> {
    const cursor=decodeProjectCursor(query.cursor);
    // One row past the page: the presence of that extra row is what distinguishes "there is more"
    // from "this page happened to be exactly full", which a count of PROJECT_PAGE cannot.
    const rows=tenant.all(statements.projects,lower(query.search),text(query.owner),exact(query.status,['active','archived']),
      since(query.inactiveRange,now()),cursor?.activity??null,cursor?.id??null,PROJECT_PAGE+1);
    const hasMore=rows.length>PROJECT_PAGE, visible=hasMore?rows.slice(0,PROJECT_PAGE):rows;
    const items=visible.map(row=>({id:String(row.id),name:String(row.name),owner:nullableText(row.owner),
      // The owner counts as a member of their own project even before anyone else joins it, so a
      // brand-new project reads 1 rather than 0. `collaborators` excludes them to avoid double counting.
      members:int(row.collaborators)+1,conversations:int(row.conversations),files:int(row.files),bytes:int(row.bytes),
      lastActivityAt:int(row.last_activity_at),status:row.archived_at===null?'active':'archived'} as const));
    const last=items[items.length-1];
    return {items,nextCursor:hasMore&&last?encodeProjectCursor({activity:last.lastActivityAt,id:last.id}):null};
  }

  return {listRoles,listRetention,listProjects};
}

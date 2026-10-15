import type Database from "better-sqlite3";
import type { TenantId } from "../../shared/types.js";

interface Due {
  id: string;
}
export interface PurgeResult {
  purged: number;
  ids: readonly string[];
}

const DAY_MS=24*60*60*1_000;
const FILE_PURGE_PREPARED_AT=0;
export const IDEMPOTENCY_RETENTION_MS=DAY_MS;
const TERMINAL_APPROVAL_STATUSES="'released','rejected','expired','cancelled','release_indeterminate'";
const ACTIVE_APPROVAL_STATUSES="'pending','claimed','approved','releasing','release_failed'";

function assertBatchSize(batchSize:number):void {
  if(!Number.isInteger(batchSize)||batchSize<1||batchSize>500)throw new TypeError('Invalid purge batch size');
}

// The worker reports this cutoff in `system.retention_purged`; deriving it twice is how the
// reported instant and the instant the rows were actually compared against drift apart.
export const retentionCutoff=(nowMs:number,retentionDays:number):number => nowMs-retentionDays*DAY_MS;

interface ConversationDue {id:string}
interface FileDue {id:string;storage_key:string;content_purged_at:number|null}
export interface PurgeHooks {beforeUpdate?:(id:string)=>void;afterPurge?:(id:string,preparedRecovery:boolean)=>void;onBlobError?:(id:string,error:unknown)=>void}
export interface BlobRemover {remove(key:string):Promise<void>;existsSync?(key:string):boolean;removeSync?(key:string):void}

export function purgeExpiredConversations(database:Database.Database,tenantId:TenantId,nowMs:number,retentionDays:number|null,batchSize=100,hooks:Readonly<PurgeHooks>={}):PurgeResult {
  assertBatchSize(batchSize);
  if(retentionDays===null)return{purged:0,ids:[]};
  if(!Number.isSafeInteger(retentionDays)||retentionDays<1||retentionDays>3650)throw new TypeError('Invalid conversation retention');
  const cutoff=retentionCutoff(nowMs,retentionDays);
  const hold=`NOT EXISTS (SELECT 1 FROM audit_legal_holds h WHERE h.tenant_id=c.tenant_id AND h.released_at_ms IS NULL AND (
    h.scope_type='tenant' OR (h.scope_type='user' AND h.scope_id=c.owner_user_id) OR
    (h.scope_type='conversation' AND h.scope_id=c.id) OR
    (h.scope_type='project' AND EXISTS (SELECT 1 FROM project_conversations pc JOIN projects p ON p.id=pc.project_id AND p.tenant_id=c.tenant_id WHERE pc.conversation_id=c.id AND pc.project_id=h.scope_id)) OR
    /* A conversation overlaps [start,end) when it ends on/after start and begins before end. */
    (h.scope_type='date_range' AND (h.starts_at_ms IS NULL OR c.updated_at>=h.starts_at_ms) AND (h.ends_at_ms IS NULL OR c.created_at<h.ends_at_ms))))`;
  const due=database.prepare<[TenantId,number,number],ConversationDue>(`SELECT c.id FROM conversations c WHERE c.tenant_id=? AND c.content_purged_at IS NULL AND c.updated_at<=? AND ${hold} ORDER BY c.updated_at,c.id LIMIT ?`);
  const clearParts=database.prepare<[TenantId,string]>(`UPDATE message_parts SET text_content=NULL,metadata_json=json_set(metadata_json,'$.purged',1) WHERE tenant_id=? AND message_id IN (SELECT id FROM messages WHERE tenant_id=? AND conversation_id=?) AND text_content IS NOT NULL`) as unknown as Database.Statement<[TenantId,TenantId,string]>;
  const update=database.prepare<[number,TenantId,string,number]>(`UPDATE conversations AS c SET title='Content purged by retention',content_purged_at=? WHERE c.tenant_id=? AND c.id=? AND c.content_purged_at IS NULL AND c.updated_at<=? AND ${hold}`);
  return database.transaction(()=>{const ids:string[]=[];for(const row of due.all(tenantId,cutoff,batchSize)){hooks.beforeUpdate?.(row.id);if(update.run(nowMs,tenantId,row.id,cutoff).changes===1){clearParts.run(tenantId,tenantId,row.id);ids.push(row.id);}}return{purged:ids.length,ids};}).immediate();
}

/**
 * SQLite and the filesystem cannot share a transaction, so deletion has a durable, fail-closed
 * prepare state: `content_purged_at=0`. The application already treats every non-NULL value as
 * unavailable, and the next sweep resumes zero-valued rows after a crash.
 *
 * Finalization owns an IMMEDIATE SQLite transaction, re-checks legal holds in the guarded UPDATE,
 * changes the row to its final purged state, and synchronously unlinks the blob before committing.
 * A hold committed before that transaction wins; a competing hold writer cannot commit until after
 * the unlink. If unlink throws, the final update rolls back and the prepare marker is released. If
 * the process dies after unlink but before commit, the earlier prepare marker remains durable, so
 * the next pass's synchronous existence check finalizes it without honoring a necessarily-later
 * hold. The database therefore never returns to claiming that missing content is present. Missing
 * synchronous probe/deletion support fails closed before the prepare state is written.
 *
 * Each file is isolated. One unreadable key must not abort the sweep, because the tenants after it
 * in `forEachMaintenanceTenant` would keep their expired content for as long as the key stayed bad.
 */
export async function purgeExpiredProjectFiles(database:Database.Database,tenantId:TenantId,nowMs:number,retentionDays:number|null,blobs:BlobRemover,batchSize=100,hooks:Readonly<PurgeHooks>={}):Promise<PurgeResult> {
  assertBatchSize(batchSize);
  if(retentionDays!==null&&(!Number.isSafeInteger(retentionDays)||retentionDays<1||retentionDays>3650))throw new TypeError('Invalid file retention');
  // Disabling a policy stops new claims, but cannot skip crash recovery for an already-prepared
  // row: surviving bytes must become visible again and missing bytes must remain honestly purged.
  const cutoff=retentionDays===null?null:retentionCutoff(nowMs,retentionDays);
  const hold=`NOT EXISTS (SELECT 1 FROM audit_legal_holds h WHERE h.tenant_id=f.tenant_id AND h.released_at_ms IS NULL AND (
    h.scope_type='tenant' OR (h.scope_type='user' AND h.scope_id=f.uploaded_by_user_id) OR (h.scope_type='project' AND h.scope_id=f.project_id) OR
    (h.scope_type='conversation' AND EXISTS (SELECT 1 FROM message_parts mp JOIN messages m ON m.tenant_id=mp.tenant_id AND m.id=mp.message_id WHERE mp.tenant_id=f.tenant_id AND mp.file_id=f.id AND m.conversation_id=h.scope_id AND mp.kind IN ('file_ref','image_ref'))) OR
    (h.scope_type='date_range' AND (h.starts_at_ms IS NULL OR f.created_at>=h.starts_at_ms) AND (h.ends_at_ms IS NULL OR f.created_at<h.ends_at_ms))))`;
  // A prepared row must always be resumed. Its policy window may have changed after the prepare
  // commit, and leaving the marker behind would make existing bytes permanently inaccessible.
  const due=database.prepare<[TenantId,number|null,number],FileDue>(`SELECT f.id,f.storage_key,f.content_purged_at FROM project_files f WHERE f.tenant_id=? AND ((f.content_purged_at IS NULL AND f.created_at<=? AND ${hold}) OR f.content_purged_at=${FILE_PURGE_PREPARED_AT}) ORDER BY f.created_at,f.id LIMIT ?`);
  const prepare=database.prepare<[TenantId,string,number]>(`UPDATE project_files AS f SET content_purged_at=${FILE_PURGE_PREPARED_AT} WHERE f.tenant_id=? AND f.id=? AND f.content_purged_at IS NULL AND f.created_at<=? AND ${hold}`);
  const update=database.prepare<[number,TenantId,string,number]>(`UPDATE project_files AS f SET extracted_text=NULL,extraction_status='purged',content_purged_at=? WHERE f.tenant_id=? AND f.id=? AND f.content_purged_at=${FILE_PURGE_PREPARED_AT} AND f.created_at<=? AND ${hold}`);
  const updateMissing=database.prepare<[number,TenantId,string]>(`UPDATE project_files SET extracted_text=NULL,extraction_status='purged',content_purged_at=? WHERE tenant_id=? AND id=? AND content_purged_at=${FILE_PURGE_PREPARED_AT}`);
  const release=database.prepare<[TenantId,string]>(`UPDATE project_files SET content_purged_at=NULL WHERE tenant_id=? AND id=? AND content_purged_at=${FILE_PURGE_PREPARED_AT}`);
  const claim=database.transaction((row:FileDue):boolean=>row.content_purged_at===FILE_PURGE_PREPARED_AT||(cutoff!==null&&prepare.run(tenantId,row.id,cutoff).changes===1));
  const finalize=database.transaction((row:FileDue,state:{unlinked:boolean}):boolean=>{
    hooks.beforeUpdate?.(row.id);
    if(!blobs.existsSync!(row.storage_key)){
      // The only supported path to a prepared-but-missing blob is a prior unlink whose SQLite
      // commit did not land. Any hold visible now committed after that irreversible operation.
      state.unlinked=true;
      const changed=updateMissing.run(nowMs,tenantId,row.id).changes===1;
      if(changed)hooks.afterPurge?.(row.id,true);
      return changed;
    }
    if(cutoff===null){release.run(tenantId,row.id);return false}
    if(update.run(nowMs,tenantId,row.id,cutoff).changes!==1){release.run(tenantId,row.id);return false}
    blobs.removeSync!(row.storage_key);
    state.unlinked=true;
    hooks.afterPurge?.(row.id,row.content_purged_at===FILE_PURGE_PREPARED_AT);
    return true;
  });
  const ids:string[]=[];
  for(const row of due.all(tenantId,cutoff,batchSize)){
    if(!blobs.existsSync||!blobs.removeSync){hooks.onBlobError?.(row.id,new Error('Blob store does not support synchronous retention deletion'));continue}
    if(!claim.immediate(row))continue;
    const state={unlinked:false};
    try{if(finalize.immediate(row,state))ids.push(row.id)}catch(error){
      // `removeSync` promises that a throw leaves the name intact. A later commit failure instead
      // leaves the durable prepare marker in place so the next pass cannot call the content present.
      if(!state.unlinked)release.run(tenantId,row.id);
      hooks.onBlobError?.(row.id,error);
    }
  }
  return{purged:ids.length,ids};
}

export function purgeExpiredTranscripts(
  database: Database.Database,
  tenantId: TenantId,
  nowMs: number,
  batchSize = 500,
): PurgeResult {
  assertBatchSize(batchSize);
  const due = database.prepare<[TenantId,number,number],Due>(`SELECT t.id FROM audit_transcripts t JOIN audit_events e ON e.tenant_id=t.tenant_id AND e.id=t.audit_event_id WHERE t.tenant_id=? AND t.content_state='present' AND t.purge_after_ms IS NOT NULL AND t.purge_after_ms<=? AND NOT EXISTS (SELECT 1 FROM audit_legal_holds h WHERE h.tenant_id=t.tenant_id AND h.released_at_ms IS NULL AND (h.scope_type='tenant' OR (h.scope_type='user' AND h.scope_id=e.subject_user_id) OR (h.scope_type='conversation' AND h.scope_id=e.conversation_id) OR (h.scope_type='project' AND h.scope_id=e.project_id) OR (h.scope_type='date_range' AND (h.starts_at_ms IS NULL OR e.occurred_at_ms>=h.starts_at_ms) AND (h.ends_at_ms IS NULL OR e.occurred_at_ms<h.ends_at_ms)))) ORDER BY t.purge_after_ms,t.id LIMIT ?`);
  const update = database.prepare<[number,TenantId,string,number]>(`UPDATE audit_transcripts AS t
    SET content_ciphertext=NULL,content_nonce=NULL,key_version=NULL,sanitized_preview=NULL,content_state='purged',purged_at_ms=?
    WHERE t.tenant_id=? AND t.id=? AND t.content_state='present' AND t.purge_after_ms IS NOT NULL AND t.purge_after_ms<=?
      AND NOT EXISTS (
        SELECT 1 FROM audit_events e JOIN audit_legal_holds h ON h.tenant_id=t.tenant_id AND h.released_at_ms IS NULL
        WHERE e.tenant_id=t.tenant_id AND e.id=t.audit_event_id AND (
          h.scope_type='tenant' OR (h.scope_type='user' AND h.scope_id=e.subject_user_id) OR
          (h.scope_type='conversation' AND h.scope_id=e.conversation_id) OR (h.scope_type='project' AND h.scope_id=e.project_id) OR
          (h.scope_type='date_range' AND (h.starts_at_ms IS NULL OR e.occurred_at_ms>=h.starts_at_ms) AND (h.ends_at_ms IS NULL OR e.occurred_at_ms<h.ends_at_ms))
        )
      )`);
  const run = database.transaction(() => {
    const ids:string[]=[];
    for(const row of due.all(tenantId,nowMs,batchSize))if(update.run(nowMs,tenantId,row.id,nowMs).changes===1)ids.push(row.id);
    return {purged:ids.length,ids} satisfies PurgeResult;
  });
  return run.immediate();
}

interface CheckpointRow {busy:number;log:number;checkpointed:number}

function enableSecureDelete(database:Database.Database):void {
  database.pragma('secure_delete = ON');
  if(database.pragma('secure_delete',{simple:true})!==1)throw new Error('SQLite secure_delete could not be enabled');
}

function truncateWal(database:Database.Database):void {
  const row=(database.pragma('wal_checkpoint(TRUNCATE)') as CheckpointRow[])[0];
  if(!row||row.busy!==0)throw new Error('SQLite WAL checkpoint could not obtain an exclusive reader gap');
}

/**
 * Destroys live-database access to v2 approval payloads by removing their only wrapped DEK. A checkpoint before the
 * update removes older WAL frames; secure_delete overwrites the key bytes in the replacement page;
 * and a second TRUNCATE checkpoint replaces the main-database page and removes the new WAL frame.
 * Legacy stable-key rows are deliberately excluded because deleting their ciphertext cannot destroy
 * the tenant key still capable of decrypting bytes retained by old database pages or backups.
 */
export function purgeExpiredApprovalPayloads(
  database:Database.Database,
  tenantId:TenantId,
  nowMs:number,
  approvalPayloadDays:number,
  batchSize=100,
):PurgeResult {
  assertBatchSize(batchSize);
  if(!Number.isSafeInteger(approvalPayloadDays)||approvalPayloadDays<1||approvalPayloadDays>365)
    throw new TypeError('Invalid approval payload retention');
  if(database.inTransaction)throw new Error('Approval key destruction cannot run inside a transaction');
  const cutoff=nowMs-approvalPayloadDays*DAY_MS;
  const pending=database.prepare<[TenantId,number],Due>(`SELECT id FROM policy_approval_requests
    WHERE tenant_id=? AND payload_crypto_scheme='dek_v2' AND payload_crypto_state='key_destroy_pending_scrub'
    ORDER BY payload_key_destroyed_at_ms,id LIMIT ?`);
  const due=database.prepare<[TenantId,number,number],Due>(`SELECT a.id
    FROM policy_approval_requests a
    JOIN policy_violations v ON v.tenant_id=a.tenant_id AND v.id=a.violation_id
    JOIN audit_events e ON e.tenant_id=v.tenant_id AND e.id=v.audit_event_id
    WHERE a.tenant_id=? AND a.payload_crypto_scheme='dek_v2' AND a.payload_crypto_state='available'
      AND a.status IN (${TERMINAL_APPROVAL_STATUSES})
      AND a.payload_terminal_at_ms IS NOT NULL AND a.payload_terminal_at_ms<=?
      AND NOT EXISTS (
        SELECT 1 FROM audit_legal_holds h
        WHERE h.tenant_id=a.tenant_id AND h.released_at_ms IS NULL AND (
          h.scope_type='tenant' OR
          (h.scope_type='user' AND (h.scope_id=a.requesting_user_id OR h.scope_id=v.subject_user_id)) OR
          (h.scope_type='conversation' AND h.scope_id=v.conversation_id) OR
          (h.scope_type='project' AND h.scope_id=e.project_id) OR
          (h.scope_type='date_range' AND (h.starts_at_ms IS NULL OR e.occurred_at_ms>=h.starts_at_ms) AND (h.ends_at_ms IS NULL OR e.occurred_at_ms<h.ends_at_ms))
        )
      )
    ORDER BY a.payload_terminal_at_ms,a.id LIMIT ?`);
  const stage=database.prepare<[number,TenantId,string,number]>(`UPDATE policy_approval_requests AS a
    SET payload_wrapped_dek=NULL,payload_wrap_nonce=NULL,payload_kek_version=NULL,
        payload_crypto_state='key_destroy_pending_scrub',payload_key_destroyed_at_ms=?,
        result_ciphertext=NULL,result_nonce=NULL,result_digest=NULL
    WHERE a.tenant_id=? AND a.id=? AND a.payload_crypto_scheme='dek_v2' AND a.payload_crypto_state='available'
      AND a.status IN (${TERMINAL_APPROVAL_STATUSES})
      AND a.payload_terminal_at_ms IS NOT NULL AND a.payload_terminal_at_ms<=?
      AND NOT EXISTS (
        SELECT 1 FROM policy_violations v
        JOIN audit_events e ON e.tenant_id=v.tenant_id AND e.id=v.audit_event_id
        JOIN audit_legal_holds h ON h.tenant_id=a.tenant_id AND h.released_at_ms IS NULL
        WHERE v.tenant_id=a.tenant_id AND v.id=a.violation_id AND (
          h.scope_type='tenant' OR
          (h.scope_type='user' AND (h.scope_id=a.requesting_user_id OR h.scope_id=v.subject_user_id)) OR
          (h.scope_type='conversation' AND h.scope_id=v.conversation_id) OR
          (h.scope_type='project' AND h.scope_id=e.project_id) OR
          (h.scope_type='date_range' AND (h.starts_at_ms IS NULL OR e.occurred_at_ms>=h.starts_at_ms) AND (h.ends_at_ms IS NULL OR e.occurred_at_ms<h.ends_at_ms))
        )
      )`);
  const finish=database.prepare<[number,TenantId,string]>(`UPDATE policy_approval_requests
    SET payload_crypto_state='key_destroyed',payload_purged_at_ms=?
    WHERE tenant_id=? AND id=? AND payload_crypto_scheme='dek_v2' AND payload_crypto_state='key_destroy_pending_scrub'`);
  const alreadyPending=pending.all(tenantId,batchSize),remaining=batchSize-alreadyPending.length;
  const candidates=remaining>0?due.all(tenantId,cutoff,remaining):[];
  if(alreadyPending.length===0&&candidates.length===0)return{purged:0,ids:[]};

  enableSecureDelete(database);
  truncateWal(database);
  const stageRun=database.transaction(()=>{
    const ids=alreadyPending.map(row=>row.id);
    for(const row of candidates)if(stage.run(nowMs,tenantId,row.id,cutoff).changes===1)ids.push(row.id);
    return ids;
  });
  // The destructive update repeats the hold predicate under the stage transaction's write lock.
  // A concurrently committed hold blocks a new stage; rows already staged must finish because
  // their key is gone.
  const staged=stageRun.immediate();
  if(staged.length===0)return{purged:0,ids:[]};
  truncateWal(database);
  const finishRun=database.transaction(()=>{
    const ids:string[]=[];
    for(const id of staged)if(finish.run(nowMs,tenantId,id).changes===1)ids.push(id);
    return ids;
  });
  const ids=finishRun.immediate();
  truncateWal(database);
  return{purged:ids.length,ids};
}

/** Deletes only final replay records. In-flight chat and approval runs retain their durable claim. */
export function purgeExpiredIdempotencyRecords(
  database:Database.Database,
  tenantId:TenantId,
  nowMs:number,
  batchSize=500,
):PurgeResult {
  assertBatchSize(batchSize);
  const cutoff=nowMs-IDEMPOTENCY_RETENTION_MS;
  const activeReference=`NOT EXISTS (
    SELECT 1 FROM policy_approval_requests a
    JOIN policy_violations v ON v.tenant_id=a.tenant_id AND v.id=a.violation_id
    WHERE a.tenant_id=i.tenant_id AND a.status IN (${ACTIVE_APPROVAL_STATUSES}) AND (
      a.release_run_id=i.run_id OR a.release_user_message_id=i.user_message_id OR
      a.release_message_id=i.assistant_message_id OR v.message_id=i.user_message_id
    )
  )`;
  const due=database.prepare<[TenantId,number,number],Due>(`SELECT i.id FROM idempotency_records i
    WHERE i.tenant_id=? AND i.status IN ('completed','failed')
      AND COALESCE(i.completed_at,i.updated_at)<=? AND ${activeReference}
    ORDER BY COALESCE(i.completed_at,i.updated_at),i.id LIMIT ?`);
  const remove=database.prepare<[TenantId,string,number]>(`DELETE FROM idempotency_records AS i
    WHERE i.tenant_id=? AND i.id=? AND i.status IN ('completed','failed')
      AND COALESCE(i.completed_at,i.updated_at)<=? AND ${activeReference}`);
  const run=database.transaction(()=>{
    const purgedIds:string[]=[];
    for(const row of due.all(tenantId,cutoff,batchSize)){
      if(remove.run(tenantId,row.id,cutoff).changes===1)purgedIds.push(row.id);
    }
    return {purged:purgedIds.length,ids:purgedIds} satisfies PurgeResult;
  });
  return run.immediate();
}

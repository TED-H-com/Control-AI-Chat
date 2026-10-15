import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { AuditAction, AuditOutcome, AuditService, AuditTransaction, JsonObject } from '../../lib/audit/index.js';
import type { TenantDb } from '../../lib/db.js';
import { createDefaultExtractorRegistry, DEFAULT_EXTRACTION_LIMITS, MIME, type ExtractionErrorCode, type ExtractionWarning } from '../../lib/extraction/index.js';
import type { RouteRequest, RouteResult } from '../../routes/types.js';
import type { ErrorCode, FileDetail, FileStatus, TenantId } from '../../shared/api.js';
import { createDiskBlobStore, type FileBlobStore } from './storage.js';

type Row = Record<string, unknown>;
type Statement = Database.Statement<[TenantId, ...unknown[]], Row>;
type FileStatement = Database.Statement<[TenantId, ...unknown[]], FileRow>;

interface FileRow { id:string; project_id:string; uploaded_by_user_id:string|null; original_name:string; storage_key:string; mime_type:string; byte_size:number; sha256:string; extraction_status:string; extracted_text:string|null; extraction_error:string|null; created_at:number; deleted_at:number|null; content_purged_at:number|null }
interface UploadLimitRow { max_upload_bytes:number }
interface UploadLimitStatement extends Database.Statement<[TenantId],UploadLimitRow> {}
interface FileStatements { readonly project:Statement; readonly uploadLimit:UploadLimitStatement; readonly byId:FileStatement; readonly bySha:FileStatement; readonly insert:FileStatement; readonly softDelete:Statement }

export interface FilesAdapter { supports(operation:string):boolean; execute(operation:string,request:RouteRequest):Promise<RouteResult> }
export interface FilesAdapterDependencies {
  readonly database:Database.Database;
  readonly audit:AuditService;
  /** `config.uploadDir`. Taken as a dependency rather than read from `config` so a test can point it at a temp directory. */
  readonly storageRoot:string;
  readonly now?:()=>number;
  /** Overridable so a deployment can hold blobs somewhere other than the local disk. */
  readonly storage?:FileBlobStore;
}

const OPERATIONS=new Set(['files.upload','files.get','files.content','files.extracted','files.delete']);
// Mirrors the byte_size CHECK on project_files. A violated CHECK arrives at the caller as a 500;
// this turns the same limit into a 413 they can act on.
const MAX_BYTES=DEFAULT_EXTRACTION_LIMITS.maxFileBytes;
const EXTRACTORS=createDefaultExtractorRegistry();
const GENERIC_MIME=new Set(['','application/octet-stream','binary/octet-stream']);

/**
 * `extraction_status` records what the extractor did; `FileStatus` is what the composer renders.
 *
 * Legacy `blocked` rows predate the isolated document extractor. They cannot be policy-scanned,
 * so they are rejected for chat instead of being represented as ready.
 *
 * `purged` maps to `uploaded`: retention destroyed the text, and `uploaded` is the only value that
 * says "there is a record of this upload and nothing more".
 */
const STATUS:Readonly<Record<string,FileStatus>> = {pending:'extracting',ready:'ready',blocked:'rejected',failed:'failed',purged:'uploaded'};

/**
 * The audit registry has `chat.file_uploaded` and `chat.file_deleted` but no action for reading a
 * file back, so both read paths land under `chat.file_extracted` and are told apart by
 * `metadata.access`. `chat.file_downloaded` belongs in lib/audit/audit-actions.ts; the registry
 * rejects an action it does not know, so one cannot simply be named here.
 */
const DOWNLOAD_ACTION:AuditAction='chat.file_downloaded',EXTRACT_ACTION:AuditAction='chat.file_extracted';

const error=(request:RouteRequest,status:number,code:ErrorCode,message:string,retryable=false):RouteResult =>
  ({status,body:{error:{code,message,requestId:request.requestId,retryable}}});

/** Preparation is deliberately separate from request execution; execution always uses TenantDb. */
function prepare(database:Database.Database):FileStatements {
  const p=<S>(sql:string):S => database.prepare(sql) as S;
  return {
    // There is no project_members table: `projects.owner_user_id` is the only membership this schema
    // records, and it is the predicate ProjectRepository.get already enforces. Files read through the
    // same one, so a file can never be more visible than the project holding it.
    project:p<Statement>(`SELECT id FROM projects WHERE tenant_id=? AND id=? AND owner_user_id=? AND deleted_at IS NULL`),
    uploadLimit:p<UploadLimitStatement>(`SELECT max_upload_bytes FROM tenant_settings WHERE tenant_id=?`),
    // Soft-deleted rows come back too. Each caller decides what to do with `deleted_at`, and delete
    // needs to see them so that a retry can answer 204 instead of inventing a 404.
    byId:p<FileStatement>(`SELECT f.* FROM project_files f JOIN projects p ON p.tenant_id=f.tenant_id AND p.id=f.project_id
      WHERE f.tenant_id=? AND f.id=? AND p.owner_user_id=? AND p.deleted_at IS NULL`),
    bySha:p<FileStatement>(`SELECT * FROM project_files WHERE tenant_id=? AND project_id=? AND sha256=?`),
    // TenantDb binds the tenant id first and better-sqlite3 will not bind ?NNN positionally, so the
    // whole parameter list hoists into a one-row `q` CTE that is read by name.
    //
    // UNIQUE(project_id,sha256) is the dedupe, and it is resolved in SQL rather than by a read
    // followed by a write: two uploads of the same bytes racing each other both miss the read, and
    // the loser takes a constraint violation that reaches the caller as a 500.
    //
    // The conflict target also matches rows that are soft-deleted or content-purged, so the upsert
    // resurrects those: the user re-uploaded the same bytes into the same project and the blob has
    // just been rewritten. A live, unpurged row is left exactly as it is — RETURNING then yields
    // nothing and the caller re-reads it — because re-uploading must not silently rename a file that
    // somebody else's conversation already cites.
    insert:p<FileStatement>(`WITH q(tenant_id,q_id,q_project,q_user,q_name,q_key,q_mime,q_size,q_sha,q_status,q_text,q_error,q_at) AS (VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?))
      INSERT INTO project_files(tenant_id,id,project_id,uploaded_by_user_id,original_name,storage_key,mime_type,byte_size,sha256,extraction_status,extracted_text,extraction_error,created_at)
      SELECT q.tenant_id,q.q_id,q.q_project,q.q_user,q.q_name,q.q_key,q.q_mime,q.q_size,q.q_sha,q.q_status,q.q_text,q.q_error,q.q_at FROM q
      WHERE EXISTS(SELECT 1 FROM projects p WHERE p.tenant_id=q.tenant_id AND p.id=q.q_project AND p.deleted_at IS NULL)
      ON CONFLICT(project_id,sha256) DO UPDATE SET deleted_at=NULL,content_purged_at=NULL,storage_key=excluded.storage_key,
        extraction_status=excluded.extraction_status,extracted_text=excluded.extracted_text,extraction_error=excluded.extraction_error
      WHERE project_files.deleted_at IS NOT NULL OR project_files.content_purged_at IS NOT NULL
      RETURNING *`),
    // Deleting a file destroys its bytes and keeps its row: the row is what the audit trail, the
    // retention screen and the admin asset counts read, and a delete that left the bytes on disk
    // would not be a delete in a product sold on governance. content_purged_at is the flag every
    // byte-counting query already tests, so it has to move with deleted_at.
    softDelete:p<Statement>(`WITH q(tenant_id,q_at,q_id) AS (VALUES(?,?,?))
      UPDATE project_files SET deleted_at=q.q_at,content_purged_at=COALESCE(project_files.content_purged_at,q.q_at)
      FROM q WHERE project_files.tenant_id=q.tenant_id AND project_files.id=q.q_id AND project_files.deleted_at IS NULL`),
  };
}

interface UploadPart { readonly name?:string; readonly type?:string; arrayBuffer():Promise<ArrayBuffer> }
const isUpload=(value:unknown):value is UploadPart =>
  typeof value==='object'&&value!==null&&typeof (value as {arrayBuffer?:unknown}).arrayBuffer==='function';

function part(body:unknown):UploadPart|null {
  if(typeof body!=='object'||body===null)return null;
  const fields=body as Record<string,unknown>;
  // `file` is the field the composer sends; the sweep afterwards keeps a differently named field
  // from producing a validation error that reads as "no file attached" when one plainly was.
  for(const value of [fields.file,...Object.values(fields)]) {
    const candidate=Array.isArray(value)?value[0]:value;
    if(isUpload(candidate))return candidate;
  }
  return null;
}
function field(body:unknown,name:string):string {
  if(typeof body!=='object'||body===null)return '';
  const value=(body as Record<string,unknown>)[name],single=Array.isArray(value)?value[0]:value;
  return typeof single==='string'?single.trim():'';
}

// original_name is CHECKed to 1..500 characters and ends up inside a Content-Disposition header, so
// the directory part and the control characters come off here rather than at the edge: a name
// carrying CR/LF splits that header into two.
function filename(raw:string):string {
  const base=(raw.split(/[\\/]/).pop()??'').replace(/\p{C}/gu,'').trim();
  return (base||'upload').slice(0,500);
}
// Always an attachment, never inline: a document served inline from the application origin is stored
// XSS against the console session that opened it.
function disposition(name:string):string {
  return `attachment; filename="${name.replace(/[^\p{ASCII}]/gu,'_').replaceAll('"','_')}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

const failure=(row:FileRow):ErrorCode|null =>
  row.content_purged_at!==null?'FILE_NOT_READY':row.extraction_status==='failed'?'FILE_SCAN_FAILED':null;

/**
 * `version` is created_at. project_files has neither a version column nor an updated_at, and a row's
 * user-visible state is fixed at upload — the only later transitions are deletion and a retention
 * purge, both of which end the resource. It is also the convention ProjectRepository uses
 * (`version: updated_at`), so an If-Match minted on one screen means the same thing on the other.
 */
const detail=(row:FileRow):FileDetail => ({
  id:row.id,name:row.original_name,mimeType:row.mime_type,sizeBytes:row.byte_size,
  status:STATUS[row.extraction_status]??'uploaded',sha256:row.sha256,createdAt:new Date(row.created_at).toISOString(),
  projectId:row.project_id,extractedChars:row.extracted_text===null?null:row.extracted_text.length,
  // No gate rule has run against the file: the file-direction evaluation belongs to the chat pipeline
  // that attaches it, and reporting a decision here that nothing made would be a fabrication in the
  // one field a compliance reviewer trusts.
  gate:null,failureCode:failure(row),version:row.created_at,
});

interface Extraction { readonly status:'ready'|'failed'; readonly mimeType:string; readonly text:string|null; readonly error:string|null; readonly warnings:readonly ExtractionWarning[] }
/**
 * Uploaded programs and macros are never executed. Rich formats run in a resource-limited worker.
 * A failure remains downloadable but is never represented as provider-ready: content the gate
 * could not inspect cannot cross the provider boundary.
 */
async function extract(bytes:Uint8Array,declared:string,name:string):Promise<Extraction|{readonly refused:ExtractionErrorCode}|{readonly busy:true}> {
  const normalized=declared.toLowerCase().split(';',1)[0]?.trim()??'';
  const outcome=await EXTRACTORS.extract({bytes,filename:name,
    ...(GENERIC_MIME.has(normalized)?{}:{declaredMimeType:normalized})});
  if(outcome.status==='ok')return {status:'ready',mimeType:outcome.mimeType,text:outcome.text,error:null,warnings:outcome.warnings};
  if(outcome.code==='EXTRACTION_BUSY')return {busy:true};
  if(outcome.code==='UNSUPPORTED_TYPE'||outcome.code==='MIME_MISMATCH'||outcome.code==='FILE_TOO_LARGE')return {refused:outcome.code};
  const fallback=outcome.mimeType??(Object.values(MIME).includes(normalized as typeof MIME[keyof typeof MIME])?normalized:'application/octet-stream');
  return {status:'failed',mimeType:fallback,text:null,error:outcome.code,warnings:outcome.warnings};
}

export function createFilesAdapter(deps:FilesAdapterDependencies):FilesAdapter {
  const now=deps.now??Date.now, statements=prepare(deps.database), blobs=deps.storage??createDiskBlobStore(deps.storageRoot);

  const record=(sink:AuditTransaction,request:RouteRequest,action:AuditAction,outcome:AuditOutcome,fileId:string|null,projectId:string|null,metadata:JsonObject):void => {
    const principal=request.tenant!.principal;
    sink.append({tenantId:principal.tenantId,action,actor:{type:'user',id:principal.userId,sessionId:principal.sessionId,ip:null,userAgent:null,authMethod:null},
      target:{type:'file',id:fileId},outcome,projectId,context:{requestId:request.requestId,traceId:null,source:'http',occurredAtMs:now()},metadata});
  };

  const lookup=(tenant:TenantDb,request:RouteRequest):FileRow|undefined =>
    tenant.get(statements.byId,request.params.id??'',request.tenant!.principal.userId);

  async function upload(request:RouteRequest):Promise<RouteResult> {
    const tenant=request.tenant!.db, principal=request.tenant!.principal;
    const source=part(request.body);
    if(!source)return error(request,422,'VALIDATION_FAILED','A file part is required');
    // project_id is NOT NULL, and that is the governance rule rather than a schema accident: a file
    // outside every project is outside the retention screen, the admin asset counts and the project
    // scope of a legal hold. There is nowhere safe to default it to, so it is required.
    const projectId=field(request.body,'projectId');
    if(!projectId)return error(request,422,'VALIDATION_FAILED','projectId is required');
    if(!tenant.get(statements.project,projectId,principal.userId))return error(request,404,'RESOURCE_NOT_FOUND','Project not found');

    const bytes=new Uint8Array(await source.arrayBuffer());
    if(bytes.byteLength===0)return error(request,422,'VALIDATION_FAILED','The uploaded file is empty');
    const configured=tenant.get(statements.uploadLimit)?.max_upload_bytes;
    if(!Number.isSafeInteger(configured)||configured!<1)return error(request,500,'INTERNAL_ERROR','The tenant upload limit is unavailable',true);
    const uploadLimit=Math.min(configured!,MAX_BYTES);
    if(bytes.byteLength>uploadLimit){
      const name=filename(source.name??'upload');
      record(deps.audit,request,'chat.file_uploaded','denied',null,projectId,
        {fileName:name,byteSize:bytes.byteLength,configuredLimitBytes:configured!,effectiveLimitBytes:uploadLimit,reason:'FILE_TOO_LARGE'});
      return error(request,413,'FILE_TOO_LARGE',`The uploaded file exceeds ${uploadLimit} bytes`);
    }

    const name=filename(source.name??'upload');
    // The declared Content-Type is only a claim. The registry sniffs signatures and the Office
    // container before extracting, and refuses executable or mismatched bytes.
    const extraction=await extract(bytes,source.type??'',name);
    if('busy' in extraction){
      record(deps.audit,request,'chat.file_uploaded','denied',null,projectId,{fileName:name,byteSize:bytes.byteLength,reason:'EXTRACTION_BUSY'});
      return error(request,503,'SERVICE_UNAVAILABLE','File extraction is at capacity; try again shortly',true);
    }
    if('refused' in extraction) {
      // A refused upload is precisely the event a governance log exists to hold, so it is recorded
      // before the 422 rather than dropped as "nothing happened".
      record(deps.audit,request,'chat.file_uploaded','denied',null,projectId,{fileName:name,byteSize:bytes.byteLength,declaredMimeType:source.type??'',reason:'FILE_TYPE_NOT_ALLOWED',extractionCode:extraction.refused});
      const tooLarge=extraction.refused==='FILE_TOO_LARGE';
      return error(request,tooLarge?413:422,tooLarge?'FILE_TOO_LARGE':'FILE_TYPE_NOT_ALLOWED',tooLarge?'The uploaded file exceeds the extraction limit':'This file type is not allowed');
    }
    const mimeType=extraction.mimeType;
    const sha256=createHash('sha256').update(bytes).digest('hex');
    // Content-addressed within the project, which is exactly the grain of UNIQUE(project_id,sha256):
    // the row that wins the dedupe and the blob it points at are the same object either way, so a
    // crash between the write and the insert orphans a blob rather than leaving a row with no bytes.
    // storage_key is globally UNIQUE, so the project has to be in the key — two projects holding the
    // same bytes are two rows.
    const storageKey=`${principal.tenantId}/${projectId}/${sha256}`;
    await blobs.put(storageKey,bytes);

    const at=now();
    const row=deps.audit.transact(tx=>{
      const inserted=tenant.get(statements.insert,randomUUID(),projectId,principal.userId,name,storageKey,mimeType,bytes.byteLength,sha256,extraction.status,extraction.text,extraction.error,at);
      const current=inserted??tenant.get(statements.bySha,projectId,sha256);
      if(!current)throw new Error('project_files insert reported no row for a project that exists');
      record(tx,request,'chat.file_uploaded','success',current.id,projectId,{fileName:name,byteSize:bytes.byteLength,mimeType,extractionStatus:current.extraction_status,deduplicated:inserted===undefined});
      record(tx,request,'chat.project_file_added','success',current.id,projectId,{projectId,fileId:current.id});
      record(tx,request,'chat.file_extracted',extraction.status==='ready'?'success':'failure',current.id,projectId,
        {access:'pipeline',mimeType,characters:extraction.text?.length??0,status:extraction.status,errorCode:extraction.error,warnings:[...extraction.warnings]});
      return current;
    });
    // Extraction is settled, but file-direction policy is evaluated only when the file is attached to
    // a message. 202 therefore means accepted into the governed file lifecycle, not provider-cleared.
    return {status:202,body:detail(row)};
  }

  async function content(request:RouteRequest):Promise<RouteResult> {
    const row=lookup(request.tenant!.db,request);
    if(!row||row.deleted_at!==null)return error(request,404,'RESOURCE_NOT_FOUND','File not found');
    // 410 rather than 404. The row is still returned by GET /files/:id and still counted on the
    // project's file list, so answering 404 for the bytes would contradict a resource the caller can
    // plainly see. 410 is the distinction a reviewer needs between "retention destroyed this" and
    // "this never existed".
    if(row.content_purged_at!==null)return error(request,410,'FILE_NOT_READY','The stored content was purged by retention');
    const bytes=await blobs.read(row.storage_key);
    // The row says the bytes are held and they are not. That is an outage, and answering it with the
    // purge response would hide a lost blob behind a routine retention message.
    if(!bytes)return error(request,500,'INTERNAL_ERROR','The stored content could not be read',true);
    // Appended before the bytes are returned: if the access cannot be logged, it is not granted.
    record(deps.audit,request,DOWNLOAD_ACTION,'success',row.id,row.project_id,{access:'content',byteSize:row.byte_size,mimeType:row.mime_type});
    return {body:bytes,headers:{'Content-Type':row.mime_type,'Content-Length':String(bytes.byteLength),
      'Content-Disposition':disposition(row.original_name),'X-Content-Type-Options':'nosniff','Cache-Control':'private, no-store','ETag':`"${row.created_at}"`}};
  }

  async function extracted(request:RouteRequest):Promise<RouteResult> {
    const row=lookup(request.tenant!.db,request);
    if(!row||row.deleted_at!==null)return error(request,404,'RESOURCE_NOT_FOUND','File not found');
    if(row.extraction_status==='purged')return error(request,410,'FILE_NOT_READY','The extracted text was purged by retention');
    record(deps.audit,request,EXTRACT_ACTION,'success',row.id,row.project_id,{access:'extracted',characters:row.extracted_text?.length??0});
    // 200 with a null text and the status that explains it, rather than an error. `blocked` is
    // permanent and `extracting` is not; a client forced to tell those apart from a status code ends
    // up guessing, and the field says which it is.
    return {body:{id:row.id,status:STATUS[row.extraction_status]??'uploaded',mimeType:row.mime_type,
      extractedChars:row.extracted_text===null?null:row.extracted_text.length,text:row.extracted_text,error:row.extraction_error}};
  }

  async function remove(request:RouteRequest):Promise<RouteResult> {
    const row=lookup(request.tenant!.db,request);
    if(!row)return error(request,404,'RESOURCE_NOT_FOUND','File not found');
    // A repeated DELETE is the same request arriving twice, not a new one: 204 with no second audit
    // event, because a retry after a dropped response is not a second deletion.
    if(row.deleted_at!==null)return {status:204};
    const supplied=request.headers.get('If-Match')?.trim()??'';
    if(supplied!=='*'&&supplied.replace(/^W\//,'').replaceAll('"','')!==String(row.created_at))
      return error(request,412,'PRECONDITION_FAILED','The file was modified by another request');
    const at=now();
    deps.audit.transact(tx=>{
      request.tenant!.db.run(statements.softDelete,at,row.id);
      record(tx,request,'chat.file_deleted','success',row.id,row.project_id,{fileName:row.original_name,byteSize:row.byte_size});
    });
    // After the commit. Unlinking first would destroy the bytes behind a row that a rolled-back audit
    // write leaves alive.
    await blobs.remove(row.storage_key);
    return {status:204};
  }

  return {supports:operation=>OPERATIONS.has(operation),async execute(operation,request){
    if(!request.tenant)return error(request,401,'UNAUTHENTICATED','Authentication required');
    // file:read and file:write are enforced by the route layer from the catalog. What is checked here
    // is the project, which the catalog cannot see.
    if(operation==='files.upload')return upload(request);
    if(operation==='files.content')return content(request);
    if(operation==='files.extracted')return extracted(request);
    if(operation==='files.delete')return remove(request);
    if(operation==='files.get') {
      const row=lookup(request.tenant.db,request);
      // 404 rather than 403 when the file belongs to another tenant. A 403 would confirm that the id
      // exists, which is the disclosure the tenant predicate is there to prevent.
      if(!row||row.deleted_at!==null)return error(request,404,'RESOURCE_NOT_FOUND','File not found');
      return {body:detail(row),headers:{ETag:`"${row.created_at}"`}};
    }
    throw new Error(`NotImplemented: files operation ${operation}`);
  }};
}

export * from './storage.js';

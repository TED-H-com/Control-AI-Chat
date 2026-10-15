import type Database from 'better-sqlite3';
import type { FileRef, GateAction, GateDirection, Message, Provider } from '../../shared/api.js';
import type { TenantId } from '../../shared/types.js';
import { RepositoryError } from './errors.js';
import { cursorOf, encodeCursor, iso, limitOf } from './helpers.js';
import type { CursorPage, RepositoryContext } from './types.js';

type Stmt<R=unknown>=Database.Statement<[TenantId,...unknown[]],R>;
const stmt=<R>(database:Database.Database,sql:string):Stmt<R>=>database.prepare(sql) as unknown as Stmt<R>;

interface Row {
  id:string;conversation_id:string;parent_message_id:string|null;role:Message['role'];sequence_no:number;
  model_catalog_id:string|null;provider_key:Provider|null;input_tokens:number|null;output_tokens:number|null;
  cost_microusd:number|null;created_at:number;completed_at:number|null;
  gate_decision_id:string|null;gate_direction:GateDirection|null;gate_action:GateAction|null;
  matched_detector_keys_json:string|null;protected_item_count:number|null;approval_id:string|null;
}

interface Part {
  id:string;message_id:string;ordinal:number;kind:'text'|'file_ref'|'image_ref'|'redacted_text';text_content:string|null;
  file_id:string|null;file_name:string|null;file_mime_type:string|null;file_size:number|null;file_sha256:string|null;
  file_status:'pending'|'ready'|'blocked'|'failed'|'purged'|null;file_created_at:number|null;
}

// Keep historical message attachments on the same public contract as the live file API.
const FILE_STATUS:Readonly<Record<NonNullable<Part['file_status']>,FileRef['status']>>={
  pending:'extracting',ready:'ready',blocked:'rejected',failed:'failed',purged:'uploaded',
};

const SELECT_MESSAGES=`SELECT m.id,m.conversation_id,m.parent_message_id,m.role,m.sequence_no,m.model_catalog_id,
  m.provider_key,m.input_tokens,m.output_tokens,m.cost_microusd,m.created_at,m.completed_at,
  d.id gate_decision_id,d.direction gate_direction,d.final_action gate_action,d.matched_detector_keys_json,m.protected_item_count,
  (SELECT v.approval_id FROM policy_violations v WHERE v.tenant_id=m.tenant_id AND v.message_id=m.id
    AND v.direction=d.direction AND v.approval_id IS NOT NULL ORDER BY v.updated_at_ms DESC,v.id DESC LIMIT 1) approval_id
  FROM messages m
  LEFT JOIN gate_decisions d ON d.id=(SELECT candidate.id FROM gate_decisions candidate
    WHERE candidate.tenant_id=m.tenant_id AND candidate.message_id=m.id
    ORDER BY CASE candidate.final_action WHEN 'require_approval' THEN 7 WHEN 'block' THEN 6 WHEN 'warn' THEN 5
      WHEN 'mask' THEN 4 WHEN 'redact' THEN 3 WHEN 'flag' THEN 2 ELSE 1 END DESC,candidate.decided_at DESC,candidate.id DESC LIMIT 1)`;

const detectorCount=(value:string|null):number=>{
  if(value===null)return 0;
  const parsed=JSON.parse(value) as unknown;
  return Array.isArray(parsed)?new Set(parsed.filter(item=>typeof item==='string')).size:0;
};

export class MessageRepository {
  constructor(private readonly database:Database.Database){}

  list(context:RepositoryContext,conversationId:string,input:{limit?:number;cursor?:string}={}):CursorPage<Message>{
    const limit=limitOf(input.limit),cursor=cursorOf<{s:number;i:string}>(input.cursor);
    const own=stmt<{id:string}>(this.database,'SELECT c.id FROM conversations c WHERE c.tenant_id=? AND c.owner_user_id=? AND c.id=?');
    if(!context.db.get(own,context.principal.userId,conversationId))throw new RepositoryError('NOT_FOUND','Conversation not found');
    const rows=context.db.all(stmt<Row>(this.database,`${SELECT_MESSAGES} WHERE m.tenant_id=? AND m.conversation_id=?
      AND m.deleted_at IS NULL AND (? IS NULL OR m.sequence_no>? OR (m.sequence_no=? AND m.id>?))
      ORDER BY m.sequence_no,m.id LIMIT ?`),conversationId,cursor?.s??null,cursor?.s??0,cursor?.s??0,cursor?.i??'',limit+1);
    const visible=rows.slice(0,limit),ids=visible.map(row=>row.id);
    let parts:Part[]=[];
    if(ids.length){
      const placeholders=ids.map(()=>'?').join(',');
      parts=context.db.all(stmt<Part>(this.database,`SELECT p.id,p.message_id,p.ordinal,p.kind,p.text_content,p.file_id,
        f.original_name file_name,f.mime_type file_mime_type,f.byte_size file_size,f.sha256 file_sha256,
        f.extraction_status file_status,f.created_at file_created_at
        FROM message_parts p LEFT JOIN project_files f ON f.tenant_id=p.tenant_id AND f.id=p.file_id
        WHERE p.tenant_id=? AND p.message_id IN (${placeholders}) ORDER BY p.message_id,p.ordinal`),...ids);
    }
    const data=visible.map(row=>this.#message(row,parts.filter(part=>part.message_id===row.id)));
    const last=rows[Math.min(limit,rows.length)-1];
    return {data,hasMore:rows.length>limit,nextCursor:rows.length>limit&&last?encodeCursor({s:last.sequence_no,i:last.id}):null};
  }

  all(context:RepositoryContext,conversationId:string):Message[]{
    const messages:Message[]=[];
    let cursor:string|undefined;
    do {
      const page=this.list(context,conversationId,{limit:200,...(cursor?{cursor}:{})});
      messages.push(...page.data);
      cursor=page.nextCursor??undefined;
    } while(cursor);
    return messages;
  }

  #message(row:Row,parts:readonly Part[]):Message {
    const attachments=parts.flatMap((part):FileRef[]=>part.file_id&&part.file_name&&part.file_mime_type&&part.file_size!==null&&part.file_sha256&&part.file_status&&part.file_created_at!==null
      ? [{id:part.file_id,name:part.file_name,mimeType:part.file_mime_type,sizeBytes:part.file_size,status:FILE_STATUS[part.file_status],sha256:part.file_sha256,createdAt:iso(part.file_created_at)!}]
      : []);
    return {
      id:row.id,conversationId:row.conversation_id,parentMessageId:row.parent_message_id,role:row.role,
      content:parts.filter(part=>part.kind==='text'||part.kind==='redacted_text').map(part=>part.text_content??'').join(''),
      modelId:row.model_catalog_id,provider:row.provider_key,createdAt:iso(row.created_at)!,inputTokens:row.input_tokens,
      outputTokens:row.output_tokens,costUsd:row.cost_microusd===null?null:row.cost_microusd/1_000_000,
      gate:row.gate_decision_id&&row.gate_direction&&row.gate_action?{decisionId:row.gate_decision_id,direction:row.gate_direction,
        action:row.gate_action,detectorCount:detectorCount(row.matched_detector_keys_json),protectedItemCount:row.protected_item_count,
        approvalId:row.approval_id,userNotice:null}:null,
      attachments,version:row.completed_at??row.created_at,
    };
  }
}

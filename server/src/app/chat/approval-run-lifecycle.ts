import type Database from 'better-sqlite3';
import type { TenantDb } from '../../lib/db.js';
import type { GateAction, Message } from '../../shared/api.js';
import type { TenantId } from '../../shared/types.js';

interface HeldRunRow {
  id:string;run_id:string;conversation_id:string;user_message_id:string;assistant_message_id:string;
  assistant_created_at:number;model_catalog_id:string|null;provider_key:Message['provider'];
}

const heldRun=(database:Database.Database)=>database.prepare<[TenantId,string,string],HeldRunRow>(`SELECT i.id,i.run_id,i.conversation_id,i.user_message_id,i.assistant_message_id,m.created_at assistant_created_at,m.model_catalog_id,m.provider_key
  FROM idempotency_records i JOIN messages m ON m.tenant_id=i.tenant_id AND m.id=i.assistant_message_id
  WHERE i.tenant_id=? AND i.actor_user_id=? AND i.user_message_id=? ORDER BY i.created_at DESC LIMIT 1`);

function updateAssistant(database:Database.Database,db:TenantDb,id:string,status:'blocked'|'failed',errorCode:string,content:string,now:number):void {
  db.run(database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE messages SET status=?,error_code=?,policy_action='require_approval',completed_at=? WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=? AND role='assistant' AND (status IN ('pending','streaming') OR (status='blocked' AND error_code='APPROVAL_RELEASED'))`) as Database.Statement<[TenantId,...unknown[]]>,status,errorCode,now,id);
  db.run(database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE message_parts SET text_content=?,kind='text' WHERE tenant_id=(SELECT id FROM tenant_scope) AND message_id=? AND ordinal=0`) as Database.Statement<[TenantId,...unknown[]]>,content,id);
}

function responseMessage(row:HeldRunRow,input:{id:string;parentMessageId:string;content:string;createdAt:number;modelId:string|null;provider:Message['provider'];inputTokens:number|null;outputTokens:number|null;costUsd:number|null;approvalId:string;decisionId:string;action:GateAction;direction?:'outbound'|'inbound';protectedItemCount?:number|null}):Message {
  return {id:input.id,conversationId:row.conversation_id,parentMessageId:input.parentMessageId,role:'assistant',content:input.content,modelId:input.modelId,provider:input.provider,createdAt:new Date(input.createdAt).toISOString(),inputTokens:input.inputTokens,outputTokens:input.outputTokens,costUsd:input.costUsd,gate:{decisionId:input.decisionId,action:input.action,direction:input.direction??'outbound',detectorCount:0,protectedItemCount:input.protectedItemCount??null,approvalId:input.approvalId,userNotice:null},attachments:[],version:1};
}

function finish(database:Database.Database,db:TenantDb,row:HeldRunRow,response:unknown,status:'completed'|'failed',now:number,userMessageId=row.user_message_id,assistantMessageId=row.assistant_message_id):void {
  db.run(database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE idempotency_records SET status=?,response_json=?,user_message_id=?,assistant_message_id=?,updated_at=?,completed_at=? WHERE tenant_id=(SELECT id FROM tenant_scope) AND id=?`) as Database.Statement<[TenantId,...unknown[]]>,status,JSON.stringify(response),userMessageId,assistantMessageId,now,now,row.id);
}

export function terminalApprovalRun(input:{database:Database.Database;db:TenantDb;tenantId:TenantId;requestingUserId:string;sourceMessageId:string;approvalId:string;gateDecisionId:string|null;errorCode:string;now:number;cancelled:boolean}):void {
  const content='Request was not released.',messageStatus=input.errorCode==='APPROVAL_RELEASE_INDETERMINATE'?'failed':'blocked';
  input.db.run(input.database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE messages SET status=?,error_code=?,policy_action='require_approval',completed_at=? WHERE tenant_id=(SELECT id FROM tenant_scope) AND approval_id=? AND role='assistant' AND status IN ('pending','streaming')`) as Database.Statement<[TenantId,...unknown[]]>,messageStatus,input.errorCode,input.now,input.approvalId);
  input.db.run(input.database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE message_parts SET text_content=?,kind='text' WHERE tenant_id=(SELECT id FROM tenant_scope) AND ordinal=0 AND message_id IN (SELECT id FROM messages WHERE tenant_id=(SELECT id FROM tenant_scope) AND approval_id=?)`) as Database.Statement<[TenantId,...unknown[]]>,content,input.approvalId);
  const row=input.db.get(heldRun(input.database),input.requestingUserId,input.sourceMessageId);if(!row)return;
  updateAssistant(input.database,input.db,row.assistant_message_id,messageStatus,input.errorCode,content,input.now);
  const assistant=responseMessage(row,{id:row.assistant_message_id,parentMessageId:row.user_message_id,content,createdAt:row.assistant_created_at,modelId:row.model_catalog_id,provider:row.provider_key,inputTokens:null,outputTokens:null,costUsd:null,approvalId:input.approvalId,decisionId:input.gateDecisionId??input.approvalId,action:'require_approval'});
  const run={id:row.run_id,conversationId:row.conversation_id,userMessageId:row.user_message_id,assistantMessageId:row.assistant_message_id,status:input.cancelled?'cancelled':'failed',streamUrl:`/api/v1/chat/runs/${row.run_id}/events`,createdAt:new Date(row.assistant_created_at).toISOString()};
  finish(input.database,input.db,row,{run,assistant},'failed',input.now);
}

export function completeApprovalRun(input:{database:Database.Database;db:TenantDb;tenantId:TenantId;requestingUserId:string;sourceMessageId:string;approvalId:string;decisionId:string;action:GateAction;protectedItemCount:number;releaseUserMessageId:string;releaseMessageId:string;content:string;createdAt:number;modelId:string;provider:Message['provider'];inputTokens:number;outputTokens:number;costMicrousd:number;now:number}):void {
  const row=input.db.get(heldRun(input.database),input.requestingUserId,input.sourceMessageId);if(!row)return;
  updateAssistant(input.database,input.db,row.assistant_message_id,'blocked','APPROVAL_RELEASED','Approved request released in a new message.',input.now);
  const assistant=responseMessage(row,{id:input.releaseMessageId,parentMessageId:input.releaseUserMessageId,content:input.content,createdAt:input.createdAt,modelId:input.modelId,provider:input.provider,inputTokens:input.inputTokens,outputTokens:input.outputTokens,costUsd:input.costMicrousd/1_000_000,approvalId:input.approvalId,decisionId:input.decisionId,action:input.action,direction:'inbound',protectedItemCount:input.protectedItemCount});
  const run={id:row.run_id,conversationId:row.conversation_id,userMessageId:input.releaseUserMessageId,assistantMessageId:input.releaseMessageId,status:'completed',streamUrl:`/api/v1/chat/runs/${row.run_id}/events`,createdAt:new Date(row.assistant_created_at).toISOString()};
  finish(input.database,input.db,row,{run,assistant},'completed',input.now,input.releaseUserMessageId,input.releaseMessageId);
}

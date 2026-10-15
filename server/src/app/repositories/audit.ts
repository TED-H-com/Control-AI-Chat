import type { AuditAction } from '../../lib/audit/audit-actions.js';
import type { AuditTransaction } from '../../lib/audit/index.js';
import type { JsonObject } from '../../lib/audit/audit-types.js';
import type { RepositoryContext } from './types.js';

export function recordRepositoryEvent(sink:AuditTransaction,c:RepositoryContext,action:AuditAction,target:{type:'conversation'|'project'|'skill';id:string},metadata:JsonObject,links:{projectId?:string|null;conversationId?:string|null}={}):void{
  sink.append({tenantId:c.principal.tenantId,action,actor:{type:'user',id:c.principal.userId,sessionId:c.principal.sessionId,ip:null,userAgent:null,authMethod:null},target,outcome:'success',context:{requestId:c.requestId,traceId:null,source:'http',occurredAtMs:c.now.getTime()},...links,metadata});
}

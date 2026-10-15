import type Database from 'better-sqlite3';
import type { AuditTransaction } from '../../lib/audit/index.js';
import type { RouteRequest, RouteResult } from '../../routes/types.js';
import { createDurableMutationIdempotency } from '../idempotency/mutation.js';
import { DraftError, type DraftInput, type DraftResult } from './draft-from-url.js';
import { SafeFetchError } from '../../lib/net/safe-fetch.js';

export function createAssistantDraftAdapter(deps:{
  database:Database.Database;
  audit:{transact<T>(work:(tx:AuditTransaction)=>T):T};
  hmacKey:Uint8Array;
  draftFromUrl:(input:DraftInput)=>Promise<DraftResult>;
  now?:()=>number;
}) {
  const idempotency=createDurableMutationIdempotency({database:deps.database,audit:deps.audit,hmacKey:deps.hmacKey,namespace:'assistant-draft-from-url',method:'POST',...(deps.now?{now:deps.now}:{})});
  return {
    async execute(operation:string,request:RouteRequest):Promise<RouteResult> {
      if(!request.tenant)return {status:401,body:{error:{code:'UNAUTHENTICATED',message:'Authentication required',requestId:request.requestId,retryable:false}}};
      const input=typeof request.body==='object'&&request.body!==null?request.body as Record<string,unknown>:{};
      if(typeof input.url!=='string'||!input.url.trim()||typeof input.modelCatalogId!=='string'||input.modelCatalogId.length!==36)
        return {status:422,body:{error:{code:'VALIDATION_FAILED',message:'A URL and model are required',requestId:request.requestId,retryable:false}}};
      const principal=request.tenant.principal;
      try{
        return await idempotency.executeDispatched(operation,request,async()=>{
          const draft=await deps.draftFromUrl({url:input.url as string,modelCatalogId:input.modelCatalogId as string,subject:{tenantId:principal.tenantId,userId:principal.userId,groupIds:[],roles:principal.roles},requestId:request.requestId});
          return()=>({status:200,body:draft});
        });
      }catch(error){
        if(error instanceof DraftError){
          if(error.code==='MODEL_NOT_ALLOWED')return {status:403,body:{error:{code:'DRAFT_FAILED',message:'The selected model is not available',requestId:request.requestId,retryable:false}}};
          return {status:422,body:{error:{code:'DRAFT_FAILED',message:'The assistant draft could not be created',requestId:request.requestId,retryable:false}}};
        }
        if(error instanceof SafeFetchError)return {status:422,body:{error:{code:'DRAFT_FAILED',message:'The source URL could not be used',requestId:request.requestId,retryable:false}}};
        throw error;
      }
    },
  };
}

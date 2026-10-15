import type {MiddlewareHandler} from 'hono';
import type {AuditService} from '../audit/index.js';
import {GovernanceError} from '../governance/errors.js';
import type {RateLimitPolicy,StreamLease} from '../governance/types.js';
import type {AppVariables} from '../http/index.js';

export interface GovernanceRateLimiter {
  effectivePolicy(tenantId:string,userId:string,groupIds:readonly string[]):RateLimitPolicy;
  consumeRequest(tenantId:string,userId:string,policy:RateLimitPolicy,now:number):{allowed:boolean;remainingWholeTokens:number;retryAfterMs:number;limit:number};
  acquireStream(tenantId:string,userId:string,reservationId:string,policy:RateLimitPolicy,now:number):StreamLease;
  heartbeat(leaseId:string,now:number):StreamLease;
  releaseStream(leaseId:string,now:number):void;
}

export function governanceRateLimit(limiter:GovernanceRateLimiter,audit?:Pick<AuditService,'append'>):MiddlewareHandler<{Variables:AppVariables}>{
  return async(c,next)=>{
    const principal=c.get('principal');if(!principal)return next();
    const policy=limiter.effectivePolicy(principal.tenantId,principal.userId,[]),decision=limiter.consumeRequest(principal.tenantId,principal.userId,policy,Date.now());
    const actor={type:'user' as const,id:principal.userId,sessionId:principal.sessionId,ip:c.get('verifiedClientIp')??null,userAgent:c.req.header('User-Agent')??null,authMethod:null};
    if(!decision.allowed){
      audit?.append({tenantId:principal.tenantId,action:'billing.rate_limit_denied',actor,target:{type:'user',id:principal.userId},outcome:'denied',context:{requestId:c.get('requestId'),traceId:null,source:'http'},subjectUserId:principal.userId,metadata:{limitKind:'requests',limit:decision.limit,windowSeconds:60,retryAfterMs:decision.retryAfterMs}});
      return c.json({error:{code:'RATE_LIMITED',message:'Request rate limit exceeded',retryable:true}},429,{'Retry-After':String(Math.max(1,Math.ceil(decision.retryAfterMs/1000))),'X-RateLimit-Limit':String(decision.limit),'X-RateLimit-Remaining':'0'});
    }
    c.header('X-RateLimit-Limit',String(decision.limit));c.header('X-RateLimit-Remaining',String(decision.remainingWholeTokens));
    let lease:StreamLease|null=null;
    if(isSseRoute(c.req.method,c.req.path)){
      try{lease=limiter.acquireStream(principal.tenantId,principal.userId,c.get('requestId')||crypto.randomUUID(),policy,Date.now())}
      catch(error){
        const active=error instanceof GovernanceError&&typeof error.details.active==='number'?error.details.active:null;
        audit?.append({tenantId:principal.tenantId,action:'billing.concurrent_stream_denied',actor,target:{type:'user',id:principal.userId},outcome:'denied',context:{requestId:c.get('requestId'),traceId:null,source:'http'},subjectUserId:principal.userId,metadata:{limit:policy.concurrentStreams,...(active===null?{}:{active})}});
        return c.json({error:{code:'CONCURRENT_STREAM_LIMIT',message:'Concurrent stream limit reached',retryable:true}},429,{'Retry-After':'30'});
      }
    }
    try{await next()}catch(error){if(lease)limiter.releaseStream(lease.id,Date.now());throw error}
    if(lease)c.res=leaseResponse(c.res,lease,limiter);
  };
}

function isSseRoute(method:string,path:string):boolean{return(method==='POST'&&/\/chat\/runs(?:\/regenerate|\/edit-resend)?$/.test(path))||(method==='GET'&&/\/chat\/runs\/[^/]+\/events$/.test(path))}
function leaseResponse(response:Response,lease:StreamLease,limiter:GovernanceRateLimiter):Response{if(!response.body){limiter.releaseStream(lease.id,Date.now());return response}const reader=response.body.getReader();let released=false,lastHeartbeat=Date.now();const release=():void=>{if(!released){released=true;limiter.releaseStream(lease.id,Date.now())}};const body=new ReadableStream<Uint8Array>({async pull(controller){try{const item=await reader.read();if(item.done){release();controller.close()}else{const now=Date.now();if(now-lastHeartbeat>=10_000){limiter.heartbeat(lease.id,now);lastHeartbeat=now}controller.enqueue(item.value)}}catch(error){release();controller.error(error)}},async cancel(reason){release();await reader.cancel(reason)}});return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers})}

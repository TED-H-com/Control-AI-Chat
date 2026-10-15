import type {MiddlewareHandler} from 'hono';
import type {AppVariables} from '../http/index.js';
import {apiError} from '../http/index.js';

const DEFAULT_LIMIT=30,DEFAULT_WINDOW_MS=60_000,DEFAULT_MAX_ENTRIES=10_000;
interface Bucket {windowId:number;count:number}
export interface PublicLoginRateDecision {allowed:boolean;limit:number;remaining:number;retryAfterSeconds:number}
export interface PublicLoginIpLimiterOptions {limit?:number;windowMs?:number;maxEntries?:number}

/**
 * A process-local admission guard for the unauthenticated password/MFA entry point. Buckets use the
 * address already authenticated at the socket/proxy boundary; this class never reads forwarding
 * headers, writes a database row, or logs an address.
 *
 * Windows are globally aligned, so crossing a boundary can clear every old entry at once. Once the
 * bounded map is full, unseen addresses share one overflow bucket instead of allocating memory or
 * evicting an active bucket that an attacker could then reuse.
 */
export class PublicLoginIpLimiter {
 readonly #limit:number;readonly #windowMs:number;readonly #maxEntries:number;
 readonly #buckets=new Map<string,Bucket>();#overflow:Bucket|null=null;#windowId:number|null=null;
 constructor(options:PublicLoginIpLimiterOptions={}){
  this.#limit=positiveInteger(options.limit??DEFAULT_LIMIT,'limit');
  this.#windowMs=positiveInteger(options.windowMs??DEFAULT_WINDOW_MS,'windowMs');
  this.#maxEntries=positiveInteger(options.maxEntries??DEFAULT_MAX_ENTRIES,'maxEntries');
 }
 get trackedEntries():number{return this.#buckets.size;}
 consume(address:string|undefined,nowMs=Date.now()):PublicLoginRateDecision{
  const windowId=Math.floor(nowMs/this.#windowMs);
  if(windowId!==this.#windowId){this.#buckets.clear();this.#overflow=null;this.#windowId=windowId;}
  const key=address?.trim()||'unknown';let bucket=this.#buckets.get(key);
  if(!bucket){
   if(this.#buckets.size<this.#maxEntries){bucket={windowId,count:0};this.#buckets.set(key,bucket);}
   else{this.#overflow??={windowId,count:0};bucket=this.#overflow;}
  }
  bucket.count++;
  return{allowed:bucket.count<=this.#limit,limit:this.#limit,remaining:Math.max(0,this.#limit-bucket.count),retryAfterSeconds:Math.max(1,Math.ceil(((windowId+1)*this.#windowMs-nowMs)/1000))};
 }
}

export function publicLoginRateLimit(input:{limiter?:PublicLoginIpLimiter;now?:()=>number;path?:string}={}):MiddlewareHandler<{Variables:AppVariables}>{
 const limiter=input.limiter??new PublicLoginIpLimiter(),clock=input.now??Date.now;
 return async(c,next)=>{
  if(c.req.method!=='POST'||c.req.path!==(input.path??'/api/v1/auth/login'))return next();
  const decision=limiter.consume(c.get('verifiedClientIp'),clock());
  c.header('X-RateLimit-Limit',String(decision.limit));c.header('X-RateLimit-Remaining',String(decision.remaining));
  if(!decision.allowed){
   c.header('Retry-After',String(decision.retryAfterSeconds));c.header('X-API-Version','1');
   return apiError(c,429,'RATE_LIMITED','Request rate limit exceeded',{retryable:true});
  }
  await next();
 };
}

function positiveInteger(value:number,name:string):number{if(!Number.isSafeInteger(value)||value<1)throw new RangeError(`${name} must be a positive integer`);return value;}

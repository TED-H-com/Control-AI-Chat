import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { AuditTransaction } from '../../lib/audit/index.js';
import type { ErrorCode, TenantId } from '../../shared/types.js';
import type { RouteRequest, RouteResult } from '../../routes/types.js';
import { CRYPTO_NAMESPACE } from '../../shared/crypto.js';

interface IdempotencyRow { request_sha256:string; status:string; response_json:string|null; updated_at:number }
interface CachedMutation { status:number|null; body?:unknown; headers?:Readonly<Record<string,string>> }
interface EncryptedCachedMutation { version:1; algorithm:'A256GCM'; nonce:string; ciphertext:string }
interface ReplayBinding { tenantId:TenantId; actorUserId:string; method:string; path:string; idempotencyKey:string; requestFingerprint:string }

export class MutationIdempotencyError extends Error {
  constructor(readonly status:number,readonly code:ErrorCode,message:string){super(message);this.name='MutationIdempotencyError';}
}

export interface DurableMutationIdempotency<Transaction=AuditTransaction> {
  execute(operation:string,request:RouteRequest,work:(tx:Transaction,nowMs:number)=>RouteResult):RouteResult;
  /** Prepare outside SQL; commit state and a successful receipt atomically. Other instances may prepare again. */
  executePrepared(operation:string,request:RouteRequest,prepare:()=>Promise<(tx:Transaction,nowMs:number)=>RouteResult>):Promise<RouteResult>;
  /** Claim the key before prepare so another instance cannot start a second dispatch. A crash before completion may re-dispatch after the claim TTL. */
  executeDispatched(operation:string,request:RouteRequest,prepare:()=>Promise<(tx:Transaction,nowMs:number)=>RouteResult>):Promise<RouteResult>;
  /** Work can race and run more than once; use only for side-effect-free calculations. */
  executeSideEffectFree(operation:string,request:RouteRequest,work:()=>Promise<RouteResult>):Promise<RouteResult>;
}

export function createDurableMutationIdempotency<Transaction=AuditTransaction>(deps:{
  database:Database.Database;
  audit:{transact<T>(work:(tx:Transaction)=>T):T};
  hmacKey:Uint8Array;
  /** Encrypt cached responses that contain one-time credentials. */
  responseEncryptionKey?:Uint8Array;
  namespace:string;
  method?:string;
  now?:()=>number;
  claimTtlMs?:number;
  /** Store a replay-safe projection when the first response contains an ephemeral secret. */
  cacheResult?:(result:RouteResult)=>RouteResult;
}):DurableMutationIdempotency<Transaction> {
  if(deps.hmacKey.byteLength!==32)throw new TypeError('Mutation idempotency HMAC key must be 32 bytes');
  if(deps.responseEncryptionKey!==undefined&&deps.responseEncryptionKey.byteLength!==32)throw new TypeError('Mutation idempotency response encryption key must be 32 bytes');
  if(!/^[a-z][a-z0-9-]{0,79}$/u.test(deps.namespace))throw new TypeError('Mutation idempotency namespace is invalid');
  const method=deps.method??'POST';
  if(!/^[A-Z]{1,12}$/u.test(method))throw new TypeError('Mutation idempotency method is invalid');
  const claimTtlMs=deps.claimTtlMs??120_000;
  if(!Number.isFinite(claimTtlMs)||claimTtlMs<1)throw new TypeError('Mutation idempotency claim TTL is invalid');
  const hmacKey=Buffer.from(deps.hmacKey),responseEncryptionKey=deps.responseEncryptionKey===undefined?null:Buffer.from(deps.responseEncryptionKey),now=deps.now??Date.now;
  const inFlight=new Map<string,{fingerprint:string;result:Promise<RouteResult>}>();
  const select=deps.database.prepare(`SELECT request_sha256,status,response_json,updated_at FROM idempotency_records
    WHERE tenant_id=? AND actor_user_id=? AND method=? AND path=? AND idempotency_key=?`) as Database.Statement<[TenantId,...unknown[]],IdempotencyRow>;
  const insert=deps.database.prepare(`INSERT INTO idempotency_records(
    tenant_id,id,actor_user_id,method,path,idempotency_key,request_sha256,status,response_json,created_at,updated_at,completed_at
  ) VALUES(?,?,?,?,?,?,?,'completed',?,?,?,?)`) as Database.Statement<[TenantId,...unknown[]]>;
  const insertClaim=deps.database.prepare(`INSERT INTO idempotency_records(
    tenant_id,id,actor_user_id,method,path,idempotency_key,request_sha256,status,response_json,created_at,updated_at,completed_at
  ) VALUES(?,?,?,?,?,?,?,'claimed',NULL,?,?,NULL)`) as Database.Statement<[TenantId,...unknown[]]>;
  const complete=deps.database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE idempotency_records
    SET status='completed',response_json=?,updated_at=?,completed_at=?
    WHERE tenant_id=(SELECT id FROM tenant_scope) AND actor_user_id=? AND method=? AND path=? AND idempotency_key=? AND status='claimed' AND response_json IS NULL`) as Database.Statement<[TenantId,...unknown[]]>;
  const reclaim=deps.database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) UPDATE idempotency_records
    SET updated_at=?
    WHERE tenant_id=(SELECT id FROM tenant_scope) AND actor_user_id=? AND method=? AND path=? AND idempotency_key=? AND status='claimed' AND response_json IS NULL AND updated_at<=?`) as Database.Statement<[TenantId,...unknown[]]>;
  const drop=deps.database.prepare(`WITH tenant_scope(id) AS (VALUES (?)) DELETE FROM idempotency_records
    WHERE tenant_id=(SELECT id FROM tenant_scope) AND actor_user_id=? AND method=? AND path=? AND idempotency_key=? AND status='claimed' AND response_json IS NULL`) as Database.Statement<[TenantId,...unknown[]]>;

  const requestState=(operation:string,request:RouteRequest)=>{
    const tenant=request.tenant;
    if(!tenant)throw new MutationIdempotencyError(401,'UNAUTHENTICATED','Authentication required');
    if(!/^[A-Za-z][A-Za-z0-9.:-]{0,159}$/u.test(operation))throw new TypeError('Mutation idempotency operation is invalid');
    const key=idempotencyKey(request.headers.get('Idempotency-Key')),path=`${deps.namespace}:${operation}`;
    const fingerprint=createHmac('sha256',hmacKey)
      .update(`${CRYPTO_NAMESPACE}:durable-mutation-request:v1\0`)
      .update(stableJson({tenantId:tenant.principal.tenantId,actorUserId:tenant.principal.userId,method,namespace:deps.namespace,operation,params:request.params,query:request.query,ifMatch:request.headers.get('If-Match'),body:request.body}))
      .digest('hex');
    const binding:ReplayBinding={tenantId:tenant.principal.tenantId,actorUserId:tenant.principal.userId,method,path,idempotencyKey:key,requestFingerprint:fingerprint};
    return {tenant,key,path,fingerprint,binding};
  };
  const replay=(existing:IdempotencyRow,fingerprint:string,binding:ReplayBinding):RouteResult=>{
    if(existing.request_sha256!==fingerprint)throw new MutationIdempotencyError(409,'IDEMPOTENCY_CONFLICT','Idempotency-Key was already used with a different request');
    if(existing.status!=='completed'||existing.response_json===null)throw new MutationIdempotencyError(409,'CONFLICT','The original idempotent request has not completed');
    return responseEncryptionKey===null
      ? cachedMutation(existing.response_json)
      : decryptCachedMutation(existing.response_json,responseEncryptionKey,binding);
  };
  const serialized=(result:RouteResult,binding:ReplayBinding):string=>{
    const replayResult=deps.cacheResult?.(result)??result;
    const cached:CachedMutation={status:replayResult.status??null,...(replayResult.body===undefined?{}:{body:replayResult.body}),...(responseEncryptionKey===null||result.headers===undefined?{}:{headers:result.headers})};
    return responseEncryptionKey===null?JSON.stringify(cached):encryptCachedMutation(cached,responseEncryptionKey,binding);
  };

  return {execute(operation,request,work){
    const state=requestState(operation,request);
    return deps.audit.transact(tx=>{
      const existing=state.tenant.db.get(select,state.tenant.principal.userId,method,state.path,state.key);
      if(existing)return replay(existing,state.fingerprint,state.binding);
      const at=now();
      const result=work(tx,at),status=result.status??200;
      if(status>=200&&status<300){
        state.tenant.db.run(insert,randomUUID(),state.tenant.principal.userId,method,state.path,state.key,state.fingerprint,serialized(result,state.binding),at,at,at);
      }
      return result;
    });
  },async executePrepared(operation,request,prepare){
    const state=requestState(operation,request),existing=state.tenant.db.get(select,state.tenant.principal.userId,method,state.path,state.key);
    if(existing)return replay(existing,state.fingerprint,state.binding);
    const key=JSON.stringify([state.tenant.principal.tenantId,state.tenant.principal.userId,method,state.path,state.key]);
    const pending=inFlight.get(key);
    if(pending){
      if(pending.fingerprint!==state.fingerprint)throw new MutationIdempotencyError(409,'IDEMPOTENCY_CONFLICT','Idempotency-Key was already used with a different request');
      return pending.result;
    }
    const result=(async()=>{
      const commit=await prepare();
      return deps.audit.transact(tx=>{
        const raced=state.tenant.db.get(select,state.tenant.principal.userId,method,state.path,state.key);
        if(raced)return replay(raced,state.fingerprint,state.binding);
        const at=now(),result=commit(tx,at),status=result.status??200;
        if(status>=200&&status<300)state.tenant.db.run(insert,randomUUID(),state.tenant.principal.userId,method,state.path,state.key,state.fingerprint,serialized(result,state.binding),at,at,at);
        return result;
      });
    })();
    inFlight.set(key,{fingerprint:state.fingerprint,result});
    try{return await result}finally{inFlight.delete(key)}
  },async executeDispatched(operation,request,prepare){
    const state=requestState(operation,request);
    const inflightKey=JSON.stringify([state.tenant.principal.tenantId,state.tenant.principal.userId,method,state.path,state.key]);
    const pending=inFlight.get(inflightKey);
    if(pending){
      if(pending.fingerprint!==state.fingerprint)throw new MutationIdempotencyError(409,'IDEMPOTENCY_CONFLICT','Idempotency-Key was already used with a different request');
      return pending.result;
    }
    const existing=state.tenant.db.get(select,state.tenant.principal.userId,method,state.path,state.key);
    if(existing?.status==='completed')return replay(existing,state.fingerprint,state.binding);
    const result=(async()=>{
      type Claim={kind:'replay';result:RouteResult}|{kind:'claimed'};
      let claimed:Claim;
      try{
        claimed=deps.audit.transact(()=>{
          const raced=state.tenant.db.get(select,state.tenant.principal.userId,method,state.path,state.key);
          if(raced){
            if(raced.status==='completed')return {kind:'replay',result:replay(raced,state.fingerprint,state.binding)};
            if(raced.request_sha256!==state.fingerprint)throw new MutationIdempotencyError(409,'IDEMPOTENCY_CONFLICT','Idempotency-Key was already used with a different request');
            const at=now();
            if(raced.status==='claimed'&&raced.response_json===null&&raced.updated_at<=at-claimTtlMs){
              const taken=state.tenant.db.run(reclaim,at,state.tenant.principal.userId,method,state.path,state.key,at-claimTtlMs);
              if(taken.changes!==1)throw new MutationIdempotencyError(409,'CONFLICT','The original idempotent request has not completed');
              return {kind:'claimed'};
            }
            throw new MutationIdempotencyError(409,'CONFLICT','The original idempotent request has not completed');
          }
          const at=now();
          state.tenant.db.run(insertClaim,randomUUID(),state.tenant.principal.userId,method,state.path,state.key,state.fingerprint,at,at);
          return {kind:'claimed'};
        });
      }catch(error){
        if(!uniqueConstraint(error))throw error;
        const raced=state.tenant.db.get(select,state.tenant.principal.userId,method,state.path,state.key);
        if(raced?.status==='completed')return replay(raced,state.fingerprint,state.binding);
        if(raced&&raced.request_sha256!==state.fingerprint)throw new MutationIdempotencyError(409,'IDEMPOTENCY_CONFLICT','Idempotency-Key was already used with a different request');
        throw new MutationIdempotencyError(409,'CONFLICT','The original idempotent request has not completed');
      }
      if(claimed.kind==='replay')return claimed.result;
      try{
        const commit=await prepare();
        return deps.audit.transact(tx=>{
          const raced=state.tenant.db.get(select,state.tenant.principal.userId,method,state.path,state.key);
          if(raced?.status==='completed')return replay(raced,state.fingerprint,state.binding);
          const at=now(),result=commit(tx,at),status=result.status??200;
          if(status>=200&&status<300){
            const stored=state.tenant.db.run(complete,serialized(result,state.binding),at,at,state.tenant.principal.userId,method,state.path,state.key);
            if(stored.changes!==1){
              const finished=state.tenant.db.get(select,state.tenant.principal.userId,method,state.path,state.key);
              if(finished?.status==='completed')return replay(finished,state.fingerprint,state.binding);
              throw new MutationIdempotencyError(409,'CONFLICT','The original idempotent request has not completed');
            }
          }else state.tenant.db.run(drop,state.tenant.principal.userId,method,state.path,state.key);
          return result;
        });
      }catch(error){
        try{deps.audit.transact(()=>{state.tenant.db.run(drop,state.tenant.principal.userId,method,state.path,state.key)})}catch{/* claim may already be gone */}
        throw error;
      }
    })();
    inFlight.set(inflightKey,{fingerprint:state.fingerprint,result});
    try{return await result}finally{inFlight.delete(inflightKey)}
  },async executeSideEffectFree(operation,request,work){
    const state=requestState(operation,request),at=now(),existing=state.tenant.db.get(select,state.tenant.principal.userId,method,state.path,state.key);
    if(existing)return replay(existing,state.fingerprint,state.binding);
    const result=await work(),status=result.status??200;
    if(status<200||status>=300)return result;
    return deps.audit.transact(()=>{
      const raced=state.tenant.db.get(select,state.tenant.principal.userId,method,state.path,state.key);
      if(raced)return replay(raced,state.fingerprint,state.binding);
      state.tenant.db.run(insert,randomUUID(),state.tenant.principal.userId,method,state.path,state.key,state.fingerprint,serialized(result,state.binding),at,at,at);
      return result;
    });
  }};
}

function uniqueConstraint(error:unknown):boolean {
  return typeof error==='object'&&error!==null&&'code' in error&&(error as {code:unknown}).code==='SQLITE_CONSTRAINT_UNIQUE';
}

function idempotencyKey(value:string|null):string {
  if(value===null||value.length<1||value.length>128||!/^[\x21-\x7e]+$/u.test(value))
    throw new MutationIdempotencyError(400,'INVALID_REQUEST','Idempotency-Key must contain 1..128 visible ASCII characters');
  return value;
}

function cachedMutation(value:string):RouteResult {
  let parsed:unknown;
  try{parsed=JSON.parse(value);}catch{throw new MutationIdempotencyError(409,'CONFLICT','The original idempotent response is unavailable');}
  if(typeof parsed!=='object'||parsed===null||Array.isArray(parsed))throw new MutationIdempotencyError(409,'CONFLICT','The original idempotent response is unavailable');
  const cached=parsed as Partial<CachedMutation>;
  if(cached.status!==null&&(typeof cached.status!=='number'||!Number.isInteger(cached.status)||cached.status<200||cached.status>299))
    throw new MutationIdempotencyError(409,'CONFLICT','The original idempotent response is unavailable');
  if(cached.headers!==undefined&&!validHeaders(cached.headers))throw new MutationIdempotencyError(409,'CONFLICT','The original idempotent response is unavailable');
  return {...(cached.status===null?{}:{status:cached.status}),...(Object.hasOwn(cached,'body')?{body:cached.body}:{}),...(cached.headers===undefined?{}:{headers:{...cached.headers}})};
}

function encryptCachedMutation(cached:CachedMutation,key:Buffer,binding:ReplayBinding):string {
  const nonce=randomBytes(12),plaintext=Buffer.from(JSON.stringify(cached),'utf8');
  try {
    const cipher=createCipheriv('aes-256-gcm',key,nonce);
    cipher.setAAD(replayAad(binding));
    const ciphertext=Buffer.concat([cipher.update(plaintext),cipher.final(),cipher.getAuthTag()]);
    const envelope:EncryptedCachedMutation={version:1,algorithm:'A256GCM',nonce:nonce.toString('base64url'),ciphertext:ciphertext.toString('base64url')};
    return JSON.stringify(envelope);
  } finally { plaintext.fill(0); }
}

function decryptCachedMutation(value:string,key:Buffer,binding:ReplayBinding):RouteResult {
  let plaintext:Buffer|undefined;
  try {
    const parsed=JSON.parse(value) as unknown;
    if(!encryptedCachedMutation(parsed))throw new Error('Invalid encrypted idempotency response');
    const nonce=base64url(parsed.nonce),sealed=base64url(parsed.ciphertext);
    if(nonce.byteLength!==12||sealed.byteLength<=16)throw new Error('Invalid encrypted idempotency response');
    const ciphertext=sealed.subarray(0,sealed.byteLength-16),tag=sealed.subarray(sealed.byteLength-16);
    const decipher=createDecipheriv('aes-256-gcm',key,nonce);
    decipher.setAAD(replayAad(binding));decipher.setAuthTag(tag);
    plaintext=Buffer.concat([decipher.update(ciphertext),decipher.final()]);
    return cachedMutation(plaintext.toString('utf8'));
  } catch {
    throw new MutationIdempotencyError(409,'CONFLICT','The original idempotent response is unavailable');
  } finally { plaintext?.fill(0); }
}

function replayAad(binding:ReplayBinding):Buffer {
  // A copied envelope must not open under any other claim, caller, or request body.
  return Buffer.from(`${CRYPTO_NAMESPACE}:durable-mutation-response:v1\0${stableJson(binding)}`,'utf8');
}

function encryptedCachedMutation(value:unknown):value is EncryptedCachedMutation {
  if(typeof value!=='object'||value===null||Array.isArray(value))return false;
  const row=value as Partial<EncryptedCachedMutation>;
  return row.version===1&&row.algorithm==='A256GCM'&&typeof row.nonce==='string'&&typeof row.ciphertext==='string';
}

function base64url(value:string):Buffer {
  if(!/^[A-Za-z0-9_-]+$/u.test(value))throw new Error('Invalid base64url');
  const decoded=Buffer.from(value,'base64url');
  if(decoded.toString('base64url')!==value)throw new Error('Invalid base64url');
  return decoded;
}

function validHeaders(value:unknown):value is Readonly<Record<string,string>> {
  if(typeof value!=='object'||value===null||Array.isArray(value))return false;
  return Object.entries(value).every(([name,header])=>/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name)&&typeof header==='string'&&!/[\r\n]/u.test(header));
}

function stableJson(value:unknown):string {
  const active=new Set<object>();
  const visit=(item:unknown):string=>{
    if(item===null)return'null';
    if(typeof item==='string'||typeof item==='boolean')return JSON.stringify(item);
    if(typeof item==='number'){
      if(!Number.isFinite(item))throw new TypeError('Idempotency request contains a non-finite number');
      return JSON.stringify(item);
    }
    if(Array.isArray(item)){
      if(active.has(item))throw new TypeError('Idempotency request cannot be cyclic');
      active.add(item);const result=`[${item.map(visit).join(',')}]`;active.delete(item);return result;
    }
    if(typeof item==='object'){
      if(active.has(item))throw new TypeError('Idempotency request cannot be cyclic');
      active.add(item);const row=item as Record<string,unknown>,keys=Object.keys(row).filter(key=>row[key]!==undefined).sort();
      const result=`{${keys.map(key=>`${JSON.stringify(key)}:${visit(row[key])}`).join(',')}}`;active.delete(item);return result;
    }
    throw new TypeError('Idempotency request must be JSON-compatible');
  };
  return visit(value);
}

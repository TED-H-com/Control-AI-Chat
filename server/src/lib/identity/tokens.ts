import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { AccessTokenClaims, AuthMethod, TenantRole } from './types.js';
import { IdentityError } from './types.js';
import { CRYPTO_NAMESPACE } from '../../shared/crypto.js';
export const ACCESS_TOKEN_AUDIENCE=`${CRYPTO_NAMESPACE}:api:v1` as const;
const configuredIssuer=():string=>(process.env.APP_ORIGIN?.trim()||'http://localhost:5173').replace(/\/$/,'');
const b64=(value:string|Buffer):string=>Buffer.from(value).toString('base64url');
export const digestToken=(token:string):string=>createHash('sha256').update(token).digest('hex');
export const randomOpaqueToken=(bytes=32):string=>randomBytes(bytes).toString('base64url');
export interface IssueAccessInput {userId:string;sessionId:string;tenantId:string;role:TenantRole;authMethods:readonly AuthMethod[];mfa:boolean;sessionVersion:number;now?:number;ttlSeconds?:number}
export function issueAccessToken(input:IssueAccessInput,secret:string,issuer=configuredIssuer()):{token:string;claims:AccessTokenClaims} {
  if (Buffer.byteLength(secret)<32) throw new IdentityError('JWT_KEY_INVALID','JWT signing secret must be at least 32 bytes');
  const now=input.now??Math.floor(Date.now()/1000); const claims:AccessTokenClaims={iss:issuer.replace(/\/$/,''),aud:ACCESS_TOKEN_AUDIENCE,sub:input.userId,sid:input.sessionId,tid:input.tenantId,role:input.role,amr:input.authMethods,mfa:input.mfa,sv:input.sessionVersion,jti:randomUUID(),iat:now,nbf:now-5,exp:now+(input.ttlSeconds??600)};
  const head=b64(JSON.stringify({alg:'HS256',typ:'JWT'})); const body=b64(JSON.stringify(claims));
  return {token:`${head}.${body}.${createHmac('sha256',secret).update(`${head}.${body}`).digest('base64url')}`,claims};
}
function isClaims(value:unknown,issuer:string):value is AccessTokenClaims { if (!value||typeof value!=='object') return false; const v=value as Record<string,unknown>;
  return v.iss===issuer.replace(/\/$/,'')&&v.aud===ACCESS_TOKEN_AUDIENCE&&typeof v.sub==='string'&&typeof v.sid==='string'&&typeof v.tid==='string'&&typeof v.jti==='string'&&typeof v.exp==='number'&&typeof v.nbf==='number'&&typeof v.sv==='number'&&typeof v.mfa==='boolean'&&Array.isArray(v.amr); }
export function verifyAccessToken(token:string,secret:string,now=Math.floor(Date.now()/1000),issuer=configuredIssuer()):AccessTokenClaims {
  const parts=token.split('.'); if(parts.length!==3) throw new IdentityError('SESSION_EXPIRED','Invalid access token');
  const [head,body,signature]=parts as [string,string,string]; let header:unknown; let claims:unknown;
  try { header=JSON.parse(Buffer.from(head,'base64url').toString()); claims=JSON.parse(Buffer.from(body,'base64url').toString()); } catch { throw new IdentityError('SESSION_EXPIRED','Invalid access token'); }
  if (!header||typeof header!=='object'||(header as Record<string,unknown>).alg!=='HS256') throw new IdentityError('SESSION_EXPIRED','Invalid access token algorithm');
  const expected=createHmac('sha256',secret).update(`${head}.${body}`).digest(); const actual=Buffer.from(signature,'base64url');
  if(actual.length!==expected.length||!timingSafeEqual(actual,expected)||!isClaims(claims,issuer)||claims.nbf>now+30||claims.exp<=now) throw new IdentityError('SESSION_EXPIRED','Access token expired or invalid');
  return claims;
}

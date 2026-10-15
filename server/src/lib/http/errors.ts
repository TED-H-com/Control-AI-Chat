import type { Context } from 'hono';
import type { ApiError, ErrorCode, FieldViolation } from '../../shared/types.js';

export function errorEnvelope(code:ErrorCode, message:string, requestId:string, options?:{
  retryable?:boolean; details?:Readonly<Record<string,unknown>>; validation?:readonly FieldViolation[];
}): ApiError {
  return { error: { code, message, requestId, retryable: options?.retryable ?? false,
    ...(options?.details ? {details:options.details} : {}),
    ...(options?.validation ? {validation:options.validation} : {}) } };
}

/**
 * What to tell a caller about an error that reached the top of the stack with a `code` on it.
 *
 * A SQLite constraint code is not an API error code, and passing one through did two things at once:
 * it answered 500 for what is an ordinary conflict — inviting the same person twice, adding a model
 * already in the catalog, creating a budget for a period that already has one — and it disclosed that
 * the schema has a unique index, with the thrown message naming the columns. Both were live on every
 * admin create screen in production, which is why the message is replaced and not only the code.
 *
 * Only codes in the public contract pass through. Internal aliases are normalized, and an unknown
 * library/operating-system code becomes INTERNAL_ERROR rather than leaking a second, undocumented
 * error vocabulary to clients.
 */
export function classifyThrownError(raw:string): {code:ErrorCode; message:string|null} {
  switch (raw) {
    case 'SQLITE_CONSTRAINT_UNIQUE':
    case 'SQLITE_CONSTRAINT_PRIMARYKEY': return {code:'CONFLICT',message:'That already exists'};
    case 'SQLITE_CONSTRAINT_FOREIGNKEY': return {code:'VALIDATION_FAILED',message:'That refers to something which does not exist'};
    case 'NOT_FOUND': return {code:'RESOURCE_NOT_FOUND',message:null};
    case 'CONTEXT_WINDOW_EXCEEDED': return {code:'VALIDATION_FAILED',message:null};
    case 'AUDIT_UNAVAILABLE':
    case 'DNS_UNAVAILABLE': return {code:'SERVICE_UNAVAILABLE',message:null};
    case 'DEPENDENCY_MISSING':
    case 'ENCRYPTION_KEY_MISSING': return {code:'SERVICE_UNAVAILABLE',message:'Service is temporarily unavailable'};
    case 'ENCRYPTION_KEY_INVALID':
    case 'JWT_KEY_INVALID': return {code:'INTERNAL_ERROR',message:null};
    default: return Object.hasOwn(REQUEST_ERROR_STATUSES,raw)
      ? {code:raw as ErrorCode,message:null}
      : {code:'INTERNAL_ERROR',message:null};
  }
}

export type RequestErrorStatus=400|401|403|404|409|412|413|422|428|429|500|501|503;

const REQUEST_ERROR_STATUSES={
  INVALID_REQUEST:422,VALIDATION_FAILED:422,INVALID_CREDENTIALS:401,PASSWORD_POLICY_FAILED:422,CREDENTIAL_LINK_INVALID:422,
  UNAUTHENTICATED:401,SESSION_EXPIRED:401,CSRF_FAILED:403,CSRF_REJECTED:403,FORBIDDEN:403,
  RESOURCE_NOT_FOUND:404,CONFLICT:409,IDEMPOTENCY_CONFLICT:409,PRECONDITION_REQUIRED:428,PRECONDITION_FAILED:412,
  RATE_LIMITED:429,STREAM_LIMIT_REACHED:429,CONCURRENT_STREAM_LIMIT:429,BUDGET_SOFT_LIMIT:429,BUDGET_HARD_LIMIT:429,
  MODEL_NOT_ALLOWED:403,PROVIDER_UNAVAILABLE:503,GATE_BLOCKED:403,GATE_CONFIRMATION_REQUIRED:409,
  APPROVAL_REQUIRED:409,APPROVAL_EXPIRED:409,FILE_TOO_LARGE:413,PAYLOAD_TOO_LARGE:413,FILE_TYPE_NOT_ALLOWED:422,
  FILE_SCAN_FAILED:422,FILE_NOT_READY:409,MFA_REQUIRED:403,MFA_INVALID:400,EMAIL_NOT_VERIFIED:403,
  EXPORT_TOO_LARGE:413,DRAFT_FAILED:422,NOT_IMPLEMENTED:501,
  INTERNAL_ERROR:500,SERVICE_UNAVAILABLE:503,
} as const satisfies Record<ErrorCode,RequestErrorStatus>;

/** One status map for errors that escape route services into Hono's top-level boundary. */
export function requestErrorStatus(code:ErrorCode):RequestErrorStatus {return REQUEST_ERROR_STATUSES[code];}

/** Fail closed without disclosing an internal exception; correlate operator logs by request ID. */
export function handleRequestError(error:Error,c:Context):Response {
  const {code,message:generic}=classifyThrownError('code' in error&&typeof error.code==='string'?error.code:'INTERNAL_ERROR');
  const status=requestErrorStatus(code),requestId=(c.get('requestId') as string|undefined)||crypto.randomUUID();
  if(status>=500)console.error('Unhandled request failure',{requestId,method:c.req.method,path:c.req.path,code,error});
  const retryable=code!=='INTERNAL_ERROR'&&'retryable' in error&&error.retryable===true;
  const details='details' in error&&error.details&&typeof error.details==='object'&&!Array.isArray(error.details)
    ? error.details as Readonly<Record<string,unknown>>:undefined;
  const response=c.json(errorEnvelope(code,status===500?'Internal server error':generic??error.message,requestId,{retryable,...(details?{details}:{})}),status);
  response.headers.set('X-Request-Id',requestId);
  if(c.req.path.startsWith('/api/'))response.headers.set('X-API-Version','1');
  return response;
}

export function apiError(c:Context, status:400|401|403|404|409|412|422|428|429|500|503,
  code:ErrorCode, message:string, options?:Parameters<typeof errorEnvelope>[3]): Response {
  const requestId = c.get('requestId') as string | undefined ?? crypto.randomUUID();
  return c.json(errorEnvelope(code,message,requestId,options), status);
}

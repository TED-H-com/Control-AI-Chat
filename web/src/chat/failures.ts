import type {ErrorCode} from '@shared/types';
import {errorMessageKey} from '../error-message.js';
import type {Translate} from '../i18n/index.js';
import type {ChatFailure} from './types.js';

const retryableApiCodes=new Set<ErrorCode>(['RATE_LIMITED','STREAM_LIMIT_REACHED','CONCURRENT_STREAM_LIMIT','PROVIDER_UNAVAILABLE','SERVICE_UNAVAILABLE','INTERNAL_ERROR']);
const neverRetryRunCodes=new Set<ErrorCode>(['BUDGET_HARD_LIMIT','MODEL_NOT_ALLOWED','GATE_BLOCKED']);

export function chatFailureText(failure:ChatFailure,t:Translate):string {
  if(failure.kind==='run'||failure.kind==='api')return t(errorMessageKey(failure.error,failure.kind==='api'?failure.status:undefined));
  if(failure.kind==='status')return t(errorMessageKey({},failure.status));
  return t('chat.state.streamError');
}

export function chatFailureCanRetry(failure:ChatFailure):boolean {
  if(failure.kind==='run')return failure.partialMessageId!==null&&failure.error.retryable!==false&&!neverRetryRunCodes.has(failure.error.code);
  if(failure.kind==='api')return retryableApiCodes.has(failure.error.code);
  if(failure.kind==='status')return failure.status===429||failure.status>=500;
  return true;
}

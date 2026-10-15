import {errorEnvelope} from '../../lib/http/index.js';
import {ERROR_REASONS,type ApiError,type ChatMode,type ErrorReason} from '../../shared/api.js';

function errorCode(error:unknown):string {
  return typeof error==='object'&&error!==null&&'code' in error?String(error.code):'';
}

export function chatErrorReason(error:unknown):ErrorReason|undefined {
  if(typeof error!=='object'||error===null||!('reason' in error))return undefined;
  const reason=String(error.reason);
  return (ERROR_REASONS as readonly string[]).includes(reason)?reason as ErrorReason:undefined;
}

export function governedPipelineError(error:unknown,requestId:string,cancelled:boolean,mode:ChatMode):ApiError['error'] {
  if(cancelled)return errorEnvelope('INTERNAL_ERROR','Run cancelled',requestId,{retryable:false}).error;
  const code=errorCode(error),ownReason=chatErrorReason(error);
  if(code==='budget_hard_cap_exceeded'||code==='budget_output_too_small'||code==='BUDGET_HARD_LIMIT')return errorEnvelope('BUDGET_HARD_LIMIT','The active budget cannot fund this request',requestId,{retryable:true}).error;
  if(code==='model_not_allowed'||code==='no_models_available'||code==='MODEL_NOT_ALLOWED'){
    const reason=ownReason??(code==='no_models_available'?(mode==='multi_model'?'chat_multi_model_unavailable':'chat_no_models_available'):'chat_model_not_allowed');
    return errorEnvelope('MODEL_NOT_ALLOWED','No eligible model is available for this request',requestId,{retryable:false,details:{reason}}).error;
  }
  if(code==='provider_not_allowed')return errorEnvelope('PROVIDER_UNAVAILABLE','The selected provider is unavailable',requestId,{retryable:false,details:{reason:'chat_provider_not_allowed'}}).error;
  if(code==='PROVIDER_UNAVAILABLE')return errorEnvelope('PROVIDER_UNAVAILABLE','The selected provider is unavailable',requestId,{retryable:true}).error;
  if(code==='PRECONDITION_FAILED')return errorEnvelope('PRECONDITION_FAILED','Policy changed before dispatch. Send the message again',requestId,{retryable:true,details:{reason:'chat_policy_changed'}}).error;
  if(code==='GATE_BLOCKED')return errorEnvelope('GATE_BLOCKED','The response was withheld by policy',requestId,{retryable:false}).error;
  if(code==='VALIDATION_FAILED')return errorEnvelope('VALIDATION_FAILED','The request is not valid',requestId,{retryable:false,...(ownReason?{details:{reason:ownReason}}:{})}).error;
  if(code==='RESOURCE_NOT_FOUND')return errorEnvelope('RESOURCE_NOT_FOUND','The requested resource was not found',requestId,{retryable:false,...(ownReason?{details:{reason:ownReason}}:{})}).error;
  return errorEnvelope('INTERNAL_ERROR','The model request failed',requestId,{retryable:true}).error;
}

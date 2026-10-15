import assert from 'node:assert/strict';
import test from 'node:test';
import {governedPipelineError} from './pipeline-error.js';

const thrown=(code:string,reason?:string)=>Object.assign(new Error('SERVER-TEXT-SENTINEL'),{code,...(reason?{reason}:{})});

test('governedPipelineError preserves every governed refusal cause for both chat pipelines',()=>{
  const rows=[
    [thrown('ignored'),'single',true,'INTERNAL_ERROR',undefined,false],
    [thrown('budget_hard_cap_exceeded'),'single',false,'BUDGET_HARD_LIMIT',undefined,true],
    [thrown('budget_output_too_small'),'single',false,'BUDGET_HARD_LIMIT',undefined,true],
    [thrown('BUDGET_HARD_LIMIT'),'multi_model',false,'BUDGET_HARD_LIMIT',undefined,true],
    [thrown('model_not_allowed'),'single',false,'MODEL_NOT_ALLOWED','chat_model_not_allowed',false],
    [thrown('MODEL_NOT_ALLOWED','chat_multi_model_unavailable'),'multi_model',false,'MODEL_NOT_ALLOWED','chat_multi_model_unavailable',false],
    [thrown('no_models_available'),'single',false,'MODEL_NOT_ALLOWED','chat_no_models_available',false],
    [thrown('no_models_available'),'multi_model',false,'MODEL_NOT_ALLOWED','chat_multi_model_unavailable',false],
    [thrown('provider_not_allowed'),'single',false,'PROVIDER_UNAVAILABLE','chat_provider_not_allowed',false],
    [thrown('PROVIDER_UNAVAILABLE'),'single',false,'PROVIDER_UNAVAILABLE',undefined,true],
    [thrown('PRECONDITION_FAILED'),'single',false,'PRECONDITION_FAILED','chat_policy_changed',true],
    [thrown('GATE_BLOCKED'),'single',false,'GATE_BLOCKED',undefined,false],
    [thrown('VALIDATION_FAILED','chat_context_too_large'),'single',false,'VALIDATION_FAILED','chat_context_too_large',false],
    [thrown('RESOURCE_NOT_FOUND','chat_attachment_unavailable'),'single',false,'RESOURCE_NOT_FOUND','chat_attachment_unavailable',false],
    [thrown('unexpected'),'single',false,'INTERNAL_ERROR',undefined,true],
  ] as const;
  for(const [error,mode,cancelled,code,reason,retryable] of rows){const result=governedPipelineError(error,'request-1',cancelled,mode);assert.deepEqual([result.code,result.details?.reason,result.retryable],[code,reason,retryable]);assert.doesNotMatch(result.message,/SERVER-TEXT-SENTINEL/);}
});

import type {ApiError,ErrorCode,ErrorReason} from '@shared/types';
import {ApiClientError} from './api.js';
import type {Translate,TranslationKey} from './i18n/index.js';

export const REASON_MESSAGE_KEYS:Record<ErrorReason,TranslationKey>={
  email_taken:'errors.reason.email_taken',account_above_caller:'errors.reason.account_above_caller',self_status_change:'errors.reason.self_status_change',self_role_change:'errors.reason.self_role_change',self_removal:'errors.reason.self_removal',self_password_link:'errors.reason.self_password_link',
  password_link_unavailable:'errors.reason.password_link_unavailable',password_link_refused:'errors.reason.password_link_refused',missing_permission:'errors.reason.missing_permission',ownership_transfer_required:'errors.reason.ownership_transfer_required',system_group_immutable:'errors.reason.system_group_immutable',builtin_detector_immutable:'errors.reason.builtin_detector_immutable',legal_hold_already_released:'errors.reason.legal_hold_already_released',assistant_name_taken:'errors.reason.assistant_name_taken',
  icon_required:'errors.reason.icon_required',icon_too_large:'errors.reason.icon_too_large',icon_svg_refused:'errors.reason.icon_svg_refused',icon_type_refused:'errors.reason.icon_type_refused',icon_dimensions_invalid:'errors.reason.icon_dimensions_invalid',custom_terms_action_invalid:'errors.reason.custom_terms_action_invalid',custom_terms_required:'errors.reason.custom_terms_required',custom_terms_blank:'errors.reason.custom_terms_blank',custom_term_length:'errors.reason.custom_term_length',custom_terms_too_many:'errors.reason.custom_terms_too_many',
  soft_limit_above_hard:'errors.reason.soft_limit_above_hard',date_order_invalid:'errors.reason.date_order_invalid',support_url_invalid:'errors.reason.support_url_invalid',support_url_https_required:'errors.reason.support_url_https_required',support_email_invalid:'errors.reason.support_email_invalid',model_unavailable:'errors.reason.model_unavailable',hold_target_invalid:'errors.reason.hold_target_invalid',hold_dates_required:'errors.reason.hold_dates_required',hold_reason_invalid:'errors.reason.hold_reason_invalid',resource_changed:'errors.reason.resource_changed',membership_externally_managed:'errors.reason.membership_externally_managed',group_model_state_unchanged:'errors.reason.group_model_state_unchanged',
  chat_attachments_invalid:'errors.reason.chat_attachments_invalid',chat_too_many_attachments:'errors.reason.chat_too_many_attachments',chat_attachment_text_too_large:'errors.reason.chat_attachment_text_too_large',chat_attachment_project_mismatch:'errors.reason.chat_attachment_project_mismatch',chat_project_unavailable:'errors.reason.chat_project_unavailable',chat_message_empty:'errors.reason.chat_message_empty',chat_option_invalid:'errors.reason.chat_option_invalid',chat_single_target_required:'errors.reason.chat_single_target_required',chat_multi_model_target_refused:'errors.reason.chat_multi_model_target_refused',chat_idempotency_reused:'errors.reason.chat_idempotency_reused',chat_attachment_unavailable:'errors.reason.chat_attachment_unavailable',chat_context_too_large:'errors.reason.chat_context_too_large',chat_model_not_allowed:'errors.reason.chat_model_not_allowed',chat_provider_not_allowed:'errors.reason.chat_provider_not_allowed',chat_no_models_available:'errors.reason.chat_no_models_available',chat_multi_model_unavailable:'errors.reason.chat_multi_model_unavailable',chat_policy_changed:'errors.reason.chat_policy_changed',
};

const CODE_MESSAGE_KEYS:Partial<Record<ErrorCode,TranslationKey>>={
  BUDGET_HARD_LIMIT:'errors.code.budgetHard',MODEL_NOT_ALLOWED:'errors.code.modelNotAllowed',FORBIDDEN:'errors.code.forbidden',RESOURCE_NOT_FOUND:'errors.code.notFound',VALIDATION_FAILED:'errors.code.validation',INVALID_REQUEST:'errors.code.validation',CONFLICT:'errors.code.conflict',IDEMPOTENCY_CONFLICT:'errors.code.conflict',PRECONDITION_FAILED:'errors.code.precondition',PRECONDITION_REQUIRED:'errors.code.precondition',RATE_LIMITED:'errors.code.rateLimited',STREAM_LIMIT_REACHED:'errors.code.rateLimited',CONCURRENT_STREAM_LIMIT:'errors.code.rateLimited',PROVIDER_UNAVAILABLE:'errors.code.providerUnavailable',GATE_BLOCKED:'errors.code.gateBlocked',UNAUTHENTICATED:'errors.code.unauthenticated',SESSION_EXPIRED:'errors.code.unauthenticated',
};

function statusMessageKey(status:number|undefined):TranslationKey|undefined {
  if(status===401)return 'errors.code.unauthenticated';
  if(status===403)return 'errors.status.forbidden';
  if(status===404)return 'errors.status.notFound';
  if(status===409||status===412||status===428)return 'errors.status.conflict';
  if(status===422)return 'errors.status.validation';
  if(status===429)return 'errors.status.rateLimited';
  if(status!==undefined&&status>=500)return 'errors.status.server';
  if(status!==undefined&&status>=400)return 'errors.status.client';
  return undefined;
}

export interface ErrorDescriptor {status?:number;error?:Partial<ApiError['error']>}
export function errorDescriptor(value:unknown):ErrorDescriptor {
  if(value instanceof ApiClientError)return {status:value.status,error:value.body.error};
  if(value&&typeof value==='object'&&'code' in value)return {error:value as Partial<ApiError['error']>};
  return {};
}

/** Reason -> code -> HTTP status class -> generic. Server message text is deliberately ignored. */
export function errorMessageKey(value:unknown,status?:number):TranslationKey {
  const descriptor=errorDescriptor(value),error=descriptor.error,reason=error?.details?.reason;
  if(typeof reason==='string'&&Object.hasOwn(REASON_MESSAGE_KEYS,reason))return REASON_MESSAGE_KEYS[reason as ErrorReason];
  const code=error?.code;
  if(typeof code==='string'&&Object.hasOwn(CODE_MESSAGE_KEYS,code))return CODE_MESSAGE_KEYS[code as ErrorCode]!;
  return statusMessageKey(status??descriptor.status)??'errors.code.generic';
}

export const errorText=(value:unknown,t:Translate,status?:number):string=>t(errorMessageKey(value,status));

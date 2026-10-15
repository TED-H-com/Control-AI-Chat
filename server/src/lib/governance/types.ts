import type { Provider, Role } from '../../shared/api.js';

export type TenantRole = Role;
export type ProviderId = Provider;
export type BudgetScopeType = 'tenant' | 'group' | 'user';
export type BudgetWindow = 'daily' | 'weekly' | 'monthly';
export type BudgetMetric = 'tokens' | 'usd';

export interface ModelCatalogItem {
  id:string; provider:ProviderId; providerModel:string; displayName:string;
  enabledGlobally:boolean; supportsStreaming:boolean; supportsVision:boolean;
  contextWindowTokens:number; maxOutputTokens:number;
  inputPriceMicrosPerMillion:number; outputPriceMicrosPerMillion:number;
  cachedInputPriceMicrosPerMillion:number|null; pricingVersion:number; version:number;
}
export interface EffectiveModel extends ModelCatalogItem {
  isDefault:boolean; enabledByGroupIds:readonly string[]; limitingMaxOutputTokens:number;
}
export interface ResolveModelsInput { tenantId:string; userId:string; requestedModelId?:string }
export interface ResolveModelsResult { models:readonly EffectiveModel[]; defaultModelId:string|null; groupIds:readonly string[]; catalogVersion:string }

export interface PricingSnapshot { modelId:string; provider:ProviderId; providerModel:string; pricingVersion:number; inputPriceMicrosPerMillion:number; outputPriceMicrosPerMillion:number; cachedInputPriceMicrosPerMillion:number|null }
export interface CostBreakdown { inputTokens:number; cachedInputTokens:number; outputTokens:number; inputCostMicros:number; cachedInputCostMicros:number; outputCostMicros:number; totalCostMicros:number; pricingVersion:number }
export interface BudgetWarning { budgetLimitId:string; scopeType:BudgetScopeType; scopeId:string; window:BudgetWindow; metric:BudgetMetric; projected:number; limit:number; utilizationBasisPoints:number }
export interface ReservationRequest { idempotencyKey:string; tenantId:string; userId:string; groupIds:readonly string[]; conversationId:string; messageId:string; modelId:string; provider:ProviderId; estimatedInputTokens:number; requestedMaxOutputTokens:number; now:number }
export interface ReservationGrant { reservationId:string; allowedMaxOutputTokens:number; reservedInputTokens:number; reservedOutputTokens:number; reservedTotalTokens:number; reservedCostMicros:number; expiresAt:number; softWarnings:readonly BudgetWarning[]; pricingSnapshot:PricingSnapshot }
export interface SettlementInput { reservationId:string; providerRequestId:string|null; providerModel:string; actualInputTokens:number|null; actualCachedInputTokens:number|null; actualOutputTokens:number|null; actualCostMicros?:number; locallyCountedOutputTokens:number; usageQuality:'provider_actual'|'local_exact'|'estimated'; finishReason:string|null; outcome:'complete'|'client_aborted'|'provider_error'|'server_error'; now:number }
export interface SettlementResult { reservationId:string; usageEventId:string; chargedInputTokens:number; chargedOutputTokens:number; chargedCostMicros:number; releasedTokens:number; releasedCostMicros:number; status:'settled'|'reconciliation_required' }
export interface RateLimitPolicy { requestsPerMinute:number; requestBurst:number; concurrentStreams:number }
export interface RateLimitDecision { allowed:boolean; remainingWholeTokens:number; retryAfterMs:number; limit:number }
export interface StreamLease { id:string; tenantId:string; userId:string; reservationId:string; acquiredAt:number; heartbeatAt:number; expiresAt:number }

import { GovernanceError } from './errors.js';
import { priceTokens } from './pricing.js';

export type CredentialBillingSource='platform'|'byok';

function cost(value:number,label:string):void {
  if(!Number.isSafeInteger(value)||value<0)throw new GovernanceError('pricing_overflow',`${label} must be a nonnegative safe integer`);
}

function number(value:bigint,label:string):number {
  if(value>BigInt(Number.MAX_SAFE_INTEGER))throw new GovernanceError('pricing_overflow',`${label} exceeds the safe integer range`);
  return Number(value);
}

export interface ModelCostEstimateInput {
  readonly inputTokens:number;
  readonly outputTokens:number;
  readonly cachedInputTokens?:number;
  readonly inputMicrousdPerMillion:number;
  readonly outputMicrousdPerMillion:number;
  readonly cachedInputMicrousdPerMillion?:number|null;
}

export function estimateModelCostMicrousd(input:ModelCostEstimateInput):number {
  const cached=input.cachedInputTokens??0;
  cost(input.inputTokens,'input tokens');cost(input.outputTokens,'output tokens');cost(cached,'cached input tokens');
  if(cached>input.inputTokens)throw new GovernanceError('pricing_overflow','Cached input cannot exceed total input');
  const ordinary=priceTokens(input.inputTokens-cached,input.inputMicrousdPerMillion);
  const cachedCost=priceTokens(cached,input.cachedInputMicrousdPerMillion??input.inputMicrousdPerMillion);
  const output=priceTokens(input.outputTokens,input.outputMicrousdPerMillion);
  const total=BigInt(ordinary)+BigInt(cachedCost)+BigInt(output);
  return number(total,'estimated provider cost');
}

export interface UsageBillingInput {
  readonly providerCostMicrousd:number;
  readonly credentialSource:CredentialBillingSource;
  readonly baselineCostMicrousd?:number|null;
}

export interface UsageBilling {
  readonly providerCostMicrousd:number;
  readonly customerChargeMicrousd:number;
  readonly credentialSource:CredentialBillingSource;
  readonly baselineCostMicrousd:number|null;
  readonly savingsMicrousd:number|null;
  readonly usageMarkupBasisPoints:null;
}

/** Provider cost is retained for internal spend governance; the application never charges the customer. */
export function calculateUsageBilling(input:UsageBillingInput):UsageBilling {
  cost(input.providerCostMicrousd,'provider cost');
  const baseline=input.baselineCostMicrousd??null;
  if(baseline!==null)cost(baseline,'baseline cost');
  return {
    providerCostMicrousd:input.providerCostMicrousd,
    customerChargeMicrousd:0,
    credentialSource:input.credentialSource,
    baselineCostMicrousd:baseline,
    savingsMicrousd:baseline===null?null:Math.max(0,baseline-input.providerCostMicrousd),
    usageMarkupBasisPoints:null,
  };
}

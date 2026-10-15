import { GovernanceError } from './errors.js';
import type { CostBreakdown, PricingSnapshot } from './types.js';

function integer(value:number, label:string):void { if (!Number.isSafeInteger(value)||value<0) throw new GovernanceError('pricing_overflow',`${label} must be a nonnegative safe integer`); }
export function priceTokens(tokens:number, microsPerMillion:number):number {
  integer(tokens,'tokens'); integer(microsPerMillion,'price');
  const value=(BigInt(tokens)*BigInt(microsPerMillion)+999_999n)/1_000_000n;
  if (value>BigInt(Number.MAX_SAFE_INTEGER)) throw new GovernanceError('pricing_overflow','Calculated price exceeds safe integer range');
  return Number(value);
}
export function calculateCost(snapshot:PricingSnapshot,inputTokens:number,cachedInputTokens:number,outputTokens:number):CostBreakdown {
  integer(inputTokens,'inputTokens'); integer(cachedInputTokens,'cachedInputTokens'); integer(outputTokens,'outputTokens');
  if (cachedInputTokens>inputTokens) throw new GovernanceError('pricing_overflow','Cached input cannot exceed total input');
  const ordinary=inputTokens-cachedInputTokens;
  const inputCostMicros=priceTokens(ordinary,snapshot.inputPriceMicrosPerMillion);
  const cachedInputCostMicros=priceTokens(cachedInputTokens,snapshot.cachedInputPriceMicrosPerMillion??snapshot.inputPriceMicrosPerMillion);
  const outputCostMicros=priceTokens(outputTokens,snapshot.outputPriceMicrosPerMillion);
  const totalCostMicros=inputCostMicros+cachedInputCostMicros+outputCostMicros;
  integer(totalCostMicros,'total cost');
  return {inputTokens:ordinary,cachedInputTokens,outputTokens,inputCostMicros,cachedInputCostMicros,outputCostMicros,totalCostMicros,pricingVersion:snapshot.pricingVersion};
}

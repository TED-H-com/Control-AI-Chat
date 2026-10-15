import type { Provider } from '../../shared/api.js';

/**
 * Older tenant catalogs predate the explicit `reasoning` capability. Keep the compatibility
 * inference narrow: a false negative hides a family until an administrator fixes its catalog,
 * while a false positive sends an option the upstream model may reject.
 */
export function supportsReasoningEffort(
  provider:Provider,
  modelKey:string,
  capabilities:readonly string[],
):boolean {
  if(capabilities.includes('reasoning'))return true;
  switch(provider){
    case 'openai': return /^(?:gpt-5(?:[.-]|$)|o[134](?:[.-]|$))/i.test(modelKey);
    case 'anthropic': return /^claude-(?:opus|sonnet)-(?:4(?:[.-]5)?|5)(?:[.-]|$)/i.test(modelKey);
    case 'google': return /^gemini-3(?:[.-]|$)/i.test(modelKey);
    case 'xai': return /^grok-4\.5(?:[.-]|$)/i.test(modelKey);
    default: return false;
  }
}

import type {Provider} from '@shared/types';

export const PROVIDER_NAMES:Readonly<Record<string,string>>={
  openai:'OpenAI',
  anthropic:'Anthropic',
  google:'Google',
  xai:'xAI',
  openrouter:'OpenRouter',
  venice:'Venice',
  nvidia:'NVIDIA',
} satisfies Record<Provider,string>;

export function providerName(provider:Provider|null):string|null {
  return provider===null?null:PROVIDER_NAMES[provider];
}

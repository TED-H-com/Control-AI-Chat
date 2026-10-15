import type { ChatProvider, ProviderId } from "./types.js";
import { createOpenAIProvider } from "./openai.js";
import { createAnthropicProvider } from "./anthropic.js";
import { createGeminiProvider } from "./gemini.js";
import { createXaiProvider } from "./xai.js";
import { createOpenRouterProvider } from "./openrouter.js";
import { createVeniceProvider } from "./venice.js";
import { createNvidiaProvider } from "./nvidia.js";
export type ProviderKeys = Readonly<Partial<Record<ProviderId, string>>>;
export type ProviderBaseUrls = Readonly<Partial<Record<ProviderId,string|undefined>>>;
export const PROVIDERS = ['openai','anthropic','google','xai','openrouter','venice','nvidia'] as const satisfies readonly ProviderId[];
export class ProviderRegistry {
  private readonly providers: ReadonlyMap<ProviderId, ChatProvider>;
  constructor(keys: ProviderKeys,baseUrls:ProviderBaseUrls={},attribution:{appOrigin?:string;workspaceName?:string}={}) {
    const all = [
      createOpenAIProvider(keys.openai,baseUrls.openai),
      createAnthropicProvider(keys.anthropic,baseUrls.anthropic),
      createGeminiProvider(keys.google,baseUrls.google),
      createXaiProvider(keys.xai,baseUrls.xai),
      createOpenRouterProvider(keys.openrouter,baseUrls.openrouter,attribution.appOrigin,attribution.workspaceName),
      createVeniceProvider(keys.venice,baseUrls.venice),
      createNvidiaProvider(keys.nvidia,baseUrls.nvidia),
    ];
    this.providers = new Map(all.map((p) => [p.id, p]));
  }
  get(id: ProviderId): ChatProvider {
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`Unknown provider: ${id}`);
    return provider;
  }
  health() {
    return Object.fromEntries(
      [...this.providers].map(([id, p]) => [id, p.health()]),
    ) as Record<ProviderId, ReturnType<ChatProvider["health"]>>;
  }
}

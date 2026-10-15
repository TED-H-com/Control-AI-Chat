import { PINNABLE_PROVIDERS, type AvailableModel, type ChatReasoningEffort, type PinnableProvider } from '@shared/types';

export { PINNABLE_PROVIDERS };
export type ChatMode = 'auto'|'single'|'multi_model';

export const CHAT_EFFORTS = ['fast', 'standard', 'deep'] as const;
export type ChatEffort = (typeof CHAT_EFFORTS)[number];
export type ReasoningEffort = ChatReasoningEffort;

const EFFORT_VALUES: Readonly<Record<ChatEffort, ReasoningEffort>> = {
  fast: 'low',
  standard: 'medium',
  deep: 'high',
};

export function pinnableProvider(model: Pick<AvailableModel, 'provider'>): PinnableProvider | null {
  return PINNABLE_PROVIDERS.find(provider => provider === model.provider) ?? null;
}

export function supportsEffort(model:AvailableModel):boolean {
  return model.capabilities.includes('reasoning');
}

export function supportsEffortForSelection(
  models:readonly AvailableModel[],
  mode:ChatMode,
  currentModelId?:string,
):boolean {
  if(mode==='multi_model')return false;
  const eligible=models.filter(model=>model.enabled&&pinnableProvider(model)!==null);
  if(mode==='auto')return eligible.some(supportsEffort);
  const selected=eligible.find(model=>model.id===currentModelId);
  const provider=selected&&pinnableProvider(selected);
  return Boolean(provider&&eligible.some(model=>pinnableProvider(model)===provider&&supportsEffort(model)));
}

export function availableProviders(models: readonly AvailableModel[]): PinnableProvider[] {
  const allowed = new Set(models.filter(model => model.enabled).map(pinnableProvider).filter((provider): provider is PinnableProvider => provider !== null));
  return PINNABLE_PROVIDERS.filter(provider => allowed.has(provider));
}

export function preferredModel(
  models: readonly AvailableModel[],
  provider: PinnableProvider,
  currentModelId?: string,
): AvailableModel | null {
  const allowed = models.filter(model => model.enabled && pinnableProvider(model) === provider);
  return allowed.find(model => model.id === currentModelId)
    ?? allowed.find(model => model.recommendedForProvider)
    ?? allowed.find(model => model.isDefault)
    ?? allowed[0]
    ?? null;
}

export function initialModel(models: readonly AvailableModel[], currentModelId?: string, provider?:PinnableProvider): AvailableModel | null {
  const allowed = models.filter(model => model.enabled);
  return allowed.find(model => model.id === currentModelId)
    ?? (provider ? preferredModel(allowed, provider) : null)
    ?? allowed.find(model => model.isDefault)
    ?? allowed[0]
    ?? null;
}

export function reasoningEffort(effort: ChatEffort): ReasoningEffort {
  return EFFORT_VALUES[effort];
}

export function routingSelection(
  models:readonly AvailableModel[],
  mode:ChatMode,
  currentModelId?:string,
):{mode:ChatMode;provider?:PinnableProvider;modelId?:string} {
  if(mode!=='single')return {mode};
  const selected=models.find(model=>model.enabled&&model.id===currentModelId);
  const provider=selected&&pinnableProvider(selected);
  return provider?{mode,provider}:{mode};
}

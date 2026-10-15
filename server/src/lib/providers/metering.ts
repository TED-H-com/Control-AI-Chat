import type { ChatRequest, CostQuote, Usage } from "./types.js";
import { estimateUtf8Tokens } from "../token-estimate.js";
export interface PriceVersion {
  readonly id: string;
  readonly inputMicrosPerMillion: number;
  readonly outputMicrosPerMillion: number;
  readonly reasoningMicrosPerMillion: number;
  readonly cacheReadMicrosPerMillion: number;
  readonly cacheWriteMicrosPerMillion: number;
  readonly toolMicrosPerCall: number;
}
export const EMPTY_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  toolInputTokens: 0,
  totalTokens: 0,
  estimated: false,
  source: "provider",
};
function integer(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}
export function usage(
  input: unknown,
  output: unknown,
  extra: Partial<Usage> = {},
): Usage {
  const inputTokens = integer(input),
    outputTokens = integer(output),
    reasoningTokens = integer(extra.reasoningTokens),
    cachedInputTokens = integer(extra.cachedInputTokens),
    cacheWriteTokens = integer(extra.cacheWriteTokens),
    toolInputTokens = integer(extra.toolInputTokens);
  return {
    inputTokens,
    outputTokens,
    reasoningTokens,
    cachedInputTokens,
    cacheWriteTokens,
    toolInputTokens,
    totalTokens:
      inputTokens +
      outputTokens +
      (reasoningTokens > outputTokens ? reasoningTokens : 0) +
      toolInputTokens,
    estimated: extra.estimated ?? false,
    source: extra.source ?? "provider",
  };
}
export function estimateUsage(request: ChatRequest, outputText: string): Usage {
  const inputText=request.messages.flatMap(message=>message.content)
    .filter((part):part is Extract<(typeof request.messages)[number]['content'][number],{type:'text'}>=>part.type==='text')
    .map(part=>part.text).join('');
  return usage(estimateUtf8Tokens(inputText),estimateUtf8Tokens(outputText), {
    estimated: true,
    source: "local_estimate",
  });
}
const component = (tokens: number, rate: number) =>
  Math.ceil((tokens * rate) / 1_000_000);
export function quoteCost(
  value: Usage,
  price: PriceVersion,
  toolCalls = 0,
): CostQuote {
  const uncached = Math.max(
    0,
    value.inputTokens - value.cachedInputTokens - value.cacheWriteTokens,
  );
  const inputMicros = component(uncached, price.inputMicrosPerMillion),
    outputMicros = component(
      Math.max(0, value.outputTokens - value.reasoningTokens),
      price.outputMicrosPerMillion,
    ),
    reasoningMicros = component(
      value.reasoningTokens,
      price.reasoningMicrosPerMillion || price.outputMicrosPerMillion,
    ),
    cacheReadMicros = component(
      value.cachedInputTokens,
      price.cacheReadMicrosPerMillion,
    ),
    cacheWriteMicros = component(
      value.cacheWriteTokens,
      price.cacheWriteMicrosPerMillion,
    ),
    toolMicros = toolCalls * price.toolMicrosPerCall;
  return {
    currency: "USD",
    inputMicros,
    outputMicros,
    reasoningMicros,
    cacheReadMicros,
    cacheWriteMicros,
    toolMicros,
    totalMicros:
      inputMicros +
      outputMicros +
      reasoningMicros +
      cacheReadMicros +
      cacheWriteMicros +
      toolMicros,
    priceVersionId: price.id,
    estimated: value.estimated,
  };
}

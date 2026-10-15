import type {
  ProviderError,
  ProviderErrorKind,
  ProviderId,
  ProviderProtocol,
  Usage,
} from "./types.js";
export interface ErrorContext {
  provider: ProviderId;
  model: string;
  protocol: ProviderProtocol;
  attempt?: number;
  partialOutput?: boolean;
  usage?: Usage;
}
export class NormalizedProviderError extends Error implements ProviderError {
  readonly name = "ProviderError" as const;
  constructor(
    readonly kind: ProviderErrorKind,
    readonly provider: ProviderId,
    readonly model: string,
    readonly protocol: ProviderProtocol,
    readonly retryable: boolean,
    readonly safeMessage: string,
    readonly attempt = 1,
    readonly partialOutput = false,
    options?: {
      status?: number;
      providerCode?: string;
      providerRequestId?: string;
      retryAfterMs?: number;
      usage?: Usage;
      cause?: unknown;
    },
  ) {
    super(safeMessage, { cause: options?.cause });
    if (options?.status !== undefined) this.status = options.status;
    if (options?.providerCode !== undefined)
      this.providerCode = options.providerCode;
    if (options?.providerRequestId !== undefined)
      this.providerRequestId = options.providerRequestId;
    if (options?.retryAfterMs !== undefined)
      this.retryAfterMs = options.retryAfterMs;
    if (options?.usage !== undefined) this.usage = options.usage;
  }
  readonly status?: number;
  readonly providerCode?: string;
  readonly providerRequestId?: string;
  readonly retryAfterMs?: number;
  readonly usage?: Usage;
}
export function retryAfterMs(
  value: string | null,
  now = Date.now(),
): number | undefined {
  if (!value) return;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.ceil(seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}
export function httpError(
  status: number,
  headers: Headers,
  ctx: ErrorContext,
  providerCode?: string,
): NormalizedProviderError {
  let kind: ProviderErrorKind = "unknown";
  if (status === 401) kind = "authentication";
  else if (status === 403) kind = "authorization";
  else if (status === 404) kind = "model_not_found";
  else if (status === 402) kind = "quota_exhausted";
  else if (status === 429) kind = "rate_limit";
  else if (status === 408 || status === 504) kind = "timeout";
  else if (status >= 500)
    kind =
      status === 502 || status === 503
        ? "provider_overloaded"
        : "provider_internal";
  else if (status === 400 || status === 422) kind = "invalid_request";
  const retryable = [
    "rate_limit",
    "timeout",
    "provider_overloaded",
    "provider_internal",
  ].includes(kind);
  const retry = retryAfterMs(headers.get("retry-after"));
  return new NormalizedProviderError(
    kind,
    ctx.provider,
    ctx.model,
    ctx.protocol,
    retryable,
    "The AI provider could not complete the request.",
    ctx.attempt ?? 1,
    ctx.partialOutput ?? false,
    {
      status,
      ...(providerCode ? { providerCode } : {}),
      ...(retry !== undefined ? { retryAfterMs: retry } : {}),
      ...(ctx.usage ? { usage: ctx.usage } : {}),
    },
  );
}
export function normalizeThrown(
  error: unknown,
  ctx: ErrorContext,
): NormalizedProviderError {
  if (error instanceof NormalizedProviderError) return error;
  if (
    ctx.partialOutput === false &&
    error instanceof DOMException &&
    error.name === "AbortError"
  )
    return new NormalizedProviderError(
      "cancelled",
      ctx.provider,
      ctx.model,
      ctx.protocol,
      false,
      "The request was cancelled.",
      ctx.attempt ?? 1,
      false,
      { cause: error },
    );
  return new NormalizedProviderError(
    ctx.partialOutput ? "provider_internal" : "network",
    ctx.provider,
    ctx.model,
    ctx.protocol,
    !ctx.partialOutput,
    "The AI provider is temporarily unavailable.",
    ctx.attempt ?? 1,
    ctx.partialOutput ?? false,
    { cause: error, ...(ctx.usage ? { usage: ctx.usage } : {}) },
  );
}

import { NormalizedProviderError, normalizeThrown } from "./errors.js";
import type {
  ChatRequest,
  ProviderError,
  ProviderId,
  ProviderProtocol,
} from "./types.js";
export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly timeoutMs: number;
}
export async function withRetry<T>(
  operation: (signal: AbortSignal, attempt: number) => Promise<T>,
  request: ChatRequest,
  policy: RetryPolicy,
  authorize: () => void = () => {},
): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    authorize();
    if (request.signal.aborted) throw cancelled(request);
    const controller = new AbortController();
    const timeout = setTimeout(
      () =>
        controller.abort(new DOMException("Provider timeout", "TimeoutError")),
      policy.timeoutMs,
    );
    const abort = () => controller.abort(request.signal.reason);
    request.signal.addEventListener("abort", abort, { once: true });
    try {
      return await operation(controller.signal, attempt);
    } catch (error) {
      last = normalizeThrown(error, {
        provider: request.provider,
        model: request.model,
        protocol: request.protocol,
        attempt,
        partialOutput: false,
      });
      if (request.signal.aborted) throw cancelled(request);
      const normalized = last as ProviderError;
      if (!normalized.retryable || attempt === policy.maxAttempts)
        throw normalized;
      await abortableDelay(
        Math.min(
          policy.maxDelayMs,
          normalized.retryAfterMs ?? policy.baseDelayMs * 2 ** (attempt - 1),
        ),
        request.signal,
      );
    } finally {
      clearTimeout(timeout);
      request.signal.removeEventListener("abort", abort);
    }
  }
  throw last;
}
function cancelled(r: ChatRequest) {
  return new NormalizedProviderError(
    "cancelled",
    r.provider,
    r.model,
    r.protocol,
    false,
    "The request was cancelled.",
  );
}
export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      signal.removeEventListener("abort", abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}
export class CircuitBreaker {
  private state: "closed" | "open" | "half_open" = "closed";
  private failures: number[] = [];
  private probe = false;
  private until = 0;
  constructor(
    private readonly threshold = 5,
    private readonly windowMs = 60_000,
    private readonly openMs = 30_000,
  ) {}
  canAttempt(now = Date.now()): boolean {
    this.trim(now);
    if (this.state === "open" && now >= this.until) this.state = "half_open";
    if (this.state === "half_open") {
      if (this.probe) return false;
      this.probe = true;
    }
    return this.state !== "open";
  }
  success(): void {
    this.state = "closed";
    this.failures = [];
    this.probe = false;
  }
  failure(now = Date.now()): void {
    this.probe = false;
    this.failures.push(now);
    this.trim(now);
    if (this.state === "half_open" || this.failures.length >= this.threshold) {
      this.state = "open";
      this.until = now + this.openMs;
    }
  }
  health(configured: boolean) {
    return {
      configured,
      circuit: this.state,
      recentFailureRate: Math.min(1, this.failures.length / this.threshold),
      ...(this.state === "open" ? { openedUntil: this.until } : {}),
    } as const;
  }
  private trim(now: number) {
    this.failures = this.failures.filter((x) => x >= now - this.windowMs);
  }
}
export interface FallbackTarget {
  readonly provider: ProviderId;
  readonly protocol: ProviderProtocol;
  readonly model: string;
}

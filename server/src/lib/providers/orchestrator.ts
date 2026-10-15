import { accumulate, type AccumulatedStream } from "./streamAccumulator.js";
import {
  withRetry,
  type FallbackTarget,
  type RetryPolicy,
} from "./resilience.js";
import type { ChatRequest, ChatProvider, StreamEvent } from "./types.js";
export interface OrchestrationHooks {
  readonly assertTransportAuthorized: () => void;
  readonly observeUsage?: (
    event: Extract<StreamEvent, { type: "usage" }>,
  ) => void;
}
export async function orchestrate(
  request: ChatRequest,
  targets: readonly FallbackTarget[],
  resolve: (target: FallbackTarget) => ChatProvider,
  hooks: OrchestrationHooks,
  policy: RetryPolicy,
): Promise<AccumulatedStream> {
  validate(request);
  let last: unknown;
  for (const target of targets) {
    if (request.signal.aborted) throw request.signal.reason;
    const candidate: {
      provider: ChatRequest["provider"];
      protocol: ChatRequest["protocol"];
      model: string;
    } & ChatRequest = { ...request, ...target };
    const provider = resolve(target);
    try {
      return await withRetry(
        async (signal) =>
          accumulate(
            observe(provider.stream({ ...candidate, signal }), hooks),
            { ...candidate, signal },
          ),
        candidate,
        policy,
        hooks.assertTransportAuthorized,
      );
    } catch (error) {
      last = error;
      if (hasPartial(error) || request.signal.aborted) throw error;
    }
  }
  throw last ?? new Error("No eligible provider route");
}
async function* observe(
  source: AsyncIterable<StreamEvent>,
  hooks: OrchestrationHooks,
) {
  for await (const event of source) {
    if (event.type === "usage") hooks.observeUsage?.(event);
    if (event.type === "reasoning_delta" && event.visibility === "opaque")
      yield { ...event, delta: "" };
    else yield event;
  }
}
function validate(r: ChatRequest) {
  if (r.messages.length === 0)
    throw new Error("Chat messages must not be empty");
  const role = r.messages.at(-1)?.role;
  if (role !== "user" && role !== "tool")
    throw new Error("Chat messages must end with user or tool");
  if (r.signal.aborted) throw r.signal.reason;
}
function hasPartial(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "partialOutput" in error &&
    (error as { partialOutput?: unknown }).partialOutput === true
  );
}

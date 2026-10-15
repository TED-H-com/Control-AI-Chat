import { NormalizedProviderError } from "./errors.js";
import { estimateUsage } from "./metering.js";
import type {
  ChatRequest,
  Citation,
  FinishReason,
  StreamEvent,
  ToolCallPart,
  Usage,
} from "./types.js";
export interface AccumulatedStream {
  readonly text: string;
  readonly reasoningSummary: string;
  readonly toolCalls: readonly ToolCallPart[];
  readonly citations: readonly Citation[];
  readonly usage: Usage;
  readonly finishReason: FinishReason;
  readonly providerModel: string;
}
export async function accumulate(
  stream: AsyncIterable<StreamEvent>,
  request: ChatRequest,
): Promise<AccumulatedStream> {
  let started = false,
    terminal = false,
    text = "",
    reasoning = "",
    model = request.model,
    lastUsage: Usage | undefined,
    finishReason: FinishReason = "unknown";
  const citations: Citation[] = [];
  const calls = new Map<string, { id: string; name: string; args: string }>();
  for await (const event of stream) {
    if (terminal) continue;
    if (!started) {
      if (event.type !== "start")
        throw new NormalizedProviderError(
          "stream_protocol",
          request.provider,
          request.model,
          request.protocol,
          false,
          "Invalid provider stream.",
        );
      started = true;
      model = event.model;
      continue;
    }
    switch (event.type) {
      case "start":
        throw new NormalizedProviderError(
          "stream_protocol",
          request.provider,
          request.model,
          request.protocol,
          false,
          "Invalid provider stream.",
        );
      case "text_delta":
        if (event.delta) text += event.delta;
        break;
      case "reasoning_delta":
        if (event.visibility === "summary") reasoning += event.delta;
        break;
      case "tool_call_start":
        calls.set(event.callId, {
          id: event.callId,
          name: event.name,
          args: "",
        });
        break;
      case "tool_call_delta": {
        const call = calls.get(event.callId);
        if (!call)
          throw new NormalizedProviderError(
            "stream_protocol",
            request.provider,
            request.model,
            request.protocol,
            false,
            "Invalid tool stream.",
          );
        call.args += event.argumentsDelta;
        if (call.args.length > 262144)
          throw new NormalizedProviderError(
            "invalid_request",
            request.provider,
            request.model,
            request.protocol,
            false,
            "Tool arguments are too large.",
          );
        break;
      }
      case "tool_call_end":
        break;
      case "citation":
        citations.push(event.citation);
        break;
      case "usage":
        if (!lastUsage || event.usage.totalTokens >= lastUsage.totalTokens)
          lastUsage = event.usage;
        break;
      case "finish":
        terminal = true;
        finishReason = event.reason;
        break;
      case "error":
        throw event.error;
    }
  }
  if (!started || (!text && calls.size === 0))
    throw new NormalizedProviderError(
      "empty_response",
      request.provider,
      request.model,
      request.protocol,
      false,
      "The AI provider returned no answer.",
    );
  return {
    text,
    reasoningSummary: reasoning,
    toolCalls: [...calls.values()].map((c) => ({
      type: "tool_call",
      id: c.id,
      name: c.name,
      argumentsJson: c.args,
    })),
    citations,
    usage: lastUsage ?? estimateUsage(request, text),
    finishReason,
    providerModel: model,
  };
}

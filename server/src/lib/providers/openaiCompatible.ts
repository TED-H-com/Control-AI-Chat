import { dataUrl, documentText, textOf } from "./attachments.js";
import {
  NormalizedProviderError,
  httpError,
  normalizeThrown,
} from "./errors.js";
import { usage } from "./metering.js";
import { parseSse } from "./sse.js";
import type {
  ChatMessage,
  ChatProvider,
  ChatRequest,
  FinishReason,
  ModelCatalogEntry,
  ProviderId,
  ProviderProtocol,
  StreamEvent,
} from "./types.js";
import { CircuitBreaker } from "./resilience.js";
import { safeProviderFetch } from "../net/safe-fetch.js";
import { PRODUCT_NAME } from '../../shared/brand.js';
import { APP_VERSION } from '../../version.js';
interface CompatibleOptions {
  id: ProviderId;
  apiKey: string | undefined;
  baseUrl: string;
  headers?: Readonly<Record<string, string>>;
  bodyExtension?: (request: ChatRequest) => Readonly<Record<string, unknown>>;
}
export function createCompatibleProvider(
  options: CompatibleOptions,
): ChatProvider {
  const circuit = new CircuitBreaker();
  return {
    id: options.id,
    protocols: ["openai_chat_completions"],
    configured: !!options.apiKey,
    supports: (model, request) =>
      model.provider === options.id &&
      request.protocol === "openai_chat_completions",
    health: () => circuit.health(!!options.apiKey),
    async *stream(request): AsyncGenerator<StreamEvent, void, void> {
      if (!options.apiKey)
        throw new NormalizedProviderError(
          "configuration",
          options.id,
          request.model,
          request.protocol,
          false,
          "This AI provider is not configured.",
        );
      if (!circuit.canAttempt())
        throw new NormalizedProviderError(
          "provider_overloaded",
          options.id,
          request.model,
          request.protocol,
          true,
          "This AI provider is temporarily unavailable.",
        );
      try {
        const response = await safeProviderFetch(`${options.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            "Content-Type": "application/json",
            "User-Agent": `${PRODUCT_NAME}/${APP_VERSION}`,
            ...options.headers,
          },
          redirect: "error",
          signal: request.signal,
          body: JSON.stringify({
            ...encodeChatRequest(request),
            ...options.bodyExtension?.(request),
          }),
        });
        if (!response.ok)
          throw httpError(response.status, response.headers, {
            provider: options.id,
            model: request.model,
            protocol: request.protocol,
          });
        if (!response.body)
          throw new NormalizedProviderError(
            "empty_response",
            options.id,
            request.model,
            request.protocol,
            false,
            "The AI provider returned no stream.",
          );
        let started = false,
          content = false,
          malformed = 0,
          finished = false;
        for await (const record of parseSse(response.body, request.signal)) {
          if (record.data === "[DONE]") {
            if (!finished) yield { type: "finish", reason: "unknown" };
            finished = true;
            break;
          }
          let value: CompatibleChunk;
          try {
            value = JSON.parse(record.data) as CompatibleChunk;
          } catch {
            if (++malformed > 3)
              throw new NormalizedProviderError(
                "stream_protocol",
                options.id,
                request.model,
                request.protocol,
                false,
                "The AI provider returned an invalid stream.",
              );
            continue;
          }
          if (value.error)
            throw new NormalizedProviderError(
              "provider_internal",
              options.id,
              request.model,
              request.protocol,
              true,
              "The AI provider stream failed.",
              1,
              content,
            );
          if (!started) {
            started = true;
            yield {
              type: "start",
              requestId: request.context.requestId,
              providerRequestId: value.id,
              model: value.model ?? request.model,
              createdAt: Date.now(),
            };
          }
          const choice = value.choices?.[0],
            delta = choice?.delta;
          if (delta?.content) {
            content = true;
            yield { type: "text_delta", index: 0, delta: delta.content };
          }
          const reasoning = delta?.reasoning_content ?? delta?.reasoning;
          if (reasoning)
            yield {
              type: "reasoning_delta",
              index: 0,
              delta: reasoning,
              visibility: "opaque",
            };
          for (const call of delta?.tool_calls ?? []) {
            const id = call.id ?? `tool-${call.index}`;
            if (call.function?.name)
              yield {
                type: "tool_call_start",
                index: call.index ?? 0,
                callId: id,
                name: call.function.name,
              };
            if (call.function?.arguments)
              yield {
                type: "tool_call_delta",
                index: call.index ?? 0,
                callId: id,
                argumentsDelta: call.function.arguments,
              };
          }
          if (value.usage)
            yield {
              type: "usage",
              usage: usage(
                value.usage.prompt_tokens,
                value.usage.completion_tokens,
                {
                  reasoningTokens:
                    value.usage.completion_tokens_details?.reasoning_tokens ??
                    0,
                  cachedInputTokens:
                    value.usage.prompt_tokens_details?.cached_tokens ?? 0,
                },
              ),
            };
          if (choice?.finish_reason) {
            finished = true;
            yield {
              type: "finish",
              reason: finish(choice.finish_reason),
              providerReason: choice.finish_reason,
            };
          }
        }
        if (!started)
          throw new NormalizedProviderError(
            "empty_response",
            options.id,
            request.model,
            request.protocol,
            false,
            "The AI provider returned no answer.",
          );
        if (!finished) yield { type: "finish", reason: "unknown" };
        circuit.success();
      } catch (error) {
        circuit.failure();
        throw normalizeThrown(error, {
          provider: options.id,
          model: request.model,
          protocol: request.protocol,
        });
      }
    },
  };
}
interface CompatibleChunk {
  id?: string;
  model?: string;
  error?: unknown;
  choices?: Array<{
    delta?: {
      content?: string;
      reasoning?: string;
      reasoning_content?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}
function finish(value: string): FinishReason {
  return value === "stop"
    ? "stop"
    : value === "length"
      ? "length"
      : value === "tool_calls"
        ? "tool_call"
        : value === "content_filter"
          ? "content_filter"
          : "unknown";
}
function encodeMessage(message: ChatMessage): unknown {
  const contents = message.content
    .map((part) =>
      part.type === "text"
        ? { type: "text", text: part.text }
        : part.type === "image"
          ? {
              type: "image_url",
              image_url: {
                url: dataUrl(part),
                ...(part.detail ? { detail: part.detail } : {}),
              },
            }
          : part.type === "document"
            ? {
                type: "text",
                text: `[${part.filename}]\n${documentText(part)}`,
              }
            : part.type === "tool_call"
              ? undefined
              : part.type === "tool_result"
                ? { type: "text", text: textOf(part.content) }
                : undefined,
    )
    .filter((x) => x !== undefined);
  return {
    role: message.role === "developer" ? "system" : message.role,
    content:
      contents.length === 1 && contents[0]?.type === "text"
        ? contents[0].text
        : contents,
  };
}
export function encodeChatRequest(
  request: ChatRequest,
): Record<string, unknown> {
  return {
    model: request.model,
    messages: request.messages.map(encodeMessage),
    stream: true,
    stream_options: { include_usage: true },
    max_completion_tokens: request.maxOutputTokens,
    ...(request.temperature !== undefined
      ? { temperature: request.temperature }
      : {}),
    ...(request.topP !== undefined ? { top_p: request.topP } : {}),
    ...(request.stop.length ? { stop: request.stop } : {}),
    ...(request.provider === "xai" && request.reasoningEffort !== "none"
      ? { reasoning_effort: request.reasoningEffort }
      : {}),
    // A `tool_choice` with no `tools` beside it is not a request any vendor can honour, and it is
    // not always quietly ignored: xAI rejects the pair outright with `A tool_choice was set on the
    // request but no tools were specified`. The chat path sends no tools at all today and always
    // sends `tool_choice:"none"`, so this was every single Grok request in the product — failing as
    // "The model request failed" while the same key and model answered a hand-written curl.
    ...(request.tools.length
      ? {
          tools: request.tools.map((t) => ({
            type: "function",
            function: {
              name: t.name,
              description: t.description,
              parameters: t.inputSchema,
            },
          })),
          tool_choice:
            request.toolChoice === "none"
              ? "none"
              : request.toolChoice === "auto"
                ? "auto"
                : {
                    type: "function",
                    function: { name: request.toolChoice.name },
                  },
        }
      : {}),
  };
}

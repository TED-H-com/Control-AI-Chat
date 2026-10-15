import { dataUrl, documentText, textOf } from "./attachments.js";
import {
  NormalizedProviderError,
  httpError,
  normalizeThrown,
} from "./errors.js";
import { usage } from "./metering.js";
import { parseSse } from "./sse.js";
import type { ChatProvider, ChatRequest, FinishReason } from "./types.js";
import { CircuitBreaker } from "./resilience.js";
import { safeProviderFetch } from "../net/safe-fetch.js";
import { PRODUCT_NAME } from '../../shared/brand.js';
import { APP_VERSION } from '../../version.js';
export function createAnthropicProvider(
  apiKey?: string,
  baseUrl = "https://api.anthropic.com/v1",
): ChatProvider {
  const circuit = new CircuitBreaker();
  return {
    id: "anthropic",
    protocols: ["anthropic_messages"],
    configured: !!apiKey,
    supports: (m, r) =>
      m.provider === "anthropic" && r.protocol === "anthropic_messages",
    health: () => circuit.health(!!apiKey),
    async *stream(request): AsyncGenerator<import("./types.js").StreamEvent, void, void> {
      if (!apiKey)
        throw new NormalizedProviderError(
          "configuration",
          "anthropic",
          request.model,
          request.protocol,
          false,
          "This AI provider is not configured.",
        );
      try {
        const response = await safeProviderFetch(`${baseUrl}/messages`, {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
            "User-Agent": `${PRODUCT_NAME}/${APP_VERSION}`,
          },
          redirect: "error",
          signal: request.signal,
          body: JSON.stringify(anthropicBody(request)),
        });
        if (!response.ok)
          throw httpError(response.status, response.headers, {
            provider: "anthropic",
            model: request.model,
            protocol: request.protocol,
          });
        if (!response.body)
          throw new NormalizedProviderError(
            "empty_response",
            "anthropic",
            request.model,
            request.protocol,
            false,
            "The AI provider returned no stream.",
          );
        let started = false,
          terminal = false,
          inputTokens = 0,
          cachedInputTokens = 0,
          cacheWriteTokens = 0;
        for await (const record of parseSse(response.body, request.signal)) {
          let e: AnthropicEvent;
          try {
            e = JSON.parse(record.data) as AnthropicEvent;
          } catch {
            continue;
          }
          if (e.type === "message_start") {
            started = true;
            inputTokens = tokenCount(e.message?.usage?.input_tokens, inputTokens);
            cachedInputTokens = tokenCount(
              e.message?.usage?.cache_read_input_tokens,
              cachedInputTokens,
            );
            cacheWriteTokens = tokenCount(
              e.message?.usage?.cache_creation_input_tokens,
              cacheWriteTokens,
            );
            yield {
              type: "start",
              requestId: request.context.requestId,
              providerRequestId: e.message?.id,
              model: e.message?.model ?? request.model,
              createdAt: Date.now(),
            };
            if (e.message?.usage)
              yield {
                type: "usage",
                usage: usage(inputTokens, e.message.usage.output_tokens, {
                  cachedInputTokens,
                  cacheWriteTokens,
                }),
              };
          } else if (
            e.type === "content_block_start" &&
            e.content_block?.type === "tool_use"
          )
            yield {
              type: "tool_call_start",
              index: e.index ?? 0,
              callId: e.content_block.id ?? "",
              name: e.content_block.name ?? "",
            };
          else if (
            e.type === "content_block_delta" &&
            e.delta?.type === "text_delta" &&
            e.delta.text
          )
            yield {
              type: "text_delta",
              index: e.index ?? 0,
              delta: e.delta.text,
            };
          else if (
            e.type === "content_block_delta" &&
            e.delta?.type === "thinking_delta" &&
            e.delta.thinking
          )
            yield {
              type: "reasoning_delta",
              index: e.index ?? 0,
              delta: e.delta.thinking,
              visibility: "opaque",
            };
          else if (
            e.type === "content_block_delta" &&
            e.delta?.type === "input_json_delta" &&
            e.delta.partial_json
          )
            yield {
              type: "tool_call_delta",
              index: e.index ?? 0,
              callId: String(e.index ?? 0),
              argumentsDelta: e.delta.partial_json,
            };
          else if (e.type === "content_block_stop")
            yield {
              type: "tool_call_end",
              index: e.index ?? 0,
              callId: String(e.index ?? 0),
            };
          else if (e.type === "message_delta") {
            if (e.usage) {
              inputTokens = tokenCount(e.usage.input_tokens, inputTokens);
              cachedInputTokens = tokenCount(
                e.usage.cache_read_input_tokens,
                cachedInputTokens,
              );
              cacheWriteTokens = tokenCount(
                e.usage.cache_creation_input_tokens,
                cacheWriteTokens,
              );
              yield {
                type: "usage",
                // Anthropic sends input/cache counts on message_start and normally sends only the
                // cumulative output count on message_delta. Every emitted snapshot must remain
                // cumulative because downstream settlement intentionally keeps the latest one.
                usage: usage(inputTokens, e.usage.output_tokens, {
                  cachedInputTokens,
                  cacheWriteTokens,
                }),
              };
            }
            if (e.delta?.stop_reason) {
              terminal = true;
              yield {
                type: "finish",
                reason: anthropicFinish(e.delta.stop_reason),
                providerReason: e.delta.stop_reason,
              };
            }
          } else if (e.type === "error")
            throw new NormalizedProviderError(
              "provider_internal",
              "anthropic",
              request.model,
              request.protocol,
              true,
              "The AI provider stream failed.",
            );
        }
        if (!started)
          throw new NormalizedProviderError(
            "empty_response",
            "anthropic",
            request.model,
            request.protocol,
            false,
            "The AI provider returned no answer.",
          );
        if (!terminal) yield { type: "finish", reason: "unknown" };
        circuit.success();
      } catch (error) {
        circuit.failure();
        throw normalizeThrown(error, {
          provider: "anthropic",
          model: request.model,
          protocol: request.protocol,
        });
      }
    },
  };
}
export function anthropicBody(r: ChatRequest): Record<string, unknown> {
  const system = r.messages
    .filter((m) => m.role === "system" || m.role === "developer")
    .map((m) => textOf(m.content))
    .join("\n");
  const messages: unknown[] = r.messages
    .filter((m) => m.role !== "system" && m.role !== "developer")
    .map((m) => ({
      role: m.role === "tool" ? "user" : m.role,
      content: m.content.flatMap((p): unknown[] =>
        p.type === "text"
          ? [{ type: "text", text: p.text }]
          : p.type === "image"
            ? [
                {
                  type: "image",
                  source:
                    p.source.kind === "base64"
                      ? {
                          type: "base64",
                          media_type: p.mediaType,
                          data: p.source.data,
                        }
                      : { type: "url", url: dataUrl(p) },
                },
              ]
            : p.type === "document"
              ? [
                  p.mediaType === "application/pdf" &&
                  p.source.kind === "base64"
                    ? {
                        type: "document",
                        source: {
                          type: "base64",
                          media_type: p.mediaType,
                          data: p.source.data,
                        },
                        title: p.filename,
                      }
                    : { type: "text", text: documentText(p) },
                ]
              : [],
      ),
    }));
  return {
    model: r.model,
    system,
    messages,
    max_tokens: r.maxOutputTokens,
    stream: true,
    tools: r.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    })),
    ...(r.temperature !== undefined ? { temperature: r.temperature } : {}),
    ...(r.reasoningEffort !== "none"
      ? { output_config: { effort: r.reasoningEffort } }
      : {}),
  };
}
interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}
interface AnthropicEvent {
  type?: string;
  index?: number;
  message?: { id?: string; model?: string; usage?: AnthropicUsage };
  content_block?: { type?: string; id?: string; name?: string };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  usage?: AnthropicUsage;
}
function tokenCount(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value! >= 0 ? value! : fallback;
}
function anthropicFinish(r: string): FinishReason {
  return r === "end_turn" || r === "stop_sequence"
    ? "stop"
    : r === "max_tokens"
      ? "length"
      : r === "tool_use"
        ? "tool_call"
        : "unknown";
}

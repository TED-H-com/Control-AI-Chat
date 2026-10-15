import { dataUrl, textOf } from "./attachments.js";
import {
  NormalizedProviderError,
  httpError,
  normalizeThrown,
} from "./errors.js";
import { usage } from "./metering.js";
import { createCompatibleProvider } from "./openaiCompatible.js";
import { parseSse } from "./sse.js";
import type { ChatProvider, ChatRequest, ModelCatalogEntry } from "./types.js";
import { safeProviderFetch } from "../net/safe-fetch.js";
import { PRODUCT_NAME } from '../../shared/brand.js';
import { APP_VERSION } from '../../version.js';
export function createOpenAIProvider(
  apiKey?: string,
  baseUrl = "https://api.openai.com/v1",
): ChatProvider {
  const chat = createCompatibleProvider({ id: "openai", apiKey, baseUrl });
  return {
    id: "openai",
    protocols: ["openai_responses", "openai_chat_completions"],
    configured: !!apiKey,
    supports: (m, r) =>
      m.provider === "openai" &&
      (["openai_responses", "openai_chat_completions"] as string[]).includes(
        r.protocol,
      ),
    health: chat.health,
    stream: (request) =>
      request.protocol === "openai_chat_completions"
        ? chat.stream(request)
        : responsesStream(request, apiKey, baseUrl, "openai"),
  };
}
/**
 * The `input` array of a Responses request. An assistant turn replayed from history must be
 * `output_text`: the API rejects `input_text` on the assistant role outright with
 * `Invalid value: 'input_text'. Supported values are: 'output_text' and 'refusal'.` Because it is
 * only reached once a conversation already has an assistant turn in it, every OpenAI conversation
 * in the product worked for exactly one message and then failed on every message after — and any
 * probe that sends a single question and reads the reply saw nothing wrong.
 */
export function encodeResponsesInput(request: ChatRequest): unknown[] {
  return request.messages
    .filter((m) => m.role !== "system" && m.role !== "developer")
    .map((m) => ({
      role: m.role,
      content: m.content.flatMap((p): unknown[] =>
        p.type === "text"
          ? [
              {
                type: m.role === "assistant" ? "output_text" : "input_text",
                text: p.text,
              },
            ]
          : p.type === "image"
            ? [{ type: "input_image", image_url: dataUrl(p) }]
            : [],
      ),
    }));
}
export async function* responsesStream(
  request: ChatRequest,
  apiKey: string | undefined,
  baseUrl: string,
  provider: "openai" | "xai",
): AsyncGenerator<import("./types.js").StreamEvent, void, void> {
  if (!apiKey)
    throw new NormalizedProviderError(
      "configuration",
      provider,
      request.model,
      request.protocol,
      false,
      "This AI provider is not configured.",
    );
  const instructions = request.messages
    .filter((m) => m.role === "system" || m.role === "developer")
    .map((m) => textOf(m.content))
    .join("\n");
  const input: unknown[] = encodeResponsesInput(request);
  try {
    const response = await safeProviderFetch(`${baseUrl}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": `${PRODUCT_NAME}/${APP_VERSION}`,
      },
      redirect: "error",
      signal: request.signal,
      body: JSON.stringify({
        model: request.model,
        instructions,
        input,
        stream: true,
        store: false,
        max_output_tokens: request.maxOutputTokens,
        metadata: { request_id: request.context.requestId },
        tools: request.tools.map((t) => ({
          type: "function",
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        })),
        ...(request.reasoningEffort !== "none"
          ? { reasoning: { effort: request.reasoningEffort, summary: "auto" } }
          : {}),
      }),
    });
    if (!response.ok)
      throw httpError(response.status, response.headers, {
        provider,
        model: request.model,
        protocol: request.protocol,
      });
    if (!response.body)
      throw new NormalizedProviderError(
        "empty_response",
        provider,
        request.model,
        request.protocol,
        false,
        "The AI provider returned no stream.",
      );
    let started = false,
      terminal = false,
      content = false,
      refused = false;
    for await (const record of parseSse(response.body, request.signal)) {
      let event: ResponsesEvent;
      try {
        event = JSON.parse(record.data) as ResponsesEvent;
      } catch {
        continue;
      }
      if (!started) {
        started = true;
        yield {
          type: "start",
          requestId: request.context.requestId,
          providerRequestId: event.response?.id,
          model: event.response?.model ?? request.model,
          createdAt: Date.now(),
        };
      }
      if (event.type === "response.output_text.delta" && event.delta) {
        content = true;
        yield {
          type: "text_delta",
          index: event.output_index ?? 0,
          delta: event.delta,
        };
      } else if (event.type === "response.refusal.delta" && event.delta) {
        // Refusal text is the provider's user-facing answer, not private error detail. Preserve it
        // for the inbound gate instead of completing the chat with an empty assistant message.
        content = true;
        refused = true;
        yield {
          type: "text_delta",
          index: event.output_index ?? 0,
          delta: event.delta,
        };
      } else if (
        event.type === "response.reasoning_summary_text.delta" &&
        event.delta
      )
        yield {
          type: "reasoning_delta",
          index: event.output_index ?? 0,
          delta: event.delta,
          visibility: "summary",
        };
      else if (
        event.type === "response.function_call_arguments.delta" &&
        event.delta
      )
        yield {
          type: "tool_call_delta",
          index: event.output_index ?? 0,
          callId: event.item_id ?? "",
          argumentsDelta: event.delta,
        };
      else if (event.type === "response.completed") {
        const u = event.response?.usage;
        if (u)
          yield {
            type: "usage",
            usage: usage(u.input_tokens, u.output_tokens, {
              reasoningTokens: u.output_tokens_details?.reasoning_tokens ?? 0,
              cachedInputTokens: u.input_tokens_details?.cached_tokens ?? 0,
            }),
          };
        terminal = true;
        yield { type: "finish", reason: refused ? "content_filter" : "stop" };
      } else if (event.type === "response.incomplete") {
        const u = event.response?.usage;
        if (u)
          yield {
            type: "usage",
            usage: usage(u.input_tokens, u.output_tokens, {
              reasoningTokens: u.output_tokens_details?.reasoning_tokens ?? 0,
              cachedInputTokens: u.input_tokens_details?.cached_tokens ?? 0,
            }),
          };
        const providerReason=event.response?.incomplete_details?.reason ?? "incomplete";
        const reason=providerReason === "max_tokens" || providerReason === "max_output_tokens"
          ? "length"
          : providerReason === "content_filter" || providerReason === "safety_filter"
            ? "content_filter"
            : "unknown";
        terminal = true;
        yield { type: "finish", reason, providerReason };
      } else if (event.type === "response.failed" || event.type === "error")
        throw new NormalizedProviderError(
          "provider_internal",
          provider,
          request.model,
          request.protocol,
          !content,
          "The AI provider stream failed.",
          1,
          content,
        );
    }
    if (!started)
      throw new NormalizedProviderError(
        "empty_response",
        provider,
        request.model,
        request.protocol,
        false,
        "The AI provider returned no answer.",
      );
    if (!terminal) yield { type: "finish", reason: "unknown" };
  } catch (error) {
    throw normalizeThrown(error, {
      provider,
      model: request.model,
      protocol: request.protocol,
      partialOutput: false,
    });
  }
}
interface ResponsesEvent {
  type?: string;
  delta?: string;
  output_index?: number;
  item_id?: string;
  response?: {
    id?: string;
    model?: string;
    incomplete_details?: { reason?: string };
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      input_tokens_details?: { cached_tokens?: number };
      output_tokens_details?: { reasoning_tokens?: number };
    };
  };
}

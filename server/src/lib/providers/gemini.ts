import { dataUrl, documentText, textOf } from "./attachments.js";
import {
  NormalizedProviderError,
  httpError,
  normalizeThrown,
} from "./errors.js";
import { usage } from "./metering.js";
import { parseSse } from "./sse.js";
import type { ChatProvider, ChatRequest, FinishReason } from "./types.js";
import { safeProviderFetch } from "../net/safe-fetch.js";
import { PRODUCT_NAME } from '../../shared/brand.js';
import { APP_VERSION } from '../../version.js';
export function createGeminiProvider(
  apiKey?: string,
  baseUrl = "https://generativelanguage.googleapis.com/v1beta",
): ChatProvider {
  return {
    id: "google",
    protocols: ["google_generate_content"],
    configured: !!apiKey,
    supports: (m, r) =>
      m.provider === "google" && r.protocol === "google_generate_content",
    health: () => ({
      configured: !!apiKey,
      circuit: "closed",
      recentFailureRate: 0,
    }),
    async *stream(request) {
      if (!apiKey)
        throw new NormalizedProviderError(
          "configuration",
          "google",
          request.model,
          request.protocol,
          false,
          "This AI provider is not configured.",
        );
      try {
        const url = `${baseUrl}/models/${encodeURIComponent(request.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
        const response = await safeProviderFetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": `${PRODUCT_NAME}/${APP_VERSION}`,
          },
          redirect: "error",
          signal: request.signal,
          body: JSON.stringify(geminiBody(request)),
        });
        if (!response.ok)
          throw httpError(response.status, response.headers, {
            provider: "google",
            model: request.model,
            protocol: request.protocol,
          });
        if (!response.body)
          throw new NormalizedProviderError(
            "empty_response",
            "google",
            request.model,
            request.protocol,
            false,
            "The AI provider returned no stream.",
          );
        let started = false,
          terminal = false;
        for await (const record of parseSse(response.body, request.signal)) {
          let value: GeminiChunk;
          try {
            value = JSON.parse(record.data) as GeminiChunk;
          } catch {
            continue;
          }
          if (value.error)
            throw new NormalizedProviderError(
              "provider_internal",
              "google",
              request.model,
              request.protocol,
              true,
              "The AI provider stream failed.",
            );
          if (!started) {
            started = true;
            yield {
              type: "start",
              requestId: request.context.requestId,
              model: request.model,
              createdAt: Date.now(),
            };
          }
          for (const [index, part] of (
            value.candidates?.[0]?.content?.parts ?? []
          ).entries()) {
            if (part.text)
              yield part.thought
                ? {
                    type: "reasoning_delta",
                    index,
                    delta: part.text,
                    visibility: "opaque",
                  }
                : { type: "text_delta", index, delta: part.text };
            if (part.functionCall) {
              const id = `function-${index}`;
              yield {
                type: "tool_call_start",
                index,
                callId: id,
                name: part.functionCall.name,
              };
              yield {
                type: "tool_call_delta",
                index,
                callId: id,
                argumentsDelta: JSON.stringify(part.functionCall.args ?? {}),
              };
              yield { type: "tool_call_end", index, callId: id };
            }
          }
          const u = value.usageMetadata;
          if (u)
            yield {
              type: "usage",
              usage: usage(u.promptTokenCount, u.candidatesTokenCount, {
                reasoningTokens: u.thoughtsTokenCount ?? 0,
                cachedInputTokens: u.cachedContentTokenCount ?? 0,
              }),
            };
          const reason = value.candidates?.[0]?.finishReason;
          if (reason) {
            terminal = true;
            yield {
              type: "finish",
              reason: geminiFinish(reason),
              providerReason: reason,
            };
          }
        }
        if (!started)
          throw new NormalizedProviderError(
            "empty_response",
            "google",
            request.model,
            request.protocol,
            false,
            "The AI provider returned no answer.",
          );
        if (!terminal) yield { type: "finish", reason: "unknown" };
      } catch (error) {
        throw normalizeThrown(error, {
          provider: "google",
          model: request.model,
          protocol: request.protocol,
        });
      }
    },
  };
}
export function geminiBody(r: ChatRequest): Record<string, unknown> {
  const sys = r.messages
    .filter((m) => m.role === "system" || m.role === "developer")
    .map((m) => textOf(m.content))
    .join("\n");
  return {
    systemInstruction: { parts: [{ text: sys }] },
    contents: r.messages
      .filter((m) => m.role !== "system" && m.role !== "developer")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: m.content.flatMap((p): unknown[] =>
          p.type === "text"
            ? [{ text: p.text }]
            : p.type === "image"
              ? [
                  p.source.kind === "base64"
                    ? {
                        inlineData: {
                          mimeType: p.mediaType,
                          data: p.source.data,
                        },
                      }
                    : {
                        fileData: {
                          mimeType: p.mediaType,
                          fileUri: dataUrl(p),
                        },
                      },
                ]
              : p.type === "document"
                ? [{ text: `[${p.filename}]\n${documentText(p)}` }]
                : [],
        ),
      })),
    generationConfig: {
      maxOutputTokens: r.maxOutputTokens,
      ...(r.reasoningEffort !== "none"
        ? { thinkingConfig: { thinkingLevel: r.reasoningEffort } }
        : {}),
      ...(r.temperature !== undefined ? { temperature: r.temperature } : {}),
      ...(r.topP !== undefined ? { topP: r.topP } : {}),
    },
    tools: r.tools.length
      ? [
          {
            functionDeclarations: r.tools.map((t) => ({
              name: t.name,
              description: t.description,
              parameters: t.inputSchema,
            })),
          },
        ]
      : undefined,
  };
}
interface GeminiChunk {
  error?: unknown;
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        thought?: boolean;
        functionCall?: { name: string; args?: Record<string, unknown> };
      }>;
    };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    cachedContentTokenCount?: number;
  };
}
function geminiFinish(r: string): FinishReason {
  return r === "STOP"
    ? "stop"
    : r === "MAX_TOKENS"
      ? "length"
      : r.includes("SAFETY")
        ? "content_filter"
        : "unknown";
}

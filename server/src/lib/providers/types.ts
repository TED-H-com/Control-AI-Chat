export type ProviderId =
  | "openai"
  | "anthropic"
  | "google"
  | "xai"
  | "openrouter"
  | "venice"
  | "nvidia";
export type ProviderProtocol =
  | "openai_responses"
  | "openai_chat_completions"
  | "anthropic_messages"
  | "google_generate_content";
export type MessageRole =
  "system" | "developer" | "user" | "assistant" | "tool";
export type ReasoningEffort = "none" | "low" | "medium" | "high";
export type FinishReason =
  | "stop"
  | "length"
  | "tool_call"
  | "content_filter"
  | "cancelled"
  | "error"
  | "unknown";
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonSchema = Readonly<Record<string, JsonValue>>;
export interface TextPart {
  readonly type: "text";
  readonly text: string;
}
export interface ImagePart {
  readonly type: "image";
  readonly mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  readonly source:
    | { readonly kind: "base64"; readonly data: string }
    | { readonly kind: "url"; readonly url: string };
  readonly detail?: "auto" | "low" | "high";
  readonly attachmentId?: string;
}
export interface DocumentPart {
  readonly type: "document";
  readonly mediaType:
    "application/pdf" | "text/plain" | "text/markdown" | "text/csv";
  readonly filename: string;
  readonly source:
    | { readonly kind: "base64"; readonly data: string }
    | { readonly kind: "text"; readonly text: string };
  readonly attachmentId: string;
}
export interface ToolCallPart {
  readonly type: "tool_call";
  readonly id: string;
  readonly name: string;
  readonly argumentsJson: string;
}
export interface ToolResultPart {
  readonly type: "tool_result";
  readonly toolCallId: string;
  readonly content: readonly (TextPart | ImagePart)[];
  readonly isError: boolean;
}
export type ContentPart =
  TextPart | ImagePart | DocumentPart | ToolCallPart | ToolResultPart;
export interface ChatMessage {
  readonly id?: string;
  readonly role: MessageRole;
  readonly content: readonly ContentPart[];
  readonly name?: string;
}
export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly execution: "server";
  readonly timeoutMs: number;
  readonly maxResultBytes: number;
}
export interface ChatRequestContext {
  readonly requestId: string;
  readonly streamId: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly groupIds: readonly string[];
  readonly conversationId: string;
  readonly projectId?: string;
  readonly sourceMessageId: string;
  readonly locale: "en" | "zh-TW";
}
export interface ChatRequest {
  readonly context: ChatRequestContext;
  readonly provider: ProviderId;
  readonly protocol: ProviderProtocol;
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly ToolSpec[];
  readonly toolChoice: "auto" | "none" | { readonly name: string };
  readonly temperature?: number;
  readonly topP?: number;
  readonly maxOutputTokens: number;
  readonly reasoningEffort: ReasoningEffort;
  readonly stop: readonly string[];
  readonly seed?: number;
  readonly responseFormat?:
    | { readonly type: "text" }
    | { readonly type: "json_object" }
    | {
        readonly type: "json_schema";
        readonly name: string;
        readonly schema: JsonSchema;
      };
  readonly metadata: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}
export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteTokens: number;
  readonly toolInputTokens: number;
  readonly totalTokens: number;
  readonly estimated: boolean;
  readonly source: "provider" | "provider_partial" | "local_estimate";
}
export interface CostQuote {
  readonly currency: "USD";
  readonly inputMicros: number;
  readonly outputMicros: number;
  readonly reasoningMicros: number;
  readonly cacheReadMicros: number;
  readonly cacheWriteMicros: number;
  readonly toolMicros: number;
  readonly totalMicros: number;
  readonly priceVersionId: string;
  readonly estimated: boolean;
}
export interface Citation {
  readonly url: string;
  readonly title?: string;
  readonly startIndex?: number;
  readonly endIndex?: number;
}
export type StreamEvent =
  | {
      readonly type: "start";
      readonly requestId: string;
      readonly providerRequestId?: string | undefined;
      readonly model: string;
      readonly createdAt: number;
      readonly waitedMs?: number;
    }
  | {
      readonly type: "text_delta";
      readonly index: number;
      readonly delta: string;
    }
  | {
      readonly type: "reasoning_delta";
      readonly index: number;
      readonly delta: string;
      readonly visibility: "summary" | "opaque";
    }
  | {
      readonly type: "tool_call_start";
      readonly index: number;
      readonly callId: string;
      readonly name: string;
    }
  | {
      readonly type: "tool_call_delta";
      readonly index: number;
      readonly callId: string;
      readonly argumentsDelta: string;
    }
  | {
      readonly type: "tool_call_end";
      readonly index: number;
      readonly callId: string;
    }
  | { readonly type: "citation"; readonly citation: Citation }
  | { readonly type: "usage"; readonly usage: Usage }
  | {
      readonly type: "finish";
      readonly reason: FinishReason;
      readonly providerReason?: string | undefined;
    }
  | { readonly type: "error"; readonly error: ProviderError };
export type ProviderErrorKind =
  | "configuration"
  | "authentication"
  | "authorization"
  | "invalid_request"
  | "model_not_found"
  | "context_length"
  | "content_filter"
  | "rate_limit"
  | "quota_exhausted"
  | "timeout"
  | "cancelled"
  | "network"
  | "provider_overloaded"
  | "provider_internal"
  | "stream_protocol"
  | "empty_response"
  | "unknown";
export interface ProviderError extends Error {
  readonly name: "ProviderError";
  readonly kind: ProviderErrorKind;
  readonly provider: ProviderId;
  readonly model: string;
  readonly protocol: ProviderProtocol;
  readonly status?: number;
  readonly providerCode?: string;
  readonly providerRequestId?: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly attempt: number;
  readonly usage?: Usage;
  readonly partialOutput: boolean;
  readonly safeMessage: string;
  readonly cause?: unknown;
}
export interface ProviderHealth {
  readonly configured: boolean;
  readonly circuit: "closed" | "open" | "half_open";
  readonly openedUntil?: number;
  readonly recentFailureRate: number;
}
export interface ChatProvider {
  readonly id: ProviderId;
  readonly protocols: readonly ProviderProtocol[];
  readonly configured: boolean;
  supports(model: ModelCatalogEntry, request: ChatRequest): boolean;
  stream(request: ChatRequest): AsyncGenerator<StreamEvent, void, void>;
  health(): ProviderHealth;
}
export interface ModelModalities {
  readonly textInput: boolean;
  readonly textOutput: boolean;
  readonly imageInput: boolean;
  readonly pdfInput: boolean;
  readonly audioInput: boolean;
  readonly audioOutput: boolean;
}
export interface ModelCatalogEntry {
  readonly id: string;
  readonly provider: ProviderId;
  readonly protocol: ProviderProtocol;
  readonly upstreamModel: string;
  readonly displayName: string;
  readonly contextWindowTokens: number | null;
  readonly maxOutputTokens: number | null;
  readonly modalities: ModelModalities;
  readonly supportsTools: boolean;
  readonly supportsReasoning: boolean;
  readonly supportsReasoningStream: boolean;
  readonly inputUsdPerMillion: number | null;
  readonly outputUsdPerMillion: number | null;
  readonly cachedInputUsdPerMillion: number | null;
  readonly verification: "verified" | "verify";
  readonly verifiedAt: string | null;
  readonly notes?: string;
}

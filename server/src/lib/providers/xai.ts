import type { ChatProvider } from "./types.js";
import { createCompatibleProvider } from "./openaiCompatible.js";
import { responsesStream } from "./openai.js";
export function createXaiProvider(
  apiKey?: string,
  baseUrl = "https://api.x.ai/v1",
): ChatProvider {
  const chat = createCompatibleProvider({ id: "xai", apiKey, baseUrl });
  return {
    id: "xai",
    protocols: ["openai_responses", "openai_chat_completions"],
    configured: !!apiKey,
    supports: (m, r) =>
      m.provider === "xai" &&
      (r.protocol === "openai_responses" ||
        r.protocol === "openai_chat_completions"),
    health: chat.health,
    stream: (r) =>
      r.protocol === "openai_responses"
        ? responsesStream(r, apiKey, baseUrl, "xai")
        : chat.stream(r),
  };
}

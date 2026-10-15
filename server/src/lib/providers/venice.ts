import { createCompatibleProvider } from "./openaiCompatible.js";
export const createVeniceProvider = (
  apiKey?: string,
  baseUrl = "https://api.venice.ai/api/v1",
) =>
  createCompatibleProvider({
    id: "venice",
    apiKey,
    baseUrl,
    bodyExtension: () => ({
      venice_parameters: { include_venice_system_prompt: false },
    }),
  });

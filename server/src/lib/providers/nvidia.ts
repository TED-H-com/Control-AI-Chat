import { createCompatibleProvider } from "./openaiCompatible.js";
export const createNvidiaProvider = (
  apiKey?: string,
  baseUrl = "https://integrate.api.nvidia.com/v1",
) => createCompatibleProvider({ id: "nvidia", apiKey, baseUrl });

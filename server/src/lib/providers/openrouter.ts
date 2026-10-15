import { createCompatibleProvider } from "./openaiCompatible.js";
import { PRODUCT_NAME } from '../../shared/brand.js';
export const createOpenRouterProvider = (
  apiKey?: string,
  baseUrl = "https://openrouter.ai/api/v1",
  appOrigin = process.env.APP_ORIGIN?.trim() || "http://localhost:5173",
  workspaceName = PRODUCT_NAME,
) =>
  createCompatibleProvider({
    id: "openrouter",
    apiKey,
    baseUrl,
    headers: { "HTTP-Referer": appOrigin.replace(/\/$/, ""), "X-Title": workspaceName },
  });

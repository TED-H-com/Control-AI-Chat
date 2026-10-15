import type {
  ModelCatalogEntry,
  ProviderId,
  ProviderProtocol,
} from "./types.js";
const modalities = (image = false, pdf = false, audio = false) => ({
  textInput: true,
  textOutput: true,
  imageInput: image,
  pdfInput: pdf,
  audioInput: audio,
  audioOutput: false,
});
function row(
  id: string,
  provider: ProviderId,
  protocol: ProviderProtocol,
  options: {
    image?: boolean;
    pdf?: boolean;
    audio?: boolean;
    tools?: boolean;
    reasoning?: boolean;
    context?: number;
    output?: number;
    input?: number;
    priceOutput?: number;
    notes: string;
  },
): ModelCatalogEntry {
  return {
    id,
    provider,
    protocol,
    upstreamModel: id.slice(id.indexOf(":") + 1),
    displayName: id.slice(id.indexOf(":") + 1),
    contextWindowTokens: options.context ?? null,
    maxOutputTokens: options.output ?? null,
    modalities: modalities(options.image, options.pdf, options.audio),
    supportsTools: options.tools ?? false,
    supportsReasoning: options.reasoning ?? false,
    supportsReasoningStream: options.reasoning ?? false,
    inputUsdPerMillion: options.input ?? null,
    outputUsdPerMillion: options.priceOutput ?? null,
    cachedInputUsdPerMillion: null,
    verification: "verify",
    verifiedAt: null,
    notes: `VERIFY: ${options.notes}`,
  };
}
export const MODEL_CATALOG_SEED: readonly ModelCatalogEntry[] = [
  ...[
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5-pro",
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.4-mini",
  ].map((x) =>
    row(`openai:${x}`, "openai", "openai_responses", {
      image: true,
      tools: true,
      reasoning: true,
      notes: "name, limits, availability, and pricing",
    }),
  ),
  row("openai:o3", "openai", "openai_responses", {
    image: true,
    tools: true,
    reasoning: true,
    context: 200000,
    output: 100000,
    input: 2,
    priceOutput: 8,
    notes: "current availability and prices",
  }),
  row("openai:o4-mini", "openai", "openai_responses", {
    image: true,
    tools: true,
    reasoning: true,
    context: 200000,
    output: 100000,
    input: 1.1,
    priceOutput: 4.4,
    notes: "current availability and prices",
  }),
  ...[
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-sonnet-5",
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
  ].map((x) =>
    row(`anthropic:${x}`, "anthropic", "anthropic_messages", {
      image: true,
      pdf: true,
      tools: true,
      reasoning: true,
      notes: "official availability, limits, and pricing",
    }),
  ),
  ...[
    "gemini-3.1-pro-preview",
    "gemini-3.6-flash",
    "gemini-3.5-flash",
    "gemini-3-flash-preview",
    "gemini-3.1-flash-lite",
  ].map((x) =>
    row(`google:${x}`, "google", "google_generate_content", {
      image: true,
      pdf: true,
      audio: true,
      tools: true,
      reasoning: true,
      notes: "project/region availability, limits, and pricing",
    }),
  ),
  ...[
    "grok-4.5",
    "grok-4.3",
    "grok-4.20-0309-reasoning",
    "grok-4.20-0309-non-reasoning",
  ].map((x) =>
    row(`xai:${x}`, "xai", "openai_responses", {
      image: true,
      tools: true,
      reasoning: !x.includes("non-reasoning"),
      notes: "official availability, limits, and pricing",
    }),
  ),
  ...[
    "anthropic/claude-sonnet-4.5",
    "anthropic/claude-haiku-4.5",
    "openai/gpt-5",
    "google/gemini-2.5-pro",
    "google/gemini-2.5-flash",
    "x-ai/grok-4",
  ].map((x) =>
    row(`openrouter:${x}`, "openrouter", "openai_chat_completions", {
      notes: "live OpenRouter catalog capabilities and pricing",
    }),
  ),
  ...["llama-3.3-70b", "hermes-3-llama-3.1-405b", "qwen-3-6-plus"].map((x) =>
    row(`venice:${x}`, "venice", "openai_chat_completions", {
      reasoning: x.startsWith("qwen"),
      notes: "live Venice catalog capabilities and pricing",
    }),
  ),
  ...[
    "meta/llama-3.3-70b-instruct",
    "openai/gpt-oss-120b",
    "google/gemma-4-31b-it",
  ].map((x) =>
    row(`nvidia:${x}`, "nvidia", "openai_chat_completions", {
      reasoning: x.includes("gpt-oss"),
      notes: "live NIM availability, capabilities, and pricing",
    }),
  ),
];

export interface DefaultCatalogSeed {
  readonly provider:ProviderId;readonly model:string;readonly displayName:string;
  readonly contextWindow:number;readonly maxOutputTokens:number;
  readonly inputMicrousdPerMillion:number;readonly outputMicrousdPerMillion:number;
  readonly cachedInputMicrousdPerMillion:number|null;readonly capabilities:readonly string[];
  readonly speedClass:'fast'|'balanced'|'slow';readonly qualityTier:number;readonly multiModelEligible:boolean;
  readonly vendorJurisdiction:string;readonly processingRegion:string;
}

/** Editable starting values for a new workspace, not authoritative provider prices. */
export const DEFAULT_CATALOG_SEED:readonly DefaultCatalogSeed[]=[
  {provider:'openai',model:'gpt-5.4',displayName:'GPT-5.4',contextWindow:1_000_000,maxOutputTokens:128_000,inputMicrousdPerMillion:2_500_000,outputMicrousdPerMillion:15_000_000,cachedInputMicrousdPerMillion:250_000,capabilities:['text','files','reasoning'],speedClass:'balanced',qualityTier:3,multiModelEligible:false,vendorJurisdiction:'us',processingRegion:'unknown'},
  {provider:'openai',model:'gpt-5.4-mini',displayName:'GPT-5.4 mini',contextWindow:400_000,maxOutputTokens:128_000,inputMicrousdPerMillion:750_000,outputMicrousdPerMillion:4_500_000,cachedInputMicrousdPerMillion:75_000,capabilities:['text','files','reasoning'],speedClass:'fast',qualityTier:1,multiModelEligible:true,vendorJurisdiction:'us',processingRegion:'unknown'},
  {provider:'anthropic',model:'claude-sonnet-4-6',displayName:'Claude Sonnet 4.6',contextWindow:200_000,maxOutputTokens:64_000,inputMicrousdPerMillion:3_000_000,outputMicrousdPerMillion:15_000_000,cachedInputMicrousdPerMillion:300_000,capabilities:['text','files','reasoning'],speedClass:'balanced',qualityTier:3,multiModelEligible:false,vendorJurisdiction:'us',processingRegion:'unknown'},
  {provider:'anthropic',model:'claude-haiku-4-5',displayName:'Claude Haiku 4.5',contextWindow:200_000,maxOutputTokens:64_000,inputMicrousdPerMillion:1_000_000,outputMicrousdPerMillion:5_000_000,cachedInputMicrousdPerMillion:100_000,capabilities:['text','files'],speedClass:'fast',qualityTier:1,multiModelEligible:true,vendorJurisdiction:'us',processingRegion:'unknown'},
  {provider:'google',model:'gemini-3.1-pro-preview',displayName:'Gemini 3.1 Pro Preview',contextWindow:1_048_576,maxOutputTokens:65_536,inputMicrousdPerMillion:2_000_000,outputMicrousdPerMillion:12_000_000,cachedInputMicrousdPerMillion:200_000,capabilities:['text','files','reasoning'],speedClass:'balanced',qualityTier:3,multiModelEligible:false,vendorJurisdiction:'us',processingRegion:'global'},
  {provider:'google',model:'gemini-3.1-flash-lite',displayName:'Gemini 3.1 Flash Lite',contextWindow:1_048_576,maxOutputTokens:65_536,inputMicrousdPerMillion:250_000,outputMicrousdPerMillion:1_500_000,cachedInputMicrousdPerMillion:25_000,capabilities:['text','files','reasoning'],speedClass:'fast',qualityTier:1,multiModelEligible:true,vendorJurisdiction:'us',processingRegion:'global'},
  {provider:'xai',model:'grok-4.5',displayName:'Grok 4.5',contextWindow:256_000,maxOutputTokens:32_768,inputMicrousdPerMillion:2_000_000,outputMicrousdPerMillion:6_000_000,cachedInputMicrousdPerMillion:300_000,capabilities:['text','reasoning'],speedClass:'balanced',qualityTier:3,multiModelEligible:false,vendorJurisdiction:'us',processingRegion:'unknown'},
  {provider:'openrouter',model:'anthropic/claude-haiku-4.5',displayName:'Claude Haiku 4.5 via OpenRouter',contextWindow:200_000,maxOutputTokens:64_000,inputMicrousdPerMillion:1_000_000,outputMicrousdPerMillion:5_000_000,cachedInputMicrousdPerMillion:null,capabilities:['text','files'],speedClass:'fast',qualityTier:1,multiModelEligible:true,vendorJurisdiction:'unknown',processingRegion:'unknown'},
  {provider:'venice',model:'llama-3.3-70b',displayName:'Llama 3.3 70B via Venice',contextWindow:131_072,maxOutputTokens:16_384,inputMicrousdPerMillion:700_000,outputMicrousdPerMillion:2_800_000,cachedInputMicrousdPerMillion:null,capabilities:['text'],speedClass:'fast',qualityTier:1,multiModelEligible:true,vendorJurisdiction:'non_us',processingRegion:'unknown'},
  {provider:'nvidia',model:'meta/llama-3.3-70b-instruct',displayName:'Llama 3.3 70B via NVIDIA',contextWindow:131_072,maxOutputTokens:16_384,inputMicrousdPerMillion:0,outputMicrousdPerMillion:0,cachedInputMicrousdPerMillion:null,capabilities:['text'],speedClass:'fast',qualityTier:1,multiModelEligible:true,vendorJurisdiction:'us',processingRegion:'unknown'},
];

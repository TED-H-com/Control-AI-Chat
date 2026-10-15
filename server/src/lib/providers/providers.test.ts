import test from "node:test";
import assert from "node:assert/strict";
import { createVeniceProvider } from "./venice.js";
import { ProviderRegistry } from "./registry.js";
import { encodeChatRequest } from "./openaiCompatible.js";
import { encodeResponsesInput, responsesStream } from "./openai.js";
import { anthropicBody, createAnthropicProvider } from "./anthropic.js";
import { geminiBody } from "./gemini.js";
import type { ChatRequest, StreamEvent } from "./types.js";

function request(): ChatRequest {
  return { context:{requestId:"r",streamId:"s",tenantId:"t",userId:"u",groupIds:[],conversationId:"c",sourceMessageId:"m",locale:"en"},provider:"venice",protocol:"openai_chat_completions",model:"fixture-model",messages:[{role:"user",content:[{type:"text",text:"hello"}]}],tools:[],toolChoice:"none",maxOutputTokens:10,reasoningEffort:"none",stop:[],metadata:{},signal:new AbortController().signal };
}

test("registry boots with every optional key absent", () => {
  const registry = new ProviderRegistry({});
  assert.equal(registry.get("openai").configured, false);
  assert.equal(registry.get("anthropic").configured, false);
  assert.equal(registry.get("google").configured, false);
});

test("OpenAI-compatible fixture normalizes reasoning, text, usage, and Venice request", async (t) => {
  const original = globalThis.fetch;
  let sent = "";
  globalThis.fetch = async (_input, init) => {
    sent = String(init?.body);
    const fixture = [
      `data: ${JSON.stringify({id:"upstream",model:"actual",choices:[{delta:{reasoning_content:"private thought"}}]})}\n\n`,
      `data: ${JSON.stringify({choices:[{delta:{content:"answer"}}],usage:{prompt_tokens:5,completion_tokens:2}})}\n\n`,
      `data: ${JSON.stringify({choices:[{delta:{},finish_reason:"stop"}]})}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
    return new Response(fixture,{status:200,headers:{"content-type":"text/event-stream"}});
  };
  t.after(() => { globalThis.fetch = original; });
  const events: StreamEvent[]=[];
  for await (const event of createVeniceProvider("fixture-key").stream(request())) events.push(event);
  assert.equal(events.find(e=>e.type==="reasoning_delta")?.type,"reasoning_delta");
  assert.equal(events.find(e=>e.type==="text_delta"&&e.delta==="answer")?.type,"text_delta");
  assert.match(sent,/"include_venice_system_prompt":false/);
});

test("a request with no tools sends neither tools nor tool_choice", () => {
  // xAI answers 400 `A tool_choice was set on the request but no tools were specified` and the
  // product turned that into "The model request failed", so every Grok model was dead on arrival
  // while the same key and model answered a hand-written curl. The chat path sends no tools at all
  // and always sets toolChoice 'none', which is exactly the pair xAI refuses. Asserting the keys are
  // absent rather than that the value is right, because sending `tools:[]` alongside a `tool_choice`
  // is what a reasonable-looking encoder does and is precisely the shape that fails.
  const body = encodeChatRequest(request());
  assert.equal("tool_choice" in body, false, "tool_choice must not be sent without tools");
  assert.equal("tools" in body, false, "an empty tools array invites tool_choice back");

  const withTool = encodeChatRequest({ ...request(), tools:[{name:"lookup",description:"d",inputSchema:{type:"object"},execution:"server",timeoutMs:5_000,maxResultBytes:4_096}], toolChoice:"auto" });
  assert.equal(withTool.tool_choice, "auto");
  assert.equal((withTool.tools as unknown[]).length, 1);
});

test("assistant history is replayed to the Responses API as output_text", () => {
  // `Invalid value: 'input_text'. Supported values are: 'output_text' and 'refusal'.` — the API
  // refuses input_text on the assistant role, and that branch is only reached once a conversation
  // already has an assistant turn. So every OpenAI conversation in the product answered the first
  // message and failed every one after it, and a probe that asks one question and reads the reply
  // sees a healthy provider. Two turns is the smallest case that tells the truth.
  const base = request();
  const input = encodeResponsesInput({ ...base, provider:"openai", protocol:"openai_responses", messages:[
    { role:"user", content:[{type:"text",text:"Say OK"}] },
    { role:"assistant", content:[{type:"text",text:"OK"}] },
    { role:"user", content:[{type:"text",text:"Again"}] },
  ]}) as {role:string;content:{type:string}[]}[];
  assert.deepEqual(input.map(m=>[m.role,m.content[0]!.type]), [
    ["user","input_text"],["assistant","output_text"],["user","input_text"],
  ]);
});

test("Responses streaming preserves refusal text as a content-filtered answer", async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response([
    'data: {"type":"response.created","response":{"id":"refusal-request","model":"fixture-model"}}\n\n',
    'data: {"type":"response.refusal.delta","output_index":0,"delta":"I cannot help with that."}\n\n',
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":8,"output_tokens":6}}}\n\n',
  ].join(""), {status:200,headers:{"content-type":"text/event-stream"}});
  t.after(() => { globalThis.fetch = original; });

  const events:StreamEvent[]=[];
  for await (const event of responsesStream(
    {...request(),provider:"openai",protocol:"openai_responses"},"fixture-key","https://api.openai.com/v1","openai",
  )) events.push(event);
  assert.equal(events.find(event=>event.type==="text_delta")?.delta,"I cannot help with that.");
  assert.deepEqual(events.at(-1),{type:"finish",reason:"content_filter"});
});

test("Responses streaming settles incomplete max-token output with final usage", async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response([
    'data: {"type":"response.created","response":{"id":"incomplete-request","model":"fixture-model"}}\n\n',
    'data: {"type":"response.output_text.delta","output_index":0,"delta":"Partial answer"}\n\n',
    'data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"},"usage":{"input_tokens":9,"output_tokens":10,"input_tokens_details":{"cached_tokens":2},"output_tokens_details":{"reasoning_tokens":3}}}}\n\n',
  ].join(""), {status:200,headers:{"content-type":"text/event-stream"}});
  t.after(() => { globalThis.fetch = original; });

  const events:StreamEvent[]=[];
  for await (const event of responsesStream(
    {...request(),provider:"openai",protocol:"openai_responses"},"fixture-key","https://api.openai.com/v1","openai",
  )) events.push(event);
  const measured=events.find((event):event is Extract<StreamEvent,{type:"usage"}>=>event.type==="usage");
  assert.deepEqual(measured?.usage,{inputTokens:9,outputTokens:10,reasoningTokens:3,cachedInputTokens:2,cacheWriteTokens:0,toolInputTokens:0,totalTokens:19,estimated:false,source:"provider"});
  assert.deepEqual(events.at(-1),{type:"finish",reason:"length",providerReason:"max_output_tokens"});
});

test("Anthropic final usage retains input and cache counts from message_start", async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response([
    `data: ${JSON.stringify({type:"message_start",message:{id:"anthropic-request",model:"claude-fixture",usage:{input_tokens:37,output_tokens:0,cache_read_input_tokens:11,cache_creation_input_tokens:5}}})}\n\n`,
    `data: ${JSON.stringify({type:"content_block_delta",index:0,delta:{type:"text_delta",text:"answer"}})}\n\n`,
    `data: ${JSON.stringify({type:"message_delta",delta:{stop_reason:"end_turn"},usage:{output_tokens:9}})}\n\n`,
  ].join(""), {status:200,headers:{"content-type":"text/event-stream"}});
  t.after(() => { globalThis.fetch = original; });

  const events:StreamEvent[]=[];
  for await (const event of createAnthropicProvider("fixture-key").stream({
    ...request(),provider:"anthropic",protocol:"anthropic_messages",model:"claude-fixture",
  })) events.push(event);
  const snapshots=events.filter((event):event is Extract<StreamEvent,{type:"usage"}>=>event.type==="usage");
  assert.equal(snapshots.length,2);
  assert.deepEqual(snapshots.at(-1)?.usage,{
    inputTokens:37,outputTokens:9,reasoningTokens:0,cachedInputTokens:11,
    cacheWriteTokens:5,toolInputTokens:0,totalTokens:46,estimated:false,source:"provider",
  });
});

test("reasoning effort reaches each provider's supported request field", async (t) => {
  const anthropic = anthropicBody({
    ...request(),
    provider: "anthropic",
    protocol: "anthropic_messages",
    reasoningEffort: "low",
  });
  assert.deepEqual(anthropic.output_config, { effort: "low" });
  assert.equal("thinking" in anthropic, false);

  const gemini = geminiBody({
    ...request(),
    provider: "google",
    protocol: "google_generate_content",
    reasoningEffort: "medium",
  });
  assert.deepEqual(gemini.generationConfig, {
    maxOutputTokens: 10,
    thinkingConfig: { thinkingLevel: "medium" },
  });

  const grok = encodeChatRequest({
    ...request(),
    provider: "xai",
    reasoningEffort: "high",
  });
  assert.equal(grok.reasoning_effort, "high");
  assert.equal("reasoning_effort" in encodeChatRequest(request()), false);

  const original = globalThis.fetch;
  let sent = "";
  globalThis.fetch = async (_input, init) => {
    sent = String(init?.body);
    return new Response(
      'data: {"type":"response.completed","response":{"id":"upstream","model":"fixture-model"}}\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
  t.after(() => { globalThis.fetch = original; });
  for await (const _event of responsesStream(
    { ...request(), provider: "openai", protocol: "openai_responses", reasoningEffort: "high" },
    "fixture-key",
    "https://api.openai.com/v1",
    "openai",
  )) {
    // Consume the stream so the request is issued.
  }
  assert.deepEqual(JSON.parse(sent).reasoning, { effort: "high", summary: "auto" });
});

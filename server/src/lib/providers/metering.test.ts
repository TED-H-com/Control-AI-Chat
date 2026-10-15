import test from "node:test";
import assert from "node:assert/strict";
import type { ChatRequest } from './types.js';
import { estimateUsage, quoteCost, usage } from "./metering.js";

test("cost accounting uses integer micro-USD and separates cached/reasoning tokens", () => {
  const measured = usage(1_000_000, 500_000, { cachedInputTokens: 200_000, reasoningTokens: 100_000 });
  const quote = quoteCost(measured, { id: "price-1", inputMicrosPerMillion: 2_000_000, outputMicrosPerMillion: 8_000_000, reasoningMicrosPerMillion: 8_000_000, cacheReadMicrosPerMillion: 500_000, cacheWriteMicrosPerMillion: 0, toolMicrosPerCall: 0 });
  assert.equal(quote.totalMicros, 5_700_000);
});

test('local usage fallback estimates all text parts from UTF-8 bytes',()=>{
  const input='資料治理 🧑‍💻',output='已完成 ✅';
  const request:ChatRequest={context:{requestId:'request',streamId:'stream',tenantId:'tenant',userId:'user',groupIds:[],conversationId:'conversation',sourceMessageId:'message',locale:'zh-TW'},provider:'openai',protocol:'openai_responses',model:'model',messages:[{role:'system',content:[{type:'text',text:'規則'}]},{role:'user',content:[{type:'text',text:input},{type:'image',mediaType:'image/png',source:{kind:'base64',data:'ignored'}}]}],tools:[],toolChoice:'none',maxOutputTokens:100,reasoningEffort:'none',stop:[],metadata:{},signal:new AbortController().signal};
  const measured=estimateUsage(request,output),allInput=`規則${input}`;
  assert.equal(measured.inputTokens,Math.ceil(Buffer.byteLength(allInput,'utf8')/3));
  assert.equal(measured.outputTokens,Math.ceil(Buffer.byteLength(output,'utf8')/3));
  assert.equal(measured.totalTokens,measured.inputTokens+measured.outputTokens);assert.equal(measured.estimated,true);assert.equal(measured.source,'local_estimate');
});

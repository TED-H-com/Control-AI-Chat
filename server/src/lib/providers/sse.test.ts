import test from "node:test";
import assert from "node:assert/strict";
import { parseSse } from "./sse.js";

function bytes(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

test("SSE reconstructs split UTF-8, CRLF, and multiline data", async () => {
  const encoded = new TextEncoder().encode("data: 你\r\ndata: 好\r\n\r\n");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoded.slice(0, 8));
      controller.enqueue(encoded.slice(8));
      controller.close();
    },
  });
  const records = [];
  for await (const record of parseSse(stream, new AbortController().signal)) records.push(record);
  assert.deepEqual(records, [{ data: "你\n好" }]);
});

test("SSE ignores comments and preserves data whitespace", async () => {
  const records = [];
  for await (const record of parseSse(bytes([": ping\n\ndata:  x \n\n"]), new AbortController().signal)) records.push(record);
  assert.equal(records[0]?.data, " x ");
});

import type { ApiError,StreamEvent } from '@shared/types';
import { ApiClientError,fetchWithSessionRefresh } from '../api.js';

export interface ParsedSse { id: number | null; event: StreamEvent }
export class ChatHttpError extends Error {constructor(readonly status:number){super(`Chat request failed (${status})`);}}

function closesRequestStream(event:StreamEvent):boolean {
  if(event.event==='run.completed'||event.event==='run.failed'||event.event==='run.cancelled')return true;
  return event.event==='run.status'&&(event.data.status==='awaiting_confirmation'||event.data.status==='awaiting_approval');
}

export async function* parseSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<ParsedSse> {
  const reader = stream.getReader(); const decoder = new TextDecoder(); let buffer = '';
  try {
    for (;;) {
      const read = await reader.read(); buffer += decoder.decode(read.value, {stream:!read.done});
      const normalized = buffer.replace(/\r\n/g, '\n'); let boundary = normalized.indexOf('\n\n');
      if (boundary < 0) { buffer = normalized; if (read.done) break; continue; }
      buffer = normalized;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0,boundary); buffer = buffer.slice(boundary+2);
        if (!frame || frame.startsWith(':')) continue;
        const lines=frame.split('\n'); const eventName=lines.find(line=>line.startsWith('event:'))?.slice(6).trim();
        const rawId=lines.find(line=>line.startsWith('id:'))?.slice(3).trim();
        const data=lines.filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
        if (!eventName || !data) continue;
        try { yield {id:rawId && /^\d+$/.test(rawId) ? Number(rawId) : null,event:{event:eventName,data:JSON.parse(data)} as StreamEvent}; } catch { /* malformed frames are safely skipped */ }
      }
      if (read.done) break;
    }
  } finally { reader.releaseLock(); }
}

export async function streamRequest(path:string, body:unknown, signal:AbortSignal, onEvent:(event:StreamEvent)=>void): Promise<void> {
  // Every run route is declared `idempotency:true`, so without this header the server answers
  // `400 Idempotency-Key is required` and no message sent from a browser ever reached a model —
  // send, regenerate and edit-resend all failed identically, while the same call made by hand with
  // the header worked, which is how the chat surface came to be probed as healthy for so long.
  // Each caller already mints a `clientRequestId` per submission; reusing it is what makes a retry
  // of the same message collapse onto the one run instead of billing the tenant for two.
  const key=(body as {clientRequestId?:unknown}|null)?.clientRequestId;
  const response=await fetchWithSessionRefresh(path,{method:'POST',headers:{Accept:'text/event-stream','Content-Type':'application/json','Idempotency-Key':typeof key==='string'&&key?key:crypto.randomUUID()},body:JSON.stringify(body),signal});
  if (!response.ok) {
    try {
      const body=await response.json() as ApiError;
      if(body&&typeof body==='object'&&body.error&&typeof body.error.code==='string')throw new ApiClientError(response.status,body);
    } catch(error) {
      if(error instanceof ApiClientError)throw error;
    }
    throw new ChatHttpError(response.status);
  }
  if (!response.body) throw new Error('Chat stream was unavailable');
  let lastId=-1,closed=false;
  for await (const item of parseSse(response.body)) { if (item.id !== null && item.id <= lastId) continue; if (item.id !== null) lastId=item.id; onEvent(item.event);closed=closed||closesRequestStream(item.event); }
  // A clean transport EOF is not a completed run. Treat it as recoverable failure so ChatApp leaves
  // its busy state instead of disabling the composer forever while the durable run continues.
  if(!signal.aborted&&!closed)throw new Error('Chat stream ended before a terminal state');
}

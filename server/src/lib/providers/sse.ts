export interface SseRecord {
  readonly event?: string;
  readonly data: string;
  readonly id?: string;
  readonly retry?: number;
}
const MAX = 1024 * 1024;
export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<SseRecord, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let buffer = "";
  const abort = () => void reader.cancel(signal.reason).catch(() => {});
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      if (buffer.length > MAX) throw new Error("SSE record exceeds 1 MiB");
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const record = parseFrame(frame);
        if (record) yield record;
      }
      if (done) {
        if (buffer) {
          const record = parseFrame(buffer);
          if (record) yield record;
        }
        break;
      }
    }
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}
function parseFrame(frame: string): SseRecord | undefined {
  let event: string | undefined,
    id: string | undefined,
    retry: number | undefined;
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "event") event = value;
    else if (field === "id" && !value.includes("\0")) id = value;
    else if (field === "retry" && /^\d+$/.test(value)) retry = Number(value);
  }
  if (data.length === 0) return;
  return {
    data: data.join("\n"),
    ...(event !== undefined ? { event } : {}),
    ...(id !== undefined ? { id } : {}),
    ...(retry !== undefined ? { retry } : {}),
  };
}

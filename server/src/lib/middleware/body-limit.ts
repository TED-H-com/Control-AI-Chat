import { bodyLimit } from 'hono/body-limit';
import type { MiddlewareHandler } from 'hono';

export const DEFAULT_JSON_LIMIT=1024*1024;
// The extractor accepts 25 MiB of file bytes. Leave one MiB for the multipart boundary, filename and
// project field so the edge does not reject a file the application contract says is valid.
export const DEFAULT_UPLOAD_LIMIT=26*1024*1024;

export function requestSizeLimit(options:{readonly maxBytes?:number}={}):MiddlewareHandler {
  const maxSize=options.maxBytes??DEFAULT_JSON_LIMIT;
  return bodyLimit({maxSize,onError:c=>c.json({error:{code:'PAYLOAD_TOO_LARGE',message:`Request body exceeds ${maxSize} bytes`,retryable:false}},413)});
}

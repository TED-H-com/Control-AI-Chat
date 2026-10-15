import { Worker } from 'node:worker_threads';
import type { Extractor, ExtractorContext, ExtractionOutcome } from './types.js';
import { MIME } from './types.js';

// Extraction is serialized to bound worker memory use on small production hosts.
export const MAX_ACTIVE_EXTRACTIONS=1,MAX_QUEUED_EXTRACTIONS=8;
const queue:Array<{bytes:Uint8Array;context:ExtractorContext;resolve:(value:ExtractionOutcome)=>void}>=[];
let activeExtractions=0;

function isolatedNow(bytes:Uint8Array,context:ExtractorContext):Promise<ExtractionOutcome> {
  return new Promise(resolve=>{
    // Keep the caller's buffer intact for hashing and blob persistence. A single explicit copy is
    // transferred into the worker instead of asking structured clone to allocate another hidden copy.
    const transferred=new Uint8Array(bytes);
    // Node 22 cannot attach tsx's ESM resolver inside a worker thread, so source-level tests use
    // the freshly compiled worker. Production already runs from dist and keeps the adjacent URL.
    const workerUrl=new URL(import.meta.url).pathname.endsWith('.ts')
      ?new URL('../../../dist/lib/extraction/worker.js',import.meta.url)
      :new URL('./worker.js',import.meta.url);
    const worker=new Worker(workerUrl,{workerData:{bytes:transferred,mimeType:context.mimeType,limits:context.limits},transferList:[transferred.buffer],resourceLimits:{maxOldGenerationSizeMb:384,maxYoungGenerationSizeMb:64,stackSizeMb:8}});
    let settled=false; const done=(value:ExtractionOutcome)=>{if(settled)return;settled=true;clearTimeout(timer);resolve(value);};
    const timer=setTimeout(()=>{void worker.terminate();done({status:'error',code:'EXTRACTION_TIMEOUT',mimeType:context.mimeType,warnings:[],gateRequired:true});},context.limits.timeoutMs);
    worker.once('message',(value:ExtractionOutcome)=>done(value));
    worker.once('error',()=>done({status:'error',code:'EXTRACTION_FAILED',mimeType:context.mimeType,warnings:[],gateRequired:true}));
    worker.once('exit',code=>{if(code!==0)done({status:'error',code:'EXTRACTION_FAILED',mimeType:context.mimeType,warnings:[],gateRequired:true});});
  });
}

function launch(job:{bytes:Uint8Array;context:ExtractorContext;resolve:(value:ExtractionOutcome)=>void}):void {
  activeExtractions++;
  void isolatedNow(job.bytes,job.context).catch(()=>({status:'error' as const,code:'EXTRACTION_FAILED' as const,mimeType:job.context.mimeType,warnings:[],gateRequired:true as const})).then(job.resolve).finally(()=>{
    activeExtractions--;
    const next=queue.shift();if(next)launch(next);
  });
}

function isolated(bytes:Uint8Array,context:ExtractorContext):Promise<ExtractionOutcome> {
  return new Promise(resolve=>{
    const job={bytes,context,resolve};
    if(activeExtractions<MAX_ACTIVE_EXTRACTIONS)launch(job);
    else if(queue.length<MAX_QUEUED_EXTRACTIONS)queue.push(job);
    else resolve({status:'error',code:'EXTRACTION_BUSY',mimeType:context.mimeType,warnings:[],gateRequired:true});
  });
}

export class PdfExtractor implements Extractor { readonly id='pdf'; readonly mimeTypes=new Set([MIME.pdf]); extract=isolated; }
export class OfficeExtractor implements Extractor { readonly id='ooxml'; readonly mimeTypes=new Set([MIME.docx,MIME.xlsx,MIME.pptx]); extract=isolated; }
export class TextExtractor implements Extractor {
  readonly id='text'; readonly mimeTypes=new Set([MIME.text,MIME.csv,MIME.markdown]);
  extract=isolated;
}

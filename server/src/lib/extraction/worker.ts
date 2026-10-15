import { parentPort, workerData } from 'node:worker_threads';
import { ArchiveSecurityError, safeZipFiles } from './archive.js';
import { detectLanguage } from './language.js';
import { sanitizeExtractedText } from './security.js';
import { MIME, type ExtractionLimits, type ExtractionOutcome, type ExtractionWarning } from './types.js';

interface Job { bytes: Uint8Array; mimeType: string; limits: ExtractionLimits }
const xmlText=(xml:string) => xml.replace(/<f\b[^>]*>[\s\S]*?<\/f>/gi,'').replace(/<w:instrText\b[^>]*>[\s\S]*?<\/w:instrText>/gi,'').replace(/<w:tab\b[^>]*\/?\s*>/gi,'\t').replace(/<w:br\b[^>]*\/?\s*>/gi,'\n').replace(/<\/w:p>|<\/a:p>|<\/row>/gi,'\n').replace(/<[^>]+>/g,'').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&apos;/g,"'");
function finish(mimeType:string, raw:string, unitCount:number, unitKind:'document'|'page'|'sheet'|'slide', limits:ExtractionLimits, warnings:ExtractionWarning[]=[]):ExtractionOutcome {
  const safe=sanitizeExtractedText(raw,limits.maxExtractedCharacters);
  if(safe.removedControls) warnings.push('CONTROL_CHARACTERS_REMOVED');
  if(safe.truncated) warnings.push('TEXT_TRUNCATED');
  const language=detectLanguage(safe.text); if(!language) warnings.push('LANGUAGE_UNDETERMINED');
  return {status:'ok',mimeType,text:safe.text,unitCount,unitKind,language,truncated:safe.truncated,warnings,gateRequired:true};
}

function text(job:Job):ExtractionOutcome {
  try {
    if(job.bytes.includes(0))return {status:'error',code:'CORRUPT_FILE',mimeType:job.mimeType,warnings:[],gateRequired:true};
    const raw=new TextDecoder('utf-8',{fatal:true}).decode(job.bytes);
    return finish(job.mimeType,raw,1,'document',job.limits);
  } catch {
    return {status:'error',code:'CORRUPT_FILE',mimeType:job.mimeType,warnings:[],gateRequired:true};
  }
}

async function office(job:Job):Promise<ExtractionOutcome> {
  const isDoc=job.mimeType===MIME.docx,isSheet=job.mimeType===MIME.xlsx;
  const wanted=(name:string)=> isDoc ? name==='word/document.xml' : isSheet ? name==='xl/sharedStrings.xml'||/^xl\/worksheets\/sheet\d+\.xml$/.test(name) : /^ppt\/slides\/slide\d+\.xml$/.test(name);
  const files=safeZipFiles(job.bytes,job.limits,wanted);
  const required=isDoc?'word/document.xml':null;
  if(required&&!files.has(required)) return {status:'error',code:'CORRUPT_FILE',mimeType:job.mimeType,warnings:[],gateRequired:true};
  if(isSheet){const shared=[...(files.get('xl/sharedStrings.xml')??'').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)].map(match=>xmlText(match[1]??''));for(const [name,xml] of files){if(!/^xl\/worksheets\//.test(name))continue;files.set(name,xml.replace(/<c\b([^>]*)\bt=["']s["']([^>]*)>([\s\S]*?)<\/c>/gi,(_all:string,a:string,b:string,body:string)=>{const index=Number(/<v\b[^>]*>(\d+)<\/v>/i.exec(body)?.[1]);return `<c${a}${b}><v>${shared[index]??''}</v></c>`;}));}}
  const ordered=[...files.entries()].sort(([a],[b])=>a.localeCompare(b,undefined,{numeric:true}));
  const content=ordered.filter(([name])=>!name.endsWith('sharedStrings.xml'));
  const raw=content.map(([,xml])=>xmlText(xml)).join('\n\n');
  return finish(job.mimeType,raw,isDoc?1:content.length,isDoc?'page':isSheet?'sheet':'slide',job.limits,['EXTERNAL_REFERENCES_REMOVED']);
}

async function pdf(job:Job):Promise<ExtractionOutcome> {
  const source=Buffer.from(job.bytes).toString('latin1');
  if(/\/Encrypt\b/.test(source)) return {status:'error',code:'ENCRYPTED_FILE',mimeType:job.mimeType,warnings:[],gateRequired:true};
  try {
    const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
    const options={data:job.bytes.slice(),isEvalSupported:false};
    const loadingTask=getDocument(options);
    let parsed:{text:string;numpages:number};
    try {
      const doc=await loadingTask.promise;
      try {
        const numpages=doc.numPages;
        if(numpages>job.limits.maxPages) return {status:'error',code:'PAGE_LIMIT_EXCEEDED',mimeType:job.mimeType,warnings:['PAGE_LIMIT_REACHED'],gateRequired:true};
        const pages:string[]=[];
        for(let pageNumber=1;pageNumber<=Math.min(numpages,job.limits.maxPages);pageNumber++) {
          const page=await doc.getPage(pageNumber);
          const content=await page.getTextContent();
          pages.push(content.items.map(item=>'str' in item?item.str:'').join(' '));
          page.cleanup();
        }
        parsed={text:pages.join('\n\n'),numpages};
      } finally {
        await doc.cleanup();
      }
    } finally {
      await loadingTask.destroy();
    }
    if(parsed.text.trim()) return finish(job.mimeType,parsed.text,parsed.numpages,'page',job.limits);
    return {status:'error',code:'EXTRACTION_FAILED',mimeType:job.mimeType,warnings:[],gateRequired:true};
  } catch(error) {
    const code=(error as NodeJS.ErrnoException).code;
    if(code==='MODULE_NOT_FOUND'||code==='ERR_MODULE_NOT_FOUND') return {status:'error',code:'EXTRACTION_FAILED',mimeType:job.mimeType,warnings:[],gateRequired:true};
    if(code==='CORRUPT_FILE')return {status:'error',code,mimeType:job.mimeType,warnings:[],gateRequired:true};
    if(code==='ETIMEDOUT')return {status:'error',code:'EXTRACTION_TIMEOUT',mimeType:job.mimeType,warnings:[],gateRequired:true};
    return {status:'error',code:'CORRUPT_FILE',mimeType:job.mimeType,warnings:[],gateRequired:true};
  }
}

async function main(job:Job):Promise<ExtractionOutcome> {
  try { if([MIME.text,MIME.csv,MIME.markdown].includes(job.mimeType as typeof MIME.text))return text(job);if(job.mimeType===MIME.pdf) return await pdf(job); return await office(job); }
  catch(error) { if(error instanceof ArchiveSecurityError) return {status:'error',code:error.code,mimeType:job.mimeType,warnings:[],gateRequired:true};const code=(error as NodeJS.ErrnoException).code;if(code==='CORRUPT_FILE')return {status:'error',code,mimeType:job.mimeType,warnings:[],gateRequired:true};return {status:'error',code:code==='ETIMEDOUT'?'EXTRACTION_TIMEOUT':'EXTRACTION_FAILED',mimeType:job.mimeType,warnings:[],gateRequired:true}; }
}
void main(workerData as Job).then(result=>parentPort?.postMessage(result));

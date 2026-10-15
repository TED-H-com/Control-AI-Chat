import { ArchiveSecurityError, safeZipFiles } from './archive.js';
import { OfficeExtractor, PdfExtractor, TextExtractor } from './extractors.js';
import { failure, mergeLimits, sniffMime } from './security.js';
import { MIME, type Extractor, type ExtractionOutcome, type ExtractionRequest } from './types.js';

const supported=new Set<string>(Object.values(MIME));
const textTypes=new Set<string>([MIME.text,MIME.csv,MIME.markdown]);
const declaredAliases:Readonly<Record<string,string>>={
  'application/csv':MIME.csv,
  'application/vnd.ms-excel':MIME.csv,
  'text/x-csv':MIME.csv,
  'text/md':MIME.markdown,
  'text/x-markdown':MIME.markdown,
};
const textSuffixes:Readonly<Record<string,string>>={'.txt':MIME.text,'.csv':MIME.csv,'.md':MIME.markdown,'.markdown':MIME.markdown};
function declaredMime(value:string|undefined):string|undefined {
  if(!value)return undefined;
  const normalized=value.toLowerCase().split(';',1)[0]!.trim();
  return declaredAliases[normalized]??normalized;
}
function textMime(request:ExtractionRequest):string|null {
  const declared=declaredMime(request.declaredMimeType);
  if(declared&&textTypes.has(declared))return declared;
  const name=request.filename?.toLowerCase()??'';
  return Object.entries(textSuffixes).find(([suffix])=>name.endsWith(suffix))?.[1]??null;
}
function officeMime(bytes:Uint8Array, limits:ReturnType<typeof mergeLimits>):string|null {
  const files=safeZipFiles(bytes,limits,name=>name==='[Content_Types].xml'); const xml=files.get('[Content_Types].xml')??'';
    if(xml.includes('wordprocessingml.document.main+xml')) return MIME.docx;
    if(xml.includes('spreadsheetml.sheet.main+xml')) return MIME.xlsx;
    if(xml.includes('presentationml.presentation.main+xml')) return MIME.pptx;
  return null;
}

export class ExtractorRegistry {
  readonly #byMime=new Map<string,Extractor>();
  register(extractor:Extractor):this { for(const mime of extractor.mimeTypes){if(this.#byMime.has(mime))throw new Error(`Extractor already registered: ${mime}`);this.#byMime.set(mime,extractor);} return this; }
  async extract(request:ExtractionRequest):Promise<ExtractionOutcome> {
    const limits=mergeLimits(request.limits); if(request.bytes.byteLength>limits.maxFileBytes)return failure('FILE_TOO_LARGE',null);
    const declared=declaredMime(request.declaredMimeType);
    let detected=sniffMime(request.bytes); if(detected==='application/zip'){try{detected=officeMime(request.bytes,limits);}catch(error){if(error instanceof ArchiveSecurityError)return failure(error.code,null);return failure('CORRUPT_FILE',null);}}
    if(detected===null)detected=textMime(request);
    if(!detected||!supported.has(detected))return failure('UNSUPPORTED_TYPE',detected);
    if(declared&&declared!==detected)return failure('MIME_MISMATCH',detected);
    const extractor=this.#byMime.get(detected); if(!extractor)return failure('UNSUPPORTED_TYPE',detected);
    return extractor.extract(request.bytes,{mimeType:detected,limits});
  }
}
export function createDefaultExtractorRegistry():ExtractorRegistry { return new ExtractorRegistry().register(new TextExtractor()).register(new PdfExtractor()).register(new OfficeExtractor()); }

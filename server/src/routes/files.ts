const allowedText=new Set(['text/plain','text/csv','text/markdown']);
const pdf='application/pdf';
const docx='application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export interface ExtractedUpload { readonly mimeType:string; readonly text:string; }

function starts(bytes:Uint8Array,signature:readonly number[]):boolean { return signature.every((value,index)=>bytes[index]===value); }
export function sniffUpload(bytes:Uint8Array,declared:string):string|null {
  if(starts(bytes,[0x4d,0x5a])||starts(bytes,[0x7f,0x45,0x4c,0x46])||starts(bytes,[0xcf,0xfa,0xed,0xfe])||starts(bytes,[0xfe,0xed,0xfa,0xcf])) return null;
  if(starts(bytes,[0x25,0x50,0x44,0x46,0x2d])) return pdf;
  if(starts(bytes,[0x50,0x4b,0x03,0x04])&&declared===docx) return docx;
  if(allowedText.has(declared)&&!bytes.includes(0)) return declared;
  return null;
}

/** Safe built-in extraction. Rich PDF/DOCX extraction is supplied by the file service. */
export function extractUpload(bytes:Uint8Array,declared:string):ExtractedUpload {
  const mimeType=sniffUpload(bytes,declared); if(!mimeType) throw new Error('FILE_TYPE_NOT_ALLOWED');
  if(allowedText.has(mimeType)) return {mimeType,text:new TextDecoder('utf-8',{fatal:true}).decode(bytes)};
  if(mimeType===pdf) {
    const source=new TextDecoder('latin1').decode(bytes); const fragments=[...source.matchAll(/\(([^()\\]{1,4096})\)\s*Tj/g)].map(match=>match[1] ?? '');
    if(fragments.length) return {mimeType,text:fragments.join('\n')};
    throw new Error('FILE_SCAN_FAILED: PDF requires the configured document extractor');
  }
  throw new Error('FILE_SCAN_FAILED: DOCX requires the configured document extractor');
}

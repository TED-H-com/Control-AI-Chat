import { MIME, type ExtractionErrorCode, type ExtractionFailure, type ExtractionLimits } from './types.js';

export const DEFAULT_EXTRACTION_LIMITS: ExtractionLimits = Object.freeze({
  maxFileBytes: 25 * 1024 * 1024,
  maxExtractedCharacters: 2_000_000,
  maxPages: 300,
  timeoutMs: 30_000,
  maxDecompressedBytes: 100 * 1024 * 1024,
  maxCompressionRatio: 100,
});

export function failure(code: ExtractionErrorCode, mimeType: string | null): ExtractionFailure {
  return { status: 'error', code, mimeType, warnings: [], gateRequired: true };
}

export function sanitizeExtractedText(input: string, limit: number): { text: string; truncated: boolean; removedControls: boolean } {
  const source=input[Symbol.iterator](),inputChunks:string[]=[];
  let inputChunk='',retainedPoints=0,target=Math.max(1,limit+1),inputDone=false,removedControls=false,previousCr=false;
  const retain=(point:string):void=>{
    inputChunk+=point;retainedPoints++;
    if(inputChunk.length>=16_384){inputChunks.push(inputChunk);inputChunk='';}
  };
  const normalizedOutput=():{text:string;overflow:boolean}=>{
    const normalized=[...inputChunks,inputChunk].join('').normalize('NFKC'),outputChunks:string[]=[];
    let outputChunk='',outputPoints=0,overflow=false;
    for(const point of normalized){
      const code=point.codePointAt(0)!;
      if((code<=0x08)||(code>=0x0b&&code<=0x0c)||(code>=0x0e&&code<=0x1f)||code===0x7f){removedControls=true;continue;}
      if(outputPoints>=limit){overflow=true;break;}
      outputChunk+=point;outputPoints++;
      if(outputChunk.length>=16_384){outputChunks.push(outputChunk);outputChunk='';}
    }
    if(outputChunk)outputChunks.push(outputChunk);
    return {text:outputChunks.join(''),overflow};
  };

  // Normalize only enough input to fill the bounded output. If composition contracts the prefix,
  // grow it geometrically and try again. Removed controls are scanned but never accumulated.
  while(true){
    while(retainedPoints<target){
      const next=source.next();
      if(next.done){inputDone=true;break;}
      const point=next.value;
      if(previousCr){previousCr=false;if(point==='\n')continue;}
      if(point==='\r'){retain('\n');previousCr=true;continue;}
      const code=point.codePointAt(0)!;
      if((code<=0x08)||(code>=0x0b&&code<=0x0c)||(code>=0x0e&&code<=0x1f)||code===0x7f){removedControls=true;continue;}
      retain(point);
    }
    const output=normalizedOutput();
    if(output.overflow||inputDone)return {text:output.text,truncated:output.overflow,removedControls};
    target=Math.max(target+1,target*2);
  }
}

export function sniffMime(bytes: Uint8Array): string | null {
  const ascii = (start: number, end: number) => Buffer.from(bytes.subarray(start, end)).toString('ascii');
  // Keep executable signatures distinguishable from unknown data. A text-looking executable must
  // never fall through to the UTF-8 extractor merely because its declared type or suffix says text.
  if (ascii(0,2) === 'MZ' || ascii(0,4) === '\u007fELF'
    || (bytes[0] === 0xcf && bytes[1] === 0xfa && bytes[2] === 0xed && bytes[3] === 0xfe)
    || (bytes[0] === 0xfe && bytes[1] === 0xed && bytes[2] === 0xfa && bytes[3] === 0xcf)) return 'application/x-executable';
  if (ascii(0, 5) === '%PDF-') return MIME.pdf;
  if (bytes[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return 'application/zip';
  return null;
}

export interface ImageDimensions { readonly width:number;readonly height:number }
const u16be=(bytes:Uint8Array,offset:number):number => bytes[offset]!*256+bytes[offset+1]!;
const u16le=(bytes:Uint8Array,offset:number):number => bytes[offset]!+bytes[offset+1]!*256;
const u24le=(bytes:Uint8Array,offset:number):number => bytes[offset]!+bytes[offset+1]!*256+bytes[offset+2]!*65536;

/** Reads dimensions from headers only; no compressed pixels are decoded. */
export function imageDimensions(bytes:Uint8Array,mimeType:string):ImageDimensions|null {
  if(mimeType==='image/png'){
    if(bytes.byteLength<24||Buffer.from(bytes.subarray(12,16)).toString('ascii')!=='IHDR')return null;
    const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),width=view.getUint32(16),height=view.getUint32(20);
    return width&&height?{width,height}:null;
  }
  if(mimeType==='image/jpeg'){
    if(bytes.byteLength<4||bytes[0]!==0xff||bytes[1]!==0xd8)return null;
    const sof=new Set([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]);
    let offset=2;
    while(offset+3<bytes.byteLength){
      while(offset<bytes.byteLength&&bytes[offset]!==0xff)offset++;
      while(offset<bytes.byteLength&&bytes[offset]===0xff)offset++;
      const marker=bytes[offset++];if(marker===undefined||marker===0xd9||marker===0xda)break;
      if(marker===0x01||(marker>=0xd0&&marker<=0xd7))continue;
      if(offset+1>=bytes.byteLength)return null;
      const length=u16be(bytes,offset);if(length<2||offset+length>bytes.byteLength)return null;
      if(sof.has(marker)){if(length<7)return null;const height=u16be(bytes,offset+3),width=u16be(bytes,offset+5);return width&&height?{width,height}:null;}
      offset+=length;
    }
    return null;
  }
  if(mimeType==='image/webp'){
    if(bytes.byteLength<30||Buffer.from(bytes.subarray(0,4)).toString('ascii')!=='RIFF'||Buffer.from(bytes.subarray(8,12)).toString('ascii')!=='WEBP')return null;
    const chunk=Buffer.from(bytes.subarray(12,16)).toString('ascii');
    if(chunk==='VP8X')return {width:u24le(bytes,24)+1,height:u24le(bytes,27)+1};
    if(chunk==='VP8L'&&bytes[20]===0x2f){const width=1+bytes[21]!+((bytes[22]!&0x3f)<<8),height=1+(bytes[22]!>>6)+(bytes[23]!<<2)+((bytes[24]!&0x0f)<<10);return {width,height};}
    if(chunk==='VP8 '&&bytes[23]===0x9d&&bytes[24]===0x01&&bytes[25]===0x2a)return {width:u16le(bytes,26)&0x3fff,height:u16le(bytes,28)&0x3fff};
  }
  return null;
}

export function imagePixelsAllowed(dimensions:ImageDimensions,limit:number):boolean {
  return Number.isSafeInteger(dimensions.width)&&Number.isSafeInteger(dimensions.height)&&dimensions.width>0&&dimensions.height>0
    &&dimensions.width<=16_384&&dimensions.height<=16_384&&dimensions.width*dimensions.height<=limit;
}

export function mergeLimits(overrides?: Partial<ExtractionLimits>): ExtractionLimits {
  const limits = { ...DEFAULT_EXTRACTION_LIMITS, ...overrides };
  for (const value of Object.values(limits)) if (!Number.isFinite(value) || value <= 0) throw new RangeError('Extraction limits must be positive');
  return limits;
}

import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createDefaultExtractorRegistry, MIME } from './index.js';
import { MAX_ACTIVE_EXTRACTIONS, MAX_QUEUED_EXTRACTIONS } from './extractors.js';
import { sanitizeExtractedText } from './security.js';

interface Entry { name:string; data:Buffer; compressed?:Buffer }
function zip(input:readonly Entry[]):Buffer {
  const locals:Buffer[]=[]; const centrals:Buffer[]=[]; let offset=0;
  for(const item of input){const name=Buffer.from(item.name),data=item.data,compressed=item.compressed??deflateRawSync(data); const local=Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(8,8);local.writeUInt32LE(compressed.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(name.length,26);
    locals.push(local,name,compressed);const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(8,10);central.writeUInt32LE(compressed.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(name.length,28);central.writeUInt32LE(offset,42);centrals.push(central,name);offset+=local.length+name.length+compressed.length;}
  const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(input.length,8);end.writeUInt16LE(input.length,10);const cs=Buffer.concat(centrals);end.writeUInt32LE(cs.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...locals,cs,end]);
}
const types=(main:string)=>Buffer.from(`<?xml version="1.0"?><Types><Override ContentType="${main}"/></Types>`);
function docx(document:string, extra:readonly Entry[]=[]):Buffer{return zip([{name:'[Content_Types].xml',data:types('application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml')},{name:'word/document.xml',data:Buffer.from(document)},...extra]);}

const scannedPdf=readFileSync(new URL('./fixtures/scanned-image-only.pdf',import.meta.url));
const encryptedPdf=readFileSync(new URL('./fixtures/encrypted.pdf',import.meta.url));
const twoPagePdf=readFileSync(new URL('./fixtures/two-page.pdf',import.meta.url));
const registry=createDefaultExtractorRegistry();

test('extracts DOCX text and labels it gate-required',async()=>{const out=await registry.extract({bytes:docx('<w:document><w:body><w:p><w:r><w:t>Quarterly confidential report</w:t></w:r></w:p></w:body></w:document>'),declaredMimeType:MIME.docx});assert.equal(out.status,'ok');if(out.status==='ok'){assert.match(out.text,/Quarterly confidential/);assert.equal(out.gateRequired,true);}});
test('extracts text from a real multi-page PDF',async()=>{const out=await registry.extract({bytes:twoPagePdf,declaredMimeType:MIME.pdf});assert.equal(out.status,'ok');if(out.status==='ok'){assert.equal(out.unitCount,2);assert.match(out.text,/First page extraction marker/);assert.match(out.text,/Second page extraction marker/);}});
test('enforces PDF page limit',async()=>{const out=await registry.extract({bytes:twoPagePdf,declaredMimeType:MIME.pdf,limits:{maxPages:1}});assert.equal(out.status,'error');if(out.status==='error')assert.equal(out.code,'PAGE_LIMIT_EXCEEDED');});
test('extracts XLSX sheets without executing formulas',async()=>{const bytes=zip([{name:'[Content_Types].xml',data:types('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml')},{name:'xl/worksheets/sheet1.xml',data:Buffer.from('<worksheet><row><c><f>WEBSERVICE("https://attacker.invalid")</f><v>Safe cached value</v></c></row></worksheet>')}]);const out=await registry.extract({bytes,declaredMimeType:MIME.xlsx});assert.equal(out.status,'ok');if(out.status==='ok'){assert.equal(out.unitKind,'sheet');assert.doesNotMatch(out.text,/WEBSERVICE|attacker/);assert.match(out.text,/Safe cached value/);}});
test('extracts PPTX slides',async()=>{const bytes=zip([{name:'[Content_Types].xml',data:types('application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml')},{name:'ppt/slides/slide1.xml',data:Buffer.from('<p:sld><a:p><a:r><a:t>Board presentation</a:t></a:r></a:p></p:sld>')}]);const out=await registry.extract({bytes,declaredMimeType:MIME.pptx});assert.equal(out.status,'ok');if(out.status==='ok'){assert.equal(out.unitKind,'slide');assert.match(out.text,/Board presentation/);}});
test('rejects encrypted/password PDF explicitly',async()=>{const out=await registry.extract({bytes:encryptedPdf,declaredMimeType:MIME.pdf});assert.equal(out.status,'error');if(out.status==='error')assert.equal(out.code,'ENCRYPTED_FILE');});
test('reports an image-only PDF as having no extractable text',async()=>{const out=await registry.extract({bytes:scannedPdf,declaredMimeType:MIME.pdf});assert.equal(out.status,'error');if(out.status==='error')assert.equal(out.code,'EXTRACTION_FAILED');});
test('rejects ZIP bomb from metadata before decompression',async()=>{const bomb=Buffer.alloc(2_000_000,65);const bytes=docx('<w:document/>',[{name:'word/media/bomb.bin',data:bomb}]);const out=await registry.extract({bytes,declaredMimeType:MIME.docx,limits:{maxCompressionRatio:10}});assert.equal(out.status,'error');if(out.status==='error')assert.equal(out.code,'ARCHIVE_BOMB');});
test('rejects XXE-laden DOCX',async()=>{const xxe='<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><w:document><w:t>&xxe;</w:t></w:document>';const out=await registry.extract({bytes:docx(xxe),declaredMimeType:MIME.docx});assert.equal(out.status,'error');if(out.status==='error')assert.equal(out.code,'UNSAFE_XML');});
test('rejects archive traversal',async()=>{const bytes=docx('<w:document/>',[{name:'../escape',data:Buffer.from('x')}]);const out=await registry.extract({bytes,declaredMimeType:MIME.docx});assert.equal(out.status,'error');});
test('MIME sniffing is authoritative',async()=>{const out=await registry.extract({bytes:scannedPdf,declaredMimeType:MIME.docx});assert.equal(out.status,'error');if(out.status==='error')assert.equal(out.code,'MIME_MISMATCH');});
test('extracts UTF-8 text using common browser CSV and Markdown MIME aliases',async()=>{
  for(const input of [
    {bytes:Buffer.from('name,value\nalpha,1'),filename:'report.csv',declaredMimeType:'application/vnd.ms-excel',mime:MIME.csv},
    {bytes:Buffer.from('# Review\nSafe text'),filename:'review.md',declaredMimeType:'text/x-markdown; charset=utf-8',mime:MIME.markdown},
    {bytes:Buffer.from('name,value\nalpha,1'),filename:'report.csv',mime:MIME.csv},
  ]){
    const out=await registry.extract(input);assert.equal(out.status,'ok');if(out.status==='ok')assert.equal(out.mimeType,input.mime);
  }
});
test('an executable signature cannot fall through to text extraction',async()=>{
  const out=await registry.extract({bytes:Buffer.from([0x4d,0x5a,0x90,0,3,0]),filename:'setup.txt',declaredMimeType:MIME.text});
  assert.equal(out.status,'error');if(out.status==='error')assert.equal(out.code,'UNSUPPORTED_TYPE');
});
test('refuses image uploads as unsupported',async()=>{
  const png=Buffer.from('89504e470d0a1a0a0000000d49484452','hex');
  const out=await registry.extract({bytes:png,filename:'image.png',declaredMimeType:'image/png'});
  assert.equal(out.status,'error');if(out.status==='error')assert.equal(out.code,'UNSUPPORTED_TYPE');
});
test('bounds concurrent extraction workers and explicitly refuses excess queue capacity',async()=>{
  const bytes=docx('<w:document><w:body><w:p><w:r><w:t>bounded</w:t></w:r></w:p></w:body></w:document>');
  const outcomes=await Promise.all(Array.from({length:MAX_ACTIVE_EXTRACTIONS+MAX_QUEUED_EXTRACTIONS+1},()=>registry.extract({bytes,declaredMimeType:MIME.docx})));
  assert.equal(outcomes.filter(outcome=>outcome.status==='error'&&outcome.code==='EXTRACTION_BUSY').length,1);
  assert.equal(outcomes.filter(outcome=>outcome.status==='ok').length,MAX_ACTIVE_EXTRACTIONS+MAX_QUEUED_EXTRACTIONS);
});
test('text extraction shares the bounded worker queue and honours its deadline',async()=>{
  const bytes=Buffer.from('bounded text extraction');
  const outcomes=await Promise.all(Array.from({length:MAX_ACTIVE_EXTRACTIONS+MAX_QUEUED_EXTRACTIONS+1},()=>registry.extract({bytes,filename:'evidence.txt',declaredMimeType:MIME.text})));
  assert.equal(outcomes.filter(outcome=>outcome.status==='error'&&outcome.code==='EXTRACTION_BUSY').length,1);
  assert.equal(outcomes.filter(outcome=>outcome.status==='ok').length,MAX_ACTIVE_EXTRACTIONS+MAX_QUEUED_EXTRACTIONS);
  const timedOut=await registry.extract({bytes:Buffer.alloc(1024*1024,65),filename:'large.txt',declaredMimeType:MIME.text,limits:{timeoutMs:1}});
  assert.equal(timedOut.status,'error');if(timedOut.status==='error')assert.equal(timedOut.code,'EXTRACTION_TIMEOUT');
});
test('large text extraction is capped off the main event loop',async()=>{
  const bytes=Buffer.alloc(25*1024*1024,65);let heartbeats=0,lastHeartbeat=performance.now(),maxHeartbeatGap=0;
  const heartbeat=setInterval(()=>{const current=performance.now();maxHeartbeatGap=Math.max(maxHeartbeatGap,current-lastHeartbeat);lastHeartbeat=current;heartbeats++;},2);
  await new Promise(resolve=>setTimeout(resolve,5));
  try {
    const out=await registry.extract({bytes,filename:'large.txt',declaredMimeType:MIME.text,limits:{maxExtractedCharacters:4096}});
    assert.equal(out.status,'ok');if(out.status==='ok'){assert.equal(out.text.length,4096);assert.equal(out.truncated,true);assert(out.warnings.includes('TEXT_TRUNCATED'));}
    await new Promise(resolve=>setTimeout(resolve,5));
  } finally {clearInterval(heartbeat);}
  assert(heartbeats>0,'worker extraction must yield to the server event loop');
  assert(maxHeartbeatGap<150,`main event loop stalled for ${maxHeartbeatGap.toFixed(1)}ms while copying or extracting text`);
});
test('bounded sanitization preserves normalization, CRLF handling, controls, and code-point limits',()=>{
  assert.deepEqual(sanitizeExtractedText('Ａ\r\nB\u0000C😀tail',4),{text:'A\nBC',truncated:true,removedControls:true});
  assert.deepEqual(sanitizeExtractedText('A\u030a',1),{text:'Å',truncated:false,removedControls:false});
  assert.deepEqual(sanitizeExtractedText('A\u030aA\u030a',1),{text:'Å',truncated:true,removedControls:false});
});

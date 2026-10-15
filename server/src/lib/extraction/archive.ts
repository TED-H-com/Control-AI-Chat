import { inflateRawSync } from 'node:zlib';
import type { ExtractionLimits } from './types.js';

interface ZipEntry { name: string; compressed: number; uncompressed: number; method: number; flags: number; localOffset: number; }
export class ArchiveSecurityError extends Error { constructor(readonly code: 'ARCHIVE_BOMB'|'ARCHIVE_PATH_TRAVERSAL'|'CORRUPT_FILE'|'ENCRYPTED_FILE'|'UNSAFE_XML') { super(code); } }

function entries(bytes: Uint8Array, limits: ExtractionLimits): ZipEntry[] {
  const b = Buffer.from(bytes); const found: ZipEntry[] = []; let total = 0;
  for (let i = 0; i <= b.length - 46; i++) {
    if (b.readUInt32LE(i) !== 0x02014b50) continue;
    const flags=b.readUInt16LE(i+8), method=b.readUInt16LE(i+10), compressed=b.readUInt32LE(i+20), uncompressed=b.readUInt32LE(i+24);
    const nameLength=b.readUInt16LE(i+28), extraLength=b.readUInt16LE(i+30), commentLength=b.readUInt16LE(i+32);
    if (i+46+nameLength+extraLength+commentLength>b.length) throw new ArchiveSecurityError('CORRUPT_FILE');
    const name=b.subarray(i+46,i+46+nameLength).toString('utf8');
    if (!name || name.includes('\0') || name.startsWith('/') || name.startsWith('\\') || /^[A-Za-z]:/.test(name) || name.split(/[\\/]/).includes('..')) throw new ArchiveSecurityError('ARCHIVE_PATH_TRAVERSAL');
    if (flags & 1) throw new ArchiveSecurityError('ENCRYPTED_FILE');
    total += uncompressed;
    if (total>limits.maxDecompressedBytes || (uncompressed>1024 && uncompressed/Math.max(1,compressed)>limits.maxCompressionRatio)) throw new ArchiveSecurityError('ARCHIVE_BOMB');
    found.push({name,compressed,uncompressed,method,flags,localOffset:b.readUInt32LE(i+42)});
    i += 45+nameLength+extraLength+commentLength;
  }
  if (!found.length) throw new ArchiveSecurityError('CORRUPT_FILE');
  return found;
}

export function safeZipFiles(bytes: Uint8Array, limits: ExtractionLimits, wanted: (name:string)=>boolean): Map<string,string> {
  const b=Buffer.from(bytes), result=new Map<string,string>();
  for (const entry of entries(bytes,limits)) {
    if (!wanted(entry.name)) continue;
    const o=entry.localOffset;
    if (o+30>b.length || b.readUInt32LE(o)!==0x04034b50) throw new ArchiveSecurityError('CORRUPT_FILE');
    const start=o+30+b.readUInt16LE(o+26)+b.readUInt16LE(o+28), end=start+entry.compressed;
    if (end>b.length) throw new ArchiveSecurityError('CORRUPT_FILE');
    let out: Buffer;
    if(entry.method===0) out=b.subarray(start,end); else if(entry.method===8) out=inflateRawSync(b.subarray(start,end),{maxOutputLength:limits.maxDecompressedBytes}); else throw new ArchiveSecurityError('CORRUPT_FILE');
    if(out.length!==entry.uncompressed) throw new ArchiveSecurityError('CORRUPT_FILE');
    const xml=out.toString('utf8');
    if(/<!DOCTYPE|<!ENTITY|SYSTEM\s+["']|PUBLIC\s+["']/i.test(xml)) throw new ArchiveSecurityError('UNSAFE_XML');
    result.set(entry.name,xml);
  }
  return result;
}


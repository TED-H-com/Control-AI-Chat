import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { IdentityError } from './types.js';
import { PRODUCT_NAME } from '../../shared/brand.js';

const ALPHABET='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const RECOVERY_ALPHABET='ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
function base32Encode(input:Buffer):string { let bits=0,value=0,out=''; for(const byte of input){value=(value<<8)|byte;bits+=8;while(bits>=5){out+=ALPHABET[(value>>>(bits-5))&31];bits-=5;}} if(bits) out+=ALPHABET[(value<<(5-bits))&31]; return out; }
function base32Decode(input:string):Buffer { let bits=0,value=0;const out:number[]=[];for(const char of input.replace(/=+$/,'').toUpperCase()){const i=ALPHABET.indexOf(char);if(i<0)throw new IdentityError('MFA_INVALID','Invalid TOTP secret');value=(value<<5)|i;bits+=5;if(bits>=8){out.push((value>>>(bits-8))&255);bits-=8;}}return Buffer.from(out); }
export interface EncryptedSecret {ciphertext:string;keyId:string}
export interface EncryptionKey {id:string;key:Buffer}
export function encryptSecret(plaintext:string,key:EncryptionKey):EncryptedSecret { if(key.key.length!==32)throw new IdentityError('ENCRYPTION_KEY_INVALID','MFA encryption key must be 32 bytes');const iv=randomBytes(12);const cipher=createCipheriv('aes-256-gcm',key.key,iv);const encrypted=Buffer.concat([cipher.update(plaintext,'utf8'),cipher.final()]);return {keyId:key.id,ciphertext:Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64url')}; }
export function decryptSecret(value:EncryptedSecret,keys:readonly EncryptionKey[]):string {const key=keys.find(k=>k.id===value.keyId);if(!key)throw new IdentityError('ENCRYPTION_KEY_MISSING','MFA encryption key is unavailable');const raw=Buffer.from(value.ciphertext,'base64url');if(raw.length<29)throw new IdentityError('MFA_INVALID','Corrupt encrypted secret');const decipher=createDecipheriv('aes-256-gcm',key.key,raw.subarray(0,12));decipher.setAuthTag(raw.subarray(12,28));try{return Buffer.concat([decipher.update(raw.subarray(28)),decipher.final()]).toString('utf8');}catch{throw new IdentityError('MFA_INVALID','Corrupt encrypted secret');}}
export function generateTotpSecret():string{return base32Encode(randomBytes(20));}
export function totp(secret:string,timeMs=Date.now(),step=30,digits=6):string {const counter=Math.floor(timeMs/1000/step);const b=Buffer.alloc(8);b.writeBigUInt64BE(BigInt(counter));const mac=createHmac('sha1',base32Decode(secret)).update(b).digest();const offset=mac[mac.length-1]!&15;const value=(mac.readUInt32BE(offset)&0x7fffffff)%10**digits;return String(value).padStart(digits,'0');}
export function verifyTotp(secret:string,code:string,timeMs=Date.now(),window=1):boolean {if(!/^\d{6}$/.test(code))return false;const actual=Buffer.from(code);for(let i=-window;i<=window;i++){const expected=Buffer.from(totp(secret,timeMs+i*30_000));if(timingSafeEqual(actual,expected))return true;}return false;}
export function otpauthUri(secret:string,email:string,issuer=PRODUCT_NAME):string {return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;}
function recoveryCharacters(length:number,entropy:(size:number)=>Buffer):string {
 let value='';
 // 252 is the largest multiple of 36 below 256. Rejecting the four remaining byte values avoids
 // modulo bias while keeping the displayed alphabet compatible with password managers and the UI.
 while(value.length<length)for(const byte of entropy(Math.max(16,length-value.length))){if(byte>=252)continue;value+=RECOVERY_ALPHABET[byte%RECOVERY_ALPHABET.length];if(value.length===length)break}
 return value;
}
export function generateRecoveryCodes(count=10,entropy:(size:number)=>Buffer=randomBytes):readonly string[]{
 if(count<1||count>20)throw new RangeError('Recovery code count must be 1-20');
 const codes=new Set<string>();
 while(codes.size<count){const raw=recoveryCharacters(10,entropy);codes.add(`${raw.slice(0,5)}-${raw.slice(5)}`)}
 return [...codes];
}
export function recoveryCodeDigest(code:string,pepper:string):string{return createHmac('sha256',pepper).update(code.replace(/\s/g,'').toUpperCase()).digest('hex');}
export function mfaRequired(policy:'optional'|'admins'|'all',role:string,enabled:boolean):boolean{return enabled||(policy==='all')||(policy==='admins'&&(role==='owner'||role==='admin'));}

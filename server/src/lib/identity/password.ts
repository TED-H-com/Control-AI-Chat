import { createRequire } from 'node:module';
import { timingSafeEqual } from 'node:crypto';
import { IdentityError } from './types.js';

export const BCRYPT_COST = 12;
const require = createRequire(import.meta.url);
interface BcryptModule { hash(value:string, rounds:number):Promise<string>; compare(value:string, hash:string):Promise<boolean> }
let bcrypt: BcryptModule | undefined;
try { bcrypt = require('bcryptjs') as BcryptModule; } catch { /* reported when hashing is requested */ }

const COMMON = new Set(['password','password123','123456789012','qwertyuiop12','letmein123456','admin12345678']);
export function normalizeEmail(value:string): string { return value.normalize('NFC').trim().toLocaleLowerCase('en-US'); }
export function normalizePassword(value:string): string { return value.normalize('NFC'); }
export function validatePassword(value:string, minimum=12): readonly string[] {
  const password=normalizePassword(value); const length=[...password].length; const failures:string[]=[];
  if (!Number.isInteger(minimum) || minimum < 12 || minimum > 128) throw new RangeError('minimum must be from 12 to 128');
  if (length < minimum) failures.push('minimum_length');
  if (length > 128) failures.push('maximum_length');
  if (COMMON.has(password.toLocaleLowerCase('en-US'))) failures.push('common_password');
  return failures;
}
function implementation():BcryptModule { if (!bcrypt) throw new IdentityError('DEPENDENCY_MISSING','bcryptjs is required for password operations'); return bcrypt; }
export async function hashPassword(value:string, minimum=12):Promise<string> {
  const normalized=normalizePassword(value); const failures=validatePassword(normalized,minimum);
  if (failures.length) throw new IdentityError('PASSWORD_POLICY_FAILED',failures.join(','),false,{rules:failures});
  return implementation().hash(normalized,BCRYPT_COST);
}
export async function verifyPassword(value:string, hash:string):Promise<boolean> {
  try { return await implementation().compare(normalizePassword(value),hash); } catch (error) {
    if (error instanceof IdentityError) throw error; return false;
  }
}
const DUMMY_HASH='$2b$12$C6UzMDM.H6dfI/f/IKcEe.5Z5fS7S5F5gQw8W7lXrM7O4oP0jR7eK';
export async function dummyPasswordVerification(value:string):Promise<void> { await verifyPassword(value,DUMMY_HASH); }
export function constantTimeTextEqual(left:string,right:string):boolean {
  const a=Buffer.from(left); const b=Buffer.from(right); return a.length===b.length && timingSafeEqual(a,b);
}

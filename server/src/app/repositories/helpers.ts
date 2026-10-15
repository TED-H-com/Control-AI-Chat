import { decodeCursor, encodeCursor, parseLimit } from '../../lib/http/pagination.js';
import { RepositoryError } from './errors.js';

export const iso=(value:number|null):string|null=>value===null?null:new Date(value).toISOString();
export function limitOf(value:number|undefined):number { try{return parseLimit(value?.toString())}catch(error){throw new RepositoryError('VALIDATION_FAILED',(error as Error).message)} }
export function cursorOf<T>(value:string|undefined):T|null { if(!value)return null;try{return decodeCursor<T>(value)}catch{throw new RepositoryError('VALIDATION_FAILED','Invalid cursor')} }
export {encodeCursor};
export function jsonObject(value:string):Readonly<Record<string,unknown>> { const parsed:unknown=JSON.parse(value);return parsed!==null&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed as Readonly<Record<string,unknown>>:{} }
export function assertText(value:string,label:string,max:number):string {const result=value.trim();if(!result||Array.from(result).length>max)throw new RepositoryError('VALIDATION_FAILED',`${label} must contain 1-${max} characters`);return result}
export function requireVersion(actual:number,expected:number|undefined):void {if(expected!==undefined&&actual!==expected)throw new RepositoryError('PRECONDITION_FAILED','The resource was modified by another request')}

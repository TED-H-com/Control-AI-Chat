import type { Page, PageMeta } from '../../shared/types.js';
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;
export function parseLimit(value:string|undefined): number {
  if (value === undefined) return DEFAULT_LIMIT;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new Error('limit must be an integer from 1 to 200');
  return limit;
}
export function encodeCursor(value:Readonly<Record<string,unknown>>): string {
  return Buffer.from(JSON.stringify(value),'utf8').toString('base64url');
}
export function decodeCursor<T>(cursor:string): T {
  try { return JSON.parse(Buffer.from(cursor,'base64url').toString('utf8')) as T; }
  catch { throw new Error('Invalid cursor'); }
}
export function pageOf<T>(rows:readonly T[], limit:number, cursorFor:(row:T)=>string): Page<T> {
  const hasMore = rows.length > limit;
  const data = rows.slice(0,limit);
  const last = data.at(-1);
  const page:PageMeta = {limit,hasMore,nextCursor:hasMore && last ? cursorFor(last) : null};
  return {data,page};
}

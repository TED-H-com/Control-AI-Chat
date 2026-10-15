import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { classifyThrownError, handleRequestError, requestErrorStatus } from './errors.js';

/**
 * Anchored to what better-sqlite3 actually throws rather than to codes typed from memory. The whole
 * defect was that nobody had looked: `POST /api/v1/admin/users` for an address already invited threw
 * SQLITE_CONSTRAINT_UNIQUE, the top-level handler had no case for it, and the caller got a 500 whose
 * body named the table and the columns of the index that rejected it.
 */
function thrown(work:(database:Database.Database)=>void): string {
  const database = new Database(':memory:');
  database.exec(`CREATE TABLE parent(id TEXT PRIMARY KEY);
    CREATE TABLE child(id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parent(id), email TEXT UNIQUE);`);
  database.pragma('foreign_keys = ON');
  try { work(database); assert.fail('the statement was expected to violate a constraint'); }
  catch (error) { return (error as {code:string}).code; }
  finally { database.close(); }
}

test('a duplicate is a conflict, and says nothing about the index that caught it', () => {
  const code = thrown(database => {
    const insert = database.prepare(`INSERT INTO child(id,email) VALUES(?,?)`);
    insert.run('a','one@example.test'); insert.run('b','one@example.test');
  });
  assert.equal(code, 'SQLITE_CONSTRAINT_UNIQUE');
  const classified = classifyThrownError(code);
  assert.deepEqual(classified, {code:'CONFLICT',message:'That already exists'});
  assert.doesNotMatch(classified.message ?? '', /table|column|index|constraint|child|email/i);
});

test('a dangling reference is the caller\'s error, not a 500', () => {
  const code = thrown(database => database.prepare(`INSERT INTO child(id,parent_id) VALUES(?,?)`).run('a','missing'));
  assert.equal(code, 'SQLITE_CONSTRAINT_FOREIGNKEY');
  assert.equal(classifyThrownError(code).code, 'VALIDATION_FAILED');
});

test('every other SQLite failure stays a 500 and stops being a SQLite failure out loud', () => {
  // A CHECK violation is a bug in the code that built the row, not something the caller can act on,
  // so it is deliberately not mapped to 4xx. What it must not do is travel as SQLITE_CONSTRAINT_CHECK.
  for (const code of ['SQLITE_CONSTRAINT_CHECK','SQLITE_CONSTRAINT_NOTNULL','SQLITE_BUSY','SQLITE_CORRUPT','SQLITE_READONLY'])
    assert.deepEqual(classifyThrownError(code), {code:'INTERNAL_ERROR',message:null}, code);
});

test('the application\'s own codes pass through untouched', () => {
  for (const code of ['RESOURCE_NOT_FOUND','FORBIDDEN','VALIDATION_FAILED','CREDENTIAL_LINK_INVALID','CONFLICT','NOT_IMPLEMENTED','INTERNAL_ERROR'] as const)
    assert.deepEqual(classifyThrownError(code), {code,message:null}, code);
});

test('internal aliases normalize to the public contract and unknown raw codes never leak',()=>{
  assert.deepEqual(classifyThrownError('NOT_FOUND'),{code:'RESOURCE_NOT_FOUND',message:null});
  assert.deepEqual(classifyThrownError('CONTEXT_WINDOW_EXCEEDED'),{code:'VALIDATION_FAILED',message:null});
  assert.deepEqual(classifyThrownError('DNS_UNAVAILABLE'),{code:'SERVICE_UNAVAILABLE',message:null});
  assert.deepEqual(classifyThrownError('ENOENT'),{code:'INTERNAL_ERROR',message:null});
  assert.deepEqual(classifyThrownError('made_up_application_code'),{code:'INTERNAL_ERROR',message:null});
});

test('MFA and email verification errors retain actionable client statuses',async()=>{
  assert.equal(requestErrorStatus('MFA_INVALID'),400);
  assert.equal(requestErrorStatus('MFA_REQUIRED'),403);
  assert.equal(requestErrorStatus('EMAIL_NOT_VERIFIED'),403);
  assert.equal(requestErrorStatus('PRECONDITION_FAILED'),412);
  assert.equal(requestErrorStatus('CREDENTIAL_LINK_INVALID'),422);
  const app=new Hono<{Variables:{requestId:string}}>();
  app.onError(handleRequestError);
  app.use('*',async(c,next)=>{c.set('requestId','request-mfa-contract');await next()});
  app.get('/api/v1/failure',()=>{throw Object.assign(new Error('Recent MFA verification is required'),{code:'MFA_REQUIRED'})});
  const response=await app.request('/api/v1/failure');
  assert.equal(response.status,403);
  assert.equal(response.headers.get('X-API-Version'),'1');
  assert.equal(response.headers.get('X-Request-Id'),'request-mfa-contract');
  assert.deepEqual(await response.json(),{error:{code:'MFA_REQUIRED',message:'Recent MFA verification is required',requestId:'request-mfa-contract',retryable:false}});
});

test('the HTTP boundary normalizes not-found aliases',async()=>{
  const app=new Hono<{Variables:{requestId:string}}>();
  app.onError(handleRequestError);
  app.use('*',async(c,next)=>{c.set('requestId','request-public-code');await next()});
  app.get('/api/v1/missing',()=>{throw Object.assign(new Error('Resource not found'),{code:'NOT_FOUND'})});
  const missing=await app.request('/api/v1/missing');
  assert.equal(missing.status,404);
  assert.deepEqual(await missing.json(),{error:{code:'RESOURCE_NOT_FOUND',message:'Resource not found',requestId:'request-public-code',retryable:false}});
});

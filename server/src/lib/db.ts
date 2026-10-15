import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config.js';
import { runMigrations } from './migrations/index.js';
import type { TenantId } from '../shared/types.js';

mkdirSync(dirname(config.dbPath), { recursive: true });
export const db = new Database(config.dbPath);
db.pragma('busy_timeout = 5000');
// Converting a brand new database to WAL takes an exclusive lock, and SQLite does not apply
// busy_timeout to a journal-mode change. Two processes opening the same fresh file at once — the
// test runner does this on every clean run, and a first boot can too — leave one to die at import
// with SQLITE_BUSY. Retry until the mode sticks; once any process has converted the file the call
// needs no lock, so this costs nothing in the ordinary case.
if(config.dbPath!==':memory:')for (let attempt = 0; ; attempt++) {
  let mode: unknown;
  try { mode = db.pragma('journal_mode = WAL', { simple: true }); } catch (error) { if (attempt >= 50) throw error; }
  if (mode === 'wal') break;
  if (attempt >= 50) throw new Error('SQLite journal_mode could not be set to WAL');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}
db.pragma('synchronous = FULL');
db.pragma('wal_autocheckpoint = 1000');
db.pragma('secure_delete = ON');
db.pragma('foreign_keys = ON');
db.pragma('trusted_schema = OFF');
db.pragma('temp_store = MEMORY');
db.prepare('SELECT json_valid(?) AS valid').get('{}');
if(db.pragma('secure_delete',{simple:true})!==1)throw new Error('SQLite secure_delete could not be enabled');
runMigrations(db);
const quickCheck = db.pragma('quick_check', { simple: true });
if (quickCheck !== 'ok') throw new Error(`SQLite quick_check failed: ${String(quickCheck)}`);

export const statements = {
  health: db.prepare<[], {ok:number}>('SELECT 1 AS ok'),
  tenantExists: db.prepare<[TenantId], {id:string}>('SELECT id FROM tenants WHERE id = ?'),
} as const;

export interface TenantDb {
  readonly tenantId: TenantId;
  get<Row>(statement: Database.Statement<[TenantId, ...unknown[]], Row>, ...params: unknown[]): Row | undefined;
  all<Row>(statement: Database.Statement<[TenantId, ...unknown[]], Row>, ...params: unknown[]): Row[];
  run(statement: Database.Statement<[TenantId, ...unknown[]]>, ...params: unknown[]): Database.RunResult;
}

/**
 * TenantDb binds tenantId as the FIRST parameter, always. A statement whose tenant predicate is not
 * the first placeholder therefore receives the tenant id in some other column and the tenant id
 * itself is matched against whatever argument happened to land there — so the WHERE clause matches
 * nothing and the write silently does nothing. `revokeSession` had exactly this shape, which meant
 * signing out never revoked a session and a deprovisioned employee kept a working token.
 *
 * There is no way to notice that by reading the call site, so check the SQL instead. Every statement
 * is inspected once and the verdict cached; the accepted forms are:
 *   - the tenant predicate is the first positional `?`
 *   - a leading one-row CTE whose first column is the tenant id — `WITH tenant_scope(id) AS
 *     (VALUES (?))` or `WITH q(tenant_id,…) AS (VALUES (?,…))` — for a statement whose SET clause
 *     would otherwise come first, or that needs the tenant id in more than one place
 * A statement that needs neither does not belong on TenantDb; call it on the database.
 *
 * The CTE form is only accepted if the body actually joins against that column. A one-row CTE nobody
 * reads binds the tenant id into a value that is never compared to anything, which is the same
 * unscoped query with a tenant parameter parked next to it.
 *
 * `?1`-style numbering looks like the obvious answer and is not one: better-sqlite3 binds arrays only
 * to anonymous `?`, and rejects a numbered statement outright with "Too many parameter values were
 * provided". Several statements were written that way and threw on every call.
 */
const verdicts = new WeakMap<object, string|null>();
const LEADING_CTE = /WITH\s+([A-Za-z_]\w*)\s*\(\s*([A-Za-z_]\w*)[^)]*\)\s+AS\s*\(\s*VALUES\s*\(\s*$/i;
const INSERT_TENANT_FIRST = /^\s*INSERT\s+(?:OR\s+\w+\s+)?INTO\s+\w+\s*\(\s*tenant_id\s*,[^)]*\)\s*(?:VALUES\s*\(\s*|SELECT\s+)$/i;
export function assertTenantFirst(sql: string): string|null {
  if (/\?\d/.test(sql)) return 'uses ?N numbered parameters, which better-sqlite3 cannot bind from an argument list';
  const first = sql.indexOf('?');
  if (first < 0) return 'takes no parameters, so it cannot be tenant-scoped by binding';
  // `CASE WHEN ?=tenant_id` is the same binding, written backwards to spend the tenant parameter
  // inside a SET clause; accept it rather than force a rewrite of a statement that is already right.
  if (/^\s*=\s*tenant_id\b/i.test(sql.slice(first + 1))) return null;
  const before = sql.slice(0, first);
  if (/tenant_id\s*(?:=|IN)\s*\(?\s*$/i.test(before)) return null;
  // An INSERT does not compare the tenant id, it writes it, so there is no predicate to look for. The
  // binding is right when `tenant_id` heads the column list and the first `?` is the first thing being
  // projected into it — `INSERT INTO t(tenant_id,…) VALUES(?,…)` or `… SELECT ?,…`. Every admin create
  // statement was written this way and every one of them was refused, which took out invite-a-user,
  // create-a-group, add-a-model, create-a-budget, create-a-rule and create-a-detector at once.
  if (INSERT_TENANT_FIRST.test(before)) return null;
  const cte = LEADING_CTE.exec(before);
  if (cte) {
    const [, alias, column] = cte as unknown as [string, string, string];
    if (column.toLowerCase() !== 'tenant_id' && !(alias.toLowerCase() === 'tenant_scope' && column.toLowerCase() === 'id'))
      return `binds ${alias}.${column} first, which is not the tenant id`;
    const used = new RegExp(`tenant_id\\s*=\\s*(?:${alias}\\.${column}\\b|\\(\\s*SELECT\\s+${column}\\s+FROM\\s+${alias}\\s*\\))`, 'i');
    return used.test(sql) ? null : `binds the tenant id into ${alias}.${column} but never compares any tenant_id to it`;
  }
  const tenant = /tenant_id\s*(?:=|IN)\s*\(?\s*\?/i.exec(sql);
  if (!tenant) return 'has parameters but no tenant_id predicate to bind the first one to';
  return `binds ${(sql.slice(0, tenant.index + tenant[0].length - 1).match(/\?/g) ?? []).length} parameter(s) before tenant_id`;
}
function checked<S extends {source?:string}>(statement: S): S {
  if (!verdicts.has(statement)) {
    const problem = typeof statement.source === 'string' ? assertTenantFirst(statement.source) : null;
    verdicts.set(statement, problem);
  }
  const problem = verdicts.get(statement);
  if (problem) throw new Error(`Tenant-scoped statement ${problem}: ${statement.source}`);
  return statement;
}

export function forTenant(context: {readonly tenantId:TenantId}): TenantDb {
  return {
    tenantId: context.tenantId,
    get: (statement, ...params) => checked(statement).get(context.tenantId, ...params),
    all: (statement, ...params) => checked(statement).all(context.tenantId, ...params),
    run: (statement, ...params) => checked(statement).run(context.tenantId, ...params),
  };
}

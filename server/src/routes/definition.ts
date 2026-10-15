import type { Permission } from '../shared/api.js';

/**
 * The shape of one row of the route table, kept apart from the rest of `routes/types.ts` because the
 * admin console typechecks against `catalog.ts` to prove every screen calls a route the server really
 * serves. That check is only worth having if importing the table costs nothing: `types.ts` pulls in
 * hono and, through `lib/http`, better-sqlite3, so a browser build that reached for the table would
 * have to install the server's runtime dependencies to typecheck. The table itself is plain data.
 */
export interface RouteDefinition {
  readonly method: 'GET'|'POST'|'PUT'|'PATCH'|'DELETE';
  readonly path: string;
  readonly operation: string;
  readonly access: 'public'|'tenant'|'internal';
  readonly permission?: Permission;
  readonly body?: 'json'|'multipart'|'raw'|'none';
  readonly success?: number;
  readonly ifMatch?: boolean;
  readonly idempotency?: boolean;
}

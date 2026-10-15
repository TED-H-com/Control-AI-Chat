import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import type { TenantId } from "../../shared/types.js";
import { canonicalJson } from "./audit-canonical.js";
import type {
  AuditCategory,
  AuditOutcome,
  GateAction,
  JsonValue,
  TargetType,
} from "./audit-types.js";
import type { AuditAction } from "./audit-actions.js";

/**
 * An entity filter takes a list because the console filters on what a reviewer can read — a name or
 * an email — and one name can resolve to several ids. A list is matched with `IN`, so an empty list
 * means "nothing matched the name you typed" and must return no rows; see the scalar loop below.
 */
export type EntityFilter = string | readonly string[];
export interface AuditSearchQuery {
  fromMs?: number;
  toMs?: number;
  actions?: AuditAction[];
  categories?: AuditCategory[];
  outcomes?: AuditOutcome[];
  severities?: string[];
  actorId?: EntityFilter;
  subjectUserId?: EntityFilter;
  groupId?: EntityFilter;
  projectId?: EntityFilter;
  conversationId?: EntityFilter;
  messageId?: EntityFilter;
  modelId?: EntityFilter;
  providerId?: EntityFilter;
  gateActions?: GateAction[];
  detectors?: string[];
  targetType?: TargetType;
  targetId?: EntityFilter;
  requestId?: EntityFilter;
  /** HMAC of the client address, because the raw address is never stored. */
  actorIpHmac?: EntityFilter;
  /** Free text, matched against the columns this table actually indexes text in. */
  text?: string;
  hasTranscript?: boolean;
  violationStatus?: string;
  sort?: "newest" | "oldest";
  limit?: number;
  cursor?: string;
}
/** Executes a statement with the tenant id bound first; `TenantDb` satisfies it. */
export interface AuditSearchScope {
  all<Row>(
    statement: Database.Statement<[TenantId, ...unknown[]], Row>,
    ...params: unknown[]
  ): Row[];
}
export interface AuditSearchRow {
  id: string;
  tenant_id: string;
  chain_epoch: number;
  sequence: number;
  occurred_at_ms: number;
  recorded_at_ms: number;
  action: string;
  category: string;
  outcome: string;
  severity: string;
  actor_id: string | null;
  target_type: string;
  target_id: string | null;
  metadata_json: string;
  transcript_id: string | null;
  prev_hash: string;
  event_hash: string;
}
interface Cursor {
  v: 1;
  direction: "newest" | "oldest";
  occurredAtMs: number;
  id: string;
  filterHash: string;
  issuedAtMs: number;
}
export interface AuditSearchPage {
  rows: AuditSearchRow[];
  nextCursor: string | null;
  hasMore: boolean;
}
const scalar: Readonly<Record<string, string>> = {
  actorId: "actor_id",
  subjectUserId: "subject_user_id",
  groupId: "group_id",
  projectId: "project_id",
  conversationId: "conversation_id",
  messageId: "message_id",
  modelId: "model_id",
  providerId: "provider_id",
  targetType: "target_type",
  targetId: "target_id",
  requestId: "request_id",
  actorIpHmac: "actor_ip_hmac",
};
const MAX_FILTER_VALUES = 500;
const MAX_SEARCH_CODE_POINTS = 256;
const MAX_SEARCH_TERMS = 32;
const lists: Readonly<Record<string, string>> = {
  actions: "action",
  categories: "category",
  outcomes: "outcome",
  severities: "severity",
  gateActions: "gate_action",
  detectors: "detector",
};
export class AuditSearch {
  constructor(
    readonly database: Database.Database,
    readonly cursorKey: Uint8Array,
    readonly now: () => number = Date.now,
  ) {}
  search(
    tenantId: TenantId,
    role: string,
    query: AuditSearchQuery,
    scope?: AuditSearchScope,
  ): AuditSearchPage {
    const limit = query.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500)
      throw new TypeError("limit must be 1..500");
    for (const key of Object.keys(lists)) {
      const values = query[key as keyof AuditSearchQuery];
      if (Array.isArray(values) && values.length > 25)
        throw new TypeError(`${key} has too many values`);
    }
    const direction = query.sort ?? "newest";
    // The filter hash binds a cursor to the query that produced it, so cursor and limit have to be
    // excluded from it. Excluding them by assigning `undefined` left own properties whose value
    // `canonicalJson` has no representation for, and it threw on every single search -- the audit
    // log was unreadable through the product that exists to make it readable. Omit the keys.
    const normalized: Record<string, unknown> = { sort: direction };
    for (const [key, value] of Object.entries(query))
      if (value !== undefined && key !== "cursor" && key !== "limit")
        normalized[key] = value;
    const filterHash = createHash("sha256")
      .update(canonicalJson(normalized as unknown as JsonValue))
      .digest("hex");
    const cursor = query.cursor
      ? this.#decode(query.cursor, tenantId, role, filterHash)
      : null;
    const where = ["tenant_id = ?"];
    const params: unknown[] = [tenantId];
    if (query.fromMs !== undefined) {
      where.push("occurred_at_ms >= ?");
      params.push(query.fromMs);
    }
    if (query.toMs !== undefined) {
      where.push("occurred_at_ms < ?");
      params.push(query.toMs);
    }
    for (const [key, column] of Object.entries(scalar)) {
      const value = query[key as keyof AuditSearchQuery];
      if (typeof value === "string") {
        where.push(`${column} = ?`);
        params.push(value);
      } else if (Array.isArray(value)) {
        if (value.length > MAX_FILTER_VALUES)
          throw new TypeError(`${key} has too many values`);
        // A name that resolved to no entity is a filter that matched nothing, not an absent filter.
        if (!value.length) where.push("0");
        else {
          where.push(`${column} IN (${value.map(() => "?").join(",")})`);
          params.push(...(value as readonly string[]));
        }
      }
    }
    if (query.text !== undefined && query.text !== "") {
      const match = textMatch(tenantId, query.text);
      if (match === null) where.push("0");
      else {
        where.push(
          "id IN (SELECT event_id FROM audit_events_fts WHERE audit_events_fts MATCH ? AND tenant_id = ?)",
        );
        params.push(match, tenantId);
      }
    }
    for (const [key, column] of Object.entries(lists)) {
      const value = query[key as keyof AuditSearchQuery];
      if (Array.isArray(value) && value.length) {
        where.push(`${column} IN (${value.map(() => "?").join(",")})`);
        params.push(...value);
      }
    }
    if (query.hasTranscript !== undefined)
      where.push(
        query.hasTranscript
          ? "transcript_id IS NOT NULL"
          : "transcript_id IS NULL",
      );
    if (query.violationStatus) {
      where.push(
        "EXISTS (SELECT 1 FROM policy_violations v WHERE v.tenant_id=audit_events.tenant_id AND v.audit_event_id=audit_events.id AND v.status=?)",
      );
      params.push(query.violationStatus);
    }
    const op = direction === "newest" ? "<" : ">";
    if (cursor) {
      where.push(
        `(occurred_at_ms ${op} ? OR (occurred_at_ms = ? AND id ${op} ?))`,
      );
      params.push(cursor.occurredAtMs, cursor.occurredAtMs, cursor.id);
    }
    const order = direction === "newest" ? "DESC" : "ASC";
    const sql = `SELECT id,tenant_id,chain_epoch,sequence,occurred_at_ms,recorded_at_ms,action,category,outcome,severity,actor_id,target_type,target_id,metadata_json,transcript_id,prev_hash,event_hash FROM audit_events WHERE ${where.join(" AND ")} ORDER BY occurred_at_ms ${order}, id ${order} LIMIT ?`;
    params.push(limit + 1);
    // `params[0]` is the tenant id and every filter is appended after it, so the statement still binds
    // the tenant first. Handing it to a `TenantDb` is what proves that: it inspects the SQL and throws
    // if a filter has displaced the tenant predicate, rather than silently querying another tenant.
    const statement = this.database.prepare(sql) as Database.Statement<
      [TenantId, ...unknown[]],
      AuditSearchRow
    >;
    const rows = scope
      ? scope.all(statement, ...params.slice(1))
      : (statement.all(...(params as [TenantId, ...unknown[]])) as AuditSearchRow[]);
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    const last = rows.at(-1);
    return {
      rows,
      hasMore,
      nextCursor:
        hasMore && last
          ? this.#encode(
              {
                v: 1,
                direction,
                occurredAtMs: last.occurred_at_ms,
                id: last.id,
                filterHash,
                issuedAtMs: this.now(),
              },
              tenantId,
              role,
            )
          : null,
    };
  }
  #encode(cursor: Cursor, tenantId: TenantId, role: string): string {
    const body = Buffer.from(
      canonicalJson(cursor as unknown as JsonValue),
    ).toString("base64url");
    const signature = createHmac("sha256", this.cursorKey)
      .update(`${tenantId}\n${role}\n${body}`)
      .digest("base64url");
    return `${body}.${signature}`;
  }
  #decode(
    value: string,
    tenantId: TenantId,
    role: string,
    filterHash: string,
  ): Cursor {
    const [body, signature, ...rest] = value.split(".");
    if (!body || !signature || rest.length)
      throw new TypeError("Invalid audit cursor");
    const expected = createHmac("sha256", this.cursorKey)
      .update(`${tenantId}\n${role}\n${body}`)
      .digest();
    let actual: Buffer;
    try {
      actual = Buffer.from(signature, "base64url");
    } catch {
      throw new TypeError("Invalid audit cursor");
    }
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new TypeError("Invalid audit cursor");
    let cursor: Cursor;
    try {
      cursor = JSON.parse(Buffer.from(body, "base64url").toString()) as Cursor;
    } catch {
      throw new TypeError("Invalid audit cursor");
    }
    if (
      cursor.v !== 1 ||
      cursor.filterHash !== filterHash ||
      this.now() - cursor.issuedAtMs > 86_400_000
    )
      throw new TypeError("Expired or mismatched audit cursor");
    return cursor;
  }
}

/**
 * FTS5 has its own query language. Only Unicode letter/number tokens cross this boundary, quoted as
 * literal prefixes, so pasted punctuation and words such as AND/OR cannot become operators. The
 * tenant is present both in MATCH (to prune the index) and as a relational equality in the query.
 */
function textMatch(tenantId: TenantId, input: string): string | null {
  const normalized = input.normalize("NFKC");
  if ([...normalized].length > MAX_SEARCH_CODE_POINTS)
    throw new TypeError(`text must be at most ${MAX_SEARCH_CODE_POINTS} characters`);
  const terms = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (terms.length > MAX_SEARCH_TERMS)
    throw new TypeError(`text has too many terms (maximum ${MAX_SEARCH_TERMS})`);
  if (!terms.length) return null;
  const literals = terms.map((term) => `"${term}"*`).join(" AND ");
  const tenantKey = tenantId.replaceAll("-", "").toLowerCase();
  const quotedTenant = `"${tenantKey.replaceAll('"', '""')}"`;
  return `tenant_key : ${quotedTenant} AND {event_id action request_id target_id metadata_text} : (${literals})`;
}

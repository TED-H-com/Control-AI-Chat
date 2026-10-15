import type Database from "better-sqlite3";
import type { TenantId } from "../../shared/types.js";
import { eventHash, genesisHash } from "./audit-canonical.js";
import type { AuditHashV1, JsonValue } from "./audit-types.js";

interface Head {
  chain_epoch: number;
  last_sequence: number;
  last_hash: string;
  genesis_hash: string;
}
interface Epoch {
  genesis_hash: string;
  prior_epoch_final_hash: string | null;
  last_sequence: number | null;
  final_hash: string | null;
  status: string;
}
interface EventRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  chain_epoch: number;
  sequence: number;
  metadata_json: string;
  event_hash: string;
  prev_hash: string;
}
export interface ChainVerification {
  valid: boolean;
  tenantId: TenantId;
  epoch: number;
  checkedRows: number;
  throughSequence: number;
  throughHash: string;
  breakAtSequence: number | null;
  reason:
    | "ok"
    | "missing_event"
    | "prev_hash_mismatch"
    | "event_hash_mismatch"
    | "head_mismatch"
    | "epoch_mismatch";
}
export interface ChainVerificationWindow {
  /** First row to check. Its prev_hash must equal expectedPrevHash. */
  startSequence: number;
  expectedPrevHash: string;
  maxRows: number;
}

/**
 * The stored row, restated as the object that was hashed when it was written. Exported so that a
 * single row can be re-hashed on its own — the audit screen reports per-row integrity, and a second
 * transcription of these 34 fields would report "verified" for a row whose hash it computed
 * differently from the verifier. The caller supplies the parsed metadata because a row whose
 * metadata is no longer valid JSON is a broken row, not a hashing failure.
 */
export function auditHashObject(
  row: Record<string, unknown>,
  metadata: JsonValue,
): AuditHashV1 {
  return {
    v: 1,
    tenant_id: str(row, "tenant_id"),
    chain_epoch: num(row, "chain_epoch"),
    sequence: num(row, "sequence"),
    id: str(row, "id"),
    occurred_at_ms: num(row, "occurred_at_ms"),
    recorded_at_ms: num(row, "recorded_at_ms"),
    action: str(row, "action"),
    category: str(row, "category") as AuditHashV1["category"],
    outcome: str(row, "outcome") as AuditHashV1["outcome"],
    severity: str(row, "severity") as AuditHashV1["severity"],
    actor_type: str(row, "actor_type") as AuditHashV1["actor_type"],
    actor_id: nil(row, "actor_id"),
    actor_session_id: nil(row, "actor_session_id"),
    actor_ip_hmac: nil(row, "actor_ip_hmac"),
    actor_user_agent: nil(row, "actor_user_agent"),
    subject_user_id: nil(row, "subject_user_id"),
    group_id: nil(row, "group_id"),
    project_id: nil(row, "project_id"),
    conversation_id: nil(row, "conversation_id"),
    message_id: nil(row, "message_id"),
    target_type: str(row, "target_type") as AuditHashV1["target_type"],
    target_id: nil(row, "target_id"),
    model_id: nil(row, "model_id"),
    provider_id: nil(row, "provider_id"),
    gate_action: nil(row, "gate_action") as AuditHashV1["gate_action"],
    detector: nil(row, "detector"),
    request_id: str(row, "request_id"),
    trace_id: nil(row, "trace_id"),
    source: str(row, "source") as AuditHashV1["source"],
    metadata,
    transcript_id: nil(row, "transcript_id"),
    transcript_digest: nil(row, "transcript_digest"),
    prev_hash: str(row, "prev_hash"),
  };
}

export function verifyAuditChain(
  database: Database.Database,
  tenantId: TenantId,
  epoch?: number,
  window?: ChainVerificationWindow,
): ChainVerification {
  const head = database
    .prepare<
      [TenantId],
      Head
    >("SELECT chain_epoch,last_sequence,last_hash,genesis_hash FROM audit_chain_heads WHERE tenant_id=?")
    .get(tenantId);
  const selected = epoch ?? head?.chain_epoch ?? 1;
  const epochRow = database
    .prepare<
      [TenantId, number],
      Epoch
    >("SELECT genesis_hash,prior_epoch_final_hash,last_sequence,final_hash,status FROM audit_chain_epochs WHERE tenant_id=? AND chain_epoch=?")
    .get(tenantId, selected);
  if (!epochRow)
    return result(false, tenantId, selected, 0, 0, '', 1, "epoch_mismatch");
  if (
    epochRow.genesis_hash !==
    genesisHash(tenantId, selected, epochRow.prior_epoch_final_hash)
  )
    return result(false, tenantId, selected, 0, 0, epochRow.genesis_hash, 1, "epoch_mismatch");
  const boundary =
    selected === head?.chain_epoch
      ? head.last_sequence
      : (epochRow.last_sequence ?? 0);
  if(window&&(!Number.isSafeInteger(window.startSequence)||window.startSequence<1||!Number.isSafeInteger(window.maxRows)||window.maxRows<1||window.expectedPrevHash.length===0))throw new TypeError('Invalid audit verification window');
  const start=window?.startSequence??1;
  const limit=window?.maxRows??Math.max(boundary,1);
  const iterator = database
    .prepare<
      [TenantId, number, number, number, number],
      EventRow
    >("SELECT * FROM audit_events WHERE tenant_id=? AND chain_epoch=? AND sequence>=? AND sequence<=? ORDER BY sequence LIMIT ?")
    .iterate(tenantId, selected, start, boundary, limit);
  let expectedSequence = start,
    expectedPrev = window?.expectedPrevHash??epochRow.genesis_hash,
    checked = 0;
  for (const row of iterator) {
    if (row.sequence !== expectedSequence)
      return result(
        false,
        tenantId,
        selected,
        checked,
        expectedSequence - 1,
        expectedPrev,
        expectedSequence,
        "missing_event",
      );
    if (row.prev_hash !== expectedPrev)
      return result(
        false,
        tenantId,
        selected,
        checked,
        row.sequence - 1,
        expectedPrev,
        row.sequence,
        "prev_hash_mismatch",
      );
    let metadata: JsonValue;
    try {
      metadata = JSON.parse(row.metadata_json) as JsonValue;
    } catch {
      return result(
        false,
        tenantId,
        selected,
        checked,
        row.sequence - 1,
        expectedPrev,
        row.sequence,
        "event_hash_mismatch",
      );
    }
    if (eventHash(auditHashObject(row, metadata)) !== row.event_hash)
      return result(
        false,
        tenantId,
        selected,
        checked,
        row.sequence - 1,
        expectedPrev,
        row.sequence,
        "event_hash_mismatch",
      );
    expectedPrev = row.event_hash;
    expectedSequence++;
    checked++;
  }
  const exhaustedWindow=checked===limit&&expectedSequence<=boundary;
  if (!exhaustedWindow&&expectedSequence - 1 !== boundary)
    return result(
      false,
      tenantId,
      selected,
      checked,
      expectedSequence - 1,
      expectedPrev,
      expectedSequence,
      "missing_event",
    );
  const expectedFinal = selected === head?.chain_epoch ? head.last_hash : epochRow.final_hash;
  if (!exhaustedWindow&&expectedFinal !== expectedPrev)
    return result(
      false,
      tenantId,
      selected,
      checked,
      boundary,
      expectedPrev,
      boundary,
      "head_mismatch",
    );
  return result(true, tenantId, selected, checked, expectedSequence-1, expectedPrev, null, "ok");
}
function result(
  valid: boolean,
  tenantId: TenantId,
  epoch: number,
  checkedRows: number,
  throughSequence: number,
  throughHash: string,
  breakAtSequence: number | null,
  reason: ChainVerification["reason"],
): ChainVerification {
  return {
    valid,
    tenantId,
    epoch,
    checkedRows,
    throughSequence,
    throughHash,
    breakAtSequence,
    reason,
  };
}
function num(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value !== "number") throw new TypeError(`Invalid ${key}`);
  return value;
}
function str(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new TypeError(`Invalid ${key}`);
  return value;
}
function nil(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "string") throw new TypeError(`Invalid ${key}`);
  return value;
}

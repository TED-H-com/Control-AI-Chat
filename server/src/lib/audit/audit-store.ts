import {
  createCipheriv,
  createHmac,
  randomBytes,
  randomUUID,
} from "node:crypto";
import type Database from "better-sqlite3";
import type { TenantId } from "../../shared/types.js";
import { actionDefinition } from "./audit-actions.js";
import {
  canonicalJson,
  eventHash,
  genesisHash,
  sha256Hex,
} from "./audit-canonical.js";
import { scrubMetadata, scrubSecrets } from "./audit-secret.js";
import type {
  AuditAppendInput,
  AuditDependencies,
  AuditHashV1,
  AuditReceipt,
  JsonObject,
  TranscriptCaptureInput,
} from "./audit-types.js";

interface HeadRow {
  chain_epoch: number;
  last_sequence: number;
  last_hash: string;
  genesis_hash: string;
  status: string;
  updated_at_ms: number;
}
interface LastTimeRow {
  recorded_at_ms: number;
}
export class AuditChainUnavailableError extends Error {
  constructor(readonly status: string) {
    super(`Audit chain is unavailable (${status})`);
    this.name = "AuditChainUnavailableError";
  }
}
export class AuditWriteUnavailableError extends Error {
  constructor(message = "Audit write unavailable") {
    super(message);
    this.name = "AuditWriteUnavailableError";
  }
}

function uuid7(now: number): string {
  const bytes = randomBytes(16);
  let time = BigInt(now);
  for (let i = 5; i >= 0; i--) {
    bytes[i] = Number(time & 255n);
    time >>= 8n;
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function hmac(key: Uint8Array, value: string): string {
  return createHmac("sha256", key).update(value).digest("hex");
}
/**
 * The client address is stored only as this HMAC, so filtering the audit log by address means
 * hashing the address the same way and comparing. Exported rather than restated at the reader,
 * because a reader that salted or joined the parts differently would match nothing at all and look
 * exactly like "no events from that address".
 */
export function actorIpHmac(
  key: Uint8Array,
  tenantId: TenantId,
  ip: string,
): string {
  return hmac(key, `${tenantId}\n${ip}`);
}
function userAgent(value: string | null): string | null {
  return value === null
    ? null
    : scrubSecrets(value.replace(/[\u0000-\u001f\u007f]/g, " ")).slice(0, 512);
}
function retentionMs(
  input: TranscriptCaptureInput,
  policy: ReturnType<AuditDependencies["retentionPolicy"]>,
): number {
  const days =
    input.retentionClass === "chat"
      ? policy.chatTranscriptDays
      : input.retentionClass === "approval"
        ? policy.approvalPayloadDays
        : policy.violationTranscriptDays;
  return days * 86_400_000;
}
function encryptTranscript(
  input: TranscriptCaptureInput,
  tenantId: TenantId,
  id: string,
  key: Uint8Array,
  created: number,
  purgeAfter: number | null,
) {
  if (key.byteLength !== 32)
    throw new TypeError("Transcript key must be 32 bytes");
  const content = scrubSecrets(input.sanitizedContent);
  const preview =
    input.sanitizedPreview === null
      ? null
      : scrubSecrets(input.sanitizedPreview).slice(0, 512);
  if (Buffer.byteLength(content) > 2 * 1024 * 1024)
    throw new RangeError("Audit transcript exceeds 2 MiB");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(`${tenantId}\n${id}\n${input.direction}\n1`));
  const ciphertext = Buffer.concat([
    cipher.update(content, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return {
    id,
    direction: input.direction,
    ciphertext,
    nonce,
    preview,
    digest: sha256Hex(content),
    characters: [...content].length,
    tokenCount: input.tokenCount,
    redactionCount: input.redactionCount,
    created,
    purgeAfter,
  };
}

export class AuditStore {
  readonly #db: Database.Database;
  readonly #deps: AuditDependencies;
  readonly #head: Database.Statement<[TenantId], HeadRow>;
  readonly #lastTime: Database.Statement<[TenantId, number], LastTimeRow>;
  readonly #insertEpoch: Database.Statement;
  readonly #insertHead: Database.Statement;
  readonly #insertEvent: Database.Statement;
  readonly #insertSearch: Database.Statement | null;
  readonly #insertTranscript: Database.Statement;
  readonly #casHead: Database.Statement;
  constructor(deps: AuditDependencies) {
    this.#deps = deps;
    this.#db = deps.database;
    this.#head = this.#db.prepare(
      "SELECT chain_epoch,last_sequence,last_hash,genesis_hash,status,updated_at_ms FROM audit_chain_heads WHERE tenant_id=?",
    );
    this.#lastTime = this.#db.prepare(
      "SELECT recorded_at_ms FROM audit_events WHERE tenant_id=? AND chain_epoch=? ORDER BY sequence DESC LIMIT 1",
    );
    this.#insertEpoch = this.#db.prepare(
      "INSERT INTO audit_chain_epochs(tenant_id,chain_epoch,genesis_hash,prior_epoch_final_hash,status,reason,opened_at_ms) VALUES(?,?,?,?,'open',?,?)",
    );
    this.#insertHead = this.#db.prepare(
      "INSERT INTO audit_chain_heads(tenant_id,chain_epoch,last_sequence,last_hash,genesis_hash,status,updated_at_ms) VALUES(?,?,0,?,?,'healthy',?)",
    );
    this.#insertEvent = this.#db.prepare(
      `INSERT INTO audit_events(id,tenant_id,chain_epoch,sequence,occurred_at_ms,recorded_at_ms,action,category,outcome,severity,actor_type,actor_id,actor_session_id,actor_ip_hmac,actor_user_agent,subject_user_id,group_id,project_id,conversation_id,message_id,target_type,target_id,model_id,provider_id,gate_action,detector,request_id,trace_id,source,metadata_json,metadata_text,transcript_id,transcript_digest,prev_hash,event_hash,hash_version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`,
    );
    this.#insertSearch = this.#db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='audit_events_fts'")
      .get()
      ? this.#db.prepare(
          "INSERT INTO audit_events_fts(tenant_key,tenant_id,event_id,action,request_id,target_id,metadata_text) VALUES(?,?,?,?,?,?,?)",
        )
      : null;
    this.#insertTranscript = this.#db.prepare(
      `INSERT INTO audit_transcripts(id,tenant_id,audit_event_id,direction,content_state,content_encoding,content_ciphertext,content_nonce,key_version,sanitized_preview,redacted_content_sha256,original_content_hmac,character_count,token_count,redaction_count,created_at_ms,purge_after_ms) VALUES(?,?,?,?,'present','utf8',?,?,1,?,?,?,?,?,?,?,?)`,
    );
    this.#casHead = this.#db.prepare(
      `UPDATE audit_chain_heads SET last_sequence=?,last_hash=?,updated_at_ms=? WHERE tenant_id=? AND chain_epoch=? AND last_sequence=? AND last_hash=? AND status='healthy'`,
    );
  }
  append(input: AuditAppendInput): AuditReceipt {
    return this.transact((tx) => tx.append(input));
  }
  transact<T>(
    work: (tx: { append: (input: AuditAppendInput) => AuditReceipt }) => T,
  ): T {
    const transaction = this.#db.transaction(() =>
      work({ append: (input) => this.#appendInside(input, true) }),
    );
    try {
      return transaction.immediate();
    } catch (error) {
      if (
        error instanceof AuditChainUnavailableError ||
        error instanceof TypeError ||
        error instanceof RangeError
      )
        throw error;
      const code = (error as { code?: unknown }).code;
      if (
        code === "SQLITE_BUSY" ||
        code === "SQLITE_FULL" ||
        code === "SQLITE_IOERR"
      )
        throw new AuditWriteUnavailableError();
      throw error;
    }
  }
  #appendInside(input: AuditAppendInput, emitDefensiveEvents: boolean, nowOverride?: number): AuditReceipt {
    const definition = actionDefinition(input.action);
    const now = nowOverride ?? this.#deps.now?.() ?? Date.now();
    const metadata = scrubMetadata(
      definition.validateMetadata(input.metadata),
    ) as JsonObject;
    if (Buffer.byteLength(canonicalJson(metadata)) > 32 * 1024)
      throw new RangeError("Audit metadata exceeds 32 KiB");
    let head = this.#head.get(input.tenantId);
    if (!head) {
      const genesis = genesisHash(input.tenantId, 1);
      this.#insertEpoch.run(
        input.tenantId,
        1,
        genesis,
        null,
        "tenant_created",
        now,
      );
      this.#insertHead.run(input.tenantId, 1, genesis, genesis, now);
      head = this.#head.get(input.tenantId);
      if (!head) throw new AuditWriteUnavailableError();
      if (emitDefensiveEvents) {
        this.#appendInside({
          tenantId: input.tenantId,
          action: "system.audit_chain_initialized",
          actor: { type: "service", id: "audit-store", sessionId: null, ip: null, userAgent: null, authMethod: "system" },
          target: { type: "tenant", id: input.tenantId },
          outcome: "success",
          context: { requestId: `audit-chain:${input.tenantId}`, traceId: input.context.traceId, source: input.context.source, occurredAtMs: now },
          metadata: { epoch: 1, genesisHash: genesis, reason: "tenant_created" },
        }, false, now);
        head = this.#head.get(input.tenantId);
      }
    }
    if (!head) throw new AuditWriteUnavailableError();
    if (head.status !== "healthy")
      throw new AuditChainUnavailableError(head.status);
    const priorRecorded =
      this.#lastTime.get(input.tenantId, head.chain_epoch)?.recorded_at_ms ?? 0;
    const recorded = Math.max(now, priorRecorded);
    if (emitDefensiveEvents && now < priorRecorded) {
      this.#appendInside({
        tenantId: input.tenantId,
        action: "system.clock_regression_detected",
        actor: { type: "service", id: "audit-store", sessionId: null, ip: null, userAgent: null, authMethod: "system" },
        target: { type: "tenant", id: input.tenantId },
        outcome: "failure",
        context: { requestId: `clock-regression:${input.context.requestId}`, traceId: input.context.traceId, source: input.context.source, occurredAtMs: now },
        metadata: { observedAtMs: now, clampedAtMs: priorRecorded, deltaMs: priorRecorded - now },
      }, false, now);
      head = this.#head.get(input.tenantId);
      if (!head) throw new AuditWriteUnavailableError();
    }
    const sequence = head.last_sequence + 1;
    const occurred = input.context.occurredAtMs ?? now;
    if (!Number.isSafeInteger(occurred) || occurred < 0)
      throw new TypeError("Invalid occurredAtMs");
    const id = this.#deps.id?.() ?? uuid7(recorded);
    const transcriptId = input.transcript ? randomUUID() : null;
    const policy = this.#deps.retentionPolicy(input.tenantId);
    const capture =
      input.transcript && policy.captureTranscripts
        ? encryptTranscript(
            input.transcript,
            input.tenantId,
            transcriptId!,
            this.#deps.transcriptKey(input.tenantId),
            recorded,
            recorded + retentionMs(input.transcript, policy),
          )
        : null;
    const digest = capture?.digest ?? null;
    const ip =
      input.actor.ip === null
        ? null
        : actorIpHmac(this.#deps.ipHmacKey, input.tenantId, input.actor.ip);
    const hashObject: AuditHashV1 = {
      v: 1,
      tenant_id: input.tenantId,
      chain_epoch: head.chain_epoch,
      sequence,
      id,
      occurred_at_ms: occurred,
      recorded_at_ms: recorded,
      action: input.action,
      category: definition.category,
      outcome: input.outcome,
      severity: definition.defaultSeverity,
      actor_type: input.actor.type,
      actor_id: input.actor.id,
      actor_session_id: input.actor.sessionId,
      actor_ip_hmac: ip,
      actor_user_agent: userAgent(input.actor.userAgent),
      subject_user_id: input.subjectUserId ?? null,
      group_id: input.groupId ?? null,
      project_id: input.projectId ?? null,
      conversation_id: input.conversationId ?? null,
      message_id: input.messageId ?? null,
      target_type: input.target.type,
      target_id: input.target.id,
      model_id: input.modelId ?? null,
      provider_id: input.providerId ?? null,
      gate_action: input.gateAction ?? null,
      detector: input.detector ?? null,
      request_id: input.context.requestId,
      trace_id: input.context.traceId,
      source: input.context.source,
      metadata,
      transcript_id: capture ? transcriptId : null,
      transcript_digest: digest,
      prev_hash: head.last_hash,
    };
    const hash = eventHash(hashObject);
    const searchableMetadata = metadataText(metadata);
    const values = Object.values(hashObject).slice(1, -1); // exact column order below is explicit despite compact construction
    void values;
    this.#insertEvent.run(
      id,
      input.tenantId,
      head.chain_epoch,
      sequence,
      occurred,
      recorded,
      input.action,
      definition.category,
      input.outcome,
      definition.defaultSeverity,
      input.actor.type,
      input.actor.id,
      input.actor.sessionId,
      ip,
      hashObject.actor_user_agent,
      hashObject.subject_user_id,
      hashObject.group_id,
      hashObject.project_id,
      hashObject.conversation_id,
      hashObject.message_id,
      input.target.type,
      input.target.id,
      hashObject.model_id,
      hashObject.provider_id,
      hashObject.gate_action,
      hashObject.detector,
      input.context.requestId,
      input.context.traceId,
      input.context.source,
      canonicalJson(metadata),
      searchableMetadata,
      capture ? transcriptId : null,
      digest,
      head.last_hash,
      hash,
    );
    this.#insertSearch?.run(
      input.tenantId.replaceAll("-", "").toLowerCase(),
      input.tenantId,
      id,
      input.action,
      input.context.requestId,
      input.target.id ?? "",
      searchableMetadata,
    );
    if (capture)
      this.#insertTranscript.run(
        capture.id,
        input.tenantId,
        id,
        capture.direction,
        capture.ciphertext,
        capture.nonce,
        capture.preview,
        capture.digest,
        hmac(
          this.#deps.transcriptKey(input.tenantId),
          scrubSecrets(input.transcript!.sanitizedContent),
        ),
        capture.characters,
        capture.tokenCount,
        capture.redactionCount,
        capture.created,
        capture.purgeAfter,
      );
    const changed = this.#casHead.run(
      sequence,
      hash,
      recorded,
      input.tenantId,
      head.chain_epoch,
      head.last_sequence,
      head.last_hash,
    );
    if (changed.changes !== 1)
      throw new AuditWriteUnavailableError("Audit head changed concurrently");
    return {
      id,
      tenantId: input.tenantId,
      chainEpoch: head.chain_epoch,
      sequence,
      eventHash: hash,
      recordedAtMs: recorded,
    };
  }
}
function metadataText(metadata: JsonObject): string {
  const strings: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") strings.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(metadata);
  return strings.join(" ").slice(0, 8192);
}

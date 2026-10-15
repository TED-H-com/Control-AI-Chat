export * from "./audit-actions.js";
export * from "./audit-canonical.js";
export * from "./audit-export.js";
export * from "./audit-retention.js";
export * from "./audit-search.js";
export * from "./audit-secret.js";
export * from "./audit-store.js";
export * from "./audit-types.js";
export * from "./audit-verify.js";
export * from "./audit-violations.js";
export * from './tenant-retention-policy.js';

import type {
  AuditAppendInput,
  AuditDependencies,
  AuditReceipt,
} from "./audit-types.js";
import { actionDefinition, type AuditAction } from "./audit-actions.js";
import { AuditStore } from "./audit-store.js";
export interface AuditTransaction {
  append<A extends AuditAction>(input: AuditAppendInput<A>): AuditReceipt;
}
export interface AuditService {
  transact<T>(work: (tx: AuditTransaction) => T): T;
  append<A extends AuditAction>(input: AuditAppendInput<A>): AuditReceipt;
  enqueue<A extends AuditAction>(input: AuditAppendInput<A>): void;
}
export function createAuditService(
  dependencies: AuditDependencies,
): AuditService {
  const store = new AuditStore(dependencies);
  return {
    transact: (work) => store.transact(work),
    append: (input) => store.append(input),
    enqueue: (input) => {
      if (!actionDefinition(input.action).asyncSafe)
        throw new TypeError("This audit action is not async-safe");
      queueMicrotask(() => {
        store.append(input);
      });
    },
  };
}

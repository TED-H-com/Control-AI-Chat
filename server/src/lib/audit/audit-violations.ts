import type Database from "better-sqlite3";
import type { TenantId } from "../../shared/types.js";

export type ViolationStatus =
  | "open"
  | "triaged"
  | "in_review"
  | "approved"
  | "rejected"
  | "resolved"
  | "dismissed"
  | "expired"
  | "cancelled";
const transitions: Readonly<
  Record<ViolationStatus, readonly ViolationStatus[]>
> = {
  open: [
    "triaged",
    "dismissed",
    "approved",
    "rejected",
    "expired",
    "cancelled",
  ],
  triaged: [
    "in_review",
    "dismissed",
    "approved",
    "rejected",
    "expired",
    "cancelled",
  ],
  in_review: [
    "resolved",
    "dismissed",
    "approved",
    "rejected",
    "expired",
    "cancelled",
  ],
  approved: ["resolved"],
  rejected: [],
  resolved: [],
  dismissed: [],
  expired: [],
  cancelled: [],
};
export class ViolationChangedError extends Error {
  constructor() {
    super("Violation changed");
    this.name = "ViolationChangedError";
  }
}
export function updateViolation(
  database: Database.Database,
  tenantId: TenantId,
  id: string,
  version: number,
  from: ViolationStatus,
  to: ViolationStatus,
  assignee: string | null,
  nowMs: number,
): void {
  if (!transitions[from].includes(to))
    throw new TypeError(`Invalid violation transition ${from} -> ${to}`);
  const changed = database
    .prepare<
      [
        ViolationStatus,
        string | null,
        number,
        TenantId,
        string,
        number,
        ViolationStatus,
      ]
    >(`UPDATE policy_violations SET status=?,assignee_user_id=?,version=version+1,updated_at_ms=? WHERE tenant_id=? AND id=? AND version=? AND status=?`)
    .run(to, assignee, nowMs, tenantId, id, version, from);
  if (changed.changes !== 1) throw new ViolationChangedError();
}

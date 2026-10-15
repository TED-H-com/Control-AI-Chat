import type {
  AuditCategory,
  AuditSeverity,
  JsonObject,
  JsonValue,
} from "./audit-types.js";
import {
  AUDIT_ACTIONS as AUDIT_ACTION_NAMES,
  type AuditActionName,
} from "../../shared/audit-actions.js";

export type AuditAction = AuditActionName;
export interface AuditActionDefinition {
  action: AuditAction;
  category: AuditCategory;
  sensitivity: "metadata" | "content" | "restricted_content";
  asyncSafe: boolean;
  defaultSeverity: AuditSeverity;
  schemaVersion: 1;
  validateMetadata(value: unknown): JsonObject;
}

const forbidden =
  /(^|_)(secret|password|authorization|cookie|raw|credential)(_|$)/i;
const allowedSensitive = new Set([
  "secretVersion",
  "sessionsRevoked",
  "identifierHmac",
  "subjectHmac",
  "nameIdHmac",
  "externalIdHmac",
  "originalDigest",
  "providerResponseDigest",
]);
function json(
  value: unknown,
  path = "$",
  active = new Set<object>(),
): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0))
      throw new TypeError(`${path} must contain safe integers only`);
    return value;
  }
  if (
    typeof value !== "object" ||
    ArrayBuffer.isView(value) ||
    value instanceof Date
  )
    throw new TypeError(`${path} is not audit JSON`);
  if (active.has(value)) throw new TypeError(`${path} is cyclic`);
  active.add(value);
  if (Array.isArray(value)) {
    const out = value.map((entry, index) =>
      json(entry, `${path}/${index}`, active),
    );
    active.delete(value);
    return out;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null)
    throw new TypeError(`${path} must be a plain object`);
  const output: JsonObject = {};
  for (const [key, entry] of Object.entries(value)) {
    if (forbidden.test(key) && !allowedSensitive.has(key))
      throw new TypeError(`${path}/${key} is forbidden in audit metadata`);
    output[key] = json(entry, `${path}/${key}`, active);
  }
  active.delete(value);
  return output;
}
function validateMetadata(value: unknown): JsonObject {
  const out = json(value);
  if (Array.isArray(out) || out === null || typeof out !== "object")
    throw new TypeError("Audit metadata must be an object");
  return out;
}
const severity = (category: AuditCategory, name: string): AuditSeverity =>
  category === "gate" && /(blocked|withheld|detector_failed)/.test(name)
    ? "high"
    : category === "system" && /(break|dead_letter|overflow)/.test(name)
      ? "critical"
      : "info";
const sensitivity = (name: string): AuditActionDefinition["sensitivity"] =>
  /transcript|approval|rule_matched|content_/.test(name)
    ? "content"
    : "metadata";
const asyncSafe = (name: string): boolean =>
  name.startsWith("identity.login_failed") || name.startsWith("system.");
function entries(): Array<[AuditAction, AuditActionDefinition]> {
  return AUDIT_ACTION_NAMES.map((action) => {
    const category = action.slice(0, action.indexOf(".")) as AuditCategory;
    return [
      action,
      {
        action,
        category,
        sensitivity: sensitivity(action),
        asyncSafe: asyncSafe(action),
        defaultSeverity: severity(category, action),
        schemaVersion: 1,
        validateMetadata,
      },
    ];
  });
}
export const AUDIT_ACTIONS = Object.freeze(
  Object.fromEntries(entries()) as Record<AuditAction, AuditActionDefinition>,
);
export function actionDefinition(action: string): AuditActionDefinition {
  const definition = (
    AUDIT_ACTIONS as Readonly<Record<string, AuditActionDefinition | undefined>>
  )[action];
  if (!definition) throw new TypeError("Unknown audit action");
  return definition;
}

import { createHash } from "node:crypto";
import type { AuditHashV1, JsonValue } from "./audit-types.js";
import { CRYPTO_NAMESPACE } from '../../shared/crypto.js';

function validString(value: string): void {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff))
        throw new TypeError("Unpaired Unicode surrogate");
    } else if (code >= 0xdc00 && code <= 0xdfff)
      throw new TypeError("Unpaired Unicode surrogate");
  }
}
export function canonicalJson(value: JsonValue): string {
  const active = new Set<object>();
  const visit = (item: JsonValue): string => {
    if (item === null) return "null";
    // JSON has no `undefined`, so there is no canonical form to hash. Say so: reaching this with an
    // undefined property used to fall through to `Object.keys(undefined)` and surface as "Cannot
    // convert undefined or null to object", which names neither the key nor the caller.
    if (item === undefined)
      throw new TypeError("Audit JSON cannot contain undefined; omit the property instead");
    if (typeof item === "string") {
      validString(item);
      return JSON.stringify(item);
    }
    if (typeof item === "boolean") return item ? "true" : "false";
    if (typeof item === "number") {
      if (!Number.isSafeInteger(item) || Object.is(item, -0))
        throw new TypeError("Audit JSON numbers must be safe integers");
      return String(item);
    }
    if (active.has(item)) throw new TypeError("Cyclic audit JSON");
    active.add(item);
    let result: string;
    if (Array.isArray(item)) result = `[${item.map(visit).join(",")}]`;
    else
      result = `{${Object.keys(item)
        .sort()
        .map((key) => {
          validString(key);
          return `${JSON.stringify(key)}:${visit(item[key] as JsonValue)}`;
        })
        .join(",")}}`;
    active.delete(item);
    return result;
  };
  return visit(value);
}
export const sha256Hex = (bytes: string | Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
export function genesisHash(
  tenantId: string,
  epoch: number,
  priorHash: string | null = null,
): string {
  if (!Number.isSafeInteger(epoch) || epoch < 1)
    throw new TypeError("Invalid chain epoch");
  const prior = priorHash ?? "0".repeat(64);
  if (!/^[0-9a-f]{64}$/.test(prior)) throw new TypeError("Invalid prior hash");
  return sha256Hex(
    `${CRYPTO_NAMESPACE}:audit-genesis:v1\n${tenantId}\n${epoch}\n${prior}`,
  );
}
export function eventHash(value: AuditHashV1): string {
  return sha256Hex(
    `${CRYPTO_NAMESPACE}:audit-event:v1\n${canonicalJson(value as unknown as JsonValue)}`,
  );
}

import type { AuditSearchRow } from "./audit-search.js";

export type AuditExportFormat = "csv" | "ndjson" | "json";
export const AUDIT_EXPORT_FIELDS = [
  "id",
  "tenant_id",
  "chain_epoch",
  "sequence",
  "occurred_at_ms",
  "recorded_at_ms",
  "action",
  "category",
  "outcome",
  "severity",
  "actor_id",
  "target_type",
  "target_id",
  "metadata_json",
  "transcript_id",
  "prev_hash",
  "event_hash",
] as const;
export type AuditExportField = typeof AUDIT_EXPORT_FIELDS[number];
const allowedFields:ReadonlySet<string>=new Set(AUDIT_EXPORT_FIELDS);
export function validateAuditExportFields(value:unknown):readonly AuditExportField[]{
  if(value===undefined||value===null)return AUDIT_EXPORT_FIELDS;
  if(!Array.isArray(value))throw new TypeError("fields must be an array");
  if(value.some(field=>typeof field!=="string"||!allowedFields.has(field)))throw new TypeError("fields may contain only allowed audit export columns");
  if(value.length===0)return AUDIT_EXPORT_FIELDS;
  const selected=new Set(value);
  return AUDIT_EXPORT_FIELDS.filter(field=>selected.has(field));
}
function csv(value: unknown): string {
  let text = value === null ? "" : String(value);
  if (/^[ \t\r]*[=+\-@]/.test(text) || /^[\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
export async function* streamAuditExport(
  rows: AsyncIterable<AuditSearchRow> | Iterable<AuditSearchRow>,
  format: AuditExportFormat,
  fields?: readonly string[],
): AsyncGenerator<Uint8Array> {
  const columns=validateAuditExportFields(fields);
  const bytes = (value: string) => Buffer.from(value, "utf8");
  let first = true,
    count = 0;
  if (format === "csv") yield bytes(`${columns.join(",")}\r\n`);
  else if (format === "json") yield bytes('{"schemaVersion":1,"events":[');
  for await (const row of rows) {
    count++;
    if (format === "csv")
      yield bytes(`${columns.map((column) => csv(row[column])).join(",")}\r\n`);
    else {
      const value = JSON.stringify(Object.fromEntries(columns.map(column=>[column,row[column]])));
      if (format === "ndjson") yield bytes(`${value}\n`);
      else {
        yield bytes(`${first ? "" : ","}${value}`);
        first = false;
      }
    }
  }
  if (format === "json") yield bytes(`],"summary":{"rowCount":${count}}}`);
}

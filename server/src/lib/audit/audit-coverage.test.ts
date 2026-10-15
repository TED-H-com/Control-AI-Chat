import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { AUDIT_ACTIONS, type AuditAction } from "./audit-actions.js";

export const NOT_YET_EMITTED = new Map<AuditAction, string>();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_ROOT = path.resolve(HERE, "../..");

async function productionSources(directory: string): Promise<string[]> {
  const sources: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) sources.push(...(await productionSources(candidate)));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && candidate !== fileURLToPath(new URL("./audit-actions.ts", import.meta.url)))
      sources.push(await readFile(candidate, "utf8"));
  }
  return sources;
}

const difference = (left: ReadonlySet<string>, right: ReadonlySet<string>): string[] =>
  [...left].filter((action) => !right.has(action)).sort();

test("audit registry, emit sites, and gap allowlist stay aligned", async () => {
  const declared = new Set(Object.keys(AUDIT_ACTIONS));
  // Each file is read once; all action checks reuse these in-memory strings.
  const sources = await productionSources(SOURCE_ROOT);
  const emitted = new Set([...declared].filter((action) => sources.some((source) =>
    source.includes(`'${action}'`) || source.includes(`"${action}"`) || source.includes(`\`${action}\``),
  )));
  const uncovered = difference(declared, new Set([...emitted, ...NOT_YET_EMITTED.keys()]));
  const stale = [...NOT_YET_EMITTED.keys()].filter((action) => emitted.has(action)).sort();
  assert.deepEqual(uncovered, [], `declared audit actions neither emitted nor allowlisted: ${JSON.stringify(uncovered)}`);
  assert.deepEqual(stale, [], `stale NOT_YET_EMITTED entries are now emitted: ${JSON.stringify(stale)}`);
  for (const [action, reason] of NOT_YET_EMITTED)
    assert.match(reason, /\S/, `NOT_YET_EMITTED reason is empty for ${action}`);
});

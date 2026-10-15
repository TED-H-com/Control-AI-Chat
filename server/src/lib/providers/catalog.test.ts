import test from "node:test";
import assert from "node:assert/strict";
import { ModelCatalog } from "./catalog.js";
import { MODEL_CATALOG_SEED } from "./catalogSeed.js";

test("unverified and unpriced catalog models fail closed", () => {
  const catalog = new ModelCatalog(MODEL_CATALOG_SEED);
  assert.throws(() => catalog.assertCallable("openai:o3"), /requires verification/);
  assert.ok(catalog.list().every(row => row.verification === "verify" && row.notes?.startsWith("VERIFY:")));
});

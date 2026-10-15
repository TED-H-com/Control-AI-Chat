/**
 * Test-only bootstrap. `config.ts` throws on a missing secret at import time — correct for
 * production, but it means any test that transitively imports it dies before running. These
 * are fixed, obviously-fake values so failures are reproducible; real secrets come from
 * .env, created from .env.example as docs/DEPLOY.md describes, and are never committed.
 *
 * Anything already set in the environment wins, so a test can still override.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.DB_PATH===undefined) {
  const databaseDirectory=mkdtempSync(join(tmpdir(),'gateway-test-'));
  process.env.DB_PATH=join(databaseDirectory,'app.db');
  process.once('exit',()=>rmSync(databaseDirectory,{recursive:true,force:true}));
}

const testDefaults: Readonly<Record<string, string>> = {
  JWT_SECRET: 'test-jwt-secret-not-for-any-real-deployment-0000',
  AUDIT_KEY: 'test-audit-key-not-for-any-real-deployment-0000',
  PROVIDER_CREDENTIAL_KEY: 'test-provider-credential-key-not-for-deployment',
  NODE_ENV: 'test',
};

for (const [key, value] of Object.entries(testDefaults)) process.env[key] ??= value;

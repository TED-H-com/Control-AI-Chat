import type Database from 'better-sqlite3';
import { migration001 } from './001_baseline.js';

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly checksumSha256: string;
  readonly up: (database: Database.Database) => void;
  /**
   * Set by migrations that rebuild a table other tables reference, via the
   * rename / recreate / copy / drop dance. Two pragmas are required, and measurement says
   * both — neither alone is safe:
   *
   *   foreign_keys=ON,  legacy_alter_table=ON  -> children silently deleted, fk check CLEAN
   *   foreign_keys=ON,  legacy_alter_table=OFF -> children silently deleted, fk check CLEAN
   *   foreign_keys=OFF, legacy_alter_table=OFF -> children kept, but left pointing at the
   *                                               scratch table (fk check catches it)
   *   foreign_keys=OFF, legacy_alter_table=ON  -> correct
   *
   * `legacy_alter_table` stops the rename from re-aiming other tables' REFERENCES clauses at
   * the scratch table; `foreign_keys=OFF` stops the subsequent drop from cascading. The first
   * two rows are why this is a runner concern rather than a per-migration one: they destroy
   * data and still pass the post-migration check.
   *
   * `foreign_keys` is a no-op inside a transaction, so it is toggled around the whole apply.
   */
  readonly requiresTableRebuild?: boolean;
}

export const migrations: readonly Migration[] = [migration001];
const ledgerSql = `CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  name TEXT NOT NULL UNIQUE,
  checksum_sha256 TEXT NOT NULL CHECK (length(checksum_sha256) = 64),
  applied_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0)
) STRICT;`;

export function runMigrations(database: Database.Database, selected:readonly Migration[]=migrations): void {
  database.exec(ledgerSql);
  const newestVersion=migrations.at(-1)?.version??0;
  const recordedVersion=database.prepare<[],{version:number|null}>('SELECT MAX(version) AS version FROM schema_version').get()?.version??0;
  if(recordedVersion>newestVersion)throw new Error('Refusing to start: database is newer than this build');
  selected.forEach((migration, index) => {
    if (migration.version !== index + 1) throw new Error('Migrations must be contiguous from version 1');
    const appliedStatement=database.prepare<[number], {name:string;checksum_sha256:string}>(
      'SELECT name, checksum_sha256 FROM schema_version WHERE version = ?',
    );
    const verify=(applied:{name:string;checksum_sha256:string}):void=>{
      if (applied.name !== migration.name || applied.checksum_sha256 !== migration.checksumSha256) {
        throw new Error(`Migration ${migration.version} checksum/name mismatch`);
      }
    };
    const existing=appliedStatement.get(migration.version);
    if(existing){verify(existing);return;}
    const apply = database.transaction(() => {
      // The check belongs behind the same IMMEDIATE write lock as the schema change. Otherwise two
      // processes can both observe a missing ledger row and the second repeats an ALTER TABLE after
      // the first commits it.
      const applied=appliedStatement.get(migration.version);
      if(applied){verify(applied);return;}
      const started = Date.now();
      migration.up(database);
      const violations = database.prepare<[], unknown>('PRAGMA foreign_key_check').all();
      if (violations.length > 0) throw new Error(`Migration ${migration.version} introduced foreign key violations`);
      database.prepare<[number,string,string,number,number]>(
        'INSERT INTO schema_version(version,name,checksum_sha256,applied_at,duration_ms) VALUES(?,?,?,?,?)',
      ).run(migration.version, migration.name, migration.checksumSha256, Date.now(), Date.now() - started);
    });
    if (!migration.requiresTableRebuild) {
      apply.immediate();
      return;
    }
    // Enforcement is off for the duration, so the `PRAGMA foreign_key_check` inside `apply` is
    // the only thing standing between a botched rebuild and a corrupt schema. It runs regardless
    // of the pragma, and a violation still rolls the whole migration back.
    if (database.inTransaction) throw new Error(`Migration ${migration.version} cannot run inside an open transaction`);
    database.pragma('foreign_keys = OFF');
    database.pragma('legacy_alter_table = ON');
    try {
      apply.immediate();
    } finally {
      database.pragma('legacy_alter_table = OFF');
      database.pragma('foreign_keys = ON');
    }
  });
}

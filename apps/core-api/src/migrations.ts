import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";

export type Migration = {
  version: string;
  name: string;
  checksum: string;
  sql: string;
};

const migrationDirectory = fileURLToPath(
  new URL("../../../database/migrations/", import.meta.url),
);
const migrationLockId = "98036563096137";

export async function loadMigrations(
  directory = migrationDirectory,
): Promise<Migration[]> {
  const files = (await readdir(directory)).filter((file) =>
    file.endsWith(".sql"),
  );
  const migrations = await Promise.all(
    files.map(async (file): Promise<Migration> => {
      const match = /^(\d{3,})_([a-z0-9][a-z0-9_-]*)\.sql$/i.exec(file);
      if (!match) throw new Error(`Invalid migration filename: ${file}`);
      const sql = (await readFile(join(directory, file), "utf8")).replace(
        /\r\n/g,
        "\n",
      );
      return {
        version: match[1],
        name: file,
        checksum: createHash("sha256").update(sql).digest("hex"),
        sql,
      };
    }),
  );
  migrations.sort((left, right) => {
    const leftVersion = BigInt(left.version);
    const rightVersion = BigInt(right.version);
    return leftVersion < rightVersion ? -1 : leftVersion > rightVersion ? 1 : 0;
  });

  for (let index = 1; index < migrations.length; index += 1) {
    if (migrations[index - 1].version === migrations[index].version) {
      throw new Error(
        `Duplicate migration version: ${migrations[index].version}`,
      );
    }
  }
  if (!migrations.length)
    throw new Error(`No SQL migrations found in ${directory}`);
  return migrations;
}

async function applyMigration(
  client: PoolClient,
  migration: Migration,
): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(migration.sql);
    await client.query(
      `INSERT INTO schema_migrations (version, name, checksum)
       VALUES ($1, $2, $3)`,
      [migration.version, migration.name, migration.checksum],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw new Error(`Failed to apply database migration ${migration.name}`, {
      cause: error,
    });
  }
}

export async function runMigrations(
  pool: Pool,
  directory = migrationDirectory,
): Promise<string[]> {
  const migrations = await loadMigrations(directory);
  const client = await pool.connect();
  let locked = false;
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock($1::bigint)", [
      migrationLockId,
    ]);
    locked = true;
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version TEXT PRIMARY KEY,
         name TEXT NOT NULL,
         checksum TEXT NOT NULL CHECK (length(checksum) = 64),
         applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`,
    );
    const existing = await client.query<{
      version: string;
      name: string;
      checksum: string;
    }>(
      "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
    );
    const migrationByVersion = new Map(
      migrations.map((migration) => [migration.version, migration]),
    );
    for (const row of existing.rows) {
      const migration = migrationByVersion.get(row.version);
      if (!migration)
        throw new Error(
          `Applied migration ${row.version} is missing from the current build`,
        );
      if (migration.name !== row.name || migration.checksum !== row.checksum) {
        throw new Error(
          `Applied migration ${row.name} has changed; add a new migration instead`,
        );
      }
    }

    const appliedVersions = new Set(existing.rows.map((row) => row.version));
    for (const migration of migrations) {
      if (appliedVersions.has(migration.version)) continue;
      await applyMigration(client, migration);
      applied.push(migration.name);
    }
    return applied;
  } finally {
    try {
      if (locked)
        await client.query("SELECT pg_advisory_unlock($1::bigint)", [
          migrationLockId,
        ]);
    } finally {
      client.release();
    }
  }
}

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMigrations } from "./migrations.js";

describe("database migrations", () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("loads migrations in numeric version order with content checksums", async () => {
    directory = await mkdtemp(join(tmpdir(), "yanagi-migrations-"));
    await writeFile(join(directory, "010_second.sql"), "SELECT 2;");
    await writeFile(join(directory, "002_first.sql"), "SELECT 1;");

    const migrations = await loadMigrations(directory);

    expect(migrations.map(({ version, name }) => ({ version, name }))).toEqual([
      { version: "002", name: "002_first.sql" },
      { version: "010", name: "010_second.sql" },
    ]);
    expect(migrations[0].checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(migrations[0].sql).toBe("SELECT 1;");
  });

  it("rejects malformed and duplicate migration versions", async () => {
    directory = await mkdtemp(join(tmpdir(), "yanagi-migrations-"));
    await writeFile(join(directory, "notes.sql"), "SELECT 1;");
    await expect(loadMigrations(directory)).rejects.toThrow(
      "Invalid migration filename",
    );

    await rm(join(directory, "notes.sql"));
    await writeFile(join(directory, "001_first.sql"), "SELECT 1;");
    await writeFile(join(directory, "001_duplicate.sql"), "SELECT 2;");
    await expect(loadMigrations(directory)).rejects.toThrow(
      "Duplicate migration version",
    );
  });
});

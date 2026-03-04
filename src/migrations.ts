import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";

function nowIso(): string {
  return new Date().toISOString();
}

export async function runMigrations(db: Database, migrationsDir: string): Promise<void> {
  db.run("CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");

  const entries = await readdir(migrationsDir, { withFileTypes: true });
  const migrationFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();

  const getApplied = db.query("SELECT 1 FROM migrations WHERE name = ?");
  const insertApplied = db.query("INSERT INTO migrations (name, applied_at) VALUES (?, ?)");

  for (const fileName of migrationFiles) {
    const applied = getApplied.get(fileName);
    if (applied) {
      continue;
    }

    const sqlPath = join(migrationsDir, fileName);
    const sql = await Bun.file(sqlPath).text();

    db.transaction(() => {
      db.exec(sql);
      insertApplied.run(fileName, nowIso());
    })();
  }
}

export function defaultMigrationsDir(importMetaUrl: string): string {
  return join(dirname(new URL(importMetaUrl).pathname), "..", "migrations");
}

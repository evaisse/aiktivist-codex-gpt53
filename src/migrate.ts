import { join } from "node:path";
import { loadConfig } from "./config";
import { openDatabase } from "./db";
import { runMigrations } from "./migrations";

const config = loadConfig();
const db = await openDatabase(config.dbPath);

await runMigrations(db, join(import.meta.dir, "..", "migrations"));

console.log(`Migrations applied for ${config.dbPath}`);

db.close(false);

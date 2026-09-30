import { Database } from "bun:sqlite";
import { readFileSync, existsSync, mkdirSync, chmodSync, lstatSync, realpathSync, openSync, fchmodSync, closeSync, fstatSync, constants } from "node:fs";
import { dirname, join, resolve as pathResolve } from "node:path";
import { config } from "@/shared/config.js";
import { logger } from "@/shared/logger.js";

process.umask(0o077);

let db: Database | null = null;

function checkSymlink(path: string, description: string): void {
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      throw new Error(`SECURITY: ${description} ${path} is a symbolic link. Refusing to start.`);
    }
  }
}

function checkAncestorSymlinks(dbPath: string): void {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) return;

  const lexicalPath = pathResolve(dir);
  let canonicalPath: string;
  try {
    canonicalPath = realpathSync(dir);
  } catch (err) {
    throw new Error(`SECURITY: Failed to resolve real path of ${dir}: ${(err as Error).message}`);
  }

  if (lexicalPath !== canonicalPath) {
    throw new Error(`SECURITY: Database directory ${dir} has a symlink in its ancestor chain (resolved to ${canonicalPath}). Refusing to start.`);
  }
}

function lockDownPermissions(dbPath: string): void {
  try {
    const fd = openSync(dbPath, constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) {
        throw new Error(`SECURITY: ${dbPath} is not a regular file.`);
      }
      fchmodSync(fd, 0o600);
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    throw new Error(`SECURITY: Failed to set permissions on ${dbPath}: ${(err as Error).message}`);
  }
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${dbPath}${suffix}`;
    if (existsSync(sidecar)) {
      try {
        const fd = openSync(sidecar, constants.O_RDWR | constants.O_NOFOLLOW);
        try {
          const stat = fstatSync(fd);
          if (!stat.isFile()) {
            throw new Error(`SECURITY: ${sidecar} is not a regular file.`);
          }
          fchmodSync(fd, 0o600);
        } finally {
          closeSync(fd);
        }
      } catch (err) {
        throw new Error(`SECURITY: Failed to set permissions on ${sidecar}: ${(err as Error).message}`);
      }
    }
  }
}

/** Returns the singleton SQLite connection, creating the database file with restricted permissions (0600) on first access. Sets process umask to 0o077 before DB creation to ensure WAL/SHM sidecars inherit safe permissions. */
export function getDb(): Database {
  if (!db) {
    const dbPath = config.DB_PATH;
    const isFile = dbPath !== ":memory:";

    if (isFile) {
      const dir = dirname(dbPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
      }

      checkAncestorSymlinks(dbPath);
      checkSymlink(dir, "Database directory");
      checkSymlink(dbPath, "Database file");

      try {
        chmodSync(dir, 0o700);
      } catch (err) {
        throw new Error(`SECURITY: Failed to set permissions on directory ${dir}: ${(err as Error).message}`);
      }
    }

    db = new Database(dbPath, { create: true });

    db.exec("PRAGMA secure_delete = ON");

    if (isFile) lockDownPermissions(dbPath);

    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA journal_mode = WAL");

    if (isFile) lockDownPermissions(dbPath);

    logger.info("Database connection established", { path: dbPath });
  }

  return db;
}

export function closeDb(): void {
  if (db) {
    try {
      const stmt = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)");
      const MAX_RETRIES = 5;
      const RETRY_DELAY_MS = 100;

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const result = stmt.get() as { busy: number } | null;
        if (!result || result.busy === 0) {
          logger.info("WAL checkpoint completed before shutdown");
          break;
        }
        logger.warn("WAL checkpoint blocked by concurrent reader", { attempt: attempt + 1 });
        if (attempt < MAX_RETRIES - 1) {
          Bun.sleepSync(RETRY_DELAY_MS);
        } else {
          logger.error("WAL checkpoint failed after max retries during shutdown");
        }
      }
    } catch (err) {
      logger.error("WAL checkpoint failed during shutdown", err as Error);
    }
    db.close();
    db = null;
    logger.info("Database connection closed");
  }
}

interface Migration {
  name: string;
  applied_at: string;
}

function getAppliedMigrations(database: Database): string[] {
  try {
    const query = database.query<Migration, []>("SELECT name FROM _migrations ORDER BY id");
    return query.all().map((row) => row.name);
  } catch {
    return [];
  }
}

function applyMigration(database: Database, name: string, sql: string): void {
  logger.info("Applying migration", { migration: name });

  database.run("BEGIN");
  try {
    database.exec(sql);

    const insert = database.prepare(
      "INSERT INTO _migrations (name) VALUES (?)"
    );
    insert.run(name);

    database.run("COMMIT");
    logger.info("Migration applied successfully", { migration: name });
  } catch (error) {
    database.run("ROLLBACK");
    throw error;
  }
}

export function migrate(): void {
  const database = getDb();
  const migrationsDir = join(import.meta.dirname, "migrations");

  const appliedMigrations = getAppliedMigrations(database);

  const migrationFiles = ["001-inbound-emails.sql"];

  for (const file of migrationFiles) {
    const name = file.replace(".sql", "");

    if (appliedMigrations.includes(name)) {
      logger.debug("Migration already applied", { migration: name });
      continue;
    }

    const migrationPath = join(migrationsDir, file);
    const sql = readFileSync(migrationPath, "utf-8");

    applyMigration(database, name, sql);
  }

  logger.info("All migrations applied");
}

if (import.meta.main) {
  try {
    migrate();
    console.log("✓ Migrations applied successfully");
    closeDb();
    process.exit(0);
  } catch (error) {
    console.error("✗ Migration failed:", error);
    closeDb();
    process.exit(1);
  }
}

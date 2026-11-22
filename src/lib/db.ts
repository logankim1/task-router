import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { Clock } from "./clock";
import { systemClock } from "./clock";

export type DbClient = Database.Database;

const DEFAULT_DB_PATH =
  process.env.DB_PATH || path.join(process.cwd(), "data", "routing.db");

export interface SeedHooks {
  onSeed?: (db: DbClient, clock: Clock) => void;
}

export function openDb(
  dbPath = DEFAULT_DB_PATH,
  clock: Clock = systemClock,
  hooks?: SeedHooks
): DbClient {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS contributors (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      areas_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      area TEXT NOT NULL CHECK (area IN ('finance', 'healthcare', 'data analysis', 'operations')),
      priority TEXT NOT NULL CHECK (priority IN ('low', 'normal', 'high')),
      state TEXT NOT NULL CHECK (
        state IN (
          'DRAFT',
          'ROUTING',
          'ASSIGNED',
          'IN_PROGRESS',
          'UNRESOLVED',
          'RECOVERY_NEEDED',
          'COMPLETED'
        )
      ),
      assignee_id TEXT,
      routing_epoch INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (assignee_id) REFERENCES contributors(id)
    );

    CREATE TABLE IF NOT EXISTS routing_attempts (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      epoch INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN (
          'pending',
          'matched',
          'no_match',
          'stale_ignored',
          'cancelled',
          'interrupted_by_restart'
        )
      ),
      candidate_contributor_id TEXT,
      late_candidate_contributor_id TEXT,
      late_arrived_at INTEGER,
      sim_mode TEXT NOT NULL CHECK (sim_mode IN ('realistic', 'fast', 'slow', 'hang', 'no_match')),
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (candidate_contributor_id) REFERENCES contributors(id),
      FOREIGN KEY (late_candidate_contributor_id) REFERENCES contributors(id)
    );

    CREATE TABLE IF NOT EXISTS event_logs (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      task_id TEXT NOT NULL,
      epoch INTEGER,
      event_type TEXT NOT NULL,
      actor TEXT NOT NULL CHECK (actor IN ('system', 'operator', 'contributor')),
      summary TEXT NOT NULL,
      payload_json TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_one_pending_attempt_per_task
      ON routing_attempts(task_id)
      WHERE status = 'pending';

    CREATE UNIQUE INDEX IF NOT EXISTS idx_one_attempt_per_epoch
      ON routing_attempts(task_id, epoch);

    CREATE INDEX IF NOT EXISTS idx_attempts_task_epoch
      ON routing_attempts(task_id, epoch);

    CREATE INDEX IF NOT EXISTS idx_events_task_seq
      ON event_logs(task_id, seq ASC);
  `);

  seedContributorsIfEmpty(db);

  if (hooks?.onSeed) {
    const taskCount = (
      db.prepare("SELECT COUNT(*) AS cnt FROM tasks").get() as { cnt: number }
    ).cnt;
    if (taskCount === 0) {
      hooks.onSeed(db, clock);
    }
  }

  return db;
}

export function seedContributorsIfEmpty(db: DbClient): void {
  const countRow = db.prepare("SELECT COUNT(*) AS cnt FROM contributors").get() as {
    cnt: number;
  };
  if (countRow.cnt > 0) return;

  const insertContrib = db.prepare(
    "INSERT INTO contributors (id, name, areas_json) VALUES (?, ?, ?)"
  );

  const tx = db.transaction(() => {
    insertContrib.run("c-1", "Maya Lin", JSON.stringify(["finance", "operations"]));
    insertContrib.run("c-2", "Devon Brooks", JSON.stringify(["data analysis"]));
    insertContrib.run("c-3", "Priya Nair", JSON.stringify(["healthcare", "operations"]));
    insertContrib.run("c-4", "Mateo Silva", JSON.stringify(["finance", "data analysis"]));
  });

  tx();
}
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

/** Thin SQLite facade so callers don't import a driver directly. */
export type SqlStatement = {
  run: (...params: unknown[]) => { changes: number; lastInsertRowid: number | bigint };
  get: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => unknown[];
};

export type Db = {
  readonly driver: "better-sqlite3";
  readonly filePath: string;
  exec: (sql: string) => void;
  prepare: (sql: string) => SqlStatement;
  transaction: <T>(fn: () => T) => T;
  close: () => void;
};

export function openDb(filePath: string): Db {
  if (filePath !== ":memory:") {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  const raw = new Database(filePath);
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");

  return {
    driver: "better-sqlite3",
    filePath,
    exec(sql) {
      raw.exec(sql);
    },
    prepare(sql) {
      const stmt = raw.prepare(sql);
      return {
        run: (...params: unknown[]) => {
          const info = stmt.run(...params);
          return {
            changes: info.changes,
            lastInsertRowid: info.lastInsertRowid,
          };
        },
        get: (...params: unknown[]) => stmt.get(...params),
        all: (...params: unknown[]) => stmt.all(...params),
      };
    },
    transaction(fn) {
      return raw.transaction(fn)();
    },
    close() {
      raw.close();
    },
  };
}

function ensureColumn(db: Db, table: string, column: string, decl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}

export function migrate(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS questions (
      id TEXT PRIMARY KEY,
      module INTEGER NOT NULL,
      topic TEXT NOT NULL,
      type TEXT NOT NULL,
      difficulty INTEGER NOT NULL,
      source TEXT NOT NULL,
      needs_review INTEGER NOT NULL DEFAULT 0,
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question_id TEXT NOT NULL,
      module INTEGER NOT NULL,
      topic TEXT NOT NULL,
      concept_tags TEXT NOT NULL,
      type TEXT NOT NULL,
      score REAL NOT NULL,
      time_spent_ms INTEGER NOT NULL,
      timestamp TEXT NOT NULL,
      mode TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_attempts_question_id ON attempts(question_id);
    CREATE INDEX IF NOT EXISTS idx_questions_module ON questions(module);

    CREATE TABLE IF NOT EXISTS question_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question_id TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      timestamp TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_question_reports_qid ON question_reports(question_id);
  `);

  ensureColumn(db, "attempts", "llm_verdict", "TEXT");
  ensureColumn(db, "attempts", "llm_confidence", "REAL");
  ensureColumn(db, "attempts", "spelling_error", "INTEGER DEFAULT 0");
  ensureColumn(db, "attempts", "user_answer", "TEXT");
  ensureColumn(db, "attempts", "override_note", "TEXT");
}

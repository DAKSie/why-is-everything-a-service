import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

/** Thin SQLite facade so callers don't import a driver directly. */
export type SqlStatement = {
  run: (...params: unknown[]) => { changes: number };
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
        run: (...params: unknown[]) => stmt.run(...params),
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
  `);
}

import fs from "node:fs";
import path from "node:path";
import type { Db } from "../db.js";
import { attachOutdatedToQuestion } from "./outdatedAttach.js";
import { parseQuestionBank, type Question } from "./schema.js";

export type UpsertResult = {
  upserted: number;
  /** Attempt rows remaining after upsert — must never drop. */
  attemptsPreserved: number;
};

/**
 * Upsert questions by stable id. Never deletes questions or attempts.
 */
export function upsertQuestions(db: Db, questions: Question[]): UpsertResult {
  const stmt = db.prepare(`
    INSERT INTO questions (
      id, module, topic, type, difficulty, source, needs_review, data, updated_at
    ) VALUES (
      @id, @module, @topic, @type, @difficulty, @source, @needs_review, @data, @updated_at
    )
    ON CONFLICT(id) DO UPDATE SET
      module = excluded.module,
      topic = excluded.topic,
      type = excluded.type,
      difficulty = excluded.difficulty,
      source = excluded.source,
      needs_review = excluded.needs_review,
      data = excluded.data,
      updated_at = excluded.updated_at
  `);

  const now = new Date().toISOString();

  db.transaction(() => {
    for (const raw of questions) {
      const q = attachOutdatedToQuestion(raw);
      stmt.run({
        id: q.id,
        module: q.module,
        topic: q.topic,
        type: q.type,
        difficulty: q.difficulty,
        source: q.source,
        needs_review: q.needsReview ? 1 : 0,
        data: JSON.stringify(q),
        updated_at: now,
      });
    }
  });

  const attemptsRow = db.prepare(`SELECT COUNT(*) AS c FROM attempts`).get() as {
    c: number;
  };

  return {
    upserted: questions.length,
    attemptsPreserved: attemptsRow.c,
  };
}

export function loadQuestionsFromFile(filePath: string): Question[] {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  return parseQuestionBank(raw);
}

/** Prefer built bank; fall back to sample questions for offline first-run. */
export function resolveQuestionBankPath(dataDir: string): string {
  const built = path.join(dataDir, "questions.json");
  const sample = path.join(dataDir, "sample-questions.json");
  if (fs.existsSync(built)) return built;
  if (fs.existsSync(sample)) return sample;
  throw new Error(
    `No question bank found. Expected ${built} or ${sample}`,
  );
}

export function seedQuestionsFromDataDir(db: Db, dataDir: string): UpsertResult & {
  path: string;
} {
  const bankPath = resolveQuestionBankPath(dataDir);
  const questions = loadQuestionsFromFile(bankPath);
  const result = upsertQuestions(db, questions);
  return { ...result, path: bankPath };
}

export function countQuestions(db: Db): number {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM questions`).get() as {
    c: number;
  };
  return row.c;
}

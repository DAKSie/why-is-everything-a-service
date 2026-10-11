import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, openDb, type Db } from "../db.js";
import { loadQuestionsFromFile, upsertQuestions } from "./load.js";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const samplePath = path.join(rootDir, "data", "sample-questions.json");

const dbs: Db[] = [];

afterEach(() => {
  while (dbs.length) {
    dbs.pop()?.close();
  }
});

function tempDb(): Db {
  const file = path.join(
    os.tmpdir(),
    `ihateaws-test-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
  );
  const db = openDb(file);
  migrate(db);
  dbs.push(db);
  return db;
}

describe("upsertQuestions", () => {
  it("upserts by id and never deletes attempt rows", () => {
    const db = tempDb();
    const questions = loadQuestionsFromFile(samplePath);
    expect(questions.length).toBe(20);

    const first = upsertQuestions(db, questions);
    expect(first.upserted).toBe(20);

    const qid = questions[0]!.id;
    db.prepare(
      `INSERT INTO attempts (
        question_id, module, topic, concept_tags, type, score, time_spent_ms, timestamp, mode
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      qid,
      questions[0]!.module,
      questions[0]!.topic,
      JSON.stringify(questions[0]!.conceptTags),
      questions[0]!.type,
      0.5,
      1200,
      new Date().toISOString(),
      "smart",
    );

    const attemptsBefore = (
      db.prepare(`SELECT COUNT(*) AS c FROM attempts`).get() as { c: number }
    ).c;
    expect(attemptsBefore).toBe(1);

    // Second seed with a field update for the same id (explanation change only).
    const updated = questions.map((q, i) =>
      i === 0 ? { ...q, explanation: `${q.explanation} (edited)` } : q,
    );
    const second = upsertQuestions(db, updated);

    expect(second.upserted).toBe(20);
    expect(second.attemptsPreserved).toBe(1);

    const attemptsAfter = (
      db.prepare(`SELECT COUNT(*) AS c FROM attempts`).get() as { c: number }
    ).c;
    expect(attemptsAfter).toBe(1);

    const stored = db
      .prepare(`SELECT data FROM questions WHERE id = ?`)
      .get(qid) as { data: string };
    expect(JSON.parse(stored.data).explanation).toContain("(edited)");

    const questionCount = (
      db.prepare(`SELECT COUNT(*) AS c FROM questions`).get() as { c: number }
    ).c;
    expect(questionCount).toBe(20);
  });

  it("loads the sample file from disk", () => {
    expect(fs.existsSync(samplePath)).toBe(true);
    const questions = loadQuestionsFromFile(samplePath);
    expect(questions.every((q) => q.id.length === 32)).toBe(true);
  });
});

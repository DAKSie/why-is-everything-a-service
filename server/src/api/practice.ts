import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import type { Db } from "../db.js";
import { env } from "../env.js";
import {
  defaultDecisionsPath,
  loadDecisions,
  type ReviewDecision,
} from "../ingest/decisions.js";
import { checkOllama } from "../ollama.js";
import { mcSelectionMode } from "../questions/mcInput.js";
import {
  attachOutdatedToQuestion,
  explanationForDisplay,
} from "../questions/outdatedAttach.js";
import type { Question } from "../questions/schema.js";
import { upsertQuestions } from "../questions/load.js";
import {
  charDiff,
  scoreIdentificationAsync,
  scoreMultipleChoice,
  scoreProcedural,
} from "../scoring/index.js";
import { scoreSituationalKeyword } from "../scoring/situational.js";
import { appendAnswerOverride } from "./overrides.js";
import { auditQuestionFromEvidence } from "./audit.js";
import {
  getGenerateJobStatus,
  getRecentlyGenerated,
  removeRecentGenerated,
  requestCancelGenerateJob,
  startGenerateJob,
} from "../generate/job.js";

function rowToQuestion(row: { data: string }): Question {
  return attachOutdatedToQuestion(JSON.parse(row.data) as Question);
}

function sourceBreadcrumb(q: Question): string {
  const parts = q.sourceRef.heading
    .split(/\s*>\s*/)
    .map((p) => p.replace(/^module\s*\d+\s*[-–—]\s*/i, "").trim())
    .filter(Boolean);
  if (parts.length === 0) return `Module ${q.module}`;
  return `Module ${q.module} > ${parts.join(" > ")}`;
}

function publicQuestion(q: Question): Record<string, unknown> {
  const base = {
    id: q.id,
    module: q.module,
    topic: q.topic,
    conceptTags: q.conceptTags,
    type: q.type,
    difficulty: q.difficulty,
    prompt: q.prompt,
    source: q.source,
    sourceRef: q.sourceRef,
    sourceBreadcrumb: sourceBreadcrumb(q),
    needsReview: q.needsReview,
    outdatedNote: q.outdatedNote,
    aiGenerated: q.source === "generated",
  };
  switch (q.type) {
    case "multiple_choice": {
      const sel = mcSelectionMode(q);
      return {
        ...base,
        options: q.options,
        selectionMode: sel.mode,
        chooseHint: sel.chooseHint,
        correctCount: sel.correctCount,
        isTrueFalse: sel.isTrueFalse,
      };
    }
    case "procedural":
      return { ...base, shuffledSteps: shuffleStable(q.steps, q.id) };
    case "identification":
      return { ...base };
    case "situational":
      return { ...base, scenario: q.scenario };
    default:
      return base;
  }
}

function shuffleStable(steps: string[], seed: string): string[] {
  const arr = [...steps];
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  for (let i = arr.length - 1; i > 0; i -= 1) {
    h = (h * 1664525 + 1013904223) >>> 0;
    const j = h % (i + 1);
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  if (arr.every((s, i) => s === steps[i]) && arr.length > 1) {
    [arr[0], arr[1]] = [arr[1]!, arr[0]!];
  }
  return arr;
}

function mcResultLine(
  score: number,
  hits: number,
  required: number,
): string {
  if (score >= 1) return "Correct";
  if (score <= 0) return "Incorrect";
  return `Partially correct ${hits}/${required}`;
}

export function practiceRouter(db: Db): Router {
  const router = Router();

  router.get("/questions/next", (req, res) => {
    const modulesRaw = String(req.query.modules ?? "6,7,8,9,10");
    const modules = modulesRaw
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => [6, 7, 8, 9, 10].includes(n));
    const exclude = new Set(
      String(req.query.exclude ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );

    const placeholders = modules.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT id, data FROM questions WHERE module IN (${placeholders}) ORDER BY id`,
      )
      .all(...modules) as Array<{ id: string; data: string }>;

    const pool = rows.filter((r) => !exclude.has(r.id));
    if (pool.length === 0) {
      res.status(404).json({ error: "no questions left in pool" });
      return;
    }
    const pick = pool[Math.floor(Math.random() * pool.length)]!;
    const q = rowToQuestion(pick);
    res.json({ question: publicQuestion(q), remaining: pool.length - 1 });
  });

  router.post("/grade", async (req, res) => {
    const { questionId, answer } = req.body as {
      questionId?: string;
      answer?: unknown;
    };
    if (!questionId) {
      res.status(400).json({ error: "questionId required" });
      return;
    }
    const row = db
      .prepare(`SELECT data FROM questions WHERE id = ?`)
      .get(questionId) as { data: string } | undefined;
    if (!row) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const q = rowToQuestion(row);
    const explanation = explanationForDisplay(q);
    const breadcrumb = sourceBreadcrumb(q);

    let score = 0;
    let feedback: Record<string, unknown> = {};
    let llmVerdict: string | null = null;
    let llmConfidence: number | null = null;
    let spellingError = false;
    const userAnswerStr =
      typeof answer === "string"
        ? answer
        : Array.isArray(answer)
          ? JSON.stringify(answer)
          : String(answer ?? "");

    switch (q.type) {
      case "multiple_choice": {
        const selected = Array.isArray(answer)
          ? (answer as number[])
          : typeof answer === "number"
            ? [answer]
            : [];
        const scored = scoreMultipleChoice({
          correctIndices: q.correctIndices,
          selectedIndices: selected,
        });
        score = scored.score;
        const required = new Set(q.correctIndices);
        let hits = 0;
        for (const i of selected) if (required.has(i)) hits += 1;
        const options = q.options.map((text, index) => {
          const isCorrect = required.has(index);
          const isSelected = selected.includes(index);
          let mark: "correct" | "wrong_pick" | "missed" | "neutral" = "neutral";
          if (isCorrect && isSelected) mark = "correct";
          else if (!isCorrect && isSelected) mark = "wrong_pick";
          else if (isCorrect && !isSelected) mark = "missed";
          return { index, text, isCorrect, isSelected, mark };
        });
        const yourLabels = selected.map((i) => q.options[i] ?? `option ${i}`);
        const correctLabels = q.correctIndices.map(
          (i) => q.options[i] ?? `option ${i}`,
        );
        feedback = {
          kind: "multiple_choice",
          resultLine: mcResultLine(score, hits, required.size),
          yourAnswer: yourLabels,
          correctAnswer: correctLabels,
          options,
          explanation,
          sourceBreadcrumb: breadcrumb,
        };
        break;
      }
      case "procedural": {
        const submitted = Array.isArray(answer) ? (answer as string[]) : [];
        const scored = scoreProcedural({
          correctSteps: q.steps,
          submittedSteps: submitted,
        });
        score = scored.score;
        feedback = {
          kind: "procedural",
          resultLine:
            score >= 1
              ? "Correct"
              : score <= 0
                ? "Incorrect"
                : `Partially correct ${Math.round(score * q.steps.length)}/${q.steps.length}`,
          yourOrder: submitted.map((step, i) => ({
            step,
            outOfPlace: (q.steps[i] ?? "") !== step,
          })),
          correctOrder: q.steps.map((step, i) => ({
            step,
            outOfPlace: (submitted[i] ?? "") !== step,
          })),
          explanation,
          sourceBreadcrumb: breadcrumb,
        };
        break;
      }
      case "identification": {
        const submitted = typeof answer === "string" ? answer : "";
        const scored = await scoreIdentificationAsync({
          questionId: q.id,
          prompt: q.prompt,
          acceptedAnswers: q.acceptedAnswers,
          aliases: q.aliases,
          evidenceQuote: q.evidenceQuote,
          submitted,
        });
        score = scored.score;
        spellingError = scored.spellingError;
        if (scored.llmVerdict) {
          llmVerdict = scored.llmVerdict.verdict;
          llmConfidence = scored.llmVerdict.confidence;
        }
        const accepted = scored.matchedAnswer ?? q.acceptedAnswers[0] ?? "";
        feedback = {
          kind: "identification",
          resultLine:
            score >= 1
              ? scored.spellingError
                ? "Accepted (spelling)"
                : "Correct"
              : "Incorrect",
          yourAnswer: submitted,
          correctAnswer: accepted,
          diff: charDiff(submitted, accepted),
          spellingNote: scored.spellingError
            ? `Accepted: you wrote “${submitted}”, the notes say “${accepted}”`
            : undefined,
          aiNote: scored.aiUnavailable ? "AI checker unavailable" : undefined,
          llmVerdict: scored.llmVerdict,
          explanation,
          sourceBreadcrumb: breadcrumb,
        };
        break;
      }
      case "situational": {
        const submitted = typeof answer === "string" ? answer : "";
        const scored = scoreSituationalKeyword({
          keyPoints: q.rubric.keyPoints,
          mustMention: q.rubric.mustMention,
          submitted,
        });
        score = scored.score;
        feedback = {
          kind: "situational",
          resultLine: `Score ${Math.round(score * 100)}%`,
          score,
          keyPointsHit: scored.keyPointsHit,
          keyPointsMissed: scored.keyPointsMissed,
          feedback: scored.label,
          modelAnswer: q.modelAnswer,
          explanation,
          sourceBreadcrumb: breadcrumb,
        };
        break;
      }
      default:
        res.status(400).json({ error: "unsupported type" });
        return;
    }

    const insert = db
      .prepare(
        `INSERT INTO attempts (
          question_id, module, topic, concept_tags, type, score, time_spent_ms,
          timestamp, mode, llm_verdict, llm_confidence, spelling_error, user_answer
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        q.id,
        q.module,
        q.topic,
        JSON.stringify(q.conceptTags),
        q.type,
        Math.max(0, Math.min(1, score)),
        Number((req.body as { timeSpentMs?: number }).timeSpentMs ?? 0),
        new Date().toISOString(),
        "practice",
        llmVerdict,
        llmConfidence,
        spellingError ? 1 : 0,
        userAnswerStr.slice(0, 4000),
      );

    res.json({
      score,
      attemptId: Number(insert.lastInsertRowid),
      feedback,
    });
  });

  router.post("/attempts/:id/override", (req, res) => {
    const attemptId = Number(req.params.id);
    const countedAs = (req.body as { countedAs?: string }).countedAs;
    if (countedAs !== "correct" && countedAs !== "incorrect") {
      res.status(400).json({ error: "countedAs must be correct|incorrect" });
      return;
    }
    const row = db
      .prepare(
        `SELECT id, question_id, score, user_answer FROM attempts WHERE id = ?`,
      )
      .get(attemptId) as
      | {
          id: number;
          question_id: string;
          score: number;
          user_answer: string | null;
        }
      | undefined;
    if (!row) {
      res.status(404).json({ error: "attempt not found" });
      return;
    }
    const newScore = countedAs === "correct" ? 1 : 0;
    db.prepare(
      `UPDATE attempts SET score = ?, override_note = ? WHERE id = ?`,
    ).run(newScore, countedAs, attemptId);
    appendAnswerOverride({
      questionId: row.question_id,
      userAnswer: row.user_answer ?? "",
      countedAs,
      timestamp: new Date().toISOString(),
      previousScore: row.score,
      newScore,
    });
    res.json({ ok: true, score: newScore });
  });

  router.post("/questions/:id/report", (req, res) => {
    const id = req.params.id;
    const note = String((req.body as { note?: string })?.note ?? "").trim();
    const row = db
      .prepare(`SELECT id FROM questions WHERE id = ?`)
      .get(id) as { id: string } | undefined;
    if (!row) {
      res.status(404).json({ error: "not found" });
      return;
    }
    db.prepare(
      `INSERT INTO question_reports (question_id, note, timestamp) VALUES (?, ?, ?)`,
    ).run(id, note.slice(0, 2000), new Date().toISOString());
    res.json({ ok: true });
  });

  router.post("/questions/:id/audit", async (req, res) => {
    const row = db
      .prepare(`SELECT data FROM questions WHERE id = ?`)
      .get(req.params.id) as { data: string } | undefined;
    if (!row) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const q = rowToQuestion(row);
    const result = await auditQuestionFromEvidence(q);
    if (!result.agrees && !result.aiUnavailable) {
      const flagged = {
        ...q,
        needsReview: true,
        outdatedNote: q.outdatedNote
          ? `${q.outdatedNote} Audit disagreed: ${result.reason}`
          : `Audit disagreed with stored answer: ${result.reason}`,
      };
      upsertQuestions(db, [flagged]);
    }
    res.json(result);
  });

  router.get("/bank/recent", (_req, res) => {
    res.json({
      questions: getRecentlyGenerated().map((q) => ({
        ...publicQuestion(q),
        explanation: explanationForDisplay(q),
      })),
    });
  });

  router.post("/bank/decide", (req, res) => {
    const { questionId, decision, note } = req.body as {
      questionId?: string;
      decision?: "accept" | "reject";
      note?: string;
    };
    if (!questionId || (decision !== "accept" && decision !== "reject")) {
      res.status(400).json({ error: "questionId and decision required" });
      return;
    }
    const p = defaultDecisionsPath(path.join(env.rootDir, "data"));
    const decisions = loadDecisions(p);
    const entry: ReviewDecision = { decision, note };
    decisions[questionId] = entry;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `${JSON.stringify(decisions, null, 2)}\n`, "utf8");

    if (decision === "reject") {
      // Soft-hide: keep row but mark needsReview; practice can still see it —
      // decisions are applied on next generate. Remove from recent list.
      removeRecentGenerated(questionId);
    }
    res.json({ ok: true });
  });

  router.get("/generate/status", (_req, res) => {
    res.json({ job: getGenerateJobStatus() });
  });

  router.post("/generate/start", async (req, res) => {
    const ollama = await checkOllama();
    if (!ollama.reachable || !ollama.modelAvailable) {
      res.status(503).json({
        error: "Ollama offline",
        pullHint: ollama.pullHint,
        detail: ollama.detail,
      });
      return;
    }
    const body = req.body as {
      module?: number;
      topic?: string;
      type?: string;
      count?: number;
    };
    const module = Number(body.module);
    if (![6, 7, 8, 9, 10].includes(module)) {
      res.status(400).json({ error: "module must be 6–10" });
      return;
    }
    const type = body.type ?? "multiple_choice";
    if (
      type !== "multiple_choice" &&
      type !== "identification" &&
      type !== "situational"
    ) {
      res.status(400).json({ error: "unsupported type" });
      return;
    }
    try {
      const job = await startGenerateJob(db, {
        module: module as 6 | 7 | 8 | 9 | 10,
        topic: body.topic,
        type,
        count: Math.max(1, Math.min(20, Number(body.count) || 3)),
      });
      res.json({ job });
    } catch (err) {
      res.status(409).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  router.post("/generate/cancel", (_req, res) => {
    res.json({ ok: requestCancelGenerateJob() });
  });

  router.get("/stats", (_req, res) => {
    const questions = (
      db.prepare(`SELECT COUNT(*) AS c FROM questions`).get() as { c: number }
    ).c;
    const attempts = (
      db.prepare(`SELECT COUNT(*) AS c FROM attempts`).get() as { c: number }
    ).c;
    const reports = (
      db.prepare(`SELECT COUNT(*) AS c FROM question_reports`).get() as {
        c: number;
      }
    ).c;
    res.json({ questions, attempts, reports });
  });

  return router;
}

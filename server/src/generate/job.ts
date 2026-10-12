import path from "node:path";
import { dedupeByPromptSimilarity } from "../ingest/ankiImport.js";
import {
  defaultDecisionsPath,
  loadDecisions,
  type DecisionsFile,
} from "../ingest/decisions.js";
import {
  generateCandidatesFromChunk,
  type GenerateContext,
} from "../ingest/generate.js";
import { parseAllModuleNotes, type NoteChunk } from "../ingest/notesParser.js";
import { env } from "../env.js";
import type { Db } from "../db.js";
import type { Question } from "../questions/schema.js";
import { upsertQuestions } from "../questions/load.js";
import { normalizePrompt } from "../questions/ids.js";
import { similarPrompt } from "../ingest/ankiImport.js";

export type GenerateJobRequest = {
  module: 6 | 7 | 8 | 9 | 10;
  /** Heading substring or "weak" for lowest-mastery tags. */
  topic?: string;
  type: "multiple_choice" | "identification" | "situational";
  count: number;
};

export type GenerateJobStatus = {
  id: string;
  state: "queued" | "running" | "done" | "cancelled" | "error";
  module: number;
  type: string;
  targetCount: number;
  chunksTotal: number;
  chunksDone: number;
  questionsAdded: number;
  rejects: number;
  recentIds: string[];
  error?: string;
  cancelRequested: boolean;
};

type JobInternal = GenerateJobStatus & {
  req: GenerateJobRequest;
};

let active: JobInternal | null = null;
const recentGenerated: Question[] = [];

export function getGenerateJobStatus(): GenerateJobStatus | null {
  if (!active) return null;
  const { req: _, ...rest } = active;
  return rest;
}

export function getRecentlyGenerated(): Question[] {
  return [...recentGenerated].slice(-40).reverse();
}

export function requestCancelGenerateJob(): boolean {
  if (!active || active.state !== "running") return false;
  active.cancelRequested = true;
  return true;
}

function weakTags(db: Db, module: number, limit = 5): string[] {
  const rows = db
    .prepare(
      `SELECT concept_tags, score FROM attempts WHERE module = ? ORDER BY timestamp DESC LIMIT 400`,
    )
    .all(module) as Array<{ concept_tags: string; score: number }>;
  const acc = new Map<string, { n: number; sum: number }>();
  for (const r of rows) {
    let tags: string[] = [];
    try {
      tags = JSON.parse(r.concept_tags) as string[];
    } catch {
      continue;
    }
    for (const t of tags) {
      const cur = acc.get(t) ?? { n: 0, sum: 0 };
      cur.n += 1;
      cur.sum += r.score;
      acc.set(t, cur);
    }
  }
  return [...acc.entries()]
    .map(([tag, v]) => ({ tag, avg: v.sum / v.n }))
    .sort((a, b) => a.avg - b.avg)
    .slice(0, limit)
    .map((x) => x.tag);
}

function pickChunks(
  all: NoteChunk[],
  module: number,
  topic: string | undefined,
  db: Db,
): NoteChunk[] {
  let pool = all.filter((c) => c.module === module);
  if (!topic || topic === "all") return pool;
  if (topic === "weak") {
    const tags = weakTags(db, module);
    if (tags.length === 0) return pool.slice(0, 4);
    const scored = pool
      .map((c) => ({
        c,
        hit: tags.filter((t) => c.conceptTags.includes(t)).length,
      }))
      .filter((x) => x.hit > 0)
      .sort((a, b) => b.hit - a.hit);
    return (scored.length ? scored.map((x) => x.c) : pool).slice(0, 8);
  }
  const needle = topic.toLowerCase();
  return pool.filter(
    (c) =>
      c.heading.toLowerCase().includes(needle) ||
      c.headingPath.join(" ").toLowerCase().includes(needle),
  );
}

function existingPrompts(db: Db, module: number): string[] {
  const rows = db
    .prepare(`SELECT data FROM questions WHERE module = ?`)
    .all(module) as Array<{ data: string }>;
  return rows.map((r) => {
    const q = JSON.parse(r.data) as Question;
    return q.type === "situational" ? `${q.prompt}\n${q.scenario}` : q.prompt;
  });
}

/** Export for Vitest: drop candidates whose prompts are too similar to the bank. */
export function dedupeAgainstBank<T extends { prompt: string; type?: string; scenario?: string }>(
  candidates: T[],
  bankPrompts: string[],
): { kept: T[]; duplicatesDropped: number } {
  let duplicatesDropped = 0;
  const kept: T[] = [];
  for (const c of candidates) {
    const text =
      c.type === "situational" && "scenario" in c && c.scenario
        ? `${c.prompt}\n${c.scenario}`
        : c.prompt;
    if (bankPrompts.some((b) => similarPrompt(b, text))) {
      duplicatesDropped += 1;
      continue;
    }
    if (kept.some((k) => {
      const kt =
        k.type === "situational" && "scenario" in k && k.scenario
          ? `${k.prompt}\n${k.scenario}`
          : k.prompt;
      return similarPrompt(kt, text);
    })) {
      duplicatesDropped += 1;
      continue;
    }
    kept.push(c);
  }
  return { kept, duplicatesDropped };
}

export async function startGenerateJob(
  db: Db,
  req: GenerateJobRequest,
): Promise<GenerateJobStatus> {
  if (active && (active.state === "running" || active.state === "queued")) {
    throw new Error("A generate job is already running");
  }

  const id = `gen-${Date.now().toString(36)}`;
  const notesDir = path.join(env.rootDir, "notes");
  const cacheDir = path.join(env.rootDir, "data", "cache");
  const decisionsPath = defaultDecisionsPath(path.join(env.rootDir, "data"));
  const decisions: DecisionsFile = loadDecisions(decisionsPath);
  const allChunks = parseAllModuleNotes(notesDir);
  const chunks = pickChunks(allChunks, req.module, req.topic, db);
  if (chunks.length === 0) {
    throw new Error("No matching note chunks for that module/topic");
  }

  active = {
    id,
    state: "running",
    module: req.module,
    type: req.type,
    targetCount: req.count,
    chunksTotal: chunks.length,
    chunksDone: 0,
    questionsAdded: 0,
    rejects: 0,
    recentIds: [],
    cancelRequested: false,
    req,
  };

  void (async () => {
    const ctx: GenerateContext = {
      cacheDir,
      rejects: [],
      model: env.ollamaModel,
      decisions,
    };
    const bankPrompts = existingPrompts(db, req.module);
    const seed = Math.floor(Math.random() * 1_000_000_000);
    const added: Question[] = [];

    try {
      for (const chunk of chunks) {
        if (!active || active.cancelRequested) {
          if (active) active.state = "cancelled";
          break;
        }
        if (added.length >= req.count) break;

        const hints = allChunks
          .filter((c) => c.module === req.module)
          .flatMap((c) => c.conceptTags)
          .slice(0, 12);

        const batch = await generateCandidatesFromChunk({
          chunk,
          type: req.type,
          ctx,
          distractorHints: hints.length ? hints : chunk.conceptTags,
          count: Math.min(2, req.count - added.length),
          variety: {
            seed: seed + active.chunksDone,
            temperature: 0.7,
            avoidPrompts: [...bankPrompts, ...added.map((q) => q.prompt)],
            useQueue: true,
          },
        });

        const { kept } = dedupeAgainstBank(batch, [
          ...bankPrompts,
          ...added.map((q) =>
            q.type === "situational" ? `${q.prompt}\n${q.scenario}` : q.prompt,
          ),
        ]);
        const { kept: unique } = dedupeByPromptSimilarity(kept, (q) =>
          q.type === "situational" ? `${q.prompt}\n${q.scenario}` : q.prompt,
        );

        for (const q of unique) {
          if (added.length >= req.count) break;
          added.push(q);
          recentGenerated.push(q);
          active.recentIds.push(q.id);
          bankPrompts.push(
            q.type === "situational" ? `${q.prompt}\n${q.scenario}` : q.prompt,
          );
        }

        active.chunksDone += 1;
        active.questionsAdded = added.length;
        active.rejects = ctx.rejects.length;
      }

      if (added.length > 0) {
        upsertQuestions(db, added);
      }
      if (active && active.state === "running") {
        active.state = "done";
        active.questionsAdded = added.length;
        active.rejects = ctx.rejects.length;
      }
    } catch (err) {
      if (active) {
        active.state = "error";
        active.error = err instanceof Error ? err.message : String(err);
      }
    }
  })();

  return getGenerateJobStatus()!;
}

/** Used by Bank accept/reject — also clears from recent list on reject. */
export function removeRecentGenerated(id: string): void {
  const idx = recentGenerated.findIndex((q) => q.id === id);
  if (idx >= 0) recentGenerated.splice(idx, 1);
}

export function normalizePromptForDedupe(prompt: string): string {
  return normalizePrompt(prompt);
}

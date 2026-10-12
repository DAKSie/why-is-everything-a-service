import fs from "node:fs";
import path from "node:path";
import { normalizeServiceName } from "./validateQuestions.js";

export type ReviewDecision = {
  decision: "accept" | "reject" | "rewrite";
  note?: string;
  /** New prompt when decision is rewrite. */
  prompt?: string;
  /** Apply rewrite when generated answer matches (normalized). */
  matchAnswer?: string;
};

export type DecisionsFile = Record<string, ReviewDecision>;

export function loadDecisions(filePath: string): DecisionsFile {
  if (!fs.existsSync(filePath)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as DecisionsFile;
    if (!raw || typeof raw !== "object") return {};
    return raw;
  } catch {
    return {};
  }
}

export function decisionFor(
  decisions: DecisionsFile,
  id: string,
): ReviewDecision | undefined {
  return decisions[id];
}

/** Find a rewrite decision that matches this answer (normalized). */
export function rewriteForAnswer(
  decisions: DecisionsFile,
  answer: string,
): ReviewDecision | undefined {
  const norm = normalizeServiceName(answer);
  if (!norm) return undefined;
  for (const d of Object.values(decisions)) {
    if (d.decision !== "rewrite" || !d.prompt) continue;
    if (d.matchAnswer && normalizeServiceName(d.matchAnswer) === norm) {
      return d;
    }
  }
  return undefined;
}

/** Drop human-rejected ids; keep accepts, rewrites (caller applies), and undecided. */
export function applyDecisions<T extends { id: string }>(
  questions: T[],
  decisions: DecisionsFile,
): { kept: T[]; rejectedIds: string[] } {
  const rejectedIds: string[] = [];
  const kept: T[] = [];
  for (const q of questions) {
    const d = decisions[q.id];
    if (d?.decision === "reject") {
      rejectedIds.push(q.id);
      continue;
    }
    kept.push(q);
  }
  return { kept, rejectedIds };
}

export function defaultDecisionsPath(dataDir: string): string {
  return path.join(dataDir, "review", "decisions.json");
}

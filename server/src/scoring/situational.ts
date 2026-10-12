import { normalizeServiceName } from "../ingest/validateQuestions.js";
import type { ScoreResult } from "./index.js";

/** Offline keyword/fuzzy fallback when Ollama is unavailable. */
export function scoreSituationalKeyword(input: {
  keyPoints: string[];
  mustMention: string[];
  submitted: string;
}): ScoreResult & {
  keyPointsHit: string[];
  keyPointsMissed: string[];
  label: string;
} {
  const got = normalizeServiceName(input.submitted);
  if (!got) {
    return {
      score: 0,
      keyPointsHit: [],
      keyPointsMissed: [...input.keyPoints],
      label: "Basic grading (AI offline)",
      detail: "empty answer",
    };
  }

  const hit: string[] = [];
  const missed: string[] = [];
  for (const kp of input.keyPoints) {
    const tokens = normalizeServiceName(kp)
      .split(" ")
      .filter((t) => t.length >= 4);
    const matched =
      tokens.length === 0
        ? got.includes(normalizeServiceName(kp).slice(0, 12))
        : tokens.filter((t) => got.includes(t)).length >=
          Math.max(1, Math.ceil(tokens.length * 0.35));
    if (matched) hit.push(kp);
    else missed.push(kp);
  }

  let mentionHits = 0;
  for (const m of input.mustMention) {
    if (got.includes(normalizeServiceName(m))) mentionHits += 1;
  }
  const mentionScore =
    input.mustMention.length === 0
      ? 1
      : mentionHits / input.mustMention.length;
  const kpScore =
    input.keyPoints.length === 0 ? 0 : hit.length / input.keyPoints.length;
  const score = Math.max(0, Math.min(1, 0.65 * kpScore + 0.35 * mentionScore));

  return {
    score,
    keyPointsHit: hit,
    keyPointsMissed: missed,
    label: "Basic grading (AI offline)",
    detail: `kp=${hit.length}/${input.keyPoints.length} mentions=${mentionHits}/${input.mustMention.length}`,
  };
}

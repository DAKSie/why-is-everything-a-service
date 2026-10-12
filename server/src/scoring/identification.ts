import { distance } from "fastest-levenshtein";
import { normalizeServiceName } from "../ingest/validateQuestions.js";
import type { IdLlmVerdict } from "./idVerdict.js";

export type IdMatchStage =
  | "exact"
  | "normalized"
  | "alias"
  | "fuzzy"
  | "llm"
  | "none";

export type IdentificationScore = {
  score: number;
  stage: IdMatchStage;
  matchedAnswer?: string;
  spellingError: boolean;
  detail?: string;
  llmVerdict?: IdLlmVerdict;
  aiUnavailable?: boolean;
  /** True when deterministic failed and LLM is worth calling (near-miss). */
  shouldTryLlm: boolean;
};

function fuzzyThreshold(len: number): number {
  if (len <= 4) return 0;
  if (len <= 8) return 0.15;
  if (len <= 16) return 0.22;
  return 0.28;
}

function isNearMiss(got: string, candidate: string): boolean {
  const maxLen = Math.max(got.length, candidate.length);
  if (maxLen <= 4) return false;
  const ratio = distance(got, candidate) / maxLen;
  if (ratio <= 0.4) return true;
  const gt = new Set(got.split(" ").filter((t) => t.length >= 3));
  const ct = candidate.split(" ").filter((t) => t.length >= 3);
  const overlap = ct.filter((t) => gt.has(t)).length;
  return overlap >= 1 && ratio <= 0.55;
}

/**
 * Deterministic identification scoring.
 * Order: exact → normalized → alias → fuzzy (len>4 only).
 * Short answers (≤4 chars after normalize) require exact/normalized/alias — no fuzz.
 */
export function scoreIdentificationDeterministic(input: {
  acceptedAnswers: string[];
  aliases?: string[];
  submitted: string;
}): IdentificationScore {
  const raw = input.submitted.trim();
  if (!raw) {
    return {
      score: 0,
      stage: "none",
      spellingError: false,
      detail: "empty answer",
      shouldTryLlm: false,
    };
  }

  const got = normalizeServiceName(raw);
  const accepted = input.acceptedAnswers.map((a) => ({
    raw: a,
    norm: normalizeServiceName(a),
  }));
  const aliases = (input.aliases ?? []).map((a) => ({
    raw: a,
    norm: normalizeServiceName(a),
  }));

  // 1. Exact (case-insensitive trim)
  for (const a of accepted) {
    if (raw.toLowerCase() === a.raw.trim().toLowerCase()) {
      return {
        score: 1,
        stage: "exact",
        matchedAnswer: a.raw,
        spellingError: false,
        shouldTryLlm: false,
      };
    }
  }

  // 2. Normalized
  for (const a of accepted) {
    if (got && got === a.norm) {
      return {
        score: 1,
        stage: "normalized",
        matchedAnswer: a.raw,
        spellingError: false,
        shouldTryLlm: false,
      };
    }
  }

  // 3. Alias
  for (const a of aliases) {
    if (
      got &&
      (got === a.norm || raw.toLowerCase() === a.raw.trim().toLowerCase())
    ) {
      return {
        score: 1,
        stage: "alias",
        matchedAnswer: a.raw,
        spellingError: false,
        shouldTryLlm: false,
      };
    }
  }

  // 4. Deterministic fuzzy — never for ≤4 char answers (EBS/EFS/ECS/…)
  if (got.length > 4) {
    for (const a of [...accepted, ...aliases]) {
      if (a.norm.length <= 4) continue;
      const maxLen = Math.max(got.length, a.norm.length);
      const ratio = distance(got, a.norm) / maxLen;
      if (ratio <= fuzzyThreshold(maxLen)) {
        return {
          score: 1,
          stage: "fuzzy",
          matchedAnswer: a.raw,
          spellingError: false,
          detail: `fuzzy ratio=${ratio.toFixed(3)}`,
          shouldTryLlm: false,
        };
      }
    }
  }

  const near = [...accepted, ...aliases].some(
    (a) => got.length > 4 && a.norm.length > 4 && isNearMiss(got, a.norm),
  );

  return {
    score: 0,
    stage: "none",
    spellingError: false,
    detail: "no match",
    shouldTryLlm: near,
  };
}

export function applyLlmVerdict(
  det: IdentificationScore,
  verdict: IdLlmVerdict,
  acceptedPrimary: string,
): IdentificationScore {
  if (verdict.verdict === "correct" || verdict.verdict === "spelling_error") {
    return {
      score: 1,
      stage: "llm",
      matchedAnswer: acceptedPrimary,
      spellingError: verdict.verdict === "spelling_error",
      llmVerdict: verdict,
      shouldTryLlm: false,
      detail: verdict.reason,
    };
  }
  return {
    ...det,
    score: 0,
    stage: "llm",
    llmVerdict: verdict,
    shouldTryLlm: false,
    detail: verdict.reason,
  };
}

import { normalizePrompt } from "../questions/ids.js";
import {
  applyLlmVerdict,
  scoreIdentificationDeterministic,
  type IdentificationScore,
} from "./identification.js";
import { llmCheckIdentification } from "./idLlm.js";

export type ScoreResult = {
  score: number;
  detail?: string;
};

export {
  scoreIdentificationDeterministic,
  applyLlmVerdict,
  type IdentificationScore,
} from "./identification.js";
export { idLlmVerdictSchema, type IdLlmVerdict } from "./idVerdict.js";
export { charDiff, type DiffSpan } from "./charDiff.js";

/** Multi-select partial: correct picks / required, penalize extras. */
export function scoreMultipleChoice(input: {
  correctIndices: number[];
  selectedIndices: number[];
}): ScoreResult {
  const required = new Set(input.correctIndices);
  const selected = new Set(input.selectedIndices);
  if (required.size === 0) return { score: 0, detail: "no correct indices" };

  let hits = 0;
  let extras = 0;
  for (const i of selected) {
    if (required.has(i)) hits += 1;
    else extras += 1;
  }
  const score = Math.max(0, Math.min(1, (hits - extras) / required.size));
  return {
    score,
    detail: `hits=${hits}/${required.size} extras=${extras}`,
  };
}

/** Partial credit by position match. */
export function scoreProcedural(input: {
  correctSteps: string[];
  submittedSteps: string[];
}): ScoreResult {
  const n = input.correctSteps.length;
  if (n === 0) return { score: 0 };
  let matches = 0;
  for (let i = 0; i < n; i += 1) {
    const want = normalizePrompt(input.correctSteps[i] ?? "");
    const got = normalizePrompt(input.submittedSteps[i] ?? "");
    if (want && want === got) matches += 1;
  }
  return { score: matches / n, detail: `positions=${matches}/${n}` };
}

/**
 * Sync identification (deterministic only). Prefer scoreIdentificationAsync when
 * LLM near-miss checking is available.
 */
export function scoreIdentification(input: {
  acceptedAnswers: string[];
  aliases?: string[];
  submitted: string;
}): ScoreResult {
  const r = scoreIdentificationDeterministic(input);
  return { score: r.score, detail: r.detail ?? r.stage };
}

export async function scoreIdentificationAsync(input: {
  questionId: string;
  prompt: string;
  acceptedAnswers: string[];
  aliases?: string[];
  evidenceQuote?: string;
  submitted: string;
}): Promise<IdentificationScore> {
  const det = scoreIdentificationDeterministic(input);
  if (det.score === 1 || !det.shouldTryLlm) return det;

  const { verdict, aiUnavailable } = await llmCheckIdentification({
    questionId: input.questionId,
    question: input.prompt,
    acceptedAnswers: input.acceptedAnswers,
    evidenceQuote: input.evidenceQuote,
    userAnswer: input.submitted,
  });

  if (!verdict) {
    return { ...det, aiUnavailable: true, detail: "AI checker unavailable" };
  }
  return applyLlmVerdict(det, verdict, input.acceptedAnswers[0] ?? "");
}

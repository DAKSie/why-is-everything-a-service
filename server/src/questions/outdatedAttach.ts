import { detectOutdated, type OutdatedFlag } from "../ingest/outdated.js";
import type { Question, QuestionInput } from "./schema.js";

/** Answer-side strings used for outdated matching (never whole chunk text). */
export function answerTextsOf(q: QuestionInput): string[] {
  switch (q.type) {
    case "multiple_choice":
      return q.correctIndices.map((i) => q.options[i] ?? "");
    case "identification":
      return [...q.acceptedAnswers, ...(q.aliases ?? [])];
    case "procedural":
      return q.steps;
    case "situational":
      return [q.modelAnswer, ...q.rubric.keyPoints, ...q.rubric.mustMention];
    default:
      return [];
  }
}

/**
 * Attach outdatedNote only when prompt, answer, or evidenceQuote matches
 * a known outdated item — not when the surrounding notes chunk mentions it.
 */
export function outdatedForQuestion(q: QuestionInput): OutdatedFlag {
  return detectOutdated(
    q.prompt,
    ...answerTextsOf(q),
    q.evidenceQuote ?? "",
  );
}

export function attachOutdatedToQuestion<T extends QuestionInput | Question>(
  q: T,
): T {
  const flag = outdatedForQuestion(q);
  if (!flag.needsReview) {
    const next = { ...q, needsReview: false };
    delete (next as { outdatedNote?: string }).outdatedNote;
    return next;
  }
  return {
    ...q,
    needsReview: true,
    outdatedNote: flag.outdatedNote,
  };
}

/** Topic-MC explanation format. */
export function topicMcExplanation(heading: string, bullet: string): string {
  return `Correct: ${heading}. From the notes: ${bullet}`;
}

export function explanationForDisplay(q: QuestionInput): string {
  if (
    q.type === "multiple_choice" &&
    /^which topic does this describe/i.test(q.prompt)
  ) {
    const ans =
      q.options[q.correctIndices[0] ?? -1] ??
      q.topic.replace(/^section\s*\d+\s*:\s*/i, "").trim();
    const bullet = q.prompt
      .replace(/^which topic does this describe\??\s*/i, "")
      .trim();
    if (ans && bullet) return topicMcExplanation(ans, bullet);
  }
  return q.explanation;
}

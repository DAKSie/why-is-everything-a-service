import { createHash } from "node:crypto";
import { questionId } from "../questions/ids.js";
import {
  parseQuestionBank,
  questionInputSchema,
  type Question,
  type QuestionInput,
} from "../questions/schema.js";
import type { AnkiSeedCard } from "./ankiImport.js";
import { dedupeByPromptSimilarity } from "./ankiImport.js";
import {
  PROMPT_TEMPLATE_VERSION,
  chunkHash,
  generationCacheKey,
  logCache,
  readCache,
  writeCache,
} from "./cache.js";
import { buildClozeCandidates } from "./cloze.js";
import { deriveConceptTags } from "./conceptTags.js";
import type { DecisionsFile } from "./decisions.js";
import { applyDecisions, rewriteForAnswer } from "./decisions.js";
import { extractBoldTerms } from "./cloze.js";
import {
  isGroundedEvidence,
  pickEvidenceQuote,
  rankEvidenceCandidates,
  selectEvidenceQuote,
  selectKeyPointUnits,
} from "./evidence.js";
import { stripMarkdown } from "./markdown.js";
import type { NoteChunk } from "./notesParser.js";
import { ollamaChatJson } from "./ollamaClient.js";
import { ollamaChatJsonQueued } from "../ollamaQueue.js";
import { detectOutdated } from "./outdated.js";
import {
  attachOutdatedToQuestion,
  explanationForDisplay,
} from "../questions/outdatedAttach.js";
import { buildTopicMultipleChoice } from "./topicMc.js";
import {
  answerLeaksInPrompt,
  isNotExceptPrompt,
  normalizeServiceName,
  validateIdentification,
  validateMultipleChoiceOptions,
  validateNotExceptMultipleChoice,
} from "./validateQuestions.js";

const SIT_PLACEHOLDER =
  "Apply the concepts from the notes to this scenario.";

export type RejectRecord = {
  stage: string;
  module: number;
  type?: string;
  reason: string;
  detail?: string;
  sourceRef?: { file: string; heading: string };
  /** Populated for verifier-disagree rejects. */
  question?: string;
  storedAnswer?: string;
  verifierAnswer?: string;
  evidenceQuote?: string;
};

export type GenerateContext = {
  cacheDir: string;
  rejects: RejectRecord[];
  model: string;
  decisions?: DecisionsFile;
};

function pushReject(ctx: GenerateContext, reject: RejectRecord): void {
  ctx.rejects.push(reject);
  console.warn(`[reject] ${reject.stage}: ${reject.reason}`);
}

function rejectCacheKey(input: {
  module: number;
  chunkText: string;
  type: string;
  prompt: string;
  model: string;
}): string {
  return generationCacheKey({
    module: input.module,
    chunkHash: chunkHash(input.chunkText),
    type: `reject:${input.type}`,
    model: input.model,
    variant: createHash("sha256")
      .update(input.prompt.toLowerCase())
      .digest("hex")
      .slice(0, 16),
  });
}

function isRejectCached(
  ctx: GenerateContext,
  module: number,
  chunkText: string,
  type: string,
  prompt: string,
): boolean {
  const key = rejectCacheKey({
    module,
    chunkText,
    type,
    prompt,
    model: ctx.model,
  });
  return readCache<{ rejected: true }>(ctx.cacheDir, key) !== null;
}

function cacheRejectedItem(
  ctx: GenerateContext,
  module: number,
  chunkText: string,
  type: string,
  prompt: string,
  reason: string,
): void {
  const key = rejectCacheKey({
    module,
    chunkText,
    type,
    prompt,
    model: ctx.model,
  });
  writeCache(ctx.cacheDir, key, { rejected: true, reason, prompt });
}

function bestChunkForText(chunks: NoteChunk[], text: string): NoteChunk | null {
  if (chunks.length === 0) return null;
  const tokens = new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]+/gu, " ")
      .split(/\s+/)
      .filter((t) => t.length > 3),
  );
  let best = chunks[0]!;
  let bestScore = -1;
  for (const chunk of chunks) {
    const hay = `${chunk.headingPath.join(" ")} ${chunk.text}`.toLowerCase();
    let score = 0;
    for (const t of tokens) {
      if (hay.includes(t)) score += 1;
    }
    for (const tag of chunk.conceptTags) {
      if (text.toLowerCase().includes(tag.replace(/-/g, " "))) score += 3;
    }
    if (score > bestScore) {
      bestScore = score;
      best = chunk;
    }
  }
  return best;
}

function assertLiteralQuote(chunkText: string, quote: string): boolean {
  return isGroundedEvidence(chunkText, quote);
}

function notesExplanation(evidenceQuote: string): string {
  const clean = stripMarkdown(evidenceQuote);
  if (!clean || /placeholder|same header/i.test(clean)) {
    return "";
  }
  return `From the notes: ${clean}`;
}

function presentable(text: string): string {
  return stripMarkdown(text);
}

/** Topic key for near-identical answer/topic dedupe within a module. */
export function topicKey(q: Question): string {
  switch (q.type) {
    case "identification":
      return `id:${normalizeServiceName(q.acceptedAnswers[0] ?? "")}`;
    case "multiple_choice": {
      const answer = q.correctIndices.map((i) => q.options[i] ?? "").join("|");
      // Which-topic MCs share an answer heading; keep distinct bullets.
      if (/^which topic does this describe/i.test(q.prompt)) {
        const bullet = q.prompt.replace(/^which topic does this describe\??\s*/i, "");
        return `mc-topic:${normalizeServiceName(answer)}|${normalizeServiceName(bullet).slice(0, 48)}`;
      }
      return `mc:${normalizeServiceName(answer)}`;
    }
    case "situational":
      return `sit:${normalizeServiceName(
        (q.rubric.mustMention[0] ?? q.rubric.keyPoints[0] ?? "").slice(0, 80),
      )}|${normalizeServiceName(q.scenario).slice(0, 40)}`;
    case "procedural":
      return `proc:${normalizeServiceName(q.steps[0] ?? "")}`;
    default:
      return `other:${q.id}`;
  }
}

export function dedupeByTopic<T extends Question>(
  items: T[],
): { kept: T[]; duplicatesDropped: number } {
  const kept: T[] = [];
  const seen = new Set<string>();
  let duplicatesDropped = 0;
  for (const item of items) {
    const key = topicKey(item);
    if (!key.endsWith(":") && seen.has(key)) {
      duplicatesDropped += 1;
      continue;
    }
    if (!key.endsWith(":")) seen.add(key);
    kept.push(item);
  }
  return { kept, duplicatesDropped };
}

/** Assign evidenceQuote in code from question+answer; null if none passes. */
function assignEvidence(input: {
  chunkText: string;
  question: string;
  answer: string;
  aliases?: string[];
}): string | null {
  return selectEvidenceQuote({
    chunkText: input.chunkText,
    question: input.question,
    answer: input.answer,
    aliases: input.aliases,
  });
}

type VerifyResult = { agrees: boolean; modelAnswer: string };

async function verifyAgainstChunk(input: {
  chunkText: string;
  prompt: string;
  expectedAnswer: string;
  ctx: GenerateContext;
  module: number;
}): Promise<VerifyResult> {
  const key = generationCacheKey({
    module: input.module,
    chunkHash: chunkHash(input.chunkText),
    type: "verify",
    model: input.ctx.model,
    variant: createHash("sha256").update(input.prompt).digest("hex").slice(0, 12),
  });
  const cached = readCache<VerifyResult>(input.ctx.cacheDir, key);
  logCache(!!cached, `verify module=${input.module} ${key.slice(0, 8)}`);
  if (cached) return cached;

  const raw = await ollamaChatJson({
    model: input.ctx.model,
    system:
      "You answer ONLY using the provided NOTES CHUNK. Return JSON {\"answer\":\"...\",\"supported\":true|false}. If the chunk does not contain enough information, set supported=false.",
    user: `NOTES CHUNK:\n${input.chunkText}\n\nQUESTION:\n${input.prompt}\n\nReturn JSON only.`,
  });

  const obj = raw as { answer?: string; supported?: boolean };
  const modelAnswer = String(obj.answer ?? "");
  const supported = obj.supported !== false;
  const expected = input.expectedAnswer.toLowerCase();
  const got = modelAnswer.toLowerCase();
  const agrees =
    supported &&
    (got.includes(expected.slice(0, Math.min(40, expected.length))) ||
      expected.includes(got.slice(0, Math.min(40, got.length))) ||
      overlapScore(expected, got) >= 0.35);

  const result = { agrees, modelAnswer };
  writeCache(input.ctx.cacheDir, key, result);
  return result;
}

type AmbiguityResult = { ambiguous: boolean; detail?: string };

async function checkAmbiguity(input: {
  chunkText: string;
  prompt: string;
  expectedAnswer: string;
  ctx: GenerateContext;
  module: number;
}): Promise<AmbiguityResult> {
  const key = generationCacheKey({
    module: input.module,
    chunkHash: chunkHash(input.chunkText),
    type: "ambiguity",
    model: input.ctx.model,
    variant: createHash("sha256").update(input.prompt).digest("hex").slice(0, 12),
  });
  const cached = readCache<AmbiguityResult>(input.ctx.cacheDir, key);
  logCache(!!cached, `ambiguity module=${input.module} ${key.slice(0, 8)}`);
  if (cached) return cached;

  const raw = await ollamaChatJson({
    model: input.ctx.model,
    system:
      'You check whether a quiz question is ambiguous given ONLY the NOTES CHUNK. Return JSON {"ambiguous":true|false,"alternate":"..."}. Set ambiguous=true if any other bullet, option, service, or statement in the chunk could also correctly answer the question (besides the expected answer).',
    user: `NOTES CHUNK:\n${input.chunkText}\n\nQUESTION:\n${input.prompt}\n\nEXPECTED ANSWER:\n${input.expectedAnswer}\n\nDoes any other bullet or option in the chunk also answer this question? Return JSON only.`,
  });

  const obj = raw as { ambiguous?: boolean; alternate?: string };
  const result: AmbiguityResult = {
    ambiguous: obj.ambiguous === true,
    detail: obj.alternate ? String(obj.alternate) : undefined,
  };
  writeCache(input.ctx.cacheDir, key, result);
  return result;
}

function overlapScore(a: string, b: string): number {
  const ta = new Set(a.split(/\s+/).filter((w) => w.length > 3));
  const tb = new Set(b.split(/\s+/).filter((w) => w.length > 3));
  if (ta.size === 0 || tb.size === 0) return 0;
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit += 1;
  return hit / Math.max(ta.size, tb.size);
}

function expectedAnswerOf(draft: QuestionInput): string {
  if (draft.type === "multiple_choice") {
    return draft.correctIndices.map((i) => draft.options[i] ?? "").join("; ");
  }
  if (draft.type === "identification") {
    return draft.acceptedAnswers[0] ?? "";
  }
  if (draft.type === "situational") {
    return draft.modelAnswer;
  }
  if (draft.type === "procedural") {
    return draft.steps.join(" → ");
  }
  return "";
}

function promptTextOf(draft: QuestionInput): string {
  if (draft.type === "situational") {
    return `${draft.prompt}\n${draft.scenario}`;
  }
  return draft.prompt;
}

function finalizeQuestion(
  input: QuestionInput,
  chunk: NoteChunk,
): { question: Question | null; schemaError?: string } {
  const fallbackTags =
    input.conceptTags?.length > 0
      ? input.conceptTags
      : chunk.conceptTags.length > 0
        ? chunk.conceptTags
        : deriveConceptTags(chunk.heading, input.prompt, chunk.text);
  const conceptTags =
    fallbackTags.length > 0 ? fallbackTags : (["aws"] as const);

  // Strip markdown from learner-facing fields before validation.
  let cleaned: QuestionInput = {
    ...input,
    conceptTags: [...conceptTags],
    prompt: presentable(input.prompt),
    explanation: presentable(input.explanation),
    ...(input.evidenceQuote
      ? { evidenceQuote: presentable(input.evidenceQuote) }
      : {}),
  };
  if (cleaned.type === "identification") {
    cleaned = {
      ...cleaned,
      acceptedAnswers: cleaned.acceptedAnswers.map(presentable),
      aliases: (cleaned.aliases ?? []).map(presentable),
    };
  }
  if (cleaned.type === "multiple_choice") {
    cleaned = {
      ...cleaned,
      options: cleaned.options.map(presentable),
    };
  }
  if (cleaned.type === "situational") {
    cleaned = {
      ...cleaned,
      scenario: presentable(cleaned.scenario),
      modelAnswer: presentable(cleaned.modelAnswer),
      rubric: {
        keyPoints: cleaned.rubric.keyPoints.map(presentable),
        mustMention: cleaned.rubric.mustMention.map(presentable),
        commonMistakes: cleaned.rubric.commonMistakes.map(presentable),
      },
    };
  }

  const parsed = questionInputSchema.safeParse(cleaned);
  if (!parsed.success) {
    return {
      question: null,
      schemaError: parsed.error.issues.map((i) => i.message).join("; "),
    };
  }
  let q = parsed.data;

  // Grounding: allow stripped quote if original (pre-strip) was grounded.
  if (q.evidenceQuote) {
    const ok =
      assertLiteralQuote(chunk.text, q.evidenceQuote) ||
      assertLiteralQuote(chunk.text, input.evidenceQuote ?? "") ||
      isGroundedEvidence(chunk.text, input.evidenceQuote ?? q.evidenceQuote);
    if (!ok) return { question: null, schemaError: "evidence not grounded" };
  }

  if (!q.explanation.trim() || /placeholder|same header/i.test(q.explanation)) {
    return { question: null, schemaError: "missing/placeholder explanation" };
  }

  const answer = expectedAnswerOf(q);
  const aliases =
    q.type === "identification" ? (q.aliases ?? []) : ([] as string[]);
  if (answerLeaksInPrompt(promptTextOf(q), answer, aliases)) {
    return { question: null, schemaError: "answer leaks in prompt" };
  }

  if (q.type === "multiple_choice") {
    const mc = validateMultipleChoiceOptions(q.options);
    if (!mc.ok) return { question: null, schemaError: mc.reason };
    if (isNotExceptPrompt(q.prompt)) {
      const ne = validateNotExceptMultipleChoice({
        prompt: q.prompt,
        options: q.options,
        correctIndices: q.correctIndices,
        evidenceQuote: q.evidenceQuote ?? "",
      });
      if (!ne.ok) return { question: null, schemaError: ne.reason };
    }
    if (q.evidenceQuote) {
      if (/^which topic does this describe/i.test(q.prompt)) {
        q = { ...q, explanation: explanationForDisplay(q) };
      } else {
        const expl = notesExplanation(q.evidenceQuote);
        if (!expl) return { question: null, schemaError: "empty explanation" };
        q = { ...q, explanation: expl };
      }
    }
  }
  if (q.type === "identification") {
    const idv = validateIdentification({
      prompt: q.prompt,
      acceptedAnswers: q.acceptedAnswers,
      aliases: q.aliases,
      evidenceQuote: q.evidenceQuote,
    });
    if (!idv.ok) return { question: null, schemaError: idv.reason };
  }
  if (q.type === "situational") {
    if (q.scenario.length < 80 || q.scenario === SIT_PLACEHOLDER) {
      return { question: null, schemaError: "scenario missing or placeholder" };
    }
  }

  q = attachOutdatedToQuestion(q);
  const id = questionId({
    source: q.source,
    sourceRef: q.sourceRef,
    prompt: q.prompt,
    type: q.type,
    scenario: q.type === "situational" ? q.scenario : undefined,
  });
  return { question: { ...q, id } };
}

function finalizeOrNull(
  input: QuestionInput,
  chunk: NoteChunk,
): Question | null {
  return finalizeQuestion(input, chunk).question;
}

/** Deterministic short-option MC for the Module 10 ELB "three types" Anki seed. */
function deterministicElbTypesSeed(
  seed: AnkiSeedCard,
  chunk: NoteChunk,
): QuestionInput | null {
  if (!/three types of elastic load balancers/i.test(seed.front)) return null;
  if (seed.module !== 10) return null;

  const prompt = "Which three Elastic Load Balancing types does Module 10 list?";
  const aliases = [
    "Application Load Balancer",
    "Network Load Balancer",
    "Classic Load Balancer",
  ];
  const evidenceQuote = assignEvidence({
    chunkText: chunk.text,
    question: prompt,
    answer: "Application Load Balancer",
    aliases,
  });
  if (!evidenceQuote || !assertLiteralQuote(chunk.text, evidenceQuote)) {
    return null;
  }

  const outdated = detectOutdated(seed.front, seed.back);
  return {
    module: 10,
    topic: chunk.heading,
    conceptTags: deriveConceptTags(chunk.heading, chunk.text, "elb").length
      ? deriveConceptTags(chunk.heading, chunk.text, "elb")
      : ["elb"],
    type: "multiple_choice",
    difficulty: 1,
    prompt,
    options: [
      "Application, Network, and Classic",
      "Application, Gateway, and Network",
      "Classic, Target, and Network",
      "Application, Network, and Internet",
    ],
    correctIndices: [0],
    explanation: notesExplanation(evidenceQuote),
    source: "anki",
    sourceRef: {
      file: "AWS Cloud Practitioner - Anki Deck.apkg",
      heading: `anki:${seed.guid}`,
    },
    needsReview: outdated.needsReview,
    outdatedNote: outdated.outdatedNote,
    evidenceQuote,
  };
}

export async function generateFromAnkiSeed(input: {
  seed: AnkiSeedCard;
  chunks: NoteChunk[];
  preferType: "multiple_choice" | "situational";
  ctx: GenerateContext;
}): Promise<Question | null> {
  const chunk = bestChunkForText(
    input.chunks,
    `${input.seed.front}\n${input.seed.back}`,
  );
  if (!chunk) {
    pushReject(input.ctx, {
      stage: "anki-seed",
      module: input.seed.module,
      type: input.preferType,
      reason: "no notes chunk available for module",
    });
    return null;
  }

  const key = generationCacheKey({
    module: input.seed.module,
    chunkHash: chunkHash(chunk.text),
    type: input.preferType,
    model: input.ctx.model,
    variant: `seed:${input.seed.guid}`,
  });
  const cached = readCache<QuestionInput>(input.ctx.cacheDir, key);
  logCache(
    !!cached,
    `anki-seed ${input.preferType} guid=${input.seed.guid} ${key.slice(0, 8)}`,
  );
  if (cached) {
    const done = finalizeOrNull(cached, chunk);
    if (done) {
      if (input.ctx.decisions?.[done.id]?.decision === "reject") {
        pushReject(input.ctx, {
          stage: "human-decision",
          module: input.seed.module,
          type: input.preferType,
          reason: "human review reject",
          detail: input.ctx.decisions[done.id]?.note,
          question: done.prompt,
        });
        return null;
      }
      return done;
    }
  }

  // Prefer deterministic short options for the known ELB types card.
  if (input.preferType === "multiple_choice") {
    const det = deterministicElbTypesSeed(input.seed, chunk);
    if (det) {
      const finalDet = finalizeOrNull(det, chunk);
      if (finalDet) {
        if (input.ctx.decisions?.[finalDet.id]?.decision === "reject") {
          pushReject(input.ctx, {
            stage: "human-decision",
            module: input.seed.module,
            type: input.preferType,
            reason: "human review reject",
            detail: input.ctx.decisions[finalDet.id]?.note,
            question: finalDet.prompt,
          });
          return null;
        }
        writeCache(input.ctx.cacheDir, key, det);
        return finalDet;
      }
    }
  }

  const outdated = detectOutdated(input.seed.front, input.seed.back);

  const system = `You create AWS Cloud Foundations quiz questions. Use ONLY the ANKI ANSWER as ground truth and the NOTES CHUNK for wording. Never contradict or extend beyond them. Do NOT choose evidenceQuote — code assigns it. Return JSON only. Template ${PROMPT_TEMPLATE_VERSION}.`;

  const mcRules =
    "Each option MUST be at most 12 words. Never use numbered lists or multi-line list blobs as options. Prefer short service names.";

  const user =
    input.preferType === "multiple_choice"
      ? `Create a multiple_choice question from this Anki card.
ANKI FRONT: ${input.seed.front}
ANKI ANSWER (ground truth — do not contradict): ${input.seed.back}
NOTES CHUNK:
${chunk.text}

${mcRules}

Return JSON:
{
  "prompt": "...",
  "options": ["...","...","...","..."],
  "correctIndices": [0],
  "explanation": "...",
  "difficulty": 1
}
Distractors must be plausible related AWS services/concepts from THIS MODULE only.`
      : `Create a situational question from this Anki card.
ANKI FRONT: ${input.seed.front}
ANKI ANSWER (ground truth — becomes the rubric/model answer; do not contradict): ${input.seed.back}
NOTES CHUNK:
${chunk.text}

Return JSON:
{
  "prompt": "short instruction",
  "scenario": "short realistic scenario",
  "rubric": {
    "keyPoints": ["..."],
    "mustMention": ["..."],
    "commonMistakes": ["..."]
  },
  "modelAnswer": "must align with ANKI ANSWER",
  "explanation": "...",
  "difficulty": 2
}`;

  let raw: unknown;
  try {
    raw = await ollamaChatJson({
      model: input.ctx.model,
      system,
      user,
    });
  } catch (err) {
    pushReject(input.ctx, {
      stage: "anki-seed",
      module: input.seed.module,
      type: input.preferType,
      reason: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  const obj = raw as Record<string, unknown>;
  const conceptTags = deriveConceptTags(
    chunk.heading,
    chunk.text,
    input.seed.front,
    input.seed.back,
  );
  const base = {
    module: input.seed.module as 6 | 7 | 8 | 9 | 10,
    topic: chunk.heading,
    conceptTags: conceptTags.length ? conceptTags : chunk.conceptTags,
    difficulty: (Number(obj.difficulty) === 3
      ? 3
      : Number(obj.difficulty) === 2
        ? 2
        : 1) as 1 | 2 | 3,
    explanation: String(obj.explanation ?? input.seed.back),
    source: "anki" as const,
    sourceRef: {
      file: "AWS Cloud Practitioner - Anki Deck.apkg",
      heading: `anki:${input.seed.guid}`,
    },
    needsReview: outdated.needsReview,
    outdatedNote: outdated.outdatedNote,
  };

  let draft: QuestionInput;
  if (input.preferType === "multiple_choice") {
    draft = {
      ...base,
      type: "multiple_choice",
      prompt: String(obj.prompt ?? input.seed.front),
      options: (obj.options as string[]) ?? [],
      correctIndices: (obj.correctIndices as number[]) ?? [0],
      evidenceQuote: "pending",
    };
    const mc = validateMultipleChoiceOptions(draft.options);
    if (!mc.ok) {
      pushReject(input.ctx, {
        stage: "anki-seed-mc",
        module: input.seed.module,
        type: "multiple_choice",
        reason: mc.reason ?? "invalid MC options",
      });
      return null;
    }
  } else {
    const rubric = (obj.rubric as {
      keyPoints?: string[];
      mustMention?: string[];
      commonMistakes?: string[];
    }) ?? { keyPoints: [input.seed.back] };
    draft = {
      ...base,
      type: "situational",
      prompt: String(obj.prompt ?? "Apply the concept from this scenario."),
      scenario: String(obj.scenario ?? input.seed.front),
      rubric: {
        keyPoints: rubric.keyPoints?.length ? rubric.keyPoints : [input.seed.back],
        mustMention: rubric.mustMention ?? [],
        commonMistakes: rubric.commonMistakes ?? [],
      },
      modelAnswer: String(obj.modelAnswer ?? input.seed.back),
      evidenceQuote: "pending",
    };
  }

  const expectedAnswer = expectedAnswerOf(draft);
  const evidenceQuote = assignEvidence({
    chunkText: chunk.text,
    question: promptTextOf(draft),
    answer: `${expectedAnswer}\n${input.seed.back}`,
  });
  if (!evidenceQuote) {
    const ranked = rankEvidenceCandidates({
      chunkText: chunk.text,
      question: promptTextOf(draft),
      answer: `${expectedAnswer}\n${input.seed.back}`,
    });
    const best = ranked[0];
    pushReject(input.ctx, {
      stage: "anki-seed-evidence",
      module: input.seed.module,
      type: input.preferType,
      reason: "no evidence sentence with answer terms",
      question: promptTextOf(draft),
      storedAnswer: expectedAnswer,
      detail: best
        ? `bestUnit score=${best.score.toFixed(2)} hasAnswer=${best.hasAnswer} supportsPrompt=${best.supportsPrompt} :: ${best.unit.slice(0, 140)}`
        : "no units",
      sourceRef: { file: chunk.filename, heading: chunk.headingPath.join(" > ") },
      evidenceQuote: best?.unit,
    });
    cacheRejectedItem(
      input.ctx,
      input.seed.module,
      chunk.text,
      input.preferType,
      promptTextOf(draft),
      "no evidence sentence with answer terms",
    );
    return null;
  }
  draft = { ...draft, evidenceQuote };

  if (draft.type === "multiple_choice" && isNotExceptPrompt(draft.prompt)) {
    const ne = validateNotExceptMultipleChoice({
      prompt: draft.prompt,
      options: draft.options,
      correctIndices: draft.correctIndices,
      evidenceQuote,
    });
    if (!ne.ok) {
      pushReject(input.ctx, {
        stage: "anki-seed-not-except",
        module: input.seed.module,
        type: "multiple_choice",
        reason: ne.reason ?? "NOT/EXCEPT validation failed",
        question: draft.prompt,
        storedAnswer: expectedAnswer,
        evidenceQuote,
      });
      cacheRejectedItem(
        input.ctx,
        input.seed.module,
        chunk.text,
        "multiple_choice",
        draft.prompt,
        ne.reason ?? "NOT/EXCEPT",
      );
      return null;
    }
  }

  const verified = await verifyAgainstChunk({
    chunkText: chunk.text,
    prompt: promptTextOf(draft),
    expectedAnswer: `${expectedAnswer}\n${input.seed.back}`,
    ctx: input.ctx,
    module: input.seed.module,
  });
  if (!verified.agrees) {
    pushReject(input.ctx, {
      stage: "anki-seed-verify",
      module: input.seed.module,
      type: input.preferType,
      reason: "verifier disagreed",
      sourceRef: base.sourceRef,
      question: promptTextOf(draft),
      storedAnswer: expectedAnswer,
      verifierAnswer: verified.modelAnswer,
      evidenceQuote: draft.evidenceQuote,
    });
    cacheRejectedItem(
      input.ctx,
      input.seed.module,
      chunk.text,
      input.preferType,
      promptTextOf(draft),
      "verifier disagreed",
    );
    return null;
  }

  const ambi = await checkAmbiguity({
    chunkText: chunk.text,
    prompt: promptTextOf(draft),
    expectedAnswer,
    ctx: input.ctx,
    module: input.seed.module,
  });
  if (ambi.ambiguous) {
    pushReject(input.ctx, {
      stage: "anki-seed-ambiguity",
      module: input.seed.module,
      type: input.preferType,
      reason: "ambiguous: another bullet/option also answers",
      detail: ambi.detail,
      question: promptTextOf(draft),
      storedAnswer: expectedAnswer,
      evidenceQuote: draft.evidenceQuote,
    });
    cacheRejectedItem(
      input.ctx,
      input.seed.module,
      chunk.text,
      input.preferType,
      promptTextOf(draft),
      "ambiguous",
    );
    return null;
  }

  const finalRes = finalizeQuestion(draft, chunk);
  const finalQ = finalRes.question;
  if (!finalQ) {
    pushReject(input.ctx, {
      stage: "anki-seed-schema",
      module: input.seed.module,
      type: input.preferType,
      reason: finalRes.schemaError ?? "failed zod/mechanical validation after generation",
    });
    return null;
  }

  if (input.ctx.decisions?.[finalQ.id]?.decision === "reject") {
    pushReject(input.ctx, {
      stage: "human-decision",
      module: input.seed.module,
      type: input.preferType,
      reason: "human review reject",
      detail: input.ctx.decisions[finalQ.id]?.note,
      question: finalQ.prompt,
    });
    return null;
  }

  writeCache(input.ctx.cacheDir, key, draft);
  return finalQ;
}

const OVERGENERATE_PER_SLOT = 2;

async function callChunkGeneratorBatch(input: {
  chunk: NoteChunk;
  type: "multiple_choice";
  ctx: GenerateContext;
  distractorHints: string[];
  focusHint?: string;
  count: number;
  avoidPrompts?: string[];
  temperature?: number;
  seed?: number;
  useQueue?: boolean;
}): Promise<unknown[]> {
  const focus = input.focusHint
    ? `\nFocus aspects (cover different ones across candidates): ${input.focusHint}\n`
    : "";
  const avoid =
    input.avoidPrompts && input.avoidPrompts.length > 0
      ? `\nDo NOT repeat or paraphrase these existing prompts:\n${input.avoidPrompts
          .slice(0, 12)
          .map((p, i) => `${i + 1}. ${p.slice(0, 160)}`)
          .join("\n")}\n`
      : "";

  const system = `You create AWS Cloud Foundations quiz questions grounded ONLY in the NOTES CHUNK. Never invent facts. Do NOT choose evidenceQuote — code assigns it from the chunk. Do NOT write explanations. Return JSON only. Template ${PROMPT_TEMPLATE_VERSION}.`;

  const itemSchema = `{
  "prompt": "...",
  "options": ["...","...","...","..."],
  "correctIndices": [0],
  "difficulty": 1
}`;

  const rules =
    "Each option ≤ 12 words; no numbered lists; no multi-line options. For NOT/EXCEPT questions, the correct answer must be something the notes do NOT list among the true options. Do not put the correct answer wording inside the prompt.";

  const user = `NOTES CHUNK (Module ${input.chunk.module} — ${input.chunk.headingPath.join(" > ")}):
${input.chunk.text}
${focus}${avoid}
Related terms (same module): ${input.distractorHints.join(", ")}

Create ${input.count} DISTINCT multiple_choice questions (different prompts/answers — not paraphrases of the same item).
${rules}

Return JSON:
{ "questions": [ ${itemSchema}, ... ] }`;

  const raw = input.useQueue
    ? await ollamaChatJsonQueued({
        model: input.ctx.model,
        system,
        user,
        priority: "generate",
        temperature: input.temperature ?? 0.7,
        seed: input.seed,
      })
    : await ollamaChatJson({ model: input.ctx.model, system, user });
  if (Array.isArray(raw)) return raw;
  const obj = raw as { questions?: unknown[] };
  if (Array.isArray(obj.questions)) return obj.questions;
  return [raw];
}

function draftFromRaw(
  obj: Record<string, unknown>,
  type: "multiple_choice",
  chunk: NoteChunk,
  ctx: GenerateContext,
): QuestionInput | null {
  const conceptTags =
    deriveConceptTags(chunk.headingPath.join(" "), chunk.text).length > 0
      ? deriveConceptTags(chunk.headingPath.join(" "), chunk.text)
      : chunk.conceptTags;

  const base = {
    module: chunk.module as 6 | 7 | 8 | 9 | 10,
    topic: chunk.heading,
    conceptTags,
    difficulty: (Number(obj.difficulty) === 3
      ? 3
      : Number(obj.difficulty) === 2
        ? 2
        : 1) as 1 | 2 | 3,
    explanation: String(obj.explanation ?? ""),
    source: "generated" as const,
    sourceRef: {
      file: chunk.filename,
      heading: chunk.headingPath.join(" > "),
    },
    needsReview: false,
  };

  if (type === "multiple_choice") {
    const options = (obj.options as string[]) ?? [];
    const mc = validateMultipleChoiceOptions(options);
    if (!mc.ok) {
      pushReject(ctx, {
        stage: "chunk-mc",
        module: chunk.module,
        type,
        reason: mc.reason ?? "invalid MC options",
        sourceRef: base.sourceRef,
      });
      return null;
    }
    const draft: QuestionInput = {
      ...base,
      type: "multiple_choice",
      prompt: String(obj.prompt ?? ""),
      options,
      correctIndices: (obj.correctIndices as number[]) ?? [0],
      evidenceQuote: "pending",
    };
    const answer = expectedAnswerOf(draft);
    const correctSet = new Set(draft.correctIndices);
    const correctOpts = draft.correctIndices
      .map((i) => draft.options[i]!)
      .filter(Boolean);
    const distractors = draft.options.filter((_, i) => !correctSet.has(i));
    // NOT/EXCEPT: rank evidence by distractors (attested facts), not the correct answer.
    const evidenceAnchor = isNotExceptPrompt(draft.prompt)
      ? (distractors[0] ?? "")
      : (correctOpts[0] ?? answer);
    const evidenceAliases = isNotExceptPrompt(draft.prompt)
      ? distractors.slice(1)
      : correctOpts.slice(1);
    const evidenceQuote = assignEvidence({
      chunkText: chunk.text,
      question: draft.prompt,
      answer: evidenceAnchor,
      aliases: evidenceAliases,
    });
    if (!evidenceQuote) {
      const ranked = rankEvidenceCandidates({
        chunkText: chunk.text,
        question: draft.prompt,
        answer: evidenceAnchor,
        aliases: evidenceAliases,
      });
      const best = ranked[0];
      pushReject(ctx, {
        stage: "chunk-evidence",
        module: chunk.module,
        type,
        reason: "no evidence sentence with answer terms",
        question: draft.prompt,
        storedAnswer: answer,
        detail: best
          ? `bestUnit score=${best.score.toFixed(2)} hasAnswer=${best.hasAnswer} supportsPrompt=${best.supportsPrompt} :: ${best.unit.slice(0, 140)}`
          : "no units",
        sourceRef: base.sourceRef,
        evidenceQuote: best?.unit,
      });
      cacheRejectedItem(
        ctx,
        chunk.module,
        chunk.text,
        type,
        draft.prompt,
        "no evidence sentence with answer terms",
      );
      return null;
    }
    if (answerLeaksInPrompt(draft.prompt, answer, evidenceAliases)) {
      pushReject(ctx, {
        stage: "chunk-answer-leak",
        module: chunk.module,
        type,
        reason: "answer terms appear in prompt",
        question: draft.prompt,
        storedAnswer: answer,
        sourceRef: base.sourceRef,
      });
      cacheRejectedItem(
        ctx,
        chunk.module,
        chunk.text,
        type,
        draft.prompt,
        "answer leak",
      );
      return null;
    }
    if (isNotExceptPrompt(draft.prompt)) {
      const ne = validateNotExceptMultipleChoice({
        prompt: draft.prompt,
        options: draft.options,
        correctIndices: draft.correctIndices,
        evidenceQuote,
      });
      if (!ne.ok) {
        pushReject(ctx, {
          stage: "chunk-not-except",
          module: chunk.module,
          type,
          reason: ne.reason ?? "NOT/EXCEPT validation failed",
          question: draft.prompt,
          storedAnswer: answer,
          evidenceQuote,
          sourceRef: base.sourceRef,
        });
        cacheRejectedItem(
          ctx,
          chunk.module,
          chunk.text,
          type,
          draft.prompt,
          ne.reason ?? "NOT/EXCEPT",
        );
        return null;
      }
    }
    return {
      ...draft,
      evidenceQuote,
      explanation: notesExplanation(evidenceQuote),
    };
  }

  // Situational drafts are built in generateSituationalFromChunk, not here.
  pushReject(ctx, {
    stage: "chunk-gen",
    module: chunk.module,
    type,
    reason: "situational must be built from notes keyPoints",
    sourceRef: base.sourceRef,
  });
  return null;
}

/** Higher is better — used after filters to keep up to the size-based target. */
export function scoreCandidate(q: Question): number {
  let s = 0;
  if (!q.needsReview) s += 10;
  if (q.evidenceQuote) s += 5;
  if (q.type === "identification") {
    const ans = q.acceptedAnswers[0] ?? "";
    if (ans.length > 0 && ans.length <= 48) s += 4;
    if ((q.aliases?.length ?? 0) > 0) s += 1;
  }
  if (q.type === "multiple_choice") s += 2;
  if (q.type === "situational") s += 1;
  s += Math.max(0, 4 - Math.floor(q.prompt.length / 100));
  return s;
}

async function rewordClozePrompt(input: {
  clozePrompt: string;
  answer: string;
  evidenceQuote: string;
  chunk: NoteChunk;
  ctx: GenerateContext;
}): Promise<string> {
  const key = generationCacheKey({
    module: input.chunk.module,
    chunkHash: chunkHash(input.chunk.text),
    type: "cloze-reword",
    model: input.ctx.model,
    variant: createHash("sha256")
      .update(input.clozePrompt)
      .digest("hex")
      .slice(0, 12),
  });
  const cached = readCache<{ prompt: string }>(input.ctx.cacheDir, key);
  logCache(!!cached, `cloze-reword ${key.slice(0, 8)}`);
  if (cached?.prompt) return cached.prompt;

  try {
    const raw = await ollamaChatJson({
      model: input.ctx.model,
      system: `You reword identification cloze prompts for an AWS quiz. Do NOT change the blank's answer. Do NOT invent facts. NEVER include the answer text (or close paraphrase of it) in the prompt — the learner must supply it. Keep ____ or ask without naming the answer. Return JSON {"prompt":"..."}. Template ${PROMPT_TEMPLATE_VERSION}.`,
      user: `EVIDENCE (do not contradict): ${input.evidenceQuote}
ANSWER (must remain correct, but must NOT appear in the prompt): ${input.answer}
DRAFT PROMPT: ${input.clozePrompt}

Reword into a clear identification question. Do not write the words of the answer in the prompt. Return JSON only.`,
    });
    const prompt = String((raw as { prompt?: string }).prompt ?? "").trim();
    if (prompt.length >= 12) {
      writeCache(input.ctx.cacheDir, key, { prompt });
      return prompt;
    }
  } catch {
    // fall through to draft
  }
  writeCache(input.ctx.cacheDir, key, { prompt: input.clozePrompt });
  return input.clozePrompt;
}

/**
 * Identification via code-built cloze: answer + evidence fixed; model may reword prompt only.
 */
export async function generateIdentificationFromChunk(input: {
  chunk: NoteChunk;
  ctx: GenerateContext;
  slot?: number;
  count?: number;
}): Promise<Question[]> {
  const { chunk, ctx } = input;
  const slot = input.slot ?? 0;
  const count = input.count ?? OVERGENERATE_PER_SLOT;
  const key = generationCacheKey({
    module: chunk.module,
    chunkHash: chunkHash(chunk.text),
    type: "identification",
    model: ctx.model,
    variant: `cloze:slot:${slot}:n${count}`,
  });
  const cached = readCache<QuestionInput[]>(ctx.cacheDir, key);
  logCache(
    !!cached,
    `chunk-cloze id slot=${slot} n=${count} ${chunk.heading} ${key.slice(0, 8)}`,
  );
  if (cached) {
    return cached
      .map((d) => finalizeOrNull(d, chunk))
      .filter((q): q is Question => q !== null)
      .filter((q) => {
        if (ctx.decisions?.[q.id]?.decision === "reject") {
          pushReject(ctx, {
            stage: "human-decision",
            module: chunk.module,
            type: "identification",
            reason: "human review reject",
            detail: ctx.decisions[q.id]?.note,
            question: q.prompt,
          });
          return false;
        }
        return true;
      });
  }

  const clozeAll = buildClozeCandidates(chunk.text, chunk.conceptTags);
  // Prefer human rewrite answers first so they are not trimmed out of the pool.
  const rewriteAnswers = new Set(
    Object.values(ctx.decisions ?? {})
      .filter((d) => d.decision === "rewrite" && d.matchAnswer)
      .map((d) => normalizeServiceName(d.matchAnswer!)),
  );
  clozeAll.sort((a, b) => {
    const ar = rewriteAnswers.has(normalizeServiceName(a.answer)) ? 0 : 1;
    const br = rewriteAnswers.has(normalizeServiceName(b.answer)) ? 0 : 1;
    if (ar !== br) return ar - br;
    return b.evidenceQuote.length - a.evidenceQuote.length;
  });
  // Over-generate: take up to 2x requested distinct cloze items
  const pool = clozeAll.slice(0, Math.max(count * 2, count));
  if (pool.length === 0) {
    pushReject(ctx, {
      stage: "chunk-cloze",
      module: chunk.module,
      type: "identification",
      reason: "no cloze candidates in chunk",
      sourceRef: { file: chunk.filename, heading: chunk.headingPath.join(" > ") },
    });
    return [];
  }

  const survivors: Question[] = [];
  const draftsToCache: QuestionInput[] = [];

  for (const cloze of pool) {
    if (survivors.length >= count) break;
    if (
      isRejectCached(ctx, chunk.module, chunk.text, "identification", cloze.prompt)
    ) {
      logCache(true, `reject-skip cloze ${cloze.answer}`);
      continue;
    }

    // Human rewrite wins; else try model reword; fall back to cloze (blanked) prompt.
    const rewrite = rewriteForAnswer(ctx.decisions ?? {}, cloze.answer);
    let prompt = rewrite?.prompt ?? cloze.prompt;
    if (!rewrite?.prompt) {
      const reworded = await rewordClozePrompt({
        clozePrompt: cloze.prompt,
        answer: cloze.answer,
        evidenceQuote: cloze.evidenceQuote,
        chunk,
        ctx,
      });
      if (!answerLeaksInPrompt(reworded, cloze.answer, cloze.aliases)) {
        prompt = reworded;
      }
    }

    if (isRejectCached(ctx, chunk.module, chunk.text, "identification", prompt)) {
      continue;
    }

    if (!assertLiteralQuote(chunk.text, cloze.evidenceQuote)) {
      pushReject(ctx, {
        stage: "chunk-cloze",
        module: chunk.module,
        type: "identification",
        reason: "cloze evidence not literal substring",
        detail: cloze.evidenceQuote.slice(0, 120),
      });
      continue;
    }

    if (answerLeaksInPrompt(prompt, cloze.answer, cloze.aliases)) {
      pushReject(ctx, {
        stage: "chunk-answer-leak",
        module: chunk.module,
        type: "identification",
        reason: "answer terms appear in prompt",
        question: prompt,
        storedAnswer: cloze.answer,
        evidenceQuote: cloze.evidenceQuote,
      });
      cacheRejectedItem(
        ctx,
        chunk.module,
        chunk.text,
        "identification",
        prompt,
        "answer leak",
      );
      continue;
    }

    const outdated = detectOutdated(prompt, cloze.answer, cloze.evidenceQuote);

    const draft: QuestionInput = {
      module: chunk.module as 6 | 7 | 8 | 9 | 10,
      topic: chunk.heading,
      conceptTags:
        chunk.conceptTags.length > 0
          ? chunk.conceptTags
          : deriveConceptTags(chunk.heading, chunk.text),
      type: "identification",
      difficulty: 1,
      prompt,
      acceptedAnswers: [cloze.answer],
      aliases: cloze.aliases,
      explanation: notesExplanation(cloze.evidenceQuote),
      source: "generated",
      sourceRef: {
        file: chunk.filename,
        heading: chunk.headingPath.join(" > "),
      },
      needsReview: outdated.needsReview,
      outdatedNote: outdated.outdatedNote,
      evidenceQuote: cloze.evidenceQuote,
    };

    const idv = validateIdentification({
      prompt: draft.prompt,
      acceptedAnswers: draft.acceptedAnswers,
      aliases: draft.aliases,
      evidenceQuote: draft.evidenceQuote,
    });
    if (!idv.ok) {
      pushReject(ctx, {
        stage: "chunk-identification",
        module: chunk.module,
        type: "identification",
        reason: idv.reason ?? "invalid identification",
        question: draft.prompt,
        storedAnswer: cloze.answer,
        evidenceQuote: cloze.evidenceQuote,
        sourceRef: draft.sourceRef,
      });
      cacheRejectedItem(
        ctx,
        chunk.module,
        chunk.text,
        "identification",
        draft.prompt,
        idv.reason ?? "invalid identification",
      );
      continue;
    }

    const verified = await verifyAgainstChunk({
      chunkText: chunk.text,
      prompt: draft.prompt,
      expectedAnswer: cloze.answer,
      ctx,
      module: chunk.module,
    });
    if (!verified.agrees) {
      pushReject(ctx, {
        stage: "chunk-verify",
        module: chunk.module,
        type: "identification",
        reason: "verifier disagreed",
        question: draft.prompt,
        storedAnswer: cloze.answer,
        verifierAnswer: verified.modelAnswer,
        evidenceQuote: cloze.evidenceQuote,
        sourceRef: draft.sourceRef,
      });
      cacheRejectedItem(
        ctx,
        chunk.module,
        chunk.text,
        "identification",
        draft.prompt,
        "verifier disagreed",
      );
      continue;
    }

    const ambi = await checkAmbiguity({
      chunkText: chunk.text,
      prompt: draft.prompt,
      expectedAnswer: cloze.answer,
      ctx,
      module: chunk.module,
    });
    if (ambi.ambiguous) {
      pushReject(ctx, {
        stage: "chunk-ambiguity",
        module: chunk.module,
        type: "identification",
        reason: "ambiguous: another bullet/option also answers",
        detail: ambi.detail,
        question: draft.prompt,
        storedAnswer: cloze.answer,
        evidenceQuote: cloze.evidenceQuote,
      });
      cacheRejectedItem(
        ctx,
        chunk.module,
        chunk.text,
        "identification",
        draft.prompt,
        "ambiguous",
      );
      continue;
    }

    const finalRes = finalizeQuestion(draft, chunk);
    const finalQ = finalRes.question;
    if (!finalQ) {
      pushReject(ctx, {
        stage: "chunk-schema",
        module: chunk.module,
        type: "identification",
        reason: finalRes.schemaError ?? "failed zod/mechanical validation after generation",
      });
      continue;
    }
    if (ctx.decisions?.[finalQ.id]?.decision === "reject") {
      pushReject(ctx, {
        stage: "human-decision",
        module: chunk.module,
        type: "identification",
        reason: "human review reject",
        detail: ctx.decisions[finalQ.id]?.note,
        question: finalQ.prompt,
      });
      continue;
    }
    survivors.push(finalQ);
    draftsToCache.push(draft);
  }

  // Don't cache empty batches — allows code/prompt fixes to retry.
  if (draftsToCache.length > 0) {
    writeCache(ctx.cacheDir, key, draftsToCache);
  }
  return survivors;
}

/**
 * Situational from notes: code picks keyPoints/mustMention; model writes scenario only.
 * No "verifier answers the same" check.
 */
export async function generateSituationalFromChunk(input: {
  chunk: NoteChunk;
  ctx: GenerateContext;
  slot?: number;
  count?: number;
}): Promise<Question[]> {
  const { chunk, ctx } = input;
  const slot = input.slot ?? 0;
  const count = input.count ?? OVERGENERATE_PER_SLOT;
  const key = generationCacheKey({
    module: chunk.module,
    chunkHash: chunkHash(chunk.text),
    type: "situational",
    model: ctx.model,
    variant: `notes-kp:slot:${slot}:n${count}`,
  });
  const cached = readCache<QuestionInput[]>(ctx.cacheDir, key);
  logCache(
    !!cached,
    `chunk-sit notes slot=${slot} n=${count} ${chunk.heading} ${key.slice(0, 8)}`,
  );
  if (cached) {
    return cached
      .map((d) => finalizeOrNull(d, chunk))
      .filter((q): q is Question => q !== null)
      .filter((q) => ctx.decisions?.[q.id]?.decision !== "reject");
  }

  const allUnits = selectKeyPointUnits(chunk.text, 6)
    .map((u) => stripMarkdown(u))
    .filter((u) => u.length >= 24 && u.length <= 160 && !u.includes("|"));
  if (allUnits.length < 2) {
    pushReject(ctx, {
      stage: "chunk-situational",
      module: chunk.module,
      type: "situational",
      reason: "fewer than 2 actionable keyPoint sentences in chunk",
      sourceRef: { file: chunk.filename, heading: chunk.headingPath.join(" > ") },
    });
    return [];
  }

  const bold = extractBoldTerms(chunk.text).map(stripMarkdown);
  const survivors: Question[] = [];
  const draftsToCache: QuestionInput[] = [];

  for (let i = 0; i < count; i += 1) {
    const start = i % Math.max(1, allUnits.length - 1);
    const kp = [...new Set(allUnits.slice(start, start + 3))].slice(0, 4);
    if (kp.length < 2) continue;

    // keyPoints must still be literal in the chunk (allowing markdown variants)
    const literalKps = kp.filter(
      (p) =>
        chunk.text.includes(p) ||
        chunk.text.replace(/\*\*/g, "").includes(p) ||
        isGroundedEvidence(chunk.text, p),
    );
    if (literalKps.length < 2) {
      pushReject(ctx, {
        stage: "chunk-situational",
        module: chunk.module,
        type: "situational",
        reason: "keyPoint is not a literal chunk sentence",
        detail: kp[0]?.slice(0, 120),
      });
      continue;
    }

    const mustMention = [
      ...new Set(
        bold.filter((b) =>
          literalKps.some((p) =>
            normalizeServiceName(p).includes(normalizeServiceName(b)),
          ),
        ),
      ),
    ].slice(0, 6);
    if (mustMention.length === 0) {
      mustMention.push(
        ...normalizeServiceName(literalKps[0]!)
          .split(/\s+/)
          .filter((t) => t.length >= 5)
          .slice(0, 3),
      );
    }

    const evidenceQuote = literalKps[0]!;
    const scenarioKey = generationCacheKey({
      module: chunk.module,
      chunkHash: chunkHash(chunk.text),
      type: "sit-scenario",
      model: ctx.model,
      variant: createHash("sha256")
        .update(literalKps.join("|"))
        .digest("hex")
        .slice(0, 12),
    });

    async function askScenario(): Promise<{
      scenario: string;
      modelAnswer: string;
    } | null> {
      const raw = await ollamaChatJson({
        model: ctx.model,
        system: `You write AWS quiz situational items grounded ONLY in KEY POINTS. Return JSON {"scenario":"...","modelAnswer":"..."}. scenario = realistic 2–4 sentence situation (≥80 chars). modelAnswer = short readable prose (not bullet dumps, no markdown). Never copy key points verbatim into the scenario. Never use placeholder text. Template ${PROMPT_TEMPLATE_VERSION}.`,
        user: `TOPIC: ${chunk.heading}
KEY POINTS:
${literalKps.map((p, n) => `${n + 1}. ${p}`).join("\n")}

Return JSON only.`,
      });
      const scenario = String((raw as { scenario?: string }).scenario ?? "").trim();
      const modelAnswer = String(
        (raw as { modelAnswer?: string }).modelAnswer ?? "",
      ).trim();
      return { scenario, modelAnswer };
    }

    function scenarioOk(scenario: string, modelAnswer: string): string | null {
      if (scenario.length < 80) return "scenario too short";
      if (scenario === SIT_PLACEHOLDER) return "placeholder scenario";
      if (/apply the concepts from the notes/i.test(scenario)) {
        return "template scenario";
      }
      const sn = normalizeServiceName(scenario);
      const pasted = literalKps.filter((k) =>
        sn.includes(normalizeServiceName(k).slice(0, 48)),
      );
      if (pasted.length >= literalKps.length) return "scenario pastes keyPoints";
      if (modelAnswer.length < 40) return "modelAnswer too short";
      if (/\*\*|^\s*\|/m.test(modelAnswer)) return "modelAnswer has markdown";
      return null;
    }

    let cachedSit = readCache<{ scenario: string; modelAnswer: string }>(
      ctx.cacheDir,
      scenarioKey,
    );
    let scenario = cachedSit?.scenario ?? "";
    let modelAnswer = cachedSit?.modelAnswer ?? "";
    let failReason = scenarioOk(scenario, modelAnswer);

    for (let attempt = 0; attempt < 2 && failReason; attempt += 1) {
      try {
        const got = await askScenario();
        if (!got) {
          failReason = "empty model response";
          continue;
        }
        scenario = got.scenario;
        modelAnswer = got.modelAnswer;
        failReason = scenarioOk(scenario, modelAnswer);
        if (!failReason) {
          writeCache(ctx.cacheDir, scenarioKey, { scenario, modelAnswer });
        }
      } catch (err) {
        failReason = err instanceof Error ? err.message : String(err);
      }
    }

    if (failReason) {
      pushReject(ctx, {
        stage: "chunk-situational",
        module: chunk.module,
        type: "situational",
        reason: `scenario generation failed: ${failReason}`,
        detail: scenario.slice(0, 120),
        sourceRef: {
          file: chunk.filename,
          heading: chunk.headingPath.join(" > "),
        },
      });
      continue;
    }

    const outdated = detectOutdated(scenario, modelAnswer, ...literalKps);
    const tags =
      chunk.conceptTags.length > 0
        ? chunk.conceptTags
        : deriveConceptTags(chunk.heading, chunk.text);
    const conceptTags = tags.length > 0 ? tags : (["aws"] as const);

    const draft: QuestionInput = {
      module: chunk.module as 6 | 7 | 8 | 9 | 10,
      topic: chunk.heading,
      conceptTags: [...conceptTags],
      type: "situational",
      difficulty: 2,
      prompt: "Given the following scenario, what should you do and why?",
      scenario,
      rubric: {
        keyPoints: literalKps,
        mustMention,
        commonMistakes: [],
      },
      modelAnswer,
      explanation: notesExplanation(evidenceQuote),
      source: "generated",
      sourceRef: {
        file: chunk.filename,
        heading: chunk.headingPath.join(" > "),
      },
      needsReview: outdated.needsReview,
      outdatedNote: outdated.outdatedNote,
      evidenceQuote,
    };

    const finalRes = finalizeQuestion(draft, chunk);
    const finalQ = finalRes.question;
    if (!finalQ) {
      pushReject(ctx, {
        stage: "chunk-schema",
        module: chunk.module,
        type: "situational",
        reason: finalRes.schemaError ?? "failed zod/mechanical validation",
      });
      continue;
    }
    if (ctx.decisions?.[finalQ.id]?.decision === "reject") {
      pushReject(ctx, {
        stage: "human-decision",
        module: chunk.module,
        type: "situational",
        reason: "human review reject",
        detail: ctx.decisions[finalQ.id]?.note,
        question: finalQ.prompt,
      });
      continue;
    }
    survivors.push(finalQ);
    draftsToCache.push(draft);
  }

  if (draftsToCache.length > 0) {
    writeCache(ctx.cacheDir, key, draftsToCache);
  }
  return survivors;
}

/**
 * Over-generate ~2 distinct candidates per chunk+type in one call,
 * filter each, return survivors (not yet trimmed to module target).
 */
export async function generateCandidatesFromChunk(input: {
  chunk: NoteChunk;
  type: "multiple_choice" | "identification" | "situational";
  ctx: GenerateContext;
  distractorHints: string[];
  slot?: number;
  focusHint?: string;
  count?: number;
  /** In-app variety: random seed + higher temperature; included in cache key. */
  variety?: {
    seed: number;
    temperature?: number;
    avoidPrompts?: string[];
    useQueue?: boolean;
  };
}): Promise<Question[]> {
  if (input.type === "identification") {
    return generateIdentificationFromChunk({
      chunk: input.chunk,
      ctx: input.ctx,
      slot: input.slot,
      count: input.count,
    });
  }
  if (input.type === "situational") {
    return generateSituationalFromChunk({
      chunk: input.chunk,
      ctx: input.ctx,
      slot: input.slot,
      count: input.count,
    });
  }

  const { chunk, type, ctx } = input;
  const slot = input.slot ?? 0;
  const count = input.count ?? OVERGENERATE_PER_SLOT;
  const varietyTag = input.variety
    ? `:var:${input.variety.seed}:t${input.variety.temperature ?? 0.7}`
    : "";
  const key = generationCacheKey({
    module: chunk.module,
    chunkHash: chunkHash(chunk.text),
    type,
    model: ctx.model,
    variant: `batch:slot:${slot}:n${count}${varietyTag}`,
  });
  const cached = readCache<QuestionInput[]>(ctx.cacheDir, key);
  logCache(
    !!cached,
    `chunk-batch ${type} slot=${slot} n=${count} ${chunk.heading} ${key.slice(0, 8)}`,
  );
  if (cached) {
    return cached
      .map((d) => finalizeOrNull(d, chunk))
      .filter((q): q is Question => q !== null)
      .filter((q) => {
        if (ctx.decisions?.[q.id]?.decision === "reject") {
          pushReject(ctx, {
            stage: "human-decision",
            module: chunk.module,
            type,
            reason: "human review reject",
            detail: ctx.decisions[q.id]?.note,
            question: q.prompt,
          });
          return false;
        }
        return true;
      });
  }

  let rawItems: unknown[];
  try {
    rawItems = await callChunkGeneratorBatch({
      chunk,
      type,
      ctx,
      distractorHints: input.distractorHints,
      focusHint: input.focusHint,
      count,
      avoidPrompts: input.variety?.avoidPrompts,
      temperature: input.variety?.temperature,
      seed: input.variety?.seed,
      useQueue: input.variety?.useQueue,
    });
  } catch (err) {
    pushReject(ctx, {
      stage: "chunk-gen",
      module: chunk.module,
      type,
      reason: err instanceof Error ? err.message : String(err),
      sourceRef: { file: chunk.filename, heading: chunk.headingPath.join(" > ") },
    });
    return [];
  }

  const survivors: Question[] = [];
  const draftsToCache: QuestionInput[] = [];

  for (const item of rawItems.slice(0, count + 1)) {
    const obj = item as Record<string, unknown>;
    const promptPeek = String(obj.prompt ?? "");
    if (
      promptPeek &&
      isRejectCached(ctx, chunk.module, chunk.text, type, promptPeek)
    ) {
      logCache(true, `reject-skip ${type} ${promptPeek.slice(0, 40)}`);
      continue;
    }

    const draft = draftFromRaw(obj, type, chunk, ctx);
    if (!draft) continue;

    const expected = expectedAnswerOf(draft);
    const prompt = promptTextOf(draft);

    const verified = await verifyAgainstChunk({
      chunkText: chunk.text,
      prompt,
      expectedAnswer: expected,
      ctx,
      module: chunk.module,
    });
    if (!verified.agrees) {
      pushReject(ctx, {
        stage: "chunk-verify",
        module: chunk.module,
        type,
        reason: "verifier disagreed",
        sourceRef: draft.sourceRef,
        question: prompt,
        storedAnswer: expected,
        verifierAnswer: verified.modelAnswer,
        evidenceQuote: draft.evidenceQuote,
      });
      cacheRejectedItem(ctx, chunk.module, chunk.text, type, prompt, "verifier disagreed");
      continue;
    }

    const ambi = await checkAmbiguity({
      chunkText: chunk.text,
      prompt,
      expectedAnswer: expected,
      ctx,
      module: chunk.module,
    });
    if (ambi.ambiguous) {
      pushReject(ctx, {
        stage: "chunk-ambiguity",
        module: chunk.module,
        type,
        reason: "ambiguous: another bullet/option also answers",
        detail: ambi.detail,
        question: prompt,
        storedAnswer: expected,
        evidenceQuote: draft.evidenceQuote,
        sourceRef: draft.sourceRef,
      });
      cacheRejectedItem(ctx, chunk.module, chunk.text, type, prompt, "ambiguous");
      continue;
    }

    const finalRes = finalizeQuestion(draft, chunk);
    const finalQ = finalRes.question;
    if (!finalQ) {
      pushReject(ctx, {
        stage: "chunk-schema",
        module: chunk.module,
        type,
        reason: finalRes.schemaError ?? "failed zod/mechanical validation after generation",
        sourceRef: draft.sourceRef,
      });
      continue;
    }
    if (ctx.decisions?.[finalQ.id]?.decision === "reject") {
      pushReject(ctx, {
        stage: "human-decision",
        module: chunk.module,
        type,
        reason: "human review reject",
        detail: ctx.decisions[finalQ.id]?.note,
        question: finalQ.prompt,
      });
      continue;
    }
    survivors.push(finalQ);
    draftsToCache.push(draft);
  }

  if (draftsToCache.length > 0) {
    writeCache(ctx.cacheDir, key, draftsToCache);
  }
  return survivors;
}

/** @deprecated Prefer generateCandidatesFromChunk; kept for single-item callers. */
export async function generateFromChunk(input: {
  chunk: NoteChunk;
  type: "multiple_choice" | "identification" | "situational";
  ctx: GenerateContext;
  distractorHints: string[];
  slot?: number;
  focusHint?: string;
}): Promise<Question | null> {
  const list = await generateCandidatesFromChunk({ ...input, count: 1 });
  return list[0] ?? null;
}

export function buildProceduralFromSequence(
  chunk: NoteChunk,
  steps: string[],
): Question {
  const evidenceQuote =
    assignEvidence({
      chunkText: chunk.text,
      question: "Put these steps in the correct order (per the notes).",
      answer: steps.join(" "),
    }) ??
    pickEvidenceQuote(chunk.text, steps[0]) ??
    chunk.text.replace(/\s+/g, " ").trim().slice(0, 180);
  const prompt = `Put these steps in the correct order (per the notes).`;
  const tags = deriveConceptTags(chunk.heading, chunk.text);
  const conceptTags =
    chunk.conceptTags.length > 0
      ? chunk.conceptTags
      : tags.length > 0
        ? tags
        : ["ec2"];

  let quote =
    evidenceQuote && chunk.text.includes(evidenceQuote) ? evidenceQuote : "";
  if (!quote) {
    const line = chunk.text
      .split(/\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 20 && chunk.text.includes(l));
    quote = line ?? steps[0]!;
  }

  const draft: QuestionInput = attachOutdatedToQuestion({
    module: chunk.module as 6 | 7 | 8 | 9 | 10,
    topic: chunk.heading,
    conceptTags,
    type: "procedural",
    difficulty: 2,
    prompt,
    steps,
    explanation:
      "Order is per the notes for this section; score by correct positions.",
    source: "notes",
    sourceRef: {
      file: chunk.filename,
      heading: chunk.headingPath.join(" > "),
    },
    needsReview: false,
    ...(chunk.text.includes(quote) ? { evidenceQuote: quote } : {}),
  });

  const [parsed] = parseQuestionBank([draft]);
  return parsed!;
}

export function targetQuestionCount(wordCount: number): number {
  const n = Math.round(wordCount / 50);
  return Math.max(4, Math.min(n, 24));
}

export function distractorHintsForModule(chunks: NoteChunk[]): string[] {
  const tags = new Set<string>();
  for (const c of chunks) for (const t of c.conceptTags) tags.add(t);
  const headings = chunks.map((c) => c.heading);
  return [...tags, ...headings].slice(0, 20);
}

export async function buildModuleQuestions(input: {
  module: number;
  chunks: NoteChunk[];
  directAnki: QuestionInput[];
  seeds: AnkiSeedCard[];
  cacheDir: string;
  model: string;
  decisions?: DecisionsFile;
}): Promise<{ questions: Question[]; rejects: RejectRecord[] }> {
  const ctx: GenerateContext = {
    cacheDir: input.cacheDir,
    rejects: [],
    model: input.model,
    decisions: input.decisions ?? {},
  };

  const words = input.chunks.reduce((n, c) => n + c.wordCount, 0);
  const target = targetQuestionCount(words);
  const locked: Question[] = [];

  for (const q of input.directAnki.filter((x) => x.module === input.module)) {
    const id = questionId(q);
    locked.push({ ...q, id });
  }

  for (const chunk of input.chunks) {
    for (const seq of chunk.sequenceCandidates) {
      locked.push(buildProceduralFromSequence(chunk, seq.steps));
    }
  }

  // Code-built "which topic does this describe?" MC — no LLM.
  for (const draft of buildTopicMultipleChoice(
    input.chunks.filter((c) => c.module === input.module),
  )) {
    const chunk = input.chunks.find(
      (c) => c.headingPath.join(" > ") === draft.sourceRef.heading,
    );
    if (!chunk) continue;
    const q = finalizeOrNull(draft, chunk);
    if (q) locked.push(q);
  }

  const moduleSeeds = input.seeds.filter((s) => s.module === input.module);
  moduleSeeds.sort((a, b) => a.guid.localeCompare(b.guid));
  for (const seed of moduleSeeds) {
    // Situational is notes-built only; Anki seeds become MC.
    const q = await generateFromAnkiSeed({
      seed,
      chunks: input.chunks,
      preferType: "multiple_choice",
      ctx,
    });
    if (q) locked.push(q);
  }

  const fillTypes: Array<"multiple_choice" | "identification" | "situational"> =
    ["multiple_choice", "identification", "situational"];
  const hints = distractorHintsForModule(input.chunks);
  const chunkOrder = [...input.chunks].sort((a, b) => {
    if (b.wordCount !== a.wordCount) return b.wordCount - a.wordCount;
    return a.headingPath.join(">").localeCompare(b.headingPath.join(">"));
  });
  const focusHints = [
    "a concrete service or feature name; a comparison detail",
    "a behavior, alarm, or scaling action; a when-to-use detail",
    "monitoring vs scaling contrast; target registration detail",
  ];

  const generated: Question[] = [];
  let slot = 0;
  for (const type of fillTypes) {
    for (const chunk of chunkOrder) {
      const batch = await generateCandidatesFromChunk({
        chunk,
        type,
        ctx,
        distractorHints: hints,
        slot,
        focusHint: focusHints[slot % focusHints.length],
        count: OVERGENERATE_PER_SLOT,
      });
      slot += 1;
      generated.push(...batch);
    }
  }

  const pool = [...locked, ...generated];
  const { kept: promptDeduped, duplicatesDropped } = dedupeByPromptSimilarity(
    pool,
    (q) =>
      q.type === "situational" ? `${q.prompt}\n${q.scenario}` : q.prompt,
  );
  if (duplicatesDropped > 0) {
    console.log(
      `Deduped ${duplicatesDropped} near-duplicate prompt(s) in module ${input.module}`,
    );
  }
  const { kept: deduped, duplicatesDropped: topicDropped } =
    dedupeByTopic(promptDeduped);
  if (topicDropped > 0) {
    console.log(
      `Deduped ${topicDropped} near-identical topic(s) in module ${input.module}`,
    );
  }

  const lockedIds = new Set(locked.map((q) => q.id));
  const lockedKept = deduped.filter((q) => lockedIds.has(q.id));
  const fillers = deduped
    .filter((q) => !lockedIds.has(q.id))
    .sort((a, b) => {
      const ds = scoreCandidate(b) - scoreCandidate(a);
      if (ds !== 0) return ds;
      return a.id.localeCompare(b.id);
    });

  // Cap situational at 20% of the module bank, but reserve those slots
  // so other fillers cannot crowd situational out entirely.
  const maxSit = Math.max(0, Math.floor(target * 0.2));
  const sitInLocked = lockedKept.filter((q) => q.type === "situational");
  const nonSitLocked = lockedKept.filter((q) => q.type !== "situational");
  const sitFillers = fillers.filter((q) => q.type === "situational");
  const otherFillers = fillers.filter((q) => q.type !== "situational");
  const lockedKeptCapped = [...nonSitLocked, ...sitInLocked.slice(0, maxSit)];
  const sitAlready = lockedKeptCapped.filter((q) => q.type === "situational").length;
  const sitBudget = Math.max(0, maxSit - sitAlready);
  const chosenSit = sitFillers.slice(0, sitBudget);
  const remainingAfterSit = Math.max(
    0,
    target - lockedKeptCapped.length - chosenSit.length,
  );
  let chosen = [
    ...lockedKeptCapped,
    ...chosenSit,
    ...otherFillers.slice(0, remainingAfterSit),
  ];

  const { kept, rejectedIds } = applyDecisions(chosen, ctx.decisions ?? {});
  for (const id of rejectedIds) {
    const q = chosen.find((x) => x.id === id);
    pushReject(ctx, {
      stage: "human-decision",
      module: input.module,
      type: q?.type,
      reason: "human review reject",
      detail: ctx.decisions?.[id]?.note,
      question: q?.prompt,
    });
  }
  if (rejectedIds.length > 0 && kept.length < target) {
    const keptIds = new Set(kept.map((q) => q.id));
    const extra = fillers
      .filter((q) => !keptIds.has(q.id))
      .slice(0, target - kept.length);
    const second = applyDecisions([...kept, ...extra], ctx.decisions ?? {});
    chosen = second.kept;
  } else {
    chosen = kept;
  }

  chosen.sort((a, b) => a.id.localeCompare(b.id));

  console.log(
    `Module ${input.module}: candidates=${deduped.length} locked=${lockedKept.length} kept=${chosen.length}/${target} (words=${words}).`,
  );

  return { questions: chosen, rejects: ctx.rejects };
}

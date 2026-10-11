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
import { deriveConceptTags } from "./conceptTags.js";
import type { NoteChunk } from "./notesParser.js";
import { ollamaChatJson } from "./ollamaClient.js";
import { detectOutdated } from "./outdated.js";
import {
  validateIdentification,
  validateMultipleChoiceOptions,
} from "./validateQuestions.js";

export type RejectRecord = {
  stage: string;
  module: number;
  type?: string;
  reason: string;
  detail?: string;
  sourceRef?: { file: string; heading: string };
};

export type GenerateContext = {
  cacheDir: string;
  rejects: RejectRecord[];
  model: string;
};

function pushReject(ctx: GenerateContext, reject: RejectRecord): void {
  ctx.rejects.push(reject);
  console.warn(`[reject] ${reject.stage}: ${reject.reason}`);
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

function pickEvidenceQuote(chunkText: string, hint?: string): string | null {
  const sentences = chunkText
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 40 && s.length <= 280);
  if (sentences.length === 0) {
    const fallback = chunkText.replace(/\s+/g, " ").trim().slice(0, 200);
    return chunkText.includes(fallback) ? fallback : null;
  }
  if (hint) {
    const hintTokens = hint
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 4)
      .slice(0, 8);
    let best = sentences[0]!;
    let bestScore = -1;
    for (const s of sentences) {
      const lower = s.toLowerCase();
      const score = hintTokens.reduce((n, t) => n + (lower.includes(t) ? 1 : 0), 0);
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    if (chunkText.includes(best)) return best;
  }
  const first = sentences[0]!;
  return chunkText.includes(first) ? first : null;
}

function assertLiteralQuote(chunkText: string, quote: string): boolean {
  return quote.length > 0 && chunkText.includes(quote);
}

async function verifyAgainstChunk(input: {
  chunkText: string;
  prompt: string;
  expectedAnswer: string;
  ctx: GenerateContext;
  module: number;
}): Promise<boolean> {
  const key = generationCacheKey({
    module: input.module,
    chunkHash: chunkHash(input.chunkText),
    type: "verify",
    model: input.ctx.model,
    variant: createHash("sha256").update(input.prompt).digest("hex").slice(0, 12),
  });
  const cached = readCache<{ agrees: boolean; modelAnswer: string }>(
    input.ctx.cacheDir,
    key,
  );
  logCache(!!cached, `verify module=${input.module} ${key.slice(0, 8)}`);
  if (cached) return cached.agrees;

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

  writeCache(input.ctx.cacheDir, key, { agrees, modelAnswer });
  return agrees;
}

function overlapScore(a: string, b: string): number {
  const ta = new Set(a.split(/\s+/).filter((w) => w.length > 3));
  const tb = new Set(b.split(/\s+/).filter((w) => w.length > 3));
  if (ta.size === 0 || tb.size === 0) return 0;
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit += 1;
  return hit / Math.max(ta.size, tb.size);
}

function finalizeQuestion(
  input: QuestionInput,
  chunk: NoteChunk,
): Question | null {
  const parsed = questionInputSchema.safeParse(input);
  if (!parsed.success) return null;
  const q = parsed.data;
  if (q.evidenceQuote && !assertLiteralQuote(chunk.text, q.evidenceQuote)) {
    return null;
  }
  if (q.type === "multiple_choice") {
    const mc = validateMultipleChoiceOptions(q.options);
    if (!mc.ok) return null;
  }
  if (q.type === "identification") {
    const idv = validateIdentification({
      prompt: q.prompt,
      acceptedAnswers: q.acceptedAnswers,
      evidenceQuote: q.evidenceQuote,
    });
    if (!idv.ok) return null;
  }
  const id = questionId({
    source: q.source,
    sourceRef: q.sourceRef,
    prompt: q.prompt,
  });
  return { ...q, id };
}

/** Deterministic short-option MC for the Module 10 ELB "three types" Anki seed. */
function deterministicElbTypesSeed(
  seed: AnkiSeedCard,
  chunk: NoteChunk,
): QuestionInput | null {
  if (!/three types of elastic load balancers/i.test(seed.front)) return null;
  if (seed.module !== 10) return null;

  const evidenceCandidates = [
    "Classic Load Balancer (Previous Generation)",
    "With Application Load Balancers and Network Load Balancers, you register targets in target groups, and route traffic to the target groups.",
    "With Classic Load Balancers, you register instances with the load balancer.",
  ];
  const evidenceQuote =
    evidenceCandidates.find((q) => chunk.text.includes(q)) ??
    pickEvidenceQuote(chunk.text, "Classic Load Balancer");
  if (!evidenceQuote || !chunk.text.includes(evidenceQuote)) return null;

  const outdated = detectOutdated(seed.front, seed.back, chunk.text);
  return {
    module: 10,
    topic: chunk.heading,
    conceptTags: deriveConceptTags(chunk.heading, chunk.text, "elb").length
      ? deriveConceptTags(chunk.heading, chunk.text, "elb")
      : ["elb"],
    type: "multiple_choice",
    difficulty: 1,
    prompt: "Which three Elastic Load Balancing types does Module 10 list?",
    options: [
      "Application, Network, and Classic",
      "Application, Gateway, and Network",
      "Classic, Target, and Network",
      "Application, Network, and Internet",
    ],
    correctIndices: [0],
    explanation:
      "Module 10 compares Application Load Balancer, Network Load Balancer, and Classic Load Balancer (previous generation).",
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
    const done = finalizeQuestion(cached, chunk);
    if (done) return done;
  }

  // Prefer deterministic short options for the known ELB types card.
  if (input.preferType === "multiple_choice") {
    const det = deterministicElbTypesSeed(input.seed, chunk);
    if (det) {
      const finalDet = finalizeQuestion(det, chunk);
      if (finalDet) {
        writeCache(input.ctx.cacheDir, key, det);
        return finalDet;
      }
    }
  }

  const outdated = detectOutdated(
    input.seed.front,
    input.seed.back,
    chunk.text,
  );
  const evidenceHint = pickEvidenceQuote(chunk.text, input.seed.back);
  if (!evidenceHint) {
    pushReject(input.ctx, {
      stage: "anki-seed",
      module: input.seed.module,
      type: input.preferType,
      reason: "could not pick evidenceQuote substring from chunk",
      sourceRef: { file: chunk.filename, heading: chunk.headingPath.join(" > ") },
    });
    return null;
  }

  const system = `You create AWS Cloud Foundations quiz questions. Use ONLY the ANKI ANSWER as ground truth and the NOTES CHUNK for wording/evidence. Never contradict or extend beyond them. Return JSON only. Template ${PROMPT_TEMPLATE_VERSION}.`;

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
  "evidenceQuote": "exact substring copied from NOTES CHUNK",
  "difficulty": 1
}
Distractors must be plausible related AWS services/concepts from THIS MODULE only. evidenceQuote MUST be copied verbatim from the NOTES CHUNK.`
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
  "evidenceQuote": "exact substring copied from NOTES CHUNK",
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
  let evidenceQuote = String(obj.evidenceQuote ?? "");
  if (!assertLiteralQuote(chunk.text, evidenceQuote)) {
    if (!assertLiteralQuote(chunk.text, evidenceHint)) {
      pushReject(input.ctx, {
        stage: "anki-seed-grounding",
        module: input.seed.module,
        type: input.preferType,
        reason: "evidenceQuote is not a literal substring of the chunk",
        detail: evidenceQuote.slice(0, 160),
        sourceRef: {
          file: chunk.filename,
          heading: chunk.headingPath.join(" > "),
        },
      });
      return null;
    }
    evidenceQuote = evidenceHint;
  }

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
    evidenceQuote,
  };

  let draft: QuestionInput;
  if (input.preferType === "multiple_choice") {
    draft = {
      ...base,
      type: "multiple_choice",
      prompt: String(obj.prompt ?? input.seed.front),
      options: (obj.options as string[]) ?? [],
      correctIndices: (obj.correctIndices as number[]) ?? [0],
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
    };
  }

  const expectedAnswer =
    draft.type === "multiple_choice"
      ? draft.options[draft.correctIndices[0]!] ?? input.seed.back
      : draft.modelAnswer;

  const agrees = await verifyAgainstChunk({
    chunkText: chunk.text,
    prompt: draft.prompt + ("scenario" in draft ? `\n${draft.scenario}` : ""),
    expectedAnswer: `${expectedAnswer}\n${input.seed.back}`,
    ctx: input.ctx,
    module: input.seed.module,
  });
  if (!agrees) {
    pushReject(input.ctx, {
      stage: "anki-seed-verify",
      module: input.seed.module,
      type: input.preferType,
      reason: "verification pass disagreed with stored/anki answer using chunk only",
      sourceRef: base.sourceRef,
    });
    return null;
  }

  const finalQ = finalizeQuestion(draft, chunk);
  if (!finalQ) {
    pushReject(input.ctx, {
      stage: "anki-seed-schema",
      module: input.seed.module,
      type: input.preferType,
      reason: "failed zod/mechanical validation after generation",
    });
    return null;
  }

  writeCache(input.ctx.cacheDir, key, draft);
  return finalQ;
}

async function callChunkGenerator(input: {
  chunk: NoteChunk;
  type: "multiple_choice" | "identification" | "situational";
  ctx: GenerateContext;
  distractorHints: string[];
  focusHint?: string;
  attempt: number;
}): Promise<unknown> {
  const focus = input.focusHint
    ? `\nFocus on this aspect (do not repeat a generic overview question): ${input.focusHint}\n`
    : "";
  const retryNote =
    input.attempt > 0
      ? "\nPREVIOUS ATTEMPT FAILED VALIDATION. Follow option length and uniqueness rules strictly.\n"
      : "";

  const system = `You create AWS Cloud Foundations quiz questions grounded ONLY in the NOTES CHUNK. Never invent facts. Return JSON only. evidenceQuote must be copied verbatim from the chunk. Template ${PROMPT_TEMPLATE_VERSION}.`;

  let user = "";
  if (input.type === "multiple_choice") {
    user = `NOTES CHUNK (Module ${input.chunk.module} — ${input.chunk.headingPath.join(" > ")}):
${input.chunk.text}
${focus}${retryNote}
Related terms for distractors (same module): ${input.distractorHints.join(", ")}

Rules: each option ≤ 12 words; no numbered lists; no multi-line options.

Return JSON:
{
  "prompt": "...",
  "options": ["...","...","...","..."],
  "correctIndices": [0],
  "explanation": "...",
  "evidenceQuote": "verbatim substring from NOTES CHUNK",
  "difficulty": 1
}`;
  } else if (input.type === "identification") {
    user = `NOTES CHUNK (Module ${input.chunk.module} — ${input.chunk.headingPath.join(" > ")}):
${input.chunk.text}
${focus}${retryNote}
Create one identification question. The prompt MUST name the AWS service/context so only one answer fits. The accepted answer MUST appear verbatim (ignoring case) inside evidenceQuote.

Return JSON:
{
  "prompt": "...",
  "acceptedAnswers": ["primary"],
  "aliases": ["optional alias"],
  "explanation": "...",
  "evidenceQuote": "verbatim substring from NOTES CHUNK that contains the answer",
  "difficulty": 1
}`;
  } else {
    user = `NOTES CHUNK (Module ${input.chunk.module} — ${input.chunk.headingPath.join(" > ")}):
${input.chunk.text}
${focus}${retryNote}
Create one short situational question with rubric and modelAnswer grounded only in the chunk.
Return JSON:
{
  "prompt": "...",
  "scenario": "...",
  "rubric": {"keyPoints":["..."],"mustMention":["..."],"commonMistakes":["..."]},
  "modelAnswer": "...",
  "explanation": "...",
  "evidenceQuote": "verbatim substring from NOTES CHUNK",
  "difficulty": 2
}`;
  }

  return ollamaChatJson({ model: input.ctx.model, system, user });
}

export async function generateFromChunk(input: {
  chunk: NoteChunk;
  type: "multiple_choice" | "identification" | "situational";
  ctx: GenerateContext;
  distractorHints: string[];
  slot?: number;
  focusHint?: string;
}): Promise<Question | null> {
  const { chunk, type, ctx } = input;
  const slot = input.slot ?? 0;
  const key = generationCacheKey({
    module: chunk.module,
    chunkHash: chunkHash(chunk.text),
    type,
    model: ctx.model,
    variant: `slot:${slot}`,
  });
  const cached = readCache<QuestionInput>(ctx.cacheDir, key);
  logCache(!!cached, `chunk ${type} slot=${slot} ${chunk.heading} ${key.slice(0, 8)}`);
  if (cached) {
    const done = finalizeQuestion(cached, chunk);
    if (done) return done;
  }

  const outdated = detectOutdated(chunk.headingPath.join(" "), chunk.text);
  const evidenceHint = pickEvidenceQuote(chunk.text);
  if (!evidenceHint) {
    pushReject(ctx, {
      stage: "chunk-gen",
      module: chunk.module,
      type,
      reason: "chunk too thin for evidenceQuote",
      sourceRef: { file: chunk.filename, heading: chunk.headingPath.join(" > ") },
    });
    return null;
  }

  let draft: QuestionInput | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let raw: unknown;
    try {
      raw = await callChunkGenerator({
        chunk,
        type,
        ctx,
        distractorHints: input.distractorHints,
        focusHint: input.focusHint,
        attempt,
      });
    } catch (err) {
      pushReject(ctx, {
        stage: "chunk-gen",
        module: chunk.module,
        type,
        reason: err instanceof Error ? err.message : String(err),
        sourceRef: { file: chunk.filename, heading: chunk.headingPath.join(" > ") },
      });
      return null;
    }

    const obj = raw as Record<string, unknown>;
    let quote = String(obj.evidenceQuote ?? "");
    if (!assertLiteralQuote(chunk.text, quote)) {
      if (!assertLiteralQuote(chunk.text, evidenceHint)) {
        pushReject(ctx, {
          stage: "chunk-grounding",
          module: chunk.module,
          type,
          reason: "evidenceQuote not a literal substring of chunk",
          detail: quote.slice(0, 160),
          sourceRef: {
            file: chunk.filename,
            heading: chunk.headingPath.join(" > "),
          },
        });
        return null;
      }
      quote = evidenceHint;
    }

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
      needsReview: outdated.needsReview,
      outdatedNote: outdated.outdatedNote,
      evidenceQuote: quote,
    };

    if (type === "multiple_choice") {
      const options = (obj.options as string[]) ?? [];
      const mc = validateMultipleChoiceOptions(options);
      if (!mc.ok) {
        if (attempt === 0) continue;
        pushReject(ctx, {
          stage: "chunk-mc",
          module: chunk.module,
          type,
          reason: mc.reason ?? "invalid MC options",
          sourceRef: base.sourceRef,
        });
        return null;
      }
      draft = {
        ...base,
        type: "multiple_choice",
        prompt: String(obj.prompt ?? ""),
        options,
        correctIndices: (obj.correctIndices as number[]) ?? [0],
      };
    } else if (type === "identification") {
      const acceptedAnswers = (obj.acceptedAnswers as string[]) ?? [];
      const idv = validateIdentification({
        prompt: String(obj.prompt ?? ""),
        acceptedAnswers,
        evidenceQuote: quote,
      });
      if (!idv.ok) {
        if (attempt === 0) continue;
        pushReject(ctx, {
          stage: "chunk-identification",
          module: chunk.module,
          type,
          reason: idv.reason ?? "invalid identification",
          sourceRef: base.sourceRef,
        });
        return null;
      }
      draft = {
        ...base,
        type: "identification",
        prompt: String(obj.prompt ?? ""),
        acceptedAnswers,
        aliases: (obj.aliases as string[]) ?? [],
      };
    } else {
      const rubric = (obj.rubric as {
        keyPoints?: string[];
        mustMention?: string[];
        commonMistakes?: string[];
      }) ?? { keyPoints: [] };
      draft = {
        ...base,
        type: "situational",
        prompt: String(obj.prompt ?? ""),
        scenario: String(obj.scenario ?? ""),
        rubric: {
          keyPoints: rubric.keyPoints ?? [],
          mustMention: rubric.mustMention ?? [],
          commonMistakes: rubric.commonMistakes ?? [],
        },
        modelAnswer: String(obj.modelAnswer ?? ""),
      };
    }
    break;
  }

  if (!draft) return null;

  const expected =
    draft.type === "multiple_choice"
      ? draft.options[draft.correctIndices[0]!] ?? ""
      : draft.type === "identification"
        ? draft.acceptedAnswers[0] ?? ""
        : draft.modelAnswer;

  const agrees = await verifyAgainstChunk({
    chunkText: chunk.text,
    prompt:
      draft.prompt +
      (draft.type === "situational" ? `\n${draft.scenario}` : ""),
    expectedAnswer: expected,
    ctx,
    module: chunk.module,
  });
  if (!agrees) {
    pushReject(ctx, {
      stage: "chunk-verify",
      module: chunk.module,
      type,
      reason: "verification pass disagreed with stored answer using chunk only",
      sourceRef: draft.sourceRef,
    });
    return null;
  }

  const finalQ = finalizeQuestion(draft, chunk);
  if (!finalQ) {
    pushReject(ctx, {
      stage: "chunk-schema",
      module: chunk.module,
      type,
      reason: "failed zod/mechanical validation after generation",
      sourceRef: draft.sourceRef,
    });
    return null;
  }

  writeCache(ctx.cacheDir, key, draft);
  return finalQ;
}

export function buildProceduralFromSequence(
  chunk: NoteChunk,
  steps: string[],
): Question {
  const outdated = detectOutdated(chunk.headingPath.join(" "), chunk.text);
  const evidenceQuote =
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

  const draft: QuestionInput = {
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
    needsReview: outdated.needsReview,
    outdatedNote: outdated.outdatedNote,
    ...(chunk.text.includes(quote) ? { evidenceQuote: quote } : {}),
  };

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
}): Promise<{ questions: Question[]; rejects: RejectRecord[] }> {
  const ctx: GenerateContext = {
    cacheDir: input.cacheDir,
    rejects: [],
    model: input.model,
  };

  const words = input.chunks.reduce((n, c) => n + c.wordCount, 0);
  const target = targetQuestionCount(words);
  const questions: Question[] = [];

  for (const q of input.directAnki.filter((x) => x.module === input.module)) {
    const id = questionId(q);
    questions.push({ ...q, id });
  }

  for (const chunk of input.chunks) {
    for (const seq of chunk.sequenceCandidates) {
      questions.push(buildProceduralFromSequence(chunk, seq.steps));
    }
  }

  const moduleSeeds = input.seeds.filter((s) => s.module === input.module);
  // Stable order by guid for reproducibility.
  moduleSeeds.sort((a, b) => a.guid.localeCompare(b.guid));
  let seedIdx = 0;
  for (const seed of moduleSeeds) {
    if (questions.length >= target) break;
    const preferType = seedIdx % 2 === 0 ? "multiple_choice" : "situational";
    seedIdx += 1;
    const q = await generateFromAnkiSeed({
      seed,
      chunks: input.chunks,
      preferType,
      ctx,
    });
    if (q) questions.push(q);
  }

  const fillTypes: Array<"multiple_choice" | "identification" | "situational"> =
    ["multiple_choice", "identification", "situational"];
  const hints = distractorHintsForModule(input.chunks);
  const chunkOrder = [...input.chunks].sort((a, b) => {
    if (b.wordCount !== a.wordCount) return b.wordCount - a.wordCount;
    return a.headingPath.join(">").localeCompare(b.headingPath.join(">"));
  });
  const focusHints = [
    "a concrete service or feature name",
    "a behavior, alarm, or scaling action",
    "a comparison or when-to-use detail",
  ];

  let slot = 0;
  for (const type of fillTypes) {
    for (const chunk of chunkOrder) {
      if (questions.length >= target) break;
      const q = await generateFromChunk({
        chunk,
        type,
        ctx,
        distractorHints: hints,
        slot,
        focusHint: focusHints[slot % focusHints.length],
      });
      slot += 1;
      if (q) questions.push(q);
    }
  }

  const { kept, duplicatesDropped } = dedupeByPromptSimilarity(questions);
  if (duplicatesDropped > 0) {
    console.log(
      `Deduped ${duplicatesDropped} near-duplicate prompt(s) in module ${input.module}`,
    );
  }

  // Stable order for byte-identical JSON output.
  kept.sort((a, b) => a.id.localeCompare(b.id));

  if (kept.length < target) {
    console.log(
      `Module ${input.module}: ${kept.length}/${target} questions (not padding; words=${words}).`,
    );
  }

  return { questions: kept, rejects: ctx.rejects };
}

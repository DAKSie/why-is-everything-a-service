import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { env } from "../env.js";
import { normalizeServiceName } from "../ingest/validateQuestions.js";
import { ollamaChatJsonQueued } from "../ollamaQueue.js";
import { idLlmVerdictSchema, type IdLlmVerdict } from "./idVerdict.js";

const SYSTEM = `You grade short identification answers for an AWS Cloud Foundations quiz.
Compare the learner answer to the accepted answers using ONLY the evidence sentence as ground truth.
Return JSON: {"verdict":"correct"|"spelling_error"|"incorrect","confidence":0-1,"reason":"..."}.

Rules:
- A different AWS service or concept is "incorrect" even if the name looks similar (EBS≠EFS, ECS≠EKS, S3≠EBS).
- Only accept: clear spelling mistakes, abbreviation/naming variants (Amazon S3 ↔ S3), and clearly equivalent phrasings of the same concept.
- "spelling_error" = same concept with a typo; "correct" = equivalent phrasing/abbreviation; "incorrect" = wrong concept.
- Be strict. Temperature is 0; do not invent facts beyond the evidence.`;

function cachePath(questionId: string, normalizedAnswer: string): string {
  const h = createHash("sha256")
    .update(`${questionId}\n${normalizedAnswer}`)
    .digest("hex")
    .slice(0, 24);
  return path.join(env.rootDir, "data", "cache", "id-llm", `${h}.json`);
}

function readCache(p: string): IdLlmVerdict | null {
  try {
    if (!fs.existsSync(p)) return null;
    return idLlmVerdictSchema.parse(JSON.parse(fs.readFileSync(p, "utf8")));
  } catch {
    return null;
  }
}

function writeCache(p: string, v: IdLlmVerdict): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(v)}\n`, "utf8");
}

export async function llmCheckIdentification(input: {
  question: string;
  acceptedAnswers: string[];
  evidenceQuote?: string;
  userAnswer: string;
  questionId: string;
}): Promise<{ verdict: IdLlmVerdict | null; aiUnavailable: boolean }> {
  const norm = normalizeServiceName(input.userAnswer);
  const cpath = cachePath(input.questionId, norm);
  const cached = readCache(cpath);
  if (cached) return { verdict: cached, aiUnavailable: false };

  const user = `QUESTION: ${input.question}
ACCEPTED ANSWERS: ${input.acceptedAnswers.join(" | ")}
EVIDENCE: ${input.evidenceQuote ?? "(none)"}
USER ANSWER: ${input.userAnswer}`;

  const once = async (): Promise<IdLlmVerdict> => {
    const raw = await ollamaChatJsonQueued({
      system: SYSTEM,
      user,
      priority: "grade",
      temperature: 0,
      timeoutMs: 15_000,
    });
    return idLlmVerdictSchema.parse(raw);
  };

  try {
    let verdict: IdLlmVerdict;
    try {
      verdict = await once();
    } catch {
      verdict = await once(); // one retry on malformed / transient
    }
    writeCache(cpath, verdict);
    return { verdict, aiUnavailable: false };
  } catch {
    return { verdict: null, aiUnavailable: true };
  }
}

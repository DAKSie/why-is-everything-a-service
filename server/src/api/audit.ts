import { z } from "zod";
import { ollamaChatJsonQueued } from "../ollamaQueue.js";
import type { Question } from "../questions/schema.js";

const auditSchema = z.object({
  modelAnswer: z.string().min(1),
  agrees: z.boolean(),
  reason: z.string().min(1),
});

export async function auditQuestionFromEvidence(q: Question): Promise<{
  agrees: boolean;
  modelAnswer: string;
  reason: string;
  aiUnavailable?: boolean;
}> {
  const evidence = q.evidenceQuote ?? "";
  if (!evidence) {
    return {
      agrees: true,
      modelAnswer: "",
      reason: "No evidenceQuote to audit against",
    };
  }

  const expected =
    q.type === "multiple_choice"
      ? q.correctIndices.map((i) => q.options[i]).join("; ")
      : q.type === "identification"
        ? q.acceptedAnswers.join("; ")
        : q.type === "procedural"
          ? q.steps.join(" → ")
          : q.modelAnswer;

  const system = `You answer an AWS quiz question using ONLY the EVIDENCE sentence. Return JSON {"modelAnswer":"...","agrees":true|false,"reason":"..."}.
agrees=true if your answer matches the STORED ANSWER (same concept). agrees=false if they conflict.
Do not use outside knowledge.`;

  const user = `EVIDENCE: ${evidence}
QUESTION: ${q.prompt}${q.type === "situational" ? `\nSCENARIO: ${q.scenario}` : ""}
STORED ANSWER: ${expected}`;

  try {
    let raw: unknown;
    try {
      raw = await ollamaChatJsonQueued({
        system,
        user,
        priority: "grade",
        temperature: 0,
        timeoutMs: 20_000,
      });
    } catch {
      raw = await ollamaChatJsonQueued({
        system,
        user,
        priority: "grade",
        temperature: 0,
        timeoutMs: 20_000,
      });
    }
    const parsed = auditSchema.parse(raw);
    return parsed;
  } catch {
    return {
      agrees: true,
      modelAnswer: "",
      reason: "AI audit unavailable",
      aiUnavailable: true,
    };
  }
}

import { z } from "zod";
import { questionId } from "./ids.js";

export const moduleSchema = z.union([
  z.literal(6),
  z.literal(7),
  z.literal(8),
  z.literal(9),
  z.literal(10),
]);

export const sourceSchema = z.enum(["notes", "anki", "generated"]);

export const sourceRefSchema = z.object({
  file: z.string().min(1),
  heading: z.string().min(1),
});

const baseFields = {
  id: z.string().min(8).optional(),
  module: moduleSchema,
  topic: z.string().min(1),
  conceptTags: z.array(z.string().min(1)).min(1),
  difficulty: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  prompt: z.string().min(1),
  explanation: z.string().min(1),
  source: sourceSchema,
  sourceRef: sourceRefSchema,
  needsReview: z.boolean(),
  outdatedNote: z.string().min(1).optional(),
  evidenceQuote: z.string().min(1).optional(),
};

export const multipleChoiceSchema = z.object({
  ...baseFields,
  type: z.literal("multiple_choice"),
  options: z.array(z.string().min(1)).min(2),
  correctIndices: z.array(z.number().int().nonnegative()).min(1),
});

export const proceduralSchema = z.object({
  ...baseFields,
  type: z.literal("procedural"),
  steps: z.array(z.string().min(1)).min(2),
});

export const identificationSchema = z.object({
  ...baseFields,
  type: z.literal("identification"),
  acceptedAnswers: z.array(z.string().min(1)).min(1),
  aliases: z.array(z.string().min(1)).default([]),
});

export const rubricSchema = z.object({
  keyPoints: z.array(z.string().min(1)).min(1),
  mustMention: z.array(z.string().min(1)).default([]),
  commonMistakes: z.array(z.string().min(1)).default([]),
});

export const situationalSchema = z.object({
  ...baseFields,
  type: z.literal("situational"),
  scenario: z.string().min(1),
  rubric: rubricSchema,
  modelAnswer: z.string().min(1),
});

export const questionInputSchema = z
  .discriminatedUnion("type", [
    multipleChoiceSchema,
    proceduralSchema,
    identificationSchema,
    situationalSchema,
  ])
  .superRefine((q, ctx) => {
    if (q.needsReview && !q.outdatedNote) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "outdatedNote is required when needsReview is true",
        path: ["outdatedNote"],
      });
    }
    if (q.source === "generated" && !q.evidenceQuote) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "evidenceQuote is required when source is generated",
        path: ["evidenceQuote"],
      });
    }
    if (q.type === "multiple_choice") {
      for (const idx of q.correctIndices) {
        if (idx >= q.options.length) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `correctIndices value ${idx} is out of range for options length ${q.options.length}`,
            path: ["correctIndices"],
          });
        }
      }
    }
  });

export type QuestionInput = z.infer<typeof questionInputSchema>;

export type Question = QuestionInput & { id: string };

export const questionBankSchema = z.array(questionInputSchema).min(1);

export function parseQuestionBank(raw: unknown): Question[] {
  const inputs = questionBankSchema.parse(raw);
  return inputs.map((input) => {
    const id = questionId({
      source: input.source,
      sourceRef: input.sourceRef,
      prompt: input.prompt,
    });
    if (input.id && input.id !== id) {
      throw new Error(
        `Question id mismatch for prompt "${input.prompt.slice(0, 60)}…": expected ${id}, got ${input.id}`,
      );
    }
    return { ...input, id };
  });
}

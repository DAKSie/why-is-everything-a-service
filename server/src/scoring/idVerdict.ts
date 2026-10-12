import { z } from "zod";

export const idLlmVerdictSchema = z.object({
  verdict: z.enum(["correct", "spelling_error", "incorrect"]),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
});

export type IdLlmVerdict = z.infer<typeof idLlmVerdictSchema>;

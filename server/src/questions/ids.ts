import { createHash } from "node:crypto";

export function normalizePrompt(prompt: string): string {
  return prompt
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Final stable question id scheme (do not change without migrating attempts).
 *
 * Material (joined by `\n`, then SHA-256 hex truncated to 32 chars):
 *   1. source
 *   2. sourceRef.file
 *   3. sourceRef.heading
 *   4. normalizePrompt(promptMaterial)
 *
 * promptMaterial by type:
 *   - multiple_choice | identification | procedural → prompt only
 *   - situational → `${prompt}\n${scenario}`  (scenario required for uniqueness)
 *
 * Other fields (options, answers, explanation, evidence, rubric) are NOT hashed.
 */
export function questionId(input: {
  source: string;
  sourceRef: { file: string; heading: string };
  prompt: string;
  type?: string;
  scenario?: string;
}): string {
  const promptMaterial =
    input.type === "situational" && input.scenario
      ? `${input.prompt}\n${input.scenario}`
      : input.prompt;
  const material = [
    input.source,
    input.sourceRef.file,
    input.sourceRef.heading,
    normalizePrompt(promptMaterial),
  ].join("\n");
  return createHash("sha256").update(material, "utf8").digest("hex").slice(0, 32);
}

/** Id-input fields used for hashing (for tests / diagnostics). */
export function questionIdMaterial(input: {
  source: string;
  sourceRef: { file: string; heading: string };
  prompt: string;
  type?: string;
  scenario?: string;
}): string {
  const promptMaterial =
    input.type === "situational" && input.scenario
      ? `${input.prompt}\n${input.scenario}`
      : input.prompt;
  return [
    input.source,
    input.sourceRef.file,
    input.sourceRef.heading,
    normalizePrompt(promptMaterial),
  ].join("\n");
}

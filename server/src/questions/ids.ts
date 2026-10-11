import { createHash } from "node:crypto";

export function normalizePrompt(prompt: string): string {
  return prompt
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Stable id = hash(source + sourceRef + normalized prompt). */
export function questionId(input: {
  source: string;
  sourceRef: { file: string; heading: string };
  prompt: string;
}): string {
  const material = [
    input.source,
    input.sourceRef.file,
    input.sourceRef.heading,
    normalizePrompt(input.prompt),
  ].join("\n");
  return createHash("sha256").update(material, "utf8").digest("hex").slice(0, 32);
}

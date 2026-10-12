import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Bump when prompt templates change so old cache entries are ignored. */
export const PROMPT_TEMPLATE_VERSION = "v3";

export function chunkHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

export function cacheKey(parts: Record<string, string | number>): string {
  const material = Object.keys(parts)
    .sort()
    .map((k) => `${k}=${parts[k]}`)
    .join("|");
  return createHash("sha256").update(material, "utf8").digest("hex").slice(0, 32);
}

/**
 * Generation cache key: module + chunk hash + type + model + prompt-template version.
 * Optional variant (seed guid / slot) is folded into `type` so keys stay unique
 * without changing the required field set.
 */
export function generationCacheKey(input: {
  module: number;
  chunkHash: string;
  type: string;
  model: string;
  templateVersion?: string;
  variant?: string;
}): string {
  const type = input.variant ? `${input.type}::${input.variant}` : input.type;
  return cacheKey({
    module: input.module,
    chunkHash: input.chunkHash,
    type,
    model: input.model,
    templateVersion: input.templateVersion ?? PROMPT_TEMPLATE_VERSION,
  });
}

export function readCache<T>(cacheDir: string, key: string): T | null {
  const file = path.join(cacheDir, `${key}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export function writeCache(cacheDir: string, key: string, value: unknown): void {
  fs.mkdirSync(cacheDir, { recursive: true });
  const file = path.join(cacheDir, `${key}.json`);
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

export function logCache(hit: boolean, label: string): void {
  console.log(`[cache ${hit ? "hit" : "miss"}] ${label}`);
}

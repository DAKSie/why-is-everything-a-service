import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

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

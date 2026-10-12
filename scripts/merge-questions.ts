/**
 * Merge per-module question banks into data/questions.json (no LLM, no DB).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseQuestionBank } from "../server/src/questions/schema.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(rootDir, "data");

const modules = [6, 7, 8, 9, 10] as const;
const all = [];
for (const m of modules) {
  const p = path.join(dataDir, `questions-module-${m}.json`);
  if (!fs.existsSync(p)) {
    console.warn(`skip missing ${p}`);
    continue;
  }
  const part = parseQuestionBank(JSON.parse(fs.readFileSync(p, "utf8")));
  all.push(...part);
  console.log(`Module ${m}: ${part.length}`);
}

all.sort((a, b) => a.id.localeCompare(b.id));
const byId = new Map(all.map((q) => [q.id, q]));
const merged = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));

const out = path.join(dataDir, "questions.json");
fs.writeFileSync(out, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
console.log(`Wrote ${merged.length} questions → ${out}`);

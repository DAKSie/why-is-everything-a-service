import fs from "node:fs";
import path from "node:path";
import { env } from "../env.js";

export type AnswerOverride = {
  questionId: string;
  userAnswer: string;
  countedAs: "correct" | "incorrect";
  timestamp: string;
  previousScore: number;
  newScore: number;
};

function overridesPath(): string {
  return path.join(env.rootDir, "data", "review", "answer-overrides.json");
}

export function appendAnswerOverride(entry: AnswerOverride): void {
  const p = overridesPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  let list: AnswerOverride[] = [];
  if (fs.existsSync(p)) {
    try {
      list = JSON.parse(fs.readFileSync(p, "utf8")) as AnswerOverride[];
      if (!Array.isArray(list)) list = [];
    } catch {
      list = [];
    }
  }
  list.push(entry);
  fs.writeFileSync(p, `${JSON.stringify(list, null, 2)}\n`, "utf8");
}

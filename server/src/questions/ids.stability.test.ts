import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { questionId, questionIdMaterial } from "./ids.js";
import { parseQuestionBank, type Question } from "./schema.js";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const dataDir = path.join(rootDir, "data");

function loadBuiltBank(): Question[] {
  const merged = path.join(dataDir, "questions.json");
  if (fs.existsSync(merged)) {
    return parseQuestionBank(JSON.parse(fs.readFileSync(merged, "utf8")));
  }
  const parts: Question[] = [];
  for (const m of [6, 7, 8, 9, 10]) {
    const p = path.join(dataDir, `questions-module-${m}.json`);
    if (!fs.existsSync(p)) continue;
    parts.push(
      ...parseQuestionBank(JSON.parse(fs.readFileSync(p, "utf8"))),
    );
  }
  if (parts.length === 0) {
    throw new Error("No built question bank found under data/");
  }
  return parts.sort((a, b) => a.id.localeCompare(b.id));
}

describe("question id scheme (final)", () => {
  it("hashes source + sourceRef + normalized prompt; situational also hashes scenario", () => {
    const base = {
      source: "generated" as const,
      sourceRef: { file: "Module 6 Notes.md", heading: "Wrap-up" },
      prompt: "Given the following scenario, what should you do and why?",
    };
    const sitA = questionId({
      ...base,
      type: "situational",
      scenario: "Cost is high after migration. What next?",
    });
    const sitB = questionId({
      ...base,
      type: "situational",
      scenario: "Different scenario about Lambda limits.",
    });
    expect(sitA).not.toBe(sitB);

    const mc = questionId({
      ...base,
      type: "multiple_choice",
      prompt: "Which topic does this describe?\n\nRight size, then reserve",
    });
    const mcAgain = questionId({
      ...base,
      type: "multiple_choice",
      prompt: "Which topic does this describe?\n\nRight size, then reserve",
      scenario: "ignored for non-situational",
    });
    expect(mc).toBe(mcAgain);

    expect(questionIdMaterial({ ...base, type: "identification" })).toBe(
      ["generated", "Module 6 Notes.md", "Wrap-up", "given the following scenario what should you do and why"].join(
        "\n",
      ),
    );
  });

  it("fails if any id changes between two consecutive builds of the same bank", () => {
    const bank = loadBuiltBank();

    // Build 1 and build 2: recompute every id from fields (as build:questions does).
    const build1 = bank.map((q) =>
      questionId({
        source: q.source,
        sourceRef: q.sourceRef,
        prompt: q.prompt,
        type: q.type,
        scenario: q.type === "situational" ? q.scenario : undefined,
      }),
    );
    const build2 = bank.map((q) =>
      questionId({
        source: q.source,
        sourceRef: q.sourceRef,
        prompt: q.prompt,
        type: q.type,
        scenario: q.type === "situational" ? q.scenario : undefined,
      }),
    );

    expect(build1).toEqual(build2);

    // Stored ids must match the final scheme (orphan attempts if this drifts).
    for (let i = 0; i < bank.length; i += 1) {
      expect(bank[i]!.id, `mismatch at ${bank[i]!.id}`).toBe(build1[i]);
    }

    // Fingerprint of the whole bank: two consecutive fingerprints must match.
    const fingerprint = (ids: string[]) => ids.join("\n");
    expect(fingerprint(build1)).toBe(fingerprint(build2));
  });
});

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { questionId } from "./ids.js";
import {
  parseQuestionBank,
  questionInputSchema,
  questionBankSchema,
} from "./schema.js";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const samplePath = path.join(rootDir, "data", "sample-questions.json");

describe("question schemas", () => {
  it("accepts the shipped sample bank (20 questions, all types & modules)", () => {
    const raw = JSON.parse(fs.readFileSync(samplePath, "utf8")) as unknown;
    const questions = parseQuestionBank(raw);

    expect(questions).toHaveLength(20);
    expect(new Set(questions.map((q) => q.module))).toEqual(
      new Set([6, 7, 8, 9, 10]),
    );
    expect(new Set(questions.map((q) => q.type))).toEqual(
      new Set([
        "multiple_choice",
        "procedural",
        "identification",
        "situational",
      ]),
    );
    for (const q of questions) {
      expect(q.id).toMatch(/^[a-f0-9]{32}$/);
    }
  });

  it("requires outdatedNote when needsReview is true", () => {
    const result = questionInputSchema.safeParse({
      module: 9,
      topic: "AWS Well-Architected Framework",
      conceptTags: ["well-architected"],
      type: "identification",
      difficulty: 1,
      prompt: "How many pillars?",
      acceptedAnswers: ["5"],
      aliases: [],
      explanation: "Notes say five.",
      source: "notes",
      sourceRef: { file: "Module 9 Notes.md", heading: "Section 1" },
      needsReview: true,
    });
    expect(result.success).toBe(false);
  });

  it("requires evidenceQuote when source is generated", () => {
    const result = questionInputSchema.safeParse({
      module: 6,
      topic: "Amazon EC2",
      conceptTags: ["ec2"],
      type: "identification",
      difficulty: 1,
      prompt: "What is an AMI?",
      acceptedAnswers: ["Amazon Machine Image"],
      aliases: [],
      explanation: "From notes.",
      source: "generated",
      sourceRef: { file: "Module 6 Notes.md", heading: "Overview" },
      needsReview: false,
    });
    expect(result.success).toBe(false);
  });

  it("rejects out-of-range correctIndices", () => {
    const result = questionInputSchema.safeParse({
      module: 6,
      topic: "Compute",
      conceptTags: ["ec2"],
      type: "multiple_choice",
      difficulty: 1,
      prompt: "Pick one",
      options: ["A", "B"],
      correctIndices: [2],
      explanation: "Nope",
      source: "notes",
      sourceRef: { file: "Module 6 Notes.md", heading: "Section 1" },
      needsReview: false,
    });
    expect(result.success).toBe(false);
  });

  it("keeps stable ids across rebuilds for the same source material", () => {
    const raw = questionBankSchema.parse(
      JSON.parse(fs.readFileSync(samplePath, "utf8")),
    );
    const first = raw[0]!;
    const a = questionId(first);
    const b = questionId({
      source: first.source,
      sourceRef: first.sourceRef,
      prompt: `  ${first.prompt.toUpperCase()}  `,
    });
    expect(a).toBe(b);
  });
});

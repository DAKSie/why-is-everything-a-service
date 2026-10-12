import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAllModuleNotes } from "./notesParser.js";
import { buildTopicMultipleChoice } from "./topicMc.js";

const notesDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../notes",
);

describe("buildTopicMultipleChoice", () => {
  it("builds grounded which-topic questions from Module 7/8 notes", () => {
    const chunks = parseAllModuleNotes(notesDir).filter((c) =>
      [7, 8].includes(c.module),
    );
    const qs = buildTopicMultipleChoice(chunks);
    expect(qs.length).toBeGreaterThan(3);
    for (const q of qs.slice(0, 10)) {
      expect(q.type).toBe("multiple_choice");
      expect(q.prompt).toMatch(/which topic does this describe/i);
      expect(q.options.length).toBeGreaterThanOrEqual(3);
      expect(q.explanation).toMatch(/^Correct: .+\. From the notes:/);
      expect(q.evidenceQuote).toBeTruthy();
      // Ambiguity guard: answer must be one of the options
      expect(q.correctIndices.length).toBe(1);
      expect(q.options[q.correctIndices[0]!]).toBeTruthy();
    }
  });
});

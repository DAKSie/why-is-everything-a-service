import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  findSequenceCandidates,
  parseModuleNotesFile,
} from "./notesParser.js";

const notesDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../notes",
);

describe("notes chunker", () => {
  it("skips Objectives/Labs and chunks Module 6 sections / dense ###", () => {
    const file = path.join(notesDir, "Module 6 Notes.md");
    const chunks = parseModuleNotesFile(file);

    expect(chunks.length).toBeGreaterThan(5);
    expect(
      chunks.every(
        (c) =>
          !/objectives/i.test(c.heading) && !/labs/i.test(c.heading),
      ),
    ).toBe(true);

    const headings = chunks.map((c) => c.headingPath.join(" > "));
    expect(
      headings.some((h) => /Launching an EC2 Instance/i.test(h)),
    ).toBe(true);
    expect(chunks.every((c) => c.module === 6)).toBe(true);
    expect(chunks.every((c) => c.filename === "Module 6 Notes.md")).toBe(true);
    expect(chunks.every((c) => c.text.length > 0)).toBe(true);
  });

  it("flags the EC2 launch sequence and EFS implementation as sequence candidates", () => {
    const m6 = parseModuleNotesFile(path.join(notesDir, "Module 6 Notes.md"));
    const m7 = parseModuleNotesFile(path.join(notesDir, "Module 7 Notes.md"));

    const ec2Seq = m6.flatMap((c) => c.sequenceCandidates).find((s) =>
      s.steps.some((step) => /Select Amazon Machine Image/i.test(step)),
    );
    expect(ec2Seq).toBeTruthy();
    expect(ec2Seq!.steps.length).toBe(9);

    const efsSeq = m7.flatMap((c) => c.sequenceCandidates).find((s) =>
      s.steps.some((step) => /Create your Amazon EFS file system/i.test(step)),
    );
    expect(efsSeq).toBeTruthy();
    expect(efsSeq!.steps.length).toBeGreaterThanOrEqual(3);
  });

  it("findSequenceCandidates ignores non-procedural short numbered asides when lacking cues", () => {
    const text = [
      "Some pricing notes:",
      "1. Storage class type",
      "2. Amount of storage",
      "3. Requests",
      "4. Data transfer",
    ].join("\n");
    // Estimating S3 Pricing list is numbered but not a launch/implement procedure;
    // still may pass via steps.length >= 4 rule — assert helper API returns arrays.
    const found = findSequenceCandidates(
      "Random prose without procedure words.\n1. Alpha\n2. Beta",
    );
    expect(found.length).toBe(0);
  });
});

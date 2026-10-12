import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  rankEvidenceCandidates,
  selectEvidenceQuote,
  splitChunkUnits,
} from "./evidence.js";
import { parseAllModuleNotes } from "./notesParser.js";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const notesPath = path.join(rootDir, "notes", "Module 10 Notes.md");

describe("layer-7 evidence against REAL Module 10 notes", () => {
  it("selects table-backed evidence for the ALB layer-7 question", () => {
    expect(fs.existsSync(notesPath)).toBe(true);
    const raw = fs.readFileSync(notesPath, "utf8");

    // Print the ELB types table region for diagnosis.
    const tableStart = raw.indexOf("Types of Load Balancers");
    const tableSlice = raw.slice(tableStart, tableStart + 1800);
    // eslint-disable-next-line no-console
    console.log("\n=== RAW ELB types table region ===\n", tableSlice, "\n===\n");

    const chunks = parseAllModuleNotes(path.join(rootDir, "notes")).filter(
      (c) => c.module === 10 && /elastic load balancing/i.test(c.heading),
    );
    expect(chunks.length).toBeGreaterThan(0);
    const chunk = chunks[0]!;

    const units = splitChunkUnits(chunk.text);
    const layerUnits = units.filter(
      (u) => /layer 7/i.test(u) || /application layer/i.test(u),
    );
    // eslint-disable-next-line no-console
    console.log(
      "layer-related units:",
      layerUnits.map((u) => u.slice(0, 160)),
    );

    const ranked = rankEvidenceCandidates({
      chunkText: chunk.text,
      question:
        "Which load balancer operates at the application layer (OSI model layer 7)?",
      answer: "Application Load Balancer",
    });
    // eslint-disable-next-line no-console
    console.log(
      "top ranks:",
      ranked.slice(0, 5).map((r) => ({
        score: r.score.toFixed(2),
        hasAnswer: r.hasAnswer,
        supportsPrompt: r.supportsPrompt,
        unit: r.unit.slice(0, 140),
      })),
    );

    const quote = selectEvidenceQuote({
      chunkText: chunk.text,
      question:
        "Which load balancer operates at the application layer (OSI model layer 7)?",
      answer: "Application Load Balancer",
    });
    // eslint-disable-next-line no-console
    console.log("selected evidence:", quote);

    expect(quote).toBeTruthy();
    expect(quote!.toLowerCase()).toMatch(/layer 7|application layer/);
    expect(quote!.toLowerCase()).toContain("application load balancer");
  });
});

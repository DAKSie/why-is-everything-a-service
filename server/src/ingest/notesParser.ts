import fs from "node:fs";
import path from "node:path";
import { deriveConceptTags, type ConceptTag } from "./conceptTags.js";

export type SequenceCandidate = {
  label: string;
  steps: string[];
  startLine: number;
};

export type NoteChunk = {
  module: number;
  filename: string;
  headingPath: string[];
  heading: string;
  text: string;
  conceptTags: ConceptTag[];
  sequenceCandidates: SequenceCandidate[];
  wordCount: number;
};

type HeadingNode = {
  level: number;
  title: string;
  start: number; // line index of heading
  end: number; // exclusive line index
};

const SKIP_H2 =
  /^(objectives\s*\/\s*topics|labs\s*\/\s*activities|objectives|labs)$/i;

function cleanHeading(raw: string): string {
  return raw.replace(/\*\*/g, "").trim();
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Split step text glued by a missing space after a sentence period
 * (e.g. "file system.Create your mount targets" → two steps).
 */
export function splitGluedStepSentences(step: string): string[] {
  const parts = step
    .split(/(?<=\.)(?=[A-Z])/)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : [step.trim()];
}

/** Extract consecutive top-level numbered steps from chunk text. */
export function findSequenceCandidates(text: string): SequenceCandidate[] {
  const lines = text.split(/\r?\n/);
  const candidates: SequenceCandidate[] = [];
  let i = 0;

  while (i < lines.length) {
    const start = lines[i]!.match(/^1\.\s+(.+)$/);
    if (!start) {
      i += 1;
      continue;
    }

    const startLine = i + 1;
    const steps: string[] = [];
    let expected = 1;

    while (i < lines.length) {
      const stepMatch = lines[i]!.match(/^(\d+)\.\s+(.+)$/);
      if (stepMatch) {
        const n = Number(stepMatch[1]);
        if (n !== expected) break;
        steps.push(...splitGluedStepSentences(stepMatch[2]!.trim()));
        expected += 1;
        i += 1;
        continue;
      }

      const line = lines[i]!;
      // Allow blank lines / indented detail under the current step.
      if (line.trim() === "" || /^\s+/.test(line)) {
        i += 1;
        continue;
      }
      break;
    }

    if (steps.length >= 2 && looksLikeOrderedProcedure(steps, text)) {
      candidates.push({
        label: steps[0]!.slice(0, 80),
        steps,
        startLine,
      });
    }
  }

  return candidates;
}

function looksLikeOrderedProcedure(steps: string[], surrounding: string): boolean {
  const context = surrounding.toLowerCase();
  const proceduralCue =
    /\b(steps?|launch|wizard|implementation|order|sequence|decisions to make|create your)\b/i.test(
      surrounding,
    );
  const actiony = steps.filter((s) =>
    /^(select|specify|attach|add|identify|create|connect|verify|configure|launch|scale)\b/i.test(
      s,
    ),
  ).length;
  // Real procedures only: prose cues (launch/implement/steps) and/or majority action verbs.
  // Avoid flagging numbered taxonomies (e.g. S3 pricing estimate factors).
  return (
    (proceduralCue && steps.length >= 2) ||
    (actiony >= Math.ceil(steps.length * 0.5) && steps.length >= 2)
  );
}

function parseHeadings(lines: string[]): HeadingNode[] {
  const headings: HeadingNode[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i]!.match(/^(#{1,4})\s+(.+)$/);
    if (!m) continue;
    headings.push({
      level: m[1]!.length,
      title: cleanHeading(m[2]!),
      start: i,
      end: lines.length,
    });
  }
  for (let i = 0; i < headings.length; i += 1) {
    const cur = headings[i]!;
    for (let j = i + 1; j < headings.length; j += 1) {
      if (headings[j]!.level <= cur.level) {
        cur.end = headings[j]!.start;
        break;
      }
    }
  }
  return headings;
}

function bodyBetween(lines: string[], startLine: number, endLine: number): string {
  // Exclude the heading line itself.
  return lines
    .slice(startLine + 1, endLine)
    .join("\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .trim();
}

function moduleFromFilename(filename: string): number | null {
  const m = filename.match(/Module\s+(\d+)\s+Notes\.md$/i);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 6 && n <= 10 ? n : null;
}

/**
 * Parse a module notes markdown file into topic chunks.
 * Chunks = ## Section… ; split further into ### when a section is dense.
 */
export function parseModuleNotesFile(filePath: string): NoteChunk[] {
  const filename = path.basename(filePath);
  const module = moduleFromFilename(filename);
  if (module === null) {
    throw new Error(`Not a Modules 6–10 notes file: ${filename}`);
  }

  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.split(/\r?\n/);
  const headings = parseHeadings(lines);
  const h1 = headings.find((h) => h.level === 1);
  const moduleTitle = h1?.title ?? `Module ${module}`;

  const sectionH2s = headings.filter(
    (h) =>
      h.level === 2 &&
      /^section\b/i.test(h.title) &&
      !SKIP_H2.test(h.title),
  );

  const chunks: NoteChunk[] = [];

  for (const section of sectionH2s) {
    const childH3s = headings.filter(
      (h) =>
        h.level === 3 && h.start > section.start && h.start < section.end,
    );

    const dense =
      childH3s.length >= 2 &&
      childH3s.some(
        (h) => wordCount(bodyBetween(lines, h.start, h.end)) >= 40,
      );

    if (dense) {
      for (const h3 of childH3s) {
        const text = bodyBetween(lines, h3.start, h3.end);
        if (wordCount(text) < 15) continue;
        pushChunk(chunks, {
          module,
          filename,
          headingPath: [moduleTitle, section.title, h3.title],
          text,
        });
      }

      // Leading prose under the ## before the first ### (if substantial).
      const firstH3 = childH3s[0]!;
      const lead = bodyBetween(lines, section.start, firstH3.start);
      if (wordCount(lead) >= 30) {
        pushChunk(chunks, {
          module,
          filename,
          headingPath: [moduleTitle, section.title],
          text: lead,
        });
      }
    } else {
      const text = bodyBetween(lines, section.start, section.end);
      if (wordCount(text) < 15) continue;
      pushChunk(chunks, {
        module,
        filename,
        headingPath: [moduleTitle, section.title],
        text,
      });
    }
  }

  return chunks;
}

function pushChunk(
  chunks: NoteChunk[],
  input: {
    module: number;
    filename: string;
    headingPath: string[];
    text: string;
  },
): void {
  const heading = input.headingPath[input.headingPath.length - 1]!;
  const conceptTags = deriveConceptTags(...input.headingPath, input.text);
  const sequenceCandidates = findSequenceCandidates(input.text);
  chunks.push({
    module: input.module,
    filename: input.filename,
    headingPath: input.headingPath,
    heading,
    text: input.text,
    conceptTags,
    sequenceCandidates,
    wordCount: wordCount(input.text),
  });
}

export function parseAllModuleNotes(notesDir: string): NoteChunk[] {
  const files = [6, 7, 8, 9, 10].map((n) =>
    path.join(notesDir, `Module ${n} Notes.md`),
  );
  const chunks: NoteChunk[] = [];
  for (const file of files) {
    if (!fs.existsSync(file)) {
      throw new Error(`Missing notes file: ${file}`);
    }
    chunks.push(...parseModuleNotesFile(file));
  }
  return chunks;
}

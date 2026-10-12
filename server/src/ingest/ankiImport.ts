import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import Database from "better-sqlite3";
import { normalizePrompt } from "../questions/ids.js";
import type { QuestionInput } from "../questions/schema.js";
import { moduleFromAnkiTags } from "./ankiTags.js";
import { deriveConceptTags } from "./conceptTags.js";
import { stripHtml } from "./html.js";
import { detectOutdated } from "./outdated.js";
import { distance } from "fastest-levenshtein";

export type SkippedAnkiCard = {
  guid: string;
  module: number | null;
  reason: string;
  frontPreview: string;
  front: string;
  back: string;
};

/** Skipped Module 6–10 cards used as LLM generation seeds (answer = ground truth). */
export type AnkiSeedCard = {
  guid: string;
  module: number;
  front: string;
  back: string;
  reason: string;
};

export type AnkiImportResult = {
  imported: QuestionInput[];
  skipped: SkippedAnkiCard[];
  /** Skipped in-scope cards with full fields for Step 4 generation. */
  seeds: AnkiSeedCard[];
  duplicatesDropped: number;
};

const APKG_FILENAME = "AWS Cloud Practitioner - Anki Deck.apkg";

function topicForModule(module: number): string {
  const topics: Record<number, string> = {
    6: "Compute",
    7: "Storage",
    8: "Databases",
    9: "Cloud Architecture",
    10: "Automatic Scaling and Monitoring",
  };
  return topics[module] ?? `Module ${module}`;
}

function isTrueFalseQuestion(front: string): boolean {
  return /\btrue\s+or\s+false\b/i.test(front);
}

function parseTrueFalseAnswer(back: string): boolean | null {
  const first = back.trim().split(/\r?\n/)[0]?.trim() ?? "";
  if (/^true\b/i.test(first)) return true;
  if (/^false\b/i.test(first)) return false;
  return null;
}

function isShortAnswer(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 80) return false;
  if (/\n/.test(t)) return false;
  if ((t.match(/•/g) ?? []).length >= 2) return false;
  // Multi-bullet compact lists often still contain " - " separators.
  if ((t.match(/\s-\s/g) ?? []).length >= 2) return false;
  return true;
}

function looksLikeQuestion(front: string): boolean {
  return /(\?$|^(what|which|who|when|where|why|how|name|list|true or false)\b)/i.test(
    front.trim(),
  );
}

function mapAnkiNote(input: {
  guid: string;
  module: number;
  front: string;
  back: string;
}): { question: QuestionInput } | { skip: string } {
  const { guid, module, front, back } = input;
  const sourceRef = {
    file: APKG_FILENAME,
    heading: `anki:${guid}`,
  };
  const derived = deriveConceptTags(front, back, topicForModule(module));
  const fallbackTag: Record<number, string> = {
    6: "ec2",
    7: "s3",
    8: "rds",
    9: "well-architected",
    10: "elb",
  };
  const conceptTags =
    derived.length > 0 ? derived : [fallbackTag[module] ?? "ec2"];

  const base = {
    module: module as 6 | 7 | 8 | 9 | 10,
    topic: topicForModule(module),
    conceptTags,
    difficulty: 1 as const,
    explanation: back,
    source: "anki" as const,
    sourceRef,
    needsReview: false,
  };

  if (!front.trim()) return { skip: "empty front field after HTML strip" };
  if (!back.trim()) return { skip: "empty back field after HTML strip" };

  if (isTrueFalseQuestion(front)) {
    const tf = parseTrueFalseAnswer(back);
    if (tf === null) {
      return { skip: "true/false question but answer is not clearly True or False" };
    }
    return {
      question: {
        ...base,
        type: "multiple_choice",
        prompt: front,
        options: ["True", "False"],
        correctIndices: [tf ? 0 : 1],
      },
    };
  }

  if (isShortAnswer(back) && looksLikeQuestion(front)) {
    return {
      question: {
        ...base,
        type: "identification",
        prompt: front,
        acceptedAnswers: [back.trim()],
        aliases: [],
      },
    };
  }

  // Definition on front, term on back (reversed basic card style).
  if (isShortAnswer(back) && !looksLikeQuestion(front) && front.length >= 20) {
    return {
      question: {
        ...base,
        type: "identification",
        prompt: `Which term matches this description?\n\n${front}`,
        acceptedAnswers: [back.trim()],
        aliases: [],
      },
    };
  }

  if (!isShortAnswer(back)) {
    return {
      skip: "answer not a short term / T-F; mapping would invent structure or distractors",
    };
  }

  return { skip: "could not confidently map card to a supported question type" };
}

export function similarPrompt(a: string, b: string): boolean {
  const na = normalizePrompt(a);
  const nb = normalizePrompt(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen < 12) return na === nb;
  const dist = distance(na, nb);
  return dist / maxLen <= 0.12;
}

export function dedupeByPromptSimilarity<T extends { prompt: string }>(
  items: T[],
  /** Optional: compare a richer string (e.g. prompt+scenario for situational). */
  textOf: (item: T) => string = (item) => item.prompt,
): { kept: T[]; duplicatesDropped: number } {
  const kept: T[] = [];
  let duplicatesDropped = 0;
  for (const item of items) {
    const text = textOf(item);
    if (kept.some((k) => similarPrompt(textOf(k), text))) {
      duplicatesDropped += 1;
      continue;
    }
    kept.push(item);
  }
  return { kept, duplicatesDropped };
}

/**
 * Import Modules 6–10 Anki notes. Never modifies the original .apkg.
 * Opens SQLite from a temp copy in read-only mode.
 */
export function importAnkiDeck(apkgPath: string): AnkiImportResult {
  if (!fs.existsSync(apkgPath)) {
    throw new Error(`Anki deck not found: ${apkgPath}`);
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ihateaws-anki-"));
  try {
    const zip = new AdmZip(apkgPath);
    zip.extractAllTo(tmpRoot, true);

    const extractedDb = [
      path.join(tmpRoot, "collection.anki21"),
      path.join(tmpRoot, "collection.anki2"),
    ].find((p) => fs.existsSync(p));

    if (!extractedDb) {
      throw new Error("No collection.anki2 / collection.anki21 inside .apkg");
    }

    const readonlyCopy = path.join(tmpRoot, "collection.readonly.sqlite");
    fs.copyFileSync(extractedDb, readonlyCopy);

    const db = new Database(readonlyCopy, { readonly: true, fileMustExist: true });
    try {
      const rows = db
        .prepare(`SELECT guid, tags, flds FROM notes`)
        .all() as Array<{ guid: string; tags: string; flds: string }>;

      const importedRaw: QuestionInput[] = [];
      const skipped: SkippedAnkiCard[] = [];
      const seeds: AnkiSeedCard[] = [];

      for (const row of rows) {
        const module = moduleFromAnkiTags(row.tags ?? "");
        const fields = (row.flds ?? "").split("\x1f");
        const front = stripHtml(fields[0] ?? "");
        const back = stripHtml(fields[1] ?? "");
        const preview = front.slice(0, 100);

        if (module === null) {
          // Out of scope (Modules 1–5 or untagged) — do not list every one;
          // only skip-log cards that looked like 6–10 but failed multi-tag ambiguity.
          if (/\bModule-([6-9]|10)\b/i.test(row.tags ?? "")) {
            skipped.push({
              guid: row.guid,
              module: null,
              reason: "ambiguous or invalid Module-6..10 tag set",
              frontPreview: preview,
              front,
              back,
            });
          }
          continue;
        }

        const mapped = mapAnkiNote({
          guid: row.guid,
          module,
          front,
          back,
        });

        if ("skip" in mapped) {
          skipped.push({
            guid: row.guid,
            module,
            reason: mapped.skip,
            frontPreview: preview,
            front,
            back,
          });
          seeds.push({
            guid: row.guid,
            module,
            front,
            back,
            reason: mapped.skip,
          });
          continue;
        }

        const q = mapped.question;
        const outdated = detectOutdated(q.prompt, q.explanation, front, back);
        if (outdated.needsReview) {
          q.needsReview = true;
          q.outdatedNote = outdated.outdatedNote;
        }

        importedRaw.push(q);
      }

      const { kept, duplicatesDropped } = dedupeByPromptSimilarity(importedRaw);
      return { imported: kept, skipped, seeds, duplicatesDropped };
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

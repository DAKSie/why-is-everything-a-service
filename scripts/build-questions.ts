/**
 * Build question bank via notes + Anki + Ollama.
 * Pilot: npm run build:questions -- --module 10
 * Optional: --model qwen2.5:14b-instruct
 * Does NOT write to SQLite / seed the DB.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importAnkiDeck } from "../server/src/ingest/ankiImport.js";
import { buildModuleQuestions } from "../server/src/ingest/generate.js";
import { parseAllModuleNotes } from "../server/src/ingest/notesParser.js";
import {
  assertOllamaReady,
  OllamaUnavailableError,
} from "../server/src/ingest/ollamaClient.js";
import { env } from "../server/src/env.js";
import type { Question } from "../server/src/questions/schema.js";
import { parseQuestionBank } from "../server/src/questions/schema.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const notesDir = path.join(rootDir, "notes");
const dataDir = path.join(rootDir, "data");
const cacheDir = path.join(dataDir, "cache");
const reviewDir = path.join(dataDir, "review");
const apkgPath = path.join(notesDir, "AWS Cloud Practitioner - Anki Deck.apkg");

function parseArgs(argv: string[]): { module: number | null; model: string } {
  let module: number | null = null;
  let model = env.ollamaModel;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--module") {
      const n = Number(argv[i + 1]);
      if (![6, 7, 8, 9, 10].includes(n)) {
        throw new Error(`--module must be 6–10, got: ${argv[i + 1]}`);
      }
      module = n;
      i += 1;
    } else if (argv[i] === "--model") {
      const m = argv[i + 1];
      if (!m) throw new Error("--model requires a value");
      model = m;
      i += 1;
    }
  }
  return { module, model };
}

function formatAnswer(q: Question): string {
  switch (q.type) {
    case "multiple_choice":
      return q.correctIndices.map((i) => q.options[i]).join("; ");
    case "identification":
      return q.acceptedAnswers.join(" | ");
    case "procedural":
      return q.steps.map((s, i) => `${i + 1}. ${s}`).join(" → ");
    case "situational":
      return q.modelAnswer;
    default:
      return "";
  }
}

function writeReviewMarkdown(input: {
  module: number;
  model: string;
  questions: Question[];
  rejects: Array<{
    stage: string;
    module: number;
    type?: string;
    reason: string;
    detail?: string;
    sourceRef?: { file: string; heading: string };
  }>;
  outPath: string;
}): void {
  const lines: string[] = [];
  lines.push(`# Module ${input.module} — question review`);
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Model: ${input.model}`);
  lines.push(`Questions: ${input.questions.length}`);
  lines.push(`Rejects: ${input.rejects.length}`);
  lines.push("");
  lines.push("## Questions");
  lines.push("");

  input.questions.forEach((q, idx) => {
    lines.push(
      `### ${idx + 1}. [${q.type}] ${q.prompt.replace(/\n/g, " ").slice(0, 120)}`,
    );
    lines.push("");
    lines.push(`- **id:** \`${q.id}\``);
    lines.push(`- **topic:** ${q.topic}`);
    lines.push(`- **source:** ${q.source}`);
    lines.push(
      `- **sourceRef:** ${q.sourceRef.file} → ${q.sourceRef.heading}`,
    );
    lines.push(
      `- **needsReview:** ${q.needsReview}${q.outdatedNote ? ` — ${q.outdatedNote}` : ""}`,
    );
    lines.push(`- **answer:** ${formatAnswer(q)}`);
    if (q.evidenceQuote) {
      lines.push(`- **evidenceQuote:** ${q.evidenceQuote}`);
    } else {
      lines.push(`- **evidenceQuote:** _(none)_`);
    }
    lines.push(`- **explanation:** ${q.explanation}`);
    lines.push("");
  });

  lines.push("## Rejects");
  lines.push("");
  if (input.rejects.length === 0) {
    lines.push("_No rejects._");
  } else {
    for (const r of input.rejects) {
      lines.push(
        `- **${r.stage}**${r.type ? ` / ${r.type}` : ""}: ${r.reason}${r.detail ? ` — ${r.detail}` : ""}${r.sourceRef ? ` (${r.sourceRef.file} → ${r.sourceRef.heading})` : ""}`,
      );
    }
  }
  lines.push("");

  fs.mkdirSync(path.dirname(input.outPath), { recursive: true });
  fs.writeFileSync(input.outPath, lines.join("\n"), "utf8");
}

async function main(): Promise<void> {
  const { module, model } = parseArgs(process.argv.slice(2));
  if (module === null) {
    console.error(
      "Pilot mode required for now. Example:\n  npm run build:questions -- --module 10\n  npm run build:questions -- --module 10 --model qwen2.5:14b-instruct",
    );
    process.exit(1);
  }

  try {
    await assertOllamaReady(model);
  } catch (err) {
    if (err instanceof OllamaUnavailableError) {
      console.error(`\nERROR: ${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }

  console.log(`Building Module ${module} only (no DB writes)…`);
  console.log(`Ollama: ${env.ollamaBaseUrl} · model ${model}`);

  const allChunks = parseAllModuleNotes(notesDir).filter((c) => c.module === module);
  const anki = importAnkiDeck(apkgPath);
  const directAnki = anki.imported.filter((q) => q.module === module);
  const seeds = anki.seeds.filter((s) => s.module === module);

  console.log(
    `Chunks: ${allChunks.length} · direct Anki: ${directAnki.length} · Anki seeds: ${seeds.length}`,
  );

  const { questions, rejects } = await buildModuleQuestions({
    module,
    chunks: allChunks,
    directAnki,
    seeds,
    cacheDir,
    model,
  });

  const validated = parseQuestionBank(questions).sort((a, b) =>
    a.id.localeCompare(b.id),
  );

  const jsonPath = path.join(dataDir, `questions-module-${module}.json`);
  const reviewPath = path.join(reviewDir, `module-${module}.md`);
  const rejectLogPath = path.join(dataDir, `rejects-module-${module}.json`);

  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(reviewDir, { recursive: true });
  const jsonBody = `${JSON.stringify(validated, null, 2)}\n`;
  fs.writeFileSync(jsonPath, jsonBody, "utf8");
  fs.writeFileSync(rejectLogPath, `${JSON.stringify(rejects, null, 2)}\n`, "utf8");
  writeReviewMarkdown({
    module,
    model,
    questions: validated,
    rejects,
    outPath: reviewPath,
  });

  const byType: Record<string, number> = {};
  for (const q of validated) {
    byType[q.type] = (byType[q.type] ?? 0) + 1;
  }

  console.log("\n=== Module build summary ===");
  console.log(`Module: ${module}`);
  console.log(`Model: ${model}`);
  console.log(`Questions written: ${validated.length}`);
  console.log(`Per type:`, byType);
  console.log(`Rejects: ${rejects.length}`);
  console.log(`JSON: ${jsonPath}`);
  console.log(`Review: ${reviewPath}`);
  console.log(`Reject log: ${rejectLogPath}`);
  console.log("DB: not modified (pilot).");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

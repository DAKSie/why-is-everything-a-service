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
import {
  defaultDecisionsPath,
  loadDecisions,
} from "../server/src/ingest/decisions.js";
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

function parseArgs(argv: string[]): { modules: number[]; model: string } {
  const modules: number[] = [];
  let model = env.ollamaModel;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--module") {
      const n = Number(argv[i + 1]);
      if (![6, 7, 8, 9, 10].includes(n)) {
        throw new Error(`--module must be 6–10, got: ${argv[i + 1]}`);
      }
      modules.push(n);
      i += 1;
    } else if (argv[i] === "--modules") {
      const raw = argv[i + 1] ?? "";
      for (const part of raw.split(",")) {
        const n = Number(part.trim());
        if (![6, 7, 8, 9, 10].includes(n)) {
          throw new Error(`--modules entries must be 6–10, got: ${part}`);
        }
        modules.push(n);
      }
      i += 1;
    } else if (argv[i] === "--model") {
      const m = argv[i + 1];
      if (!m) throw new Error("--model requires a value");
      model = m;
      i += 1;
    }
  }
  return { modules: [...new Set(modules)], model };
}

/** Short file tag for non-default models, e.g. qwen2.5:14b-instruct → 14b */
export function modelOutputTag(model: string, defaultModel = env.ollamaModel): string | null {
  if (model === defaultModel) return null;
  const m = model.match(/(\d+b)/i);
  if (m) return m[1]!.toLowerCase();
  return model.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
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
    question?: string;
    storedAnswer?: string;
    verifierAnswer?: string;
    evidenceQuote?: string;
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
    if (q.type === "situational") {
      lines.push(`- **scenario:** ${q.scenario}`);
      lines.push(`- **modelAnswer:** ${q.modelAnswer}`);
      lines.push(`- **keyPoints:** ${q.rubric.keyPoints.join("; ") || "_(none)_"}`);
      lines.push(
        `- **mustMention:** ${q.rubric.mustMention.join("; ") || "_(none)_"}`,
      );
      if (q.rubric.commonMistakes.length > 0) {
        lines.push(
          `- **commonMistakes:** ${q.rubric.commonMistakes.join("; ")}`,
        );
      }
    }
    if (q.outdatedNote) {
      lines.push(`- **outdatedNote:** ${q.outdatedNote}`);
    }
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
      if (r.question) lines.push(`  - question: ${r.question.replace(/\n/g, " ")}`);
      if (r.storedAnswer) lines.push(`  - storedAnswer: ${r.storedAnswer}`);
      if (r.verifierAnswer) lines.push(`  - verifierAnswer: ${r.verifierAnswer}`);
      if (r.evidenceQuote) lines.push(`  - evidenceQuote: ${r.evidenceQuote}`);
    }
  }
  lines.push("");

  fs.mkdirSync(path.dirname(input.outPath), { recursive: true });
  fs.writeFileSync(input.outPath, lines.join("\n"), "utf8");
}

type ModuleSummary = {
  module: number;
  byType: Record<string, number>;
  rejects: number;
  rejectReasons: Record<string, number>;
  elapsedMs: number;
  reviewPath: string;
};

async function buildOneModule(input: {
  module: number;
  model: string;
  decisions: ReturnType<typeof loadDecisions>;
  allNotesChunks: ReturnType<typeof parseAllModuleNotes>;
  anki: ReturnType<typeof importAnkiDeck>;
}): Promise<ModuleSummary> {
  const { module, model } = input;
  const allChunks = input.allNotesChunks.filter((c) => c.module === module);
  const directAnki = input.anki.imported.filter((q) => q.module === module);
  const seeds = input.anki.seeds.filter((s) => s.module === module);

  console.log(
    `\n--- Module ${module} --- chunks=${allChunks.length} anki=${directAnki.length} seeds=${seeds.length}`,
  );

  const started = Date.now();
  const { questions, rejects } = await buildModuleQuestions({
    module,
    chunks: allChunks,
    directAnki,
    seeds,
    cacheDir,
    model,
    decisions: input.decisions,
  });
  const elapsedMs = Date.now() - started;

  const validated = parseQuestionBank(questions).sort((a, b) =>
    a.id.localeCompare(b.id),
  );

  const tag = modelOutputTag(model);
  const suffix = tag ? `.${tag}` : "";
  const jsonPath = path.join(dataDir, `questions-module-${module}${suffix}.json`);
  const reviewPath = path.join(reviewDir, `module-${module}${suffix}.md`);
  const rejectLogPath = path.join(dataDir, `rejects-module-${module}${suffix}.json`);

  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(reviewDir, { recursive: true });
  fs.writeFileSync(jsonPath, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
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
  const rejectReasons: Record<string, number> = {};
  for (const r of rejects) {
    const key = r.reason.split(":")[0]!.slice(0, 80);
    rejectReasons[key] = (rejectReasons[key] ?? 0) + 1;
  }

  console.log(
    `Module ${module}: kept=${validated.length} types=${JSON.stringify(byType)} rejects=${rejects.length} (${(elapsedMs / 1000).toFixed(1)}s)`,
  );
  console.log(`Review: ${reviewPath}`);

  return {
    module,
    byType,
    rejects: rejects.length,
    rejectReasons,
    elapsedMs,
    reviewPath,
  };
}

async function main(): Promise<void> {
  const { modules, model } = parseArgs(process.argv.slice(2));
  if (modules.length === 0) {
    console.error(
      "Example:\n  npm run build:questions -- --module 10\n  npm run build:questions -- --modules 6,7,8,9,10",
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

  console.log(`Building module(s) ${modules.join(", ")} (no DB writes)…`);
  console.log(`Ollama: ${env.ollamaBaseUrl} · model ${model}`);

  const allNotesChunks = parseAllModuleNotes(notesDir);
  const anki = importAnkiDeck(apkgPath);
  const decisionsPath = defaultDecisionsPath(dataDir);
  const decisions = loadDecisions(decisionsPath);
  console.log(
    `Human decisions: ${Object.keys(decisions).length} entries (${decisionsPath})`,
  );

  const summaries: ModuleSummary[] = [];
  for (const module of modules) {
    summaries.push(
      await buildOneModule({
        module,
        model,
        decisions,
        allNotesChunks,
        anki,
      }),
    );
  }

  console.log("\n=== Per-module summary ===");
  console.log(
    "| Module | MC | ID | Sit | Proc | Total | Rejects | Top reject reasons |",
  );
  console.log("|---|---:|---:|---:|---:|---:|---:|---|");
  for (const s of summaries) {
    const reasons = Object.entries(s.rejectReasons)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([r, n]) => `${r} (${n})`)
      .join("; ");
    console.log(
      `| ${s.module} | ${s.byType.multiple_choice ?? 0} | ${s.byType.identification ?? 0} | ${s.byType.situational ?? 0} | ${s.byType.procedural ?? 0} | ${Object.values(s.byType).reduce((a, b) => a + b, 0)} | ${s.rejects} | ${reasons || "—"} |`,
    );
  }

  // Diagnostics: sample Module 6 "no evidence" rejects with best-matching unit.
  const m6RejectPath = path.join(dataDir, "rejects-module-6.json");
  if (fs.existsSync(m6RejectPath)) {
    const rejects = JSON.parse(fs.readFileSync(m6RejectPath, "utf8")) as Array<{
      reason: string;
      question?: string;
      detail?: string;
      storedAnswer?: string;
    }>;
    const evidenceRejects = rejects.filter((r) => /no evidence/i.test(r.reason));
    const withDetail = evidenceRejects.filter((r) => r.detail);
    const samples = (withDetail.length >= 5 ? withDetail : evidenceRejects).slice(
      0,
      5,
    );
    if (samples.length > 0) {
      console.log("\n=== Diagnostics: Module 6 'no evidence' samples ===");
      for (const s of samples) {
        console.log(`- Q: ${(s.question ?? "").replace(/\n/g, " ").slice(0, 100)}`);
        console.log(`  answer: ${s.storedAnswer ?? ""}`);
        console.log(`  best: ${s.detail ?? "(no rank)"}`);
      }
    }
  }

  // Module 9 schema failures (empty conceptTags was the common cause).
  const m9RejectPath = path.join(dataDir, "rejects-module-9.json");
  if (fs.existsSync(m9RejectPath)) {
    const rejects = JSON.parse(fs.readFileSync(m9RejectPath, "utf8")) as Array<{
      reason: string;
      detail?: string;
      question?: string;
      sourceRef?: { heading?: string };
    }>;
    const schemaFails = rejects.filter((r) => /schema|zod|Array must contain/i.test(r.reason));
    if (schemaFails.length > 0) {
      console.log("\n=== Diagnostics: Module 9 schema failures ===");
      console.log(
        `Count: ${schemaFails.length}. Typical: empty conceptTags ("Array must contain at least 1 element(s)").`,
      );
      for (const s of schemaFails.slice(0, 4)) {
        console.log(
          `- ${s.reason}${s.sourceRef?.heading ? ` @ ${s.sourceRef.heading}` : ""}${s.question ? ` — ${s.question.slice(0, 80)}` : ""}`,
        );
      }
    }
  }

  // Merge per-module banks into data/questions.json when building a full set.
  if (new Set(modules).size >= 5) {
    const merged: Question[] = [];
    for (const m of [6, 7, 8, 9, 10] as const) {
      const p = path.join(dataDir, `questions-module-${m}.json`);
      if (!fs.existsSync(p)) continue;
      merged.push(...parseQuestionBank(JSON.parse(fs.readFileSync(p, "utf8"))));
    }
    merged.sort((a, b) => a.id.localeCompare(b.id));
    const byId = new Map(merged.map((q) => [q.id, q]));
    const unique = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
    const out = path.join(dataDir, "questions.json");
    fs.writeFileSync(out, `${JSON.stringify(unique, null, 2)}\n`, "utf8");
    console.log(`Merged bank: ${unique.length} → ${out}`);
  }

  console.log("DB: not modified (seed on server start).");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

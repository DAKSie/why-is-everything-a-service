/**
 * Step 3 dry-run: parse notes + import Anki. No database writes.
 * Usage: npm run dry-run:ingest
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importAnkiDeck } from "../server/src/ingest/ankiImport.js";
import { parseAllModuleNotes } from "../server/src/ingest/notesParser.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const notesDir = path.join(rootDir, "notes");
const apkgPath = path.join(
  notesDir,
  "AWS Cloud Practitioner - Anki Deck.apkg",
);

const chunks = parseAllModuleNotes(notesDir);
const anki = importAnkiDeck(apkgPath);

const chunksPerModule: Record<number, number> = {};
const sequences: Array<{
  module: number;
  heading: string;
  filename: string;
  steps: string[];
}> = [];

for (const chunk of chunks) {
  chunksPerModule[chunk.module] = (chunksPerModule[chunk.module] ?? 0) + 1;
  for (const seq of chunk.sequenceCandidates) {
    sequences.push({
      module: chunk.module,
      heading: chunk.headingPath.join(" > "),
      filename: chunk.filename,
      steps: seq.steps,
    });
  }
}

const ankiPerModule: Record<number, number> = {};
const ankiPerType: Record<string, number> = {};
for (const q of anki.imported) {
  ankiPerModule[q.module] = (ankiPerModule[q.module] ?? 0) + 1;
  ankiPerType[q.type] = (ankiPerType[q.type] ?? 0) + 1;
}

const report = {
  notes: {
    chunksTotal: chunks.length,
    chunksPerModule,
    sequenceCandidates: sequences,
    sequenceCandidateCount: sequences.length,
  },
  anki: {
    importedTotal: anki.imported.length,
    duplicatesDropped: anki.duplicatesDropped,
    importedPerModule: ankiPerModule,
    importedPerType: ankiPerType,
    skippedCount: anki.skipped.length,
    skipped: anki.skipped,
  },
  dbWrites: false,
};

console.log(JSON.stringify(report, null, 2));

console.log("\n=== Summary ===");
console.log("Chunks per module:", chunksPerModule);
console.log(`Sequence candidates: ${sequences.length}`);
for (const s of sequences) {
  console.log(
    `  M${s.module} [${s.heading}] (${s.steps.length} steps): ${s.steps[0]} → …`,
  );
}
console.log("Anki imported per module:", ankiPerModule);
console.log("Anki imported per type:", ankiPerType);
console.log(
  `Anki skipped: ${anki.skipped.length} (duplicates dropped: ${anki.duplicatesDropped})`,
);
console.log("No database writes performed.");

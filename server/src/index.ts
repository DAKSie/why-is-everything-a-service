import path from "node:path";
import cors from "cors";
import express from "express";
import { migrate, openDb } from "./db.js";
import { env } from "./env.js";
import { checkOllama } from "./ollama.js";
import { countQuestions, seedQuestionsFromDataDir } from "./questions/load.js";

const dataDir = path.join(env.rootDir, "data");
const dbPath = path.join(dataDir, "app.db");
const db = openDb(dbPath);
migrate(db);

const seed = seedQuestionsFromDataDir(db, dataDir);
console.log(
  `Seeded questions from ${path.basename(seed.path)}: upserted=${seed.upserted}, attemptsPreserved=${seed.attemptsPreserved}`,
);

const app = express();

app.use(
  cors({
    origin: env.clientOrigin,
  }),
);
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", async (_req, res) => {
  const ollama = await checkOllama();
  res.json({
    ok: true,
    service: "ihateaws-server",
    offlineReady: true,
    db: {
      driver: db.driver,
      path: db.filePath,
      questions: countQuestions(db),
    },
    ollama,
  });
});

app.listen(env.port, "127.0.0.1", () => {
  console.log(`API listening on http://127.0.0.1:${env.port}`);
  console.log(`Health: http://127.0.0.1:${env.port}/api/health`);
  console.log(`Ollama base: ${env.ollamaBaseUrl} (optional)`);
});

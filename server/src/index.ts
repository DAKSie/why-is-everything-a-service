import cors from "cors";
import express from "express";
import { env } from "./env.js";
import { checkOllama } from "./ollama.js";

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
    ollama,
    offlineReady: true,
  });
});

app.listen(env.port, "127.0.0.1", () => {
  console.log(`API listening on http://127.0.0.1:${env.port}`);
  console.log(`Health: http://127.0.0.1:${env.port}/api/health`);
  console.log(`Ollama base: ${env.ollamaBaseUrl} (optional)`);
});

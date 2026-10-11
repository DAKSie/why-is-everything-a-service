import { env } from "../env.js";
import { checkOllama } from "../ollama.js";

export class OllamaUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OllamaUnavailableError";
  }
}

export async function assertOllamaReady(): Promise<void> {
  const status = await checkOllama();
  if (!status.reachable) {
    throw new OllamaUnavailableError(
      `Ollama is not reachable at ${status.baseUrl}. Start Ollama, then retry. ${status.detail ?? ""}`.trim(),
    );
  }
  if (!status.modelAvailable) {
    throw new OllamaUnavailableError(
      `Ollama is reachable but model "${status.model}" is missing. Run: ${status.pullHint}`,
    );
  }
}

export async function ollamaChatJson(input: {
  system: string;
  user: string;
  temperature?: number;
}): Promise<unknown> {
  const res = await fetch(`${env.ollamaBaseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: env.ollamaModel,
      stream: false,
      format: "json",
      options: { temperature: input.temperature ?? 0.1 },
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.user },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ollama /api/chat failed HTTP ${res.status}: ${body.slice(0, 300)}`);
  }

  const payload = (await res.json()) as { message?: { content?: string } };
  const content = payload.message?.content ?? "";
  try {
    return JSON.parse(content) as unknown;
  } catch {
    throw new Error(`Ollama returned non-JSON content: ${content.slice(0, 300)}`);
  }
}

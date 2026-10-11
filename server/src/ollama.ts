import { env } from "./env.js";

export type OllamaStatus = {
  reachable: boolean;
  model: string;
  modelAvailable: boolean;
  baseUrl: string;
  pullHint: string;
  detail?: string;
};

export async function checkOllama(): Promise<OllamaStatus> {
  const pullHint = `ollama pull ${env.ollamaModel}`;
  const base: Omit<OllamaStatus, "reachable" | "modelAvailable" | "detail"> = {
    model: env.ollamaModel,
    baseUrl: env.ollamaBaseUrl,
    pullHint,
  };

  try {
    const tagsUrl = `${env.ollamaBaseUrl}/api/tags`;
    const res = await fetch(tagsUrl, {
      signal: AbortSignal.timeout(2000),
    });

    if (!res.ok) {
      return {
        ...base,
        reachable: false,
        modelAvailable: false,
        detail: `Ollama responded HTTP ${res.status}`,
      };
    }

    const body = (await res.json()) as {
      models?: Array<{ name?: string; model?: string }>;
    };
    const names = (body.models ?? []).map((m) => m.name ?? m.model ?? "");
    const modelAvailable = names.some(
      (name) =>
        name === env.ollamaModel ||
        name.startsWith(`${env.ollamaModel}:`) ||
        name.split(":")[0] === env.ollamaModel.split(":")[0],
    );

    return {
      ...base,
      reachable: true,
      modelAvailable,
      detail: modelAvailable
        ? "Ollama reachable; model present"
        : `Ollama reachable; model missing — run: ${pullHint}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ...base,
      reachable: false,
      modelAvailable: false,
      detail: `Ollama unreachable (${message}). App works offline with sample questions.`,
    };
  }
}

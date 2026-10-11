import { env } from "./env.js";

export type OllamaStatus = {
  reachable: boolean;
  model: string;
  modelAvailable: boolean;
  baseUrl: string;
  pullHint: string;
  detail?: string;
};

function modelMatches(installed: string, wanted: string): boolean {
  return (
    installed === wanted ||
    installed.startsWith(`${wanted}:`) ||
    installed.split(":")[0] === wanted.split(":")[0]
  );
}

export async function checkOllama(model = env.ollamaModel): Promise<OllamaStatus> {
  const pullHint = `ollama pull ${model}`;
  const base: Omit<OllamaStatus, "reachable" | "modelAvailable" | "detail"> = {
    model,
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
    const modelAvailable = names.some((name) => modelMatches(name, model));

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

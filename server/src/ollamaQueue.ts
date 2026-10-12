import { env } from "./env.js";
import { OLLAMA_FIXED_SEED } from "./ingest/ollamaClient.js";

type Priority = "grade" | "generate";

type Job = {
  priority: Priority;
  run: () => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
};

/**
 * Serializes Ollama calls: grading always jumps ahead of generation
 * so a quiz is never blocked by an in-app generate job.
 */
class OllamaQueue {
  private queue: Job[] = [];
  private active = false;

  enqueue<T>(priority: Priority, run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const job: Job = {
        priority,
        run: run as () => Promise<unknown>,
        resolve: resolve as (v: unknown) => void,
        reject,
      };
      if (priority === "grade") this.queue.unshift(job);
      else this.queue.push(job);
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.active) return;
    this.active = true;
    while (this.queue.length > 0) {
      // Prefer any grade jobs that arrived while we were working.
      this.queue.sort((a, b) =>
        a.priority === b.priority ? 0 : a.priority === "grade" ? -1 : 1,
      );
      const job = this.queue.shift()!;
      try {
        job.resolve(await job.run());
      } catch (err) {
        job.reject(err);
      }
    }
    this.active = false;
  }
}

export const ollamaQueue = new OllamaQueue();

export async function ollamaChatJsonQueued(input: {
  system: string;
  user: string;
  model?: string;
  priority: Priority;
  temperature?: number;
  seed?: number;
  timeoutMs?: number;
}): Promise<unknown> {
  const model = input.model ?? env.ollamaModel;
  const temperature = input.temperature ?? 0;
  const seed = input.seed ?? OLLAMA_FIXED_SEED;
  const timeoutMs = input.timeoutMs ?? 60_000;

  return ollamaQueue.enqueue(input.priority, async () => {
    const res = await fetch(`${env.ollamaBaseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        model,
        stream: false,
        format: "json",
        options: { temperature, seed },
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: input.user },
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `Ollama /api/chat failed HTTP ${res.status}: ${body.slice(0, 300)}`,
      );
    }
    const payload = (await res.json()) as { message?: { content?: string } };
    const content = payload.message?.content ?? "";
    try {
      return JSON.parse(content) as unknown;
    } catch {
      throw new Error(
        `Ollama returned non-JSON content: ${content.slice(0, 300)}`,
      );
    }
  });
}

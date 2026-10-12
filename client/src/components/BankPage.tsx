import { useCallback, useEffect, useState } from "react";
import type { HealthResponse, PublicQuestion } from "../types";

type JobStatus = {
  id: string;
  state: string;
  module: number;
  type: string;
  targetCount: number;
  chunksTotal: number;
  chunksDone: number;
  questionsAdded: number;
  rejects: number;
  error?: string;
};

export function BankPage({ health }: { health: HealthResponse | null }) {
  const [module, setModule] = useState(6);
  const [topic, setTopic] = useState("all");
  const [type, setType] = useState("multiple_choice");
  const [count, setCount] = useState(3);
  const [job, setJob] = useState<JobStatus | null>(null);
  const [recent, setRecent] = useState<PublicQuestion[]>([]);
  const [error, setError] = useState<string | null>(null);

  const ollamaReady =
    !!health?.ollama.reachable && !!health?.ollama.modelAvailable;

  const refresh = useCallback(async () => {
    const [st, rec] = await Promise.all([
      fetch("/api/generate/status").then((r) => r.json()),
      fetch("/api/bank/recent").then((r) => r.json()),
    ]);
    setJob((st as { job: JobStatus | null }).job);
    setRecent((rec as { questions: PublicQuestion[] }).questions ?? []);
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), 2000);
    return () => window.clearInterval(id);
  }, [refresh]);

  async function start() {
    setError(null);
    const res = await fetch("/api/generate/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ module, topic, type, count }),
    });
    const body = await res.json();
    if (!res.ok) {
      setError(
        `${body.error ?? "failed"}${body.pullHint ? ` — ${body.pullHint}` : ""}`,
      );
      return;
    }
    setJob(body.job);
  }

  async function decide(questionId: string, decision: "accept" | "reject") {
    await fetch("/api/bank/decide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ questionId, decision }),
    });
    await refresh();
  }

  return (
    <section
      className="rounded-lg border p-5 space-y-6"
      style={{ borderColor: "var(--border)", background: "var(--panel)" }}
    >
      <div>
        <h2 className="text-lg font-semibold">Question bank</h2>
        <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
          Generate new questions from notes via the same pipeline as{" "}
          <code>build:questions</code>. Grading always takes priority over
          generation.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          Module
          <select
            className="mt-1 block w-full rounded border px-2 py-1.5"
            style={{ borderColor: "var(--border)", background: "var(--bg)" }}
            value={module}
            onChange={(e) => setModule(Number(e.target.value))}
          >
            {[6, 7, 8, 9, 10].map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          Topic
          <select
            className="mt-1 block w-full rounded border px-2 py-1.5"
            style={{ borderColor: "var(--border)", background: "var(--bg)" }}
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
          >
            <option value="all">All topics in module</option>
            <option value="weak">Weak areas (lowest mastery tags)</option>
          </select>
        </label>
        <label className="text-sm">
          Type
          <select
            className="mt-1 block w-full rounded border px-2 py-1.5"
            style={{ borderColor: "var(--border)", background: "var(--bg)" }}
            value={type}
            onChange={(e) => setType(e.target.value)}
          >
            <option value="multiple_choice">Multiple choice</option>
            <option value="identification">Identification</option>
            <option value="situational">Situational</option>
          </select>
        </label>
        <label className="text-sm">
          Count
          <input
            type="number"
            min={1}
            max={20}
            value={count}
            onChange={(e) => setCount(Number(e.target.value) || 3)}
            className="mt-1 block w-full rounded border px-2 py-1.5"
            style={{ borderColor: "var(--border)", background: "var(--bg)" }}
          />
        </label>
      </div>

      {!ollamaReady ? (
        <p className="text-sm" style={{ color: "var(--warn)" }}>
          Generate disabled — Ollama offline.{" "}
          <code className="select-all">{health?.ollama.pullHint}</code>
        </p>
      ) : null}

      {error ? (
        <p className="text-sm" style={{ color: "var(--bad)" }}>
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={!ollamaReady || job?.state === "running"}
          onClick={() => void start()}
          className="rounded-md px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          style={{ background: "var(--accent)" }}
        >
          Generate questions
        </button>
        <button
          type="button"
          disabled={job?.state !== "running"}
          onClick={() => void fetch("/api/generate/cancel", { method: "POST" })}
          className="rounded-md border px-4 py-2 text-sm disabled:opacity-50"
          style={{ borderColor: "var(--border)" }}
        >
          Cancel
        </button>
      </div>

      {job ? (
        <div
          className="rounded border p-3 text-sm"
          style={{ borderColor: "var(--border)" }}
        >
          <p className="font-medium">
            Job {job.id} · {job.state}
          </p>
          <p style={{ color: "var(--muted)" }}>
            Chunks {job.chunksDone}/{job.chunksTotal} · added {job.questionsAdded}/
            {job.targetCount} · rejects {job.rejects}
          </p>
          {job.error ? (
            <p style={{ color: "var(--bad)" }}>{job.error}</p>
          ) : null}
        </div>
      ) : null}

      <div>
        <h3 className="font-medium">Recently generated</h3>
        {recent.length === 0 ? (
          <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>
            None yet this server session.
          </p>
        ) : (
          <ul className="mt-3 space-y-3">
            {recent.map((q) => (
              <li
                key={q.id}
                className="rounded border p-3 text-sm"
                style={{ borderColor: "var(--border)" }}
              >
                <div className="flex flex-wrap gap-2 text-xs" style={{ color: "var(--muted)" }}>
                  <span>Module {q.module}</span>
                  <span>{q.type}</span>
                  {q.aiGenerated ? (
                    <span
                      className="rounded px-1.5 py-0.5 text-white"
                      style={{ background: "var(--accent)" }}
                    >
                      AI-generated
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 whitespace-pre-wrap">{q.prompt}</p>
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    className="rounded border px-2 py-1 text-xs"
                    style={{ borderColor: "var(--border)" }}
                    onClick={() => void decide(q.id, "accept")}
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    className="rounded border px-2 py-1 text-xs"
                    style={{ borderColor: "var(--border)" }}
                    onClick={() => void decide(q.id, "reject")}
                  >
                    Reject
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

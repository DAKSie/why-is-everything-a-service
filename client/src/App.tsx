import { useEffect, useState } from "react";

type HealthResponse = {
  ok: boolean;
  service: string;
  offlineReady: boolean;
  db?: {
    driver: string;
    path: string;
    questions: number;
  };
  ollama: {
    reachable: boolean;
    model: string;
    modelAvailable: boolean;
    baseUrl: string;
    pullHint: string;
    detail?: string;
  };
};

export default function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dark, setDark] = useState(false);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch("/api/health");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as HealthResponse;
        if (!cancelled) {
          setHealth(data);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    }

    void load();
    const id = window.setInterval(load, 10000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const ollama = health?.ollama;
  const badge =
    !health && !error
      ? { label: "Checking…", color: "var(--muted)" }
      : error
        ? { label: "API offline", color: "var(--bad)" }
        : ollama?.reachable && ollama.modelAvailable
          ? { label: "Ollama ready", color: "var(--ok)" }
          : ollama?.reachable
            ? { label: "Ollama: pull model", color: "var(--warn)" }
            : { label: "Ollama offline (OK)", color: "var(--warn)" };

  return (
    <div className="min-h-screen px-6 py-10">
      <div className="mx-auto max-w-2xl">
        <header className="mb-8 flex items-start justify-between gap-4">
          <div>
            <p className="text-sm tracking-wide" style={{ color: "var(--muted)" }}>
              Local reviewer · Modules 6–10
            </p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight">IHateAWS</h1>
            <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>
              Scaffold is up. Sample questions and practice UI arrive in the next steps.
              Ollama is optional right now.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setDark((v) => !v)}
            className="rounded-md border px-3 py-1.5 text-sm"
            style={{ borderColor: "var(--border)", background: "var(--panel)" }}
          >
            {dark ? "Light" : "Dark"}
          </button>
        </header>

        <section
          className="rounded-lg border p-5"
          style={{ borderColor: "var(--border)", background: "var(--panel)" }}
        >
          <div className="mb-4 flex items-center gap-3">
            <span
              className="inline-flex items-center rounded-md px-2.5 py-1 text-xs font-medium text-white"
              style={{ background: badge.color }}
            >
              {badge.label}
            </span>
            {health?.offlineReady ? (
              <span className="text-xs" style={{ color: "var(--muted)" }}>
                Offline-ready
              </span>
            ) : null}
          </div>

          {error ? (
            <p className="text-sm" style={{ color: "var(--bad)" }}>
              Could not reach API: {error}. Is <code>npm run dev</code> running the
              server on port 3001?
            </p>
          ) : null}

          {health ? (
            <dl className="grid gap-3 text-sm">
              <div>
                <dt className="font-medium">API</dt>
                <dd style={{ color: "var(--muted)" }}>{health.service}</dd>
              </div>
              {health.db ? (
                <div>
                  <dt className="font-medium">Question bank</dt>
                  <dd style={{ color: "var(--muted)" }}>
                    {health.db.questions} questions · driver {health.db.driver}
                  </dd>
                </div>
              ) : null}
              <div>
                <dt className="font-medium">Ollama base URL</dt>
                <dd style={{ color: "var(--muted)" }}>{ollama?.baseUrl}</dd>
              </div>
              <div>
                <dt className="font-medium">Model</dt>
                <dd style={{ color: "var(--muted)" }}>{ollama?.model}</dd>
              </div>
              <div>
                <dt className="font-medium">Status detail</dt>
                <dd style={{ color: "var(--muted)" }}>{ollama?.detail}</dd>
              </div>
              {ollama && !ollama.modelAvailable ? (
                <div>
                  <dt className="font-medium">Pull hint</dt>
                  <dd>
                    <code
                      className="mt-1 block select-all rounded border px-2 py-1.5 text-xs"
                      style={{ borderColor: "var(--border)" }}
                    >
                      {ollama.pullHint}
                    </code>
                  </dd>
                </div>
              ) : null}
            </dl>
          ) : null}
        </section>
      </div>
    </div>
  );
}

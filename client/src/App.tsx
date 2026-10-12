import { useCallback, useEffect, useMemo, useState } from "react";
import { BankPage } from "./components/BankPage";
import { ResultViews } from "./components/ResultViews";
import type {
  GradeResponse,
  HealthResponse,
  PublicQuestion,
} from "./types";

type Screen = "home" | "quiz" | "result" | "bank";

export default function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dark, setDark] = useState(false);
  const [screen, setScreen] = useState<Screen>("home");
  const [modules, setModules] = useState([6, 7, 8, 9, 10]);
  const [targetCount, setTargetCount] = useState(8);
  const [seen, setSeen] = useState<string[]>([]);
  const [question, setQuestion] = useState<PublicQuestion | null>(null);
  const [grade, setGrade] = useState<GradeResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [sessionScores, setSessionScores] = useState<number[]>([]);
  const [startedAt, setStartedAt] = useState(0);
  const [reportNote, setReportNote] = useState("");
  const [reportDone, setReportDone] = useState(false);
  const [auditMsg, setAuditMsg] = useState<string | null>(null);

  const [mcSelected, setMcSelected] = useState<number[]>([]);
  const [idAnswer, setIdAnswer] = useState("");
  const [sitAnswer, setSitAnswer] = useState("");
  const [procSteps, setProcSteps] = useState<string[]>([]);

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
    const id = window.setInterval(load, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const resetAnswerState = useCallback((q: PublicQuestion) => {
    setGrade(null);
    setReportNote("");
    setReportDone(false);
    setAuditMsg(null);
    setMcSelected([]);
    setIdAnswer("");
    setSitAnswer("");
    setProcSteps(q.shuffledSteps ? [...q.shuffledSteps] : []);
    setStartedAt(Date.now());
  }, []);

  const loadNext = useCallback(
    async (exclude: string[]) => {
      setBusy(true);
      try {
        const qs = new URLSearchParams({
          modules: modules.join(","),
          exclude: exclude.join(","),
        });
        const res = await fetch(`/api/questions/next?${qs}`);
        if (!res.ok) {
          if (res.status === 404) {
            setScreen("result");
            setQuestion(null);
            return;
          }
          throw new Error(`next: HTTP ${res.status}`);
        }
        const data = (await res.json()) as { question: PublicQuestion };
        setQuestion(data.question);
        resetAnswerState(data.question);
        setScreen("quiz");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [modules, resetAnswerState],
  );

  async function startSession() {
    setSeen([]);
    setSessionScores([]);
    await loadNext([]);
  }

  function toggleMc(i: number) {
    if (!question) return;
    const mode = question.selectionMode ?? "checkbox";
    const n = question.correctCount ?? 1;
    if (mode === "radio") {
      setMcSelected([i]);
      return;
    }
    setMcSelected((prev) => {
      if (prev.includes(i)) return prev.filter((x) => x !== i);
      if (prev.length >= n) return prev;
      return [...prev, i].sort((a, b) => a - b);
    });
  }

  async function submit() {
    if (!question) return;
    setBusy(true);
    try {
      let answer: unknown;
      if (question.type === "multiple_choice") answer = mcSelected;
      else if (question.type === "identification") answer = idAnswer;
      else if (question.type === "situational") answer = sitAnswer;
      else answer = procSteps;

      const res = await fetch("/api/grade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          questionId: question.id,
          answer,
          timeSpentMs: Date.now() - startedAt,
        }),
      });
      if (!res.ok) throw new Error(`grade: HTTP ${res.status}`);
      const result = (await res.json()) as GradeResponse;
      setGrade(result);
      setSessionScores((s) => [...s, result.score]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function nextQuestion() {
    if (!question) return;
    const nextSeen = [...seen, question.id];
    setSeen(nextSeen);
    if (nextSeen.length >= targetCount) {
      setScreen("result");
      setQuestion(null);
      return;
    }
    await loadNext(nextSeen);
  }

  async function reportBad() {
    if (!question) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/questions/${question.id}/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          note: reportNote || "Reported from practice UI",
        }),
      });
      if (!res.ok) throw new Error(`report: HTTP ${res.status}`);
      setReportDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function audit() {
    if (!question) return;
    setBusy(true);
    setAuditMsg(null);
    try {
      const res = await fetch(`/api/questions/${question.id}/audit`, {
        method: "POST",
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "audit failed");
      if (body.aiUnavailable) {
        setAuditMsg("Audit unavailable (Ollama offline).");
      } else if (body.agrees) {
        setAuditMsg("Audit: model agrees with the stored answer.");
      } else {
        setAuditMsg(
          `Audit flagged for review — model answered “${body.modelAnswer}”. ${body.reason}`,
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function override(countedAs: "correct" | "incorrect") {
    if (!grade) return;
    const res = await fetch(`/api/attempts/${grade.attemptId}/override`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ countedAs }),
    });
    if (!res.ok) return;
    const body = (await res.json()) as { score: number };
    setGrade({ ...grade, score: body.score });
    setSessionScores((s) => {
      const next = [...s];
      next[next.length - 1] = body.score;
      return next;
    });
  }

  function moveStep(index: number, dir: -1 | 1) {
    setProcSteps((steps) => {
      const next = [...steps];
      const j = index + dir;
      if (j < 0 || j >= next.length) return steps;
      [next[index], next[j]] = [next[j]!, next[index]!];
      return next;
    });
  }

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

  const avg = useMemo(() => {
    if (sessionScores.length === 0) return 0;
    return sessionScores.reduce((a, b) => a + b, 0) / sessionScores.length;
  }, [sessionScores]);

  return (
    <div className="min-h-screen px-6 py-10">
      <div className="mx-auto max-w-2xl">
        <header className="mb-6 flex items-start justify-between gap-4">
          <div>
            <p className="text-sm tracking-wide" style={{ color: "var(--muted)" }}>
              Local reviewer · Modules 6–10
            </p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight">IHateAWS</h1>
          </div>
          <div className="flex items-center gap-2">
            <span
              className="inline-flex items-center rounded-md px-2.5 py-1 text-xs font-medium text-white"
              style={{ background: badge.color }}
            >
              {badge.label}
            </span>
            <button
              type="button"
              onClick={() => setDark((v) => !v)}
              className="rounded-md border px-3 py-1.5 text-sm"
              style={{ borderColor: "var(--border)", background: "var(--panel)" }}
            >
              {dark ? "Light" : "Dark"}
            </button>
          </div>
        </header>

        <nav className="mb-6 flex gap-2 text-sm">
          {(
            [
              ["home", "Practice"],
              ["bank", "Bank"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setScreen(key === "home" ? "home" : "bank")}
              className="rounded-md border px-3 py-1.5"
              style={{
                borderColor: "var(--border)",
                background:
                  (key === "home" && (screen === "home" || screen === "quiz" || screen === "result")) ||
                  (key === "bank" && screen === "bank")
                    ? "var(--panel)"
                    : "transparent",
              }}
            >
              {label}
            </button>
          ))}
        </nav>

        {error ? (
          <p className="mb-4 text-sm" style={{ color: "var(--bad)" }}>
            {error}
          </p>
        ) : null}

        {screen === "bank" ? <BankPage health={health} /> : null}

        {screen === "home" ? (
          <section
            className="rounded-lg border p-5"
            style={{ borderColor: "var(--border)", background: "var(--panel)" }}
          >
            <h2 className="text-lg font-semibold">Practice</h2>
            <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
              {health?.db
                ? `${health.db.questions} questions seeded`
                : "Waiting for API…"}
            </p>

            <fieldset className="mt-5">
              <legend className="text-sm font-medium">Modules</legend>
              <div className="mt-2 flex flex-wrap gap-3">
                {[6, 7, 8, 9, 10].map((m) => {
                  const on = modules.includes(m);
                  return (
                    <label key={m} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() =>
                          setModules((prev) =>
                            on
                              ? prev.filter((x) => x !== m)
                              : [...prev, m].sort((a, b) => a - b),
                          )
                        }
                      />
                      {m}
                    </label>
                  );
                })}
              </div>
            </fieldset>

            <label className="mt-4 block text-sm font-medium">
              Questions this session
              <input
                type="number"
                min={1}
                max={40}
                value={targetCount}
                onChange={(e) => setTargetCount(Number(e.target.value) || 8)}
                className="mt-1 block w-28 rounded border px-2 py-1.5"
                style={{ borderColor: "var(--border)", background: "var(--bg)" }}
              />
            </label>

            <button
              type="button"
              disabled={busy || modules.length === 0 || !health}
              onClick={() => void startSession()}
              className="mt-6 rounded-md px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              style={{ background: "var(--accent)" }}
            >
              Start practice
            </button>
          </section>
        ) : null}

        {screen === "quiz" && question ? (
          <section
            className="rounded-lg border p-5"
            style={{ borderColor: "var(--border)", background: "var(--panel)" }}
          >
            <div
              className="mb-3 flex flex-wrap items-center gap-2 text-xs"
              style={{ color: "var(--muted)" }}
            >
              <span>
                {seen.length + 1} / {targetCount}
              </span>
              <span>·</span>
              <span>{question.type.replace("_", " ")}</span>
              {question.aiGenerated ? (
                <span
                  className="rounded px-1.5 py-0.5 text-white"
                  style={{ background: "var(--accent)" }}
                >
                  AI-generated
                </span>
              ) : null}
              {question.needsReview && question.outdatedNote ? (
                <span
                  className="rounded px-1.5 py-0.5 text-white"
                  style={{ background: "var(--warn)" }}
                  title={question.outdatedNote}
                >
                  needs review: {question.outdatedNote}
                </span>
              ) : null}
            </div>

            <p className="mb-2 text-xs" style={{ color: "var(--muted)" }}>
              {question.sourceBreadcrumb}
            </p>

            <h2 className="text-lg font-semibold whitespace-pre-wrap">
              {question.prompt}
            </h2>
            {question.type === "situational" && question.scenario ? (
              <p
                className="mt-3 rounded border p-3 text-sm whitespace-pre-wrap"
                style={{ borderColor: "var(--border)", background: "var(--bg)" }}
              >
                {question.scenario}
              </p>
            ) : null}

            <div className="mt-5 space-y-3">
              {question.type === "multiple_choice" && question.options ? (
                <>
                  <p className="text-xs font-medium" style={{ color: "var(--muted)" }}>
                    {question.chooseHint ?? "Choose 1"}
                  </p>
                  {question.options.map((opt, i) => {
                    const mode = question.selectionMode ?? "radio";
                    const n = question.correctCount ?? 1;
                    const selected = mcSelected.includes(i);
                    const disabled =
                      !!grade ||
                      (mode === "checkbox" &&
                        !selected &&
                        mcSelected.length >= n);
                    return (
                      <label
                        key={i}
                        className={`flex items-start gap-2 rounded border px-3 py-2 text-sm ${disabled && !selected ? "opacity-50" : "cursor-pointer"}`}
                        style={{ borderColor: "var(--border)" }}
                      >
                        <input
                          type={mode === "radio" ? "radio" : "checkbox"}
                          name="mc"
                          checked={selected}
                          disabled={disabled}
                          onChange={() => toggleMc(i)}
                        />
                        <span>{opt}</span>
                      </label>
                    );
                  })}
                </>
              ) : null}

              {question.type === "identification" ? (
                <input
                  type="text"
                  value={idAnswer}
                  disabled={!!grade}
                  onChange={(e) => setIdAnswer(e.target.value)}
                  placeholder="Your answer"
                  className="w-full rounded border px-3 py-2 text-sm"
                  style={{ borderColor: "var(--border)", background: "var(--bg)" }}
                />
              ) : null}

              {question.type === "situational" ? (
                <textarea
                  value={sitAnswer}
                  disabled={!!grade}
                  onChange={(e) => setSitAnswer(e.target.value)}
                  rows={5}
                  placeholder="What should you do and why?"
                  className="w-full rounded border px-3 py-2 text-sm"
                  style={{ borderColor: "var(--border)", background: "var(--bg)" }}
                />
              ) : null}

              {question.type === "procedural"
                ? procSteps.map((step, i) => (
                    <div
                      key={`${step}-${i}`}
                      className="flex items-center gap-2 rounded border px-3 py-2 text-sm"
                      style={{ borderColor: "var(--border)" }}
                    >
                      <span className="w-6 shrink-0" style={{ color: "var(--muted)" }}>
                        {i + 1}.
                      </span>
                      <span className="flex-1">{step}</span>
                      {!grade ? (
                        <span className="flex gap-1">
                          <button
                            type="button"
                            className="rounded border px-2 py-0.5 text-xs"
                            style={{ borderColor: "var(--border)" }}
                            onClick={() => moveStep(i, -1)}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            className="rounded border px-2 py-0.5 text-xs"
                            style={{ borderColor: "var(--border)" }}
                            onClick={() => moveStep(i, 1)}
                          >
                            ↓
                          </button>
                        </span>
                      ) : null}
                    </div>
                  ))
                : null}
            </div>

            {!grade ? (
              <div className="mt-6 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void submit()}
                  className="rounded-md px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                  style={{ background: "var(--accent)" }}
                >
                  Check answer
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void audit()}
                  className="rounded-md border px-3 py-2 text-sm"
                  style={{ borderColor: "var(--border)" }}
                >
                  Audit this question
                </button>
              </div>
            ) : (
              <>
                <ResultViews
                  feedback={grade.feedback}
                  attemptId={grade.attemptId}
                  onOverride={(c) => void override(c)}
                />
                <div
                  className="mt-4 rounded border p-3"
                  style={{ borderColor: "var(--border)" }}
                >
                  <p className="text-sm font-medium">Report bad question</p>
                  <textarea
                    value={reportNote}
                    onChange={(e) => setReportNote(e.target.value)}
                    rows={2}
                    placeholder="What’s wrong? (optional)"
                    disabled={reportDone}
                    className="mt-2 w-full rounded border px-2 py-1.5 text-sm"
                    style={{
                      borderColor: "var(--border)",
                      background: "var(--bg)",
                    }}
                  />
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={busy || reportDone}
                      onClick={() => void reportBad()}
                      className="rounded-md border px-3 py-1.5 text-sm disabled:opacity-50"
                      style={{ borderColor: "var(--border)" }}
                    >
                      {reportDone ? "Reported" : "Report"}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void audit()}
                      className="rounded-md border px-3 py-1.5 text-sm"
                      style={{ borderColor: "var(--border)" }}
                    >
                      Audit this question
                    </button>
                  </div>
                </div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void nextQuestion()}
                  className="mt-4 rounded-md px-4 py-2 text-sm font-medium text-white"
                  style={{ background: "var(--accent)" }}
                >
                  {seen.length + 1 >= targetCount ? "Finish" : "Next"}
                </button>
              </>
            )}

            {auditMsg ? (
              <p className="mt-3 text-sm" style={{ color: "var(--warn)" }}>
                {auditMsg}
              </p>
            ) : null}
          </section>
        ) : null}

        {screen === "result" ? (
          <section
            className="rounded-lg border p-5"
            style={{ borderColor: "var(--border)", background: "var(--panel)" }}
          >
            <h2 className="text-lg font-semibold">Session complete</h2>
            <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>
              Answered {sessionScores.length} · average {Math.round(avg * 100)}%
            </p>
            <button
              type="button"
              className="mt-5 rounded-md px-4 py-2 text-sm font-medium text-white"
              style={{ background: "var(--accent)" }}
              onClick={() => setScreen("home")}
            >
              Back home
            </button>
          </section>
        ) : null}
      </div>
    </div>
  );
}

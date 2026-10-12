import type { GradeFeedback } from "../types";

function Breadcrumb({ text }: { text: string }) {
  return (
    <p className="text-xs" style={{ color: "var(--muted)" }}>
      Source: {text}
    </p>
  );
}

export function ResultViews({
  feedback,
  attemptId,
  onOverride,
}: {
  feedback: GradeFeedback;
  attemptId: number | null;
  onOverride: (countedAs: "correct" | "incorrect") => void;
}) {
  return (
    <div className="mt-6 space-y-3">
      <p className="text-base font-semibold">{feedback.resultLine}</p>
      <Breadcrumb text={feedback.sourceBreadcrumb} />

      {feedback.kind === "multiple_choice" ? (
        <McResult f={feedback} />
      ) : null}
      {feedback.kind === "identification" ? (
        <IdResult f={feedback} />
      ) : null}
      {feedback.kind === "procedural" ? (
        <ProcResult f={feedback} />
      ) : null}
      {feedback.kind === "situational" ? (
        <SitResult f={feedback} />
      ) : null}

      <p className="text-sm whitespace-pre-wrap">{feedback.explanation}</p>

      {attemptId != null ? (
        <div className="flex flex-wrap gap-2 pt-1">
          <button
            type="button"
            className="rounded border px-3 py-1.5 text-xs"
            style={{ borderColor: "var(--border)" }}
            onClick={() => onOverride("correct")}
          >
            Count this as correct
          </button>
          <button
            type="button"
            className="rounded border px-3 py-1.5 text-xs"
            style={{ borderColor: "var(--border)" }}
            onClick={() => onOverride("incorrect")}
          >
            Count this as incorrect
          </button>
        </div>
      ) : null}
    </div>
  );
}

function McResult({
  f,
}: {
  f: Extract<GradeFeedback, { kind: "multiple_choice" }>;
}) {
  return (
    <div className="space-y-3">
      <div className="text-sm">
        <p>
          <span className="font-medium">Your answer:</span>{" "}
          {f.yourAnswer.length ? f.yourAnswer.join("; ") : "(none)"}
        </p>
        <p>
          <span className="font-medium">Correct answer:</span>{" "}
          {f.correctAnswer.join("; ")}
        </p>
      </div>
      <ul className="space-y-2">
        {f.options.map((o) => (
          <li
            key={o.index}
            className="flex items-start gap-2 rounded border px-3 py-2 text-sm"
            style={{
              borderColor:
                o.mark === "correct"
                  ? "var(--ok)"
                  : o.mark === "wrong_pick"
                    ? "var(--bad)"
                    : o.mark === "missed"
                      ? "var(--ok)"
                      : "var(--border)",
              borderStyle: o.mark === "missed" ? "dashed" : "solid",
              background:
                o.mark === "correct"
                  ? "color-mix(in srgb, var(--ok) 12%, transparent)"
                  : o.mark === "wrong_pick"
                    ? "color-mix(in srgb, var(--bad) 12%, transparent)"
                    : "transparent",
            }}
          >
            <span className="mt-0.5 shrink-0 font-medium" aria-hidden>
              {o.mark === "correct"
                ? "✓"
                : o.mark === "wrong_pick"
                  ? "✗"
                  : o.mark === "missed"
                    ? "○"
                    : "·"}
            </span>
            <span className="flex-1">
              {o.text}
              {o.mark === "correct" ? (
                <span className="ml-2 text-xs" style={{ color: "var(--ok)" }}>
                  (correct)
                </span>
              ) : null}
              {o.mark === "wrong_pick" ? (
                <span className="ml-2 text-xs" style={{ color: "var(--bad)" }}>
                  (your pick)
                </span>
              ) : null}
              {o.mark === "missed" ? (
                <span className="ml-2 text-xs" style={{ color: "var(--ok)" }}>
                  (correct answer)
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function IdResult({
  f,
}: {
  f: Extract<GradeFeedback, { kind: "identification" }>;
}) {
  return (
    <div className="space-y-2 text-sm">
      <p>
        <span className="font-medium">Your answer:</span> {f.yourAnswer || "(empty)"}
      </p>
      <p>
        <span className="font-medium">Accepted answer:</span> {f.correctAnswer}
      </p>
      <p className="rounded border px-2 py-1.5 font-mono text-xs" style={{ borderColor: "var(--border)" }}>
        {f.diff.map((span, i) => (
          <span
            key={i}
            style={{
              background:
                span.kind === "del"
                  ? "color-mix(in srgb, var(--bad) 35%, transparent)"
                  : span.kind === "ins"
                    ? "color-mix(in srgb, var(--ok) 35%, transparent)"
                    : "transparent",
              textDecoration: span.kind === "del" ? "line-through" : "none",
            }}
          >
            {span.text}
          </span>
        ))}
      </p>
      {f.spellingNote ? (
        <p style={{ color: "var(--warn)" }}>{f.spellingNote}</p>
      ) : null}
      {f.aiNote ? (
        <p style={{ color: "var(--muted)" }}>{f.aiNote}</p>
      ) : null}
    </div>
  );
}

function ProcResult({
  f,
}: {
  f: Extract<GradeFeedback, { kind: "procedural" }>;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 text-sm">
      <div>
        <p className="mb-1 font-medium">Your order</p>
        <ol className="space-y-1">
          {f.yourOrder.map((row, i) => (
            <li
              key={`y-${i}`}
              className="rounded border px-2 py-1.5"
              style={{
                borderColor: row.outOfPlace ? "var(--bad)" : "var(--ok)",
                background: row.outOfPlace
                  ? "color-mix(in srgb, var(--bad) 10%, transparent)"
                  : "color-mix(in srgb, var(--ok) 10%, transparent)",
              }}
            >
              {i + 1}. {row.step}
              {row.outOfPlace ? (
                <span className="ml-1 text-xs">(out of place)</span>
              ) : null}
            </li>
          ))}
        </ol>
      </div>
      <div>
        <p className="mb-1 font-medium">Correct order</p>
        <ol className="space-y-1">
          {f.correctOrder.map((row, i) => (
            <li
              key={`c-${i}`}
              className="rounded border px-2 py-1.5"
              style={{ borderColor: "var(--border)" }}
            >
              {i + 1}. {row.step}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function SitResult({
  f,
}: {
  f: Extract<GradeFeedback, { kind: "situational" }>;
}) {
  return (
    <div className="space-y-2 text-sm">
      <p style={{ color: "var(--muted)" }}>{f.feedback}</p>
      {f.keyPointsHit.length ? (
        <div>
          <p className="font-medium" style={{ color: "var(--ok)" }}>
            Key points covered
          </p>
          <ul className="list-disc pl-5">
            {f.keyPointsHit.map((k) => (
              <li key={k}>{k}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {f.keyPointsMissed.length ? (
        <div>
          <p className="font-medium" style={{ color: "var(--bad)" }}>
            Key points missed
          </p>
          <ul className="list-disc pl-5">
            {f.keyPointsMissed.map((k) => (
              <li key={k}>{k}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <div>
        <p className="font-medium">Model answer</p>
        <p className="whitespace-pre-wrap">{f.modelAnswer}</p>
      </div>
    </div>
  );
}

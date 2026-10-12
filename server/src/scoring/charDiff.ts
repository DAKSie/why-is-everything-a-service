export type DiffSpan = { kind: "eq" | "del" | "ins"; text: string };

/** Simple character-level diff for short identification answers. */
export function charDiff(a: string, b: string): DiffSpan[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    Array(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] =
        a[i] === b[j]
          ? 1 + (dp[i + 1]![j + 1] as number)
          : Math.max(dp[i + 1]![j] as number, dp[i]![j + 1] as number);
    }
  }
  const spans: DiffSpan[] = [];
  let i = 0;
  let j = 0;
  const push = (kind: DiffSpan["kind"], ch: string) => {
    const last = spans[spans.length - 1];
    if (last && last.kind === kind) last.text += ch;
    else spans.push({ kind, text: ch });
  };
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push("eq", a[i]!);
      i += 1;
      j += 1;
    } else if ((dp[i + 1]![j] as number) >= (dp[i]![j + 1] as number)) {
      push("del", a[i]!);
      i += 1;
    } else {
      push("ins", b[j]!);
      j += 1;
    }
  }
  while (i < n) {
    push("del", a[i]!);
    i += 1;
  }
  while (j < m) {
    push("ins", b[j]!);
    j += 1;
  }
  return spans;
}

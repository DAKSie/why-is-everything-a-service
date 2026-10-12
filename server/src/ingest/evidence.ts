import { answerAppearsInEvidence, normalizeServiceName } from "./validateQuestions.js";

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "to",
  "in",
  "on",
  "for",
  "at",
  "by",
  "with",
  "from",
  "as",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "that",
  "this",
  "these",
  "those",
  "which",
  "what",
  "when",
  "where",
  "who",
  "whom",
  "how",
  "does",
  "do",
  "did",
  "can",
  "could",
  "should",
  "would",
  "will",
  "may",
  "might",
  "must",
  "not",
  "no",
  "yes",
  "you",
  "your",
  "we",
  "our",
  "their",
  "its",
  "into",
  "about",
  "over",
  "under",
  "than",
  "then",
  "also",
  "only",
  "just",
  "more",
  "most",
  "such",
  "via",
  "per",
  "module",
  "notes",
  "following",
  "below",
  "above",
  "list",
  "listed",
  "true",
  "false",
  "term",
  "feature",
  "service",
  "used",
  "use",
  "using",
  "provide",
  "provides",
  "provided",
]);

/**
 * Real Module-10 notes wrap multi-bullet `<br/>` table cells across physical
 * lines, so a logical row may span several newlines. Reassemble before parsing.
 */
export function coalesceTableRows(lines: string[]): string[] {
  const out: string[] = [];
  let expectedPipes: number | null = null;
  let buf: string | null = null;

  const flush = () => {
    if (buf !== null) {
      out.push(buf);
      buf = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const trimmed = line.trim();
    const pipes = (trimmed.match(/\|/g) ?? []).length;
    const isSep = /^\|?[\s-:|]+ \|?$/.test(trimmed);
    const isCompleteRow =
      trimmed.startsWith("|") &&
      trimmed.endsWith("|") &&
      expectedPipes !== null &&
      pipes >= expectedPipes;

    if (buf !== null) {
      // A new complete row means the buffer should close first.
      if (isSep || isCompleteRow) {
        flush();
        // fall through to handle separator / complete row normally
      } else {
        buf = `${buf} ${trimmed}`;
        const bufPipes = (buf.match(/\|/g) ?? []).length;
        if (
          expectedPipes !== null &&
          bufPipes >= expectedPipes &&
          buf.trim().endsWith("|")
        ) {
          flush();
        }
        continue;
      }
    }

    if (isSep) {
      out.push(line);
      continue;
    }

    if (trimmed.startsWith("|") && pipes >= 1) {
      if (expectedPipes === null && pipes >= 2) expectedPipes = pipes;
      // Incomplete logical row (wrapped cell content / mid-cell newline)
      if (
        expectedPipes !== null &&
        (pipes < expectedPipes || !trimmed.endsWith("|"))
      ) {
        buf = trimmed;
        continue;
      }
      if (pipes >= 2 && trimmed.endsWith("|")) {
        if (expectedPipes === null) expectedPipes = pipes;
        out.push(line);
        continue;
      }
      // Lone pipe fragment before headers known — buffer it
      buf = trimmed;
      continue;
    }

    // Continuation line inside a wrapped cell (does not start with |)
    if (expectedPipes !== null && !trimmed.startsWith("#")) {
      if (out.length > 0) {
        const prev = out[out.length - 1]!;
        if (
          prev.includes("|") &&
          ((prev.match(/\|/g) ?? []).length < expectedPipes ||
            !prev.trim().endsWith("|"))
        ) {
          out[out.length - 1] = `${prev} ${trimmed}`;
          continue;
        }
      }
    }

    out.push(line);
  }
  flush();
  return out;
}

/** Split a notes chunk into sentence/bullet/table units for evidence ranking. */
export function splitChunkUnits(chunkText: string): string[] {
  const units: string[] = [];
  const lines = coalesceTableRows(chunkText.split(/\r?\n/));

  // First pass: collect markdown table blocks → header+cell joined units
  pushTableUnits(lines, units);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^\|?[\s-:|]+ \|?$/.test(line)) continue;
    if (line.includes("|") && looksLikeTableRow(line)) continue; // handled in pushTableUnits

    // Bold-label lines: **Monitors:** rest of line
    const boldLabel = line.match(/^\*\*([^*]+)\*\*:?\s*(.+)$/);
    if (boldLabel) {
      const unit = `${boldLabel[1]!.trim()}: ${boldLabel[2]!.trim()}`;
      if (unit.length >= 12) units.push(unit);
      // Also keep the raw markdown line for literal grounding
      if (chunkText.includes(line)) units.push(line);
      continue;
    }

    // Section headings that name taxonomies (e.g. Types of Load Balancers)
    const heading = line.match(/^#{2,4}\s+\*?\*?(.+?)\*?\*?\s*$/);
    if (heading) {
      const title = heading[1]!.replace(/\*\*/g, "").trim();
      if (title.length >= 8) units.push(title);
      continue;
    }

    // Bullet / list item
    const bullet = line.match(/^[-*•]\s+(.+)$/);
    if (bullet) {
      pushSentenceUnits(bullet[1]!, units);
      continue;
    }

    pushSentenceUnits(line.replace(/\*\*/g, ""), units);
  }

  // Dedupe while preserving order
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of units) {
    const key = normalizeServiceName(u);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(u.trim());
  }
  return out;
}

function looksLikeTableRow(line: string): boolean {
  return (line.match(/\|/g) ?? []).length >= 2;
}

function parseTableCells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s
    .split("|")
    .map((c) =>
      c
        .replace(/<br\s*\/?>/gi, " ")
        .replace(/\*\*/g, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((c) => c.length > 0 && !/^[-:]+$/.test(c));
}

/**
 * For each data row, emit joined "Header — cell" units and a full-row join
 * of all header/cell pairs (supports layer-7 and three-types ELB questions).
 */
function pushTableUnits(lines: string[], units: string[]): void {
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!.trim();
    if (!looksLikeTableRow(line) || /^\|?[\s-:|]+ \|?$/.test(line)) {
      i += 1;
      continue;
    }
    const headerCells = parseTableCells(line);
    if (headerCells.length < 2) {
      i += 1;
      continue;
    }
    // Look ahead for separator then data rows
    let j = i + 1;
    if (j < lines.length && /^\|?[\s-:|]+ \|?$/.test(lines[j]!.trim())) {
      j += 1;
    }
    // Header row itself is a unit (lists the column types)
    const headerJoin = headerCells.join(" | ");
    if (headerJoin.length >= 20) units.push(headerJoin);
    // Pair nearby section title if present
    for (let k = i - 1; k >= Math.max(0, i - 3); k -= 1) {
      const prev = lines[k]!.trim();
      const hm = prev.match(/^#{2,4}\s+\*?\*?(.+?)\*?\*?\s*$/);
      if (hm) {
        const title = hm[1]!.replace(/\*\*/g, "").trim();
        units.push(`${title} — ${headerJoin}`);
        break;
      }
    }

    while (j < lines.length) {
      const row = lines[j]!.trim();
      if (!looksLikeTableRow(row) || /^\|?[\s-:|]+ \|?$/.test(row)) break;
      const cells = parseTableCells(row);
      const pairs: string[] = [];
      for (let c = 0; c < Math.min(headerCells.length, cells.length); c += 1) {
        const header = headerCells[c]!;
        const cell = cells[c]!;
        if (cell.length < 8) continue;
        const joined = `${header} — ${cell}`;
        units.push(joined);
        pairs.push(joined);
      }
      if (pairs.length >= 2) {
        units.push(pairs.join(" · "));
      }
      // Also keep the raw row as a unit when long enough
      if (row.length >= 24 && cells.join(" ").length >= 24) {
        units.push(cells.join(" | "));
      }
      j += 1;
    }
    i = Math.max(j, i + 1);
  }
}

function pushSentenceUnits(text: string, units: string[]): void {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return;
  const parts = cleaned
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12);
  if (parts.length === 0) {
    if (cleaned.length >= 12) units.push(cleaned);
    return;
  }
  for (const p of parts) units.push(p);
}

function tokenSet(text: string): Set<string> {
  return new Set(
    normalizeServiceName(text)
      .split(/\s+/)
      .filter((t) => t.length > 2),
  );
}

/** Content tokens from prompt that are not answer terms / stopwords. */
export function distinctivePromptTokens(
  question: string,
  answer: string,
  aliases: string[] = [],
): string[] {
  const answerTokens = new Set<string>();
  for (const a of [answer, ...aliases]) {
    for (const t of normalizeServiceName(a).split(/\s+/)) {
      if (t.length > 2) answerTokens.add(t);
    }
  }
  return normalizeServiceName(question)
    .split(/\s+/)
    .filter(
      (t) => t.length >= 4 && !STOPWORDS.has(t) && !answerTokens.has(t),
    );
}

function lightStem(t: string): string {
  return t.replace(/(ing|ers|er|ies|es|s)$/i, "");
}

function tokenMatches(evidenceToken: string, promptToken: string): boolean {
  if (evidenceToken === promptToken) return true;
  if (evidenceToken.includes(promptToken) || promptToken.includes(evidenceToken)) {
    return true;
  }
  const a = lightStem(evidenceToken);
  const b = lightStem(promptToken);
  return a.length >= 4 && a === b;
}

/**
 * True when evidence overlaps the prompt's distinctive terms
 * (not only the answer). Requires at least one hit when distinctive tokens exist.
 */
export function evidenceSupportsPrompt(input: {
  evidence: string;
  question: string;
  answer: string;
  aliases?: string[];
}): boolean {
  const distinctive = distinctivePromptTokens(
    input.question,
    input.answer,
    input.aliases ?? [],
  );
  if (distinctive.length === 0) return true;
  const ev = [...tokenSet(input.evidence)];
  let hits = 0;
  for (const t of distinctive) {
    if (ev.some((e) => tokenMatches(e, t))) hits += 1;
  }
  // Terse notes: one distinctive hit is enough when evidence is short.
  const terse = input.evidence.replace(/\s+/g, " ").trim().length < 140;
  const need = terse ? 1 : distinctive.length >= 5 ? 2 : 1;
  return hits >= need;
}

export type EvidenceRank = {
  unit: string;
  score: number;
  hasAnswer: boolean;
  supportsPrompt: boolean;
};

/** Rank units for diagnostics (even when nothing passes filters). */
export function rankEvidenceCandidates(input: {
  chunkText: string;
  question: string;
  answer: string;
  aliases?: string[];
}): EvidenceRank[] {
  const aliases = input.aliases ?? [];
  const query = `${input.question}\n${input.answer}`;
  return splitChunkUnits(input.chunkText)
    .map((unit) => {
      const hasAnswer = answerAppearsInEvidence(input.answer, unit, aliases);
      const supportsPrompt = evidenceSupportsPrompt({
        evidence: unit,
        question: input.question,
        answer: input.answer,
        aliases,
      });
      return {
        unit,
        score: evidenceOverlapScore(unit, query),
        hasAnswer,
        supportsPrompt,
      };
    })
    .sort((a, b) => b.score - a.score);
}

/** Token-overlap score between a unit and query text (question + answer). */
export function evidenceOverlapScore(unit: string, query: string): number {
  const ut = tokenSet(unit);
  const qt = [...tokenSet(query)];
  if (ut.size === 0 || qt.length === 0) return 0;
  let hits = 0;
  for (const t of qt) {
    if (ut.has(t)) {
      hits += 1;
      continue;
    }
    for (const u of ut) {
      if (u.includes(t) || t.includes(u)) {
        hits += 0.5;
        break;
      }
    }
  }
  return hits / qt.length;
}

/**
 * Evidence is grounded if it is a literal substring OR a table-join whose
 * segments each appear in the chunk.
 */
function segmentInChunk(chunkText: string, segment: string): boolean {
  if (!segment) return false;
  if (chunkText.includes(segment)) return true;
  const plain = chunkText.replace(/\*\*/g, "");
  const segPlain = segment.replace(/\*\*/g, "").trim();
  if (plain.includes(segPlain)) return true;
  if (plain.toLowerCase().includes(segPlain.toLowerCase())) return true;
  // Whitespace-collapsed / normalized match against lines or cells
  const normSeg = normalizeServiceName(segment);
  if (!normSeg) return false;
  if (normalizeServiceName(chunkText).includes(normSeg)) return true;
  return chunkText.split(/\r?\n|\|/).some((part) => {
    const n = normalizeServiceName(part);
    return n === normSeg || n.includes(normSeg) || normSeg.includes(n);
  });
}

export function isGroundedEvidence(chunkText: string, quote: string): boolean {
  if (!quote || quote.trim().length === 0) return false;
  if (segmentInChunk(chunkText, quote)) return true;

  const segments = quote
    .split(/\s+[—–]\s+|\s+·\s+/)
    .flatMap((s) => s.split(/\s+\|\s+/))
    .map((s) => s.trim())
    .filter((s) => s.length >= 4);
  if (segments.length >= 2) {
    return segments.every((seg) => segmentInChunk(chunkText, seg));
  }
  return false;
}

/**
 * Pick the best chunk unit as evidenceQuote for (question + answer).
 * Requires answer terms AND prompt-distinctive term overlap.
 */
export function selectEvidenceQuote(input: {
  chunkText: string;
  question: string;
  answer: string;
  aliases?: string[];
}): string | null {
  const aliases = input.aliases ?? [];
  const query = `${input.question}\n${input.answer}\n${aliases.join(" ")}`;
  const units = splitChunkUnits(input.chunkText);
  let best: string | null = null;
  let bestScore = -1;

  for (const unit of units) {
    let literal: string | null = null;
    if (isGroundedEvidence(input.chunkText, unit)) {
      literal = unit;
    } else {
      literal = findLiteralForm(input.chunkText, unit);
    }
    if (!literal) continue;
    if (literal.replace(/\*\*/g, "").trim().length < 24) continue;
    if (!answerAppearsInEvidence(input.answer, literal, aliases)) continue;
    if (
      !evidenceSupportsPrompt({
        evidence: literal,
        question: input.question,
        answer: input.answer,
        aliases,
      })
    ) {
      continue;
    }
    const score =
      evidenceOverlapScore(literal, query) +
      // Prefer units that hit more distinctive prompt tokens
      distinctivePromptTokens(input.question, input.answer, aliases).filter(
        (t) => normalizeServiceName(literal!).includes(t),
      ).length *
        0.15;
    if (score > bestScore) {
      bestScore = score;
      best = literal;
    }
  }

  if (!best || bestScore <= 0) return null;
  return best;
}

function findLiteralForm(chunkText: string, unit: string): string | null {
  if (chunkText.includes(unit)) return unit;
  const boldWhole = `**${unit}**`;
  if (chunkText.includes(boldWhole)) return boldWhole;
  if (isGroundedEvidence(chunkText, unit)) return unit;
  const norm = normalizeServiceName(unit);
  for (const line of chunkText.split(/\r?\n/)) {
    const stripped = line.replace(/\*\*/g, "").trim();
    if (normalizeServiceName(stripped) === norm && chunkText.includes(line.trim())) {
      return line.trim();
    }
    if (
      normalizeServiceName(stripped).includes(norm) &&
      stripped.includes(unit) &&
      chunkText.includes(stripped)
    ) {
      return stripped;
    }
  }
  return null;
}

/** Legacy helper: first long-enough unit (used when no Q/A yet). */
export function pickEvidenceQuote(chunkText: string, hint?: string): string | null {
  if (hint) {
    const selected = selectEvidenceQuote({
      chunkText,
      question: hint,
      answer: hint,
    });
    if (selected) return selected;
  }
  const units = splitChunkUnits(chunkText).filter(
    (u) =>
      u.length >= 40 &&
      u.length <= 400 &&
      isGroundedEvidence(chunkText, u),
  );
  if (units.length > 0) return units[0]!;
  const fallback = chunkText.replace(/\s+/g, " ").trim().slice(0, 200);
  return chunkText.includes(fallback) ? fallback : null;
}

/** Resolve a unit to a literal substring of the chunk when possible. */
function resolveLiteralUnit(chunkText: string, unit: string): string | null {
  if (chunkText.includes(unit)) return unit;
  const plain = unit.replace(/\*\*/g, "").trim();
  for (const raw of chunkText.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const stripped = line.replace(/\*\*/g, "").replace(/^[-*•]\s+/, "").trim();
    if (normalizeServiceName(stripped) === normalizeServiceName(plain)) {
      // Prefer bullet body without marker if that's what appears in prose checks;
      // keep full markdown line when it is the only literal form.
      if (chunkText.includes(line)) return line;
    }
    // Bold-label unit "Monitors: rest" ↔ "**Monitors:** rest"
    const bold = line.match(/^\*\*([^*]+)\*\*:?\s*(.+)$/);
    if (bold) {
      const asUnit = `${bold[1]!.trim()}: ${bold[2]!.trim()}`;
      if (normalizeServiceName(asUnit) === normalizeServiceName(plain)) {
        return line;
      }
    }
  }
  if (chunkText.replace(/\*\*/g, "").includes(plain) && plain.length >= 24) {
    // Find original line containing this plain text
    const hit = chunkText.split(/\r?\n/).find((l) =>
      l.replace(/\*\*/g, "").includes(plain),
    );
    return hit?.trim() ?? null;
  }
  return null;
}

/** Pick 2–4 literal sentence/bullet/bold-label units as situational keyPoints. */
export function selectKeyPointUnits(
  chunkText: string,
  count = 3,
): string[] {
  const units = splitChunkUnits(chunkText).filter((u) => {
    if (u.includes(" — ") || u.includes(" · ")) return false; // skip table joins
    if (u.includes(" | ") && u.length > 120) return false; // skip wide header joins
    if (/https?:\/\//i.test(u) || /\[lab:/i.test(u)) return false; // skip lab/link chrome
    if (u.length < 30 || u.length > 320) return false;
    return true;
  });
  const scored = units.map((u, idx) => ({
    u,
    score:
      (u.match(
        /\b(auto|scale|monitor|load|alarm|target|instance|event|metric|elastic)\b/i,
      )
        ? 2
        : 0) +
      Math.min(u.length, 160) / 160 -
      idx * 0.01,
  }));
  scored.sort((a, b) => b.score - a.score);
  const picked: string[] = [];
  const seen = new Set<string>();
  for (const { u } of scored) {
    const lit = resolveLiteralUnit(chunkText, u);
    if (!lit || !chunkText.includes(lit)) continue;
    const key = normalizeServiceName(lit).slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(lit);
    if (picked.length >= count) break;
  }
  return picked.slice(0, Math.max(2, Math.min(4, count)));
}

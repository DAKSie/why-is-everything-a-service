import { normalizeServiceName } from "./validateQuestions.js";
import { splitChunkUnits } from "./evidence.js";
import type { ConceptTag } from "./conceptTags.js";

export type GlossaryEntry = {
  term: string;
  aliases: string[];
};

/** Display names + aliases for concept tags and common Module services. */
export const TERM_GLOSSARY: GlossaryEntry[] = [
  {
    term: "Amazon CloudWatch",
    aliases: ["CloudWatch", "Amazon CloudWatch"],
  },
  {
    term: "Amazon EC2 Auto Scaling",
    aliases: ["EC2 Auto Scaling", "Auto Scaling", "Amazon EC2 Auto Scaling"],
  },
  {
    term: "Auto Scaling group",
    aliases: ["Auto Scaling Group", "ASG"],
  },
  {
    term: "Elastic Load Balancing",
    aliases: ["ELB", "Elastic Load Balancer"],
  },
  {
    term: "Application Load Balancer",
    aliases: ["ALB", "application load balancer"],
  },
  {
    term: "Network Load Balancer",
    aliases: ["NLB", "network load balancer"],
  },
  {
    term: "Classic Load Balancer",
    aliases: ["CLB", "classic load balancer"],
  },
  {
    term: "Amazon SNS",
    aliases: ["SNS", "Simple Notification Service", "Amazon Simple Notification Service"],
  },
  {
    term: "Amazon EC2",
    aliases: ["EC2", "Elastic Compute Cloud"],
  },
  {
    term: "AWS CloudTrail",
    aliases: ["CloudTrail"],
  },
  {
    term: "target groups",
    aliases: ["target group"],
  },
  {
    term: "Scale out",
    aliases: ["scale out", "launch instances"],
  },
  {
    term: "Scale in",
    aliases: ["scale in", "terminate instances"],
  },
];

const TAG_TO_TERMS: Partial<Record<ConceptTag, string[]>> = {
  cloudwatch: ["Amazon CloudWatch"],
  "auto-scaling": ["Amazon EC2 Auto Scaling", "Auto Scaling group"],
  elb: [
    "Elastic Load Balancing",
    "Application Load Balancer",
    "Network Load Balancer",
    "Classic Load Balancer",
  ],
  ec2: ["Amazon EC2"],
};

export type ClozeCandidate = {
  /** Sentence/bullet with the term blanked. */
  clozeSentence: string;
  /** Original sentence (evidence by construction). */
  evidenceQuote: string;
  answer: string;
  aliases: string[];
  /** Draft prompt before optional model reword. */
  prompt: string;
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Collect glossary entries relevant to this chunk (tags + terms found in text). */
export function glossaryForChunk(
  chunkText: string,
  conceptTags: ConceptTag[],
): GlossaryEntry[] {
  const wanted = new Set<string>();
  for (const tag of conceptTags) {
    for (const t of TAG_TO_TERMS[tag] ?? []) wanted.add(normalizeServiceName(t));
  }
  const out: GlossaryEntry[] = [];
  for (const entry of TERM_GLOSSARY) {
    const forms = [entry.term, ...entry.aliases];
    const inText = forms.some((f) =>
      normalizeServiceName(chunkText).includes(normalizeServiceName(f)),
    );
    const tagged = wanted.has(normalizeServiceName(entry.term));
    if (inText || tagged) out.push(entry);
  }
  return out;
}

/** Extract **bold** spans that look like key terms (not section chrome). */
export function extractBoldTerms(chunkText: string): string[] {
  const terms: string[] = [];
  const re = /\*\*([^*]+)\*\*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(chunkText)) !== null) {
    const t = m[1]!.replace(/:$/, "").trim();
    if (t.length < 3 || t.length > 48) continue;
    if (/^(types of|section|objectives|labs)/i.test(t)) continue;
    // Prefer noun-like labels; skip pure verbs used as field labels when short
    terms.push(t);
  }
  return terms;
}

/** Acronyms (2–5 caps) that appear in the chunk and map to a glossary entry. */
export function extractAcronymHits(
  chunkText: string,
  glossary: GlossaryEntry[],
): GlossaryEntry[] {
  const hits: GlossaryEntry[] = [];
  const acronyms = chunkText.match(/\b[A-Z]{2,5}\b/g) ?? [];
  const seen = new Set<string>();
  for (const ac of acronyms) {
    if (seen.has(ac)) continue;
    seen.add(ac);
    const entry = glossary.find(
      (g) =>
        g.aliases.some((a) => a.toUpperCase() === ac) ||
        normalizeServiceName(g.term)
          .split(/\s+/)
          .map((w) => w[0])
          .join("")
          .toUpperCase() === ac,
    );
    if (entry) hits.push(entry);
  }
  return hits;
}

function findTermInUnit(
  unit: string,
  entry: GlossaryEntry,
): { start: number; end: number; matched: string } | null {
  const forms = [entry.term, ...entry.aliases].sort((a, b) => b.length - a.length);
  for (const form of forms) {
    const re = new RegExp(`\\b${escapeRegExp(form)}\\b`, "i");
    const m = unit.match(re);
    if (m && m.index !== undefined) {
      return { start: m.index, end: m.index + m[0].length, matched: m[0] };
    }
  }
  return null;
}

/**
 * Build cloze identification candidates from a chunk.
 * Answer and evidence are chosen in code; the model may only reword `prompt`.
 */
export function buildClozeCandidates(
  chunkText: string,
  conceptTags: ConceptTag[],
): ClozeCandidate[] {
  const glossary = glossaryForChunk(chunkText, conceptTags);
  const bold = extractBoldTerms(chunkText);
  for (const b of bold) {
    if (!glossary.some((g) => normalizeServiceName(g.term) === normalizeServiceName(b))) {
      glossary.push({ term: b, aliases: [b] });
    }
  }
  // Prefer glossary hits for acronyms already in list
  extractAcronymHits(chunkText, glossary);

  const units = splitChunkUnits(chunkText).filter((u) => {
    // Prefer units that exist literally (or as bold-stripped) in the chunk
    return (
      chunkText.includes(u) ||
      chunkText.replace(/\*\*/g, "").includes(u) ||
      u.length >= 20
    );
  });

  const candidates: ClozeCandidate[] = [];
  const seen = new Set<string>();

  for (const unit of units) {
    // Never cloze from markdown tables / pipe-separated rows.
    if (unit.includes("|") || unit.includes(" — ") || unit.includes(" · ")) {
      continue;
    }
    // Resolve a literal evidence form present in the chunk
    let evidence = unit;
    if (!chunkText.includes(evidence)) {
      const strippedLine = chunkText
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find(
          (l) =>
            normalizeServiceName(l.replace(/\*\*/g, "")) ===
              normalizeServiceName(unit) ||
            normalizeServiceName(l.replace(/\*\*/g, "")).includes(
              normalizeServiceName(unit),
            ),
        );
      if (strippedLine && chunkText.includes(strippedLine)) {
        evidence = strippedLine;
      } else {
        continue;
      }
    }

    const plain = evidence.replace(/\*\*/g, "");
    // Longest glossary match wins so "Auto Scaling group" beats "Auto Scaling".
    type Hit = {
      entry: GlossaryEntry;
      start: number;
      end: number;
      matched: string;
    };
    const hits: Hit[] = [];
    for (const entry of glossary) {
      const hitPlain = findTermInUnit(plain, entry);
      if (!hitPlain) continue;
      // Avoid "Amazon EC2" cloze from "... EC2 instances ..." (answer leaks from context).
      const after = plain.slice(hitPlain.end).trimStart();
      if (
        normalizeServiceName(entry.term) === "ec2" &&
        /^instances?\b/i.test(after)
      ) {
        continue;
      }
      hits.push({ entry, ...hitPlain });
    }
    hits.sort((a, b) => b.matched.length - a.matched.length || a.start - b.start);

    const claimed = new Set<string>();
    for (const hit of hits) {
      const spanKey = `${hit.start}:${hit.end}`;
      // Skip overlaps with a longer match already taken
      let overlaps = false;
      for (const c of claimed) {
        const [cs, ce] = c.split(":").map(Number) as [number, number];
        if (hit.start < ce && hit.end > cs) {
          overlaps = true;
          break;
        }
      }
      if (overlaps) continue;
      claimed.add(spanKey);

      const clozeSentence =
        plain.slice(0, hit.start) + "____" + plain.slice(hit.end);
      const aliases = [
        ...new Set(
          [hit.entry.term, ...hit.entry.aliases].filter(
            (a) =>
              normalizeServiceName(a) !== normalizeServiceName(hit.entry.term),
          ),
        ),
      ];
      const key = `${normalizeServiceName(hit.entry.term)}|${normalizeServiceName(plain)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const prompt = `Fill in the blank (from the Module notes): "${clozeSentence}"`;
      candidates.push({
        clozeSentence,
        evidenceQuote: evidence,
        answer: hit.entry.term,
        aliases,
        prompt,
      });
    }
  }

  // Stable order: longer evidence first, then answer name
  candidates.sort((a, b) => {
    const dl = b.evidenceQuote.length - a.evidenceQuote.length;
    if (dl !== 0) return dl;
    return a.answer.localeCompare(b.answer);
  });

  return candidates;
}

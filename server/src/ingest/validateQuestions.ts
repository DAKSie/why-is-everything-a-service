import { normalizePrompt } from "../questions/ids.js";

const MAX_OPTION_WORDS = 12;

const AMBIGUOUS_PROMPT =
  /\b(this is done via|the service that|which of the following services? performs|done via the service)\b/i;

/** Basic punctuation/case collapse (legacy helper). */
export function normalizeAnswerText(text: string): string {
  return normalizePrompt(text);
}

/**
 * Normalize AWS naming variants for evidence matching:
 * lowercase, strip Amazon/AWS/EC2 prefixes, collapse whitespace/punctuation.
 */
export function normalizeServiceName(text: string): string {
  let s = text.toLowerCase().normalize("NFKC");
  s = s.replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
  let prev = "";
  while (s !== prev) {
    prev = s;
    s = s.replace(/^(amazon|aws|ec2)\s+/, "").trim();
  }
  return s;
}

/** True if answer or any alias appears in evidence after service-name normalization. */
export function answerAppearsInEvidence(
  answer: string,
  evidence: string,
  aliases: string[] = [],
): boolean {
  const quote = normalizeServiceName(evidence);
  if (!quote) return false;
  const candidates = [answer, ...aliases]
    .map((a) => normalizeServiceName(a))
    .filter((a) => a.length > 0);
  for (const c of candidates) {
    if (quote.includes(c)) return true;
  }
  return false;
}

/**
 * True when answer terms appear in the prompt after normalization
 * (lowercase, strip Amazon/AWS/EC2 prefixes) — a leak.
 */
export function answerLeaksInPrompt(
  prompt: string,
  answer: string,
  aliases: string[] = [],
): boolean {
  const p = normalizeServiceName(prompt);
  if (!p) return false;
  const candidates = [answer, ...aliases]
    .map((a) => normalizeServiceName(a))
    .filter((a) => a.length >= 3);
  for (const c of candidates) {
    if (p.includes(c)) return true;
    // Multi-word: also flag if all significant tokens appear in prompt
    const tokens = c.split(/\s+/).filter((t) => t.length >= 3);
    if (tokens.length >= 2 && tokens.every((t) => p.includes(t))) return true;
  }
  return false;
}

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Detect numbered/list-blob MC options. */
export function looksLikeListBlob(option: string): boolean {
  const t = option.trim();
  if (/\n/.test(t)) return true;
  if (/^\s*\d+\.\s+/m.test(t)) return true;
  if ((t.match(/\b\d+\.\s+/g) ?? []).length >= 2) return true;
  if ((t.match(/;/g) ?? []).length >= 2 && wordCount(t) > 12) return true;
  return false;
}

export function validateMultipleChoiceOptions(options: string[]): {
  ok: boolean;
  reason?: string;
} {
  if (options.length < 2) {
    return { ok: false, reason: "multiple_choice needs at least 2 options" };
  }
  for (const opt of options) {
    if (looksLikeListBlob(opt)) {
      return {
        ok: false,
        reason: `option is a list blob: "${opt.slice(0, 80)}"`,
      };
    }
    if (wordCount(opt) > MAX_OPTION_WORDS) {
      return {
        ok: false,
        reason: `option exceeds ${MAX_OPTION_WORDS} words (${wordCount(opt)}): "${opt}"`,
      };
    }
  }
  return { ok: true };
}

/** True when the prompt is a NOT / EXCEPT style multiple-choice. */
export function isNotExceptPrompt(prompt: string): boolean {
  return /\b(NOT|EXCEPT)\b/.test(prompt);
}

/**
 * Loose attestation for MC options vs evidence (handles "Manual scaling"
 * vs notes that say "Manual, scheduled, …").
 */
export function optionAppearsInEvidence(
  option: string,
  evidence: string,
): boolean {
  if (answerAppearsInEvidence(option, evidence)) return true;
  const quote = normalizeServiceName(evidence);
  const opt = normalizeServiceName(option);
  const core = opt
    .replace(/\b(scaling|option|options|load balancers?|balancers?)\b/g, "")
    .trim()
    .replace(/\s+/g, " ");
  if (core.length >= 3 && quote.includes(core)) return true;
  const stop = new Set(["scaling", "option", "options", "load", "balancer", "balancers"]);
  const tokens = opt.split(/\s+/).filter((t) => t.length >= 4 && !stop.has(t));
  if (tokens.length === 0) return false;
  return tokens.every((t) => quote.includes(t));
}

/**
 * NOT/EXCEPT MC: every distractor must appear in evidence; the correct
 * answer must NOT appear (otherwise the "exception" is still attested).
 */
export function validateNotExceptMultipleChoice(input: {
  prompt: string;
  options: string[];
  correctIndices: number[];
  evidenceQuote: string;
}): { ok: boolean; reason?: string } {
  if (!isNotExceptPrompt(input.prompt)) return { ok: true };
  const quote = input.evidenceQuote ?? "";
  if (!quote.trim()) {
    return { ok: false, reason: "NOT/EXCEPT requires evidenceQuote" };
  }
  const correct = new Set(input.correctIndices);
  for (let i = 0; i < input.options.length; i += 1) {
    const opt = input.options[i]!;
    const inEvidence = optionAppearsInEvidence(opt, quote);
    if (correct.has(i)) {
      if (inEvidence) {
        return {
          ok: false,
          reason: `NOT/EXCEPT correct answer appears in evidence: "${opt}"`,
        };
      }
    } else if (!inEvidence) {
      return {
        ok: false,
        reason: `NOT/EXCEPT distractor missing from evidence: "${opt}"`,
      };
    }
  }
  return { ok: true };
}

/**
 * Mechanical identification checks (not model-based).
 * - normalized answer (or alias) must appear in evidenceQuote
 * - prompt must name enough context for a unique answer
 */
export function validateIdentification(input: {
  prompt: string;
  acceptedAnswers: string[];
  aliases?: string[];
  evidenceQuote?: string;
}): { ok: boolean; reason?: string } {
  const quote = input.evidenceQuote ?? "";
  if (!quote.trim()) {
    return { ok: false, reason: "identification requires evidenceQuote" };
  }
  const answer = input.acceptedAnswers[0] ?? "";
  if (!normalizeServiceName(answer)) {
    return { ok: false, reason: "empty accepted answer" };
  }
  const aliases = input.aliases ?? [];
  if (!answerAppearsInEvidence(answer, quote, aliases)) {
    return {
      ok: false,
      reason: `normalized answer not found in evidenceQuote: "${answer}"`,
    };
  }

  const isCloze = /____/.test(input.prompt);

  if (AMBIGUOUS_PROMPT.test(input.prompt) && !isCloze) {
    return {
      ok: false,
      reason: "prompt is underspecified (multiple answers could fit)",
    };
  }

  const contextCue =
    /\b(amazon|aws|cloudwatch|auto\s*scaling|elastic load|load balancer|application load|network load|classic load|ec2|sns|target group|scale out|scale in)\b/i;
  // Cloze prompts carry context in the blanked sentence; non-cloze must name a service.
  if (!isCloze && !contextCue.test(input.prompt)) {
    return {
      ok: false,
      reason: "prompt lacks named service/concept context for a unique answer",
    };
  }

  const peers = [
    "application load balancer",
    "network load balancer",
    "classic load balancer",
  ];
  const normQuote = normalizeServiceName(quote);
  const normAnswer = normalizeServiceName(answer);
  const peersInQuote = peers.filter((p) => normQuote.includes(p));
  const answerIsPeer = peers.some(
    (p) => normAnswer === p || normAnswer.includes(p) || p.includes(normAnswer),
  );
  if (peersInQuote.length >= 2 && answerIsPeer) {
    const promptNorm = normalizeServiceName(input.prompt);
    const namesAnswer = peers.find(
      (p) => normAnswer === p || normAnswer.includes(p),
    );
    if (namesAnswer && !promptNorm.includes(namesAnswer)) {
      const uniqueTrait =
        (namesAnswer.startsWith("application") &&
          /content of (the )?request|layer 7|http/i.test(input.prompt)) ||
        (namesAnswer.startsWith("network") &&
          /layer 4|tcp|udp|ultra-low|ip protocol/i.test(input.prompt)) ||
        (namesAnswer.startsWith("classic") &&
          /previous generation|classic/i.test(input.prompt));
      if (!uniqueTrait) {
        return {
          ok: false,
          reason:
            "prompt does not uniquely identify which load balancer; multiple peers in evidence",
        };
      }
    }
  }

  return { ok: true };
}

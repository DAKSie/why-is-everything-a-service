import { normalizePrompt } from "../questions/ids.js";

const MAX_OPTION_WORDS = 12;

const AMBIGUOUS_PROMPT =
  /\b(this is done via|the service that|which of the following services? performs|done via the service)\b/i;

/** Normalize for substring checks (answers inside evidence). */
export function normalizeAnswerText(text: string): string {
  return normalizePrompt(text);
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

/**
 * Mechanical identification checks (not model-based).
 * - normalized answer must appear in evidenceQuote
 * - prompt must name enough context for a unique answer
 */
export function validateIdentification(input: {
  prompt: string;
  acceptedAnswers: string[];
  evidenceQuote?: string;
}): { ok: boolean; reason?: string } {
  const quote = input.evidenceQuote ?? "";
  if (!quote.trim()) {
    return { ok: false, reason: "identification requires evidenceQuote" };
  }
  const normQuote = normalizeAnswerText(quote);
  const answer = input.acceptedAnswers[0] ?? "";
  const normAnswer = normalizeAnswerText(answer);
  if (!normAnswer) {
    return { ok: false, reason: "empty accepted answer" };
  }
  if (!normQuote.includes(normAnswer)) {
    return {
      ok: false,
      reason: `normalized answer not found in evidenceQuote: "${answer}"`,
    };
  }

  if (AMBIGUOUS_PROMPT.test(input.prompt)) {
    return {
      ok: false,
      reason: "prompt is underspecified (multiple answers could fit)",
    };
  }

  // Prompt must name a concrete AWS/product context, not only a vague clause.
  const contextCue =
    /\b(amazon|aws|cloudwatch|auto\s*scaling|elastic load|load balancer|application load|network load|classic load|ec2|sns|target group|scale out|scale in)\b/i;
  if (!contextCue.test(input.prompt)) {
    return {
      ok: false,
      reason: "prompt lacks named service/concept context for a unique answer",
    };
  }

  // If evidence mentions several peer LBs and answer is one of them, prompt must
  // uniquely point at that peer (not a generic ELB scaling sentence).
  const peers = [
    "application load balancer",
    "network load balancer",
    "classic load balancer",
  ];
  const peersInQuote = peers.filter((p) => normQuote.includes(p));
  const answerIsPeer = peers.some(
    (p) => normAnswer === p || normAnswer.includes(p) || p.includes(normAnswer),
  );
  if (peersInQuote.length >= 2 && answerIsPeer) {
    const promptNorm = normalizeAnswerText(input.prompt);
    if (!peers.some((p) => promptNorm.includes(p) && normAnswer.includes(p.split(" ")[0]!))) {
      // Require the prompt to include the specific LB name (or clear unique trait).
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
  }

  return { ok: true };
}

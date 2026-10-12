import { stripMarkdown } from "./markdown.js";
import { deriveConceptTags } from "./conceptTags.js";
import type { NoteChunk } from "./notesParser.js";
import type { QuestionInput } from "../questions/schema.js";
import {
  attachOutdatedToQuestion,
  topicMcExplanation,
} from "../questions/outdatedAttach.js";
import { distinctivePromptTokens } from "./evidence.js";
import { normalizeServiceName } from "./validateQuestions.js";

/** Headings that are valid "which topic" answers. */
const TOPIC_HEADING =
  /\b(ebs|elastic block|s3|simple storage|efs|elastic file|glacier|rds|dynamodb|redshift|aurora|ec2|lambda|ecs|eks|fargate|elb|elastic load|cloudwatch|auto\s*scaling|security|iam|well[-\s]?architected|operational excellence|security|reliability|performance efficiency|cost optimization|trusted advisor)\b/i;

export type TopicMcCandidate = QuestionInput;

function headingDisplayName(heading: string): string {
  return stripMarkdown(heading)
    .replace(/^section\s*\d+\s*:\s*/i, "")
    .trim();
}

function siblingTopics(chunks: NoteChunk[], self: NoteChunk): string[] {
  const names = new Set<string>();
  for (const c of chunks) {
    if (c.module !== self.module) continue;
    if (c.headingPath.join(">") === self.headingPath.join(">")) continue;
    const name = headingDisplayName(c.heading);
    if (name.length >= 2 && name.length <= 48 && TOPIC_HEADING.test(name)) {
      names.add(name);
    }
  }
  return [...names];
}

function bulletsUnderChunk(chunk: NoteChunk): string[] {
  const out: string[] = [];
  for (const line of chunk.text.split(/\r?\n/)) {
    const m = line.trim().match(/^[-*•]\s+(.+)$/);
    if (!m) continue;
    const body = stripMarkdown(m[1]!).trim();
    if (body.length < 28 || body.length > 220) continue;
    if (body.includes("|")) continue;
    if (/^(additional configuration|knowledge check|walkthrough|password|---)/i.test(body)) {
      continue;
    }
    if (/^[-–—\s]+$/.test(body)) continue;
    out.push(body);
  }
  // Also allow short non-bullet sentences when few bullets
  if (out.length < 2) {
    for (const part of chunk.text.split(/(?<=[.!?])\s+/)) {
      const body = stripMarkdown(part).trim();
      if (body.length >= 40 && body.length <= 200 && !body.includes("|")) {
        out.push(body);
      }
    }
  }
  return [...new Set(out)];
}

function siblingBodyText(chunks: NoteChunk[], self: NoteChunk): string {
  return chunks
    .filter(
      (c) =>
        c.module === self.module &&
        c.headingPath.join(">") !== self.headingPath.join(">"),
    )
    .map((c) => stripMarkdown(c.text))
    .join("\n");
}

/**
 * Code-built MC: prompt = bullet under a service/pillar heading;
 * answer = heading; distractors = sibling topic names.
 */
export function buildTopicMultipleChoice(
  chunks: NoteChunk[],
): TopicMcCandidate[] {
  const results: TopicMcCandidate[] = [];
  const seen = new Set<string>();

  for (const chunk of chunks) {
    const answer = headingDisplayName(chunk.heading);
    if (!TOPIC_HEADING.test(answer)) continue;
    const siblings = siblingTopics(chunks, chunk).filter(
      (s) => normalizeServiceName(s) !== normalizeServiceName(answer),
    );
    if (siblings.length < 2) continue;

    const siblingHay = normalizeServiceName(siblingBodyText(chunks, chunk));
    const bullets = bulletsUnderChunk(chunk);

    for (const bullet of bullets) {
      const distinctive = distinctivePromptTokens(bullet, answer);
      // Ambiguity: distinctive tokens also under a sibling heading's body
      const ambiguous = distinctive.filter((t) => siblingHay.includes(t));
      if (ambiguous.length >= Math.max(2, Math.ceil(distinctive.length * 0.5))) {
        continue;
      }

      const distractors = siblings
        .sort((a, b) => a.localeCompare(b))
        .slice(0, 3);
      while (distractors.length < 3 && siblings.length > distractors.length) {
        const next = siblings[distractors.length];
        if (next) distractors.push(next);
        else break;
      }
      if (distractors.length < 2) continue;

      const options = [answer, ...distractors.slice(0, 3)];
      // Stable shuffle by bullet hash order: sort options with answer fixed at computed index
      const ordered = [...options].sort((a, b) => a.localeCompare(b));
      const correctIndices = [ordered.indexOf(answer)];
      if (correctIndices[0]! < 0) continue;

      const key = `${normalizeServiceName(answer)}|${normalizeServiceName(bullet).slice(0, 60)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const tags = deriveConceptTags(chunk.heading, bullet, chunk.text);
      const pillar =
        /\b(operational excellence|security|reliability|performance efficiency|cost optimization|well[-\s]?architected|trusted advisor)\b/i.test(
          answer,
        );
      const conceptTags =
        tags.length > 0
          ? tags
          : chunk.conceptTags.length > 0
            ? chunk.conceptTags
            : pillar
              ? (["well-architected"] as const)
              : (["ec2"] as const);
      const draft: QuestionInput = {
        module: chunk.module as 6 | 7 | 8 | 9 | 10,
        topic: chunk.heading,
        conceptTags: [...conceptTags],
        type: "multiple_choice",
        difficulty: 1,
        prompt: `Which topic does this describe?\n\n${bullet}`,
        options: ordered,
        correctIndices,
        explanation: topicMcExplanation(answer, bullet),
        source: "notes",
        sourceRef: {
          file: chunk.filename,
          heading: chunk.headingPath.join(" > "),
        },
        needsReview: false,
        evidenceQuote: bullet,
      };
      results.push(attachOutdatedToQuestion(draft));
    }
  }

  results.sort((a, b) =>
    `${a.sourceRef.heading}|${a.prompt}`.localeCompare(
      `${b.sourceRef.heading}|${b.prompt}`,
    ),
  );
  return results;
}

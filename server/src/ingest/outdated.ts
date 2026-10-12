export type OutdatedFlag = {
  needsReview: boolean;
  outdatedNote?: string;
};

/** Known stale note/Anki topics → needsReview + reason. */
export function detectOutdated(...texts: string[]): OutdatedFlag {
  const hay = texts.join("\n");
  const hits: string[] = [];

  if (/\b(5 pillars|five pillars)\b/i.test(hay) && /well[-\s]?architected/i.test(hay)) {
    hits.push("Notes/Anki predate the Sustainability pillar (still list five pillars).");
  }
  if (/\bscheduled reserved instances?\b/i.test(hay)) {
    hits.push("Mentions Scheduled Reserved Instances (retired).");
  }
  if (/\bspot instances?\b/i.test(hay) && /\bbid\b/i.test(hay)) {
    hits.push("Uses Spot 'bid' language; Spot pricing model has changed.");
  } else if (/\bspot instances?\b/i.test(hay)) {
    hits.push("Spot Instances content may reflect older pricing/interruption wording.");
  }
  if (/\bclassic load balancer\b/i.test(hay)) {
    hits.push(
      "Features Classic Load Balancer (previous generation); Gateway Load Balancer is not covered in these notes.",
    );
  }
  // Only flag CloudWatch Events items (answer/prompt), not every CloudWatch chunk.
  if (
    /\bcloudwatch events\b/i.test(hay) ||
    texts.some((t) => /^events$/i.test(t.trim()))
  ) {
    hits.push("CloudWatch Events is now Amazon EventBridge.");
  }
  if (/\b(amazon\s+)?s3 glacier\b|\bglacier\b/i.test(hay)) {
    hits.push("Uses Amazon S3 Glacier naming from the notes era; storage-class naming has evolved.");
  }

  if (hits.length === 0) return { needsReview: false };
  return { needsReview: true, outdatedNote: hits.join(" ") };
}

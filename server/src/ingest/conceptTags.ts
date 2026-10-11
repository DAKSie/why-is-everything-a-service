/** Canonical tags from PLAN.md §5 — match headings + body key terms. */
export const CANONICAL_CONCEPT_TAGS = [
  "ec2",
  "ami",
  "s3",
  "ebs",
  "efs",
  "glacier",
  "rds",
  "dynamodb",
  "aurora",
  "redshift",
  "well-architected",
  "trusted-advisor",
  "elb",
  "cloudwatch",
  "auto-scaling",
  "security-groups",
  "iam",
  "lambda",
  "ecs",
  "eks",
] as const;

export type ConceptTag = (typeof CANONICAL_CONCEPT_TAGS)[number];

const PATTERNS: Array<{ tag: ConceptTag; re: RegExp }> = [
  { tag: "ec2", re: /\b(amazon\s+)?ec2\b|\belastic compute cloud\b/i },
  { tag: "ami", re: /\bamis?\b|\bamazon machine image\b/i },
  { tag: "s3", re: /\b(amazon\s+)?s3\b|\bsimple storage service\b/i },
  { tag: "ebs", re: /\b(amazon\s+)?ebs\b|\belastic block store\b/i },
  { tag: "efs", re: /\b(amazon\s+)?efs\b|\belastic file system\b/i },
  { tag: "glacier", re: /\bglacier\b/i },
  { tag: "rds", re: /\b(amazon\s+)?rds\b|\brelational database service\b/i },
  { tag: "dynamodb", re: /\bdynamodb\b/i },
  { tag: "aurora", re: /\baurora\b/i },
  { tag: "redshift", re: /\bredshift\b/i },
  {
    tag: "well-architected",
    re: /\bwell[-\s]?architected\b|\bfive pillars\b|\b5 pillars\b/i,
  },
  { tag: "trusted-advisor", re: /\btrusted advisor\b/i },
  {
    tag: "elb",
    re: /\belastic load balanc|\bapplication load balancer\b|\bnetwork load balancer\b|\bclassic load balancer\b|\belb\b/i,
  },
  { tag: "cloudwatch", re: /\bcloudwatch\b/i },
  { tag: "auto-scaling", re: /\bauto\s*scaling\b|\bscale out\b|\bscale in\b/i },
  { tag: "security-groups", re: /\bsecurity groups?\b/i },
  { tag: "iam", re: /\b\biam\b|\bidentity and access management\b/i },
  { tag: "lambda", re: /\b(aws\s+)?lambda\b/i },
  {
    tag: "ecs",
    re: /\b(amazon\s+)?ecs\b|\belastic container service\b|\belastic container registry\b|\becr\b|\bfargate\b/i,
  },
  {
    tag: "eks",
    re: /\b(amazon\s+)?eks\b|\belastic kubernetes service\b/i,
  },
];

export function deriveConceptTags(...texts: string[]): ConceptTag[] {
  const haystack = texts.join("\n");
  const found = new Set<ConceptTag>();
  for (const { tag, re } of PATTERNS) {
    if (re.test(haystack)) found.add(tag);
  }
  return CANONICAL_CONCEPT_TAGS.filter((t) => found.has(t));
}

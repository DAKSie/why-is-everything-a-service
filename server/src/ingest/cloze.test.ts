import { describe, expect, it } from "vitest";
import { buildClozeCandidates, extractBoldTerms } from "./cloze.js";
import { answerAppearsInEvidence } from "./validateQuestions.js";

const MODULE10_SNIPPET = `
Elastic Load Balancing distributes incoming application or network traffic across multiple targets in a single Availability Zone or across multiple Availability Zones. Monitoring is done via Amazon CloudWatch, access logs, and AWS CloudTrail logs

- With Application Load Balancers and Network Load Balancers, you register targets in target groups, and route traffic to the target groups.
- An Auto Scaling group is a collection of EC2 instances that are treated as a logical grouping for the purposes of automatic scaling and management.
- Scale out (launch instances), Scale in (terminate instances)

**Monitors:** AWS resources and applications that run on AWS
`.trim();

describe("buildClozeCandidates", () => {
  it("builds several cloze items with answer present in evidence", () => {
    const candidates = buildClozeCandidates(MODULE10_SNIPPET, [
      "elb",
      "cloudwatch",
      "auto-scaling",
      "ec2",
    ]);
    expect(candidates.length).toBeGreaterThanOrEqual(3);
    for (const c of candidates) {
      expect(c.clozeSentence).toContain("____");
      expect(
        answerAppearsInEvidence(c.answer, c.evidenceQuote, c.aliases),
      ).toBe(true);
      expect(MODULE10_SNIPPET.includes(c.evidenceQuote)).toBe(true);
    }
  });

  it("prefers Auto Scaling group over shorter Auto Scaling alias", () => {
    const candidates = buildClozeCandidates(
      "An Auto Scaling group is a collection of EC2 instances that are treated as a logical grouping for the purposes of automatic scaling and management.",
      ["auto-scaling", "ec2"],
    );
    const asg = candidates.find((c) =>
      /auto scaling group/i.test(c.answer),
    );
    expect(asg).toBeTruthy();
    expect(asg!.clozeSentence).toMatch(/An ____ is a collection/i);
  });

  it("extracts bold terms", () => {
    expect(extractBoldTerms("**Monitors:** AWS resources")).toContain("Monitors");
  });
});

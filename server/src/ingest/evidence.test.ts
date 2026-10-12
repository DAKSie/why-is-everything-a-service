import { describe, expect, it } from "vitest";
import {
  evidenceSupportsPrompt,
  selectEvidenceQuote,
  splitChunkUnits,
} from "./evidence.js";

const ELB_CHUNK = `
## Section 1: Elastic Load Balancing

Elastic Load Balancing distributes incoming application or network traffic across multiple targets in a single Availability Zone or across multiple Availability Zones. Monitoring is done via Amazon CloudWatch, access logs, and AWS CloudTrail logs

### **Types of Load Balancers**

| Application Load Balancer | Network Load Balancer | Classic Load Balancer (Previous Generation) |
|---|---|---|
| Load balancing of HTTP and HTTPS traffic | Load balancing of TCP, UDP, and TLS traffic where extreme performance is required | Load balancing of HTTP, HTTPS, TCP, and SSL traffic |
| Operates at the application layer (OSI model layer 7) | Operate at the transport layer (OSI model layer 4) | Operates at both the application and transport layers |

- With Application Load Balancers and Network Load Balancers, you register targets in target groups, and route traffic to the target groups.
`.trim();

describe("selectEvidenceQuote", () => {
  it("picks the CloudWatch monitoring sentence over the generic ELB intro", () => {
    const quote = selectEvidenceQuote({
      chunkText: ELB_CHUNK,
      question: "What does Amazon CloudWatch use when monitoring Elastic Load Balancers?",
      answer: "Amazon CloudWatch",
      aliases: ["CloudWatch"],
    });
    expect(quote).toBeTruthy();
    expect(quote!.toLowerCase()).toContain("cloudwatch");
  });

  it("rejects when no sentence contains the answer terms", () => {
    const quote = selectEvidenceQuote({
      chunkText: ELB_CHUNK,
      question: "Which service provides object storage?",
      answer: "Amazon S3",
    });
    expect(quote).toBeNull();
  });

  it("uses table header+cell joins for layer-7 ALB questions", () => {
    const quote = selectEvidenceQuote({
      chunkText: ELB_CHUNK,
      question:
        "Which load balancer operates at the application layer (OSI model layer 7)?",
      answer: "Application Load Balancer",
    });
    expect(quote).toBeTruthy();
    expect(quote!.toLowerCase()).toMatch(/layer 7|application layer/);
    expect(quote!.toLowerCase()).toContain("application load balancer");
    expect(quote!.toLowerCase()).not.toContain("register targets in target groups");
  });

  it("supports three-types via Types heading + table headers", () => {
    const quote = selectEvidenceQuote({
      chunkText: ELB_CHUNK,
      question: "Which three Elastic Load Balancing types does Module 10 list?",
      answer: "Application Load Balancer",
      aliases: [
        "Network Load Balancer",
        "Classic Load Balancer",
      ],
    });
    expect(quote).toBeTruthy();
    expect(quote!.toLowerCase()).toMatch(/application load balancer/);
    expect(quote!.toLowerCase()).toMatch(/network load balancer/);
    expect(quote!.toLowerCase()).not.toContain("register targets in target groups");
  });

  it("emits joined table units", () => {
    const units = splitChunkUnits(ELB_CHUNK);
    expect(
      units.some(
        (u) =>
          /application load balancer/i.test(u) && /layer 7/i.test(u),
      ),
    ).toBe(true);
  });
});

describe("evidenceSupportsPrompt", () => {
  it("rejects unrelated target-groups evidence for a layer-7 prompt", () => {
    expect(
      evidenceSupportsPrompt({
        evidence:
          "With Application Load Balancers and Network Load Balancers, you register targets in target groups, and route traffic to the target groups.",
        question:
          "Which load balancer operates at the application layer (OSI model layer 7)?",
        answer: "Application Load Balancer",
      }),
    ).toBe(false);
  });

  it("accepts layer-7 joined evidence for a layer-7 prompt", () => {
    expect(
      evidenceSupportsPrompt({
        evidence:
          "Application Load Balancer — Operates at the application layer (OSI model layer 7)",
        question:
          "Which load balancer operates at the application layer (OSI model layer 7)?",
        answer: "Application Load Balancer",
      }),
    ).toBe(true);
  });
});

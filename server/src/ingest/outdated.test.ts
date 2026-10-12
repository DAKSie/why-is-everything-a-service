import { describe, expect, it } from "vitest";
import { detectOutdated } from "./outdated.js";

describe("detectOutdated", () => {
  it("mentions Gateway Load Balancer on Classic LB items", () => {
    const r = detectOutdated("Classic Load Balancer (Previous Generation)");
    expect(r.needsReview).toBe(true);
    expect(r.outdatedNote).toMatch(/Classic Load Balancer/i);
    expect(r.outdatedNote).toMatch(/Gateway Load Balancer/i);
  });

  it("flags CloudWatch Events answer items for EventBridge", () => {
    const r = detectOutdated(
      "Events",
      "**Events:** Define rules to match changes in AWS environment",
    );
    expect(r.needsReview).toBe(true);
    expect(r.outdatedNote).toMatch(/EventBridge/i);
  });

  it("does not flag unrelated CloudWatch Alarms items as Events", () => {
    const r = detectOutdated(
      "Alarms",
      "**Alarms:** Send notifications to an Amazon SNS topic",
    );
    expect(r.outdatedNote ?? "").not.toMatch(/EventBridge/i);
  });
});

describe("outdatedForQuestion (prompt/answer/evidence only)", () => {
  it("does not flag Right size then reserve as Spot", async () => {
    const { outdatedForQuestion } = await import(
      "../questions/outdatedAttach.js"
    );
    const r = outdatedForQuestion({
      module: 6,
      topic: "Four Pillars of Cost Optimization",
      conceptTags: ["ec2"],
      type: "multiple_choice",
      difficulty: 1,
      prompt:
        "Which topic does this describe?\n\nBest practice: Right size, then reserve",
      options: [
        "Four Pillars of Cost Optimization",
        "Amazon Pricing Models",
        "ECS",
        "EKS",
      ],
      correctIndices: [0],
      explanation: "From the notes: Best practice: Right size, then reserve",
      source: "notes",
      sourceRef: {
        file: "Module 6 Notes.md",
        heading: "Four Pillars of Cost Optimization",
      },
      needsReview: false,
      evidenceQuote: "Best practice: Right size, then reserve",
    });
    expect(r.needsReview).toBe(false);
    expect(r.outdatedNote ?? "").not.toMatch(/Spot/i);
  });
});

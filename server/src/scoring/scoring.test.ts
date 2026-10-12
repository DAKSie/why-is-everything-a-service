import { describe, expect, it } from "vitest";
import { idLlmVerdictSchema } from "./idVerdict.js";
import { scoreIdentificationDeterministic } from "./identification.js";
import {
  scoreIdentification,
  scoreMultipleChoice,
  scoreProcedural,
} from "./index.js";

describe("scoreMultipleChoice", () => {
  it("gives full credit for exact multi-select", () => {
    expect(
      scoreMultipleChoice({ correctIndices: [0, 2], selectedIndices: [0, 2] })
        .score,
    ).toBe(1);
  });

  it("gives partial credit and penalizes extras", () => {
    expect(
      scoreMultipleChoice({
        correctIndices: [0, 1],
        selectedIndices: [0, 2],
      }).score,
    ).toBe(0);
    expect(
      scoreMultipleChoice({
        correctIndices: [0, 1],
        selectedIndices: [0, 1, 2],
      }).score,
    ).toBe(0.5);
    expect(
      scoreMultipleChoice({
        correctIndices: [0, 1],
        selectedIndices: [0],
      }).score,
    ).toBe(0.5);
  });

  it("zeros out when only extras are selected", () => {
    expect(
      scoreMultipleChoice({ correctIndices: [0], selectedIndices: [1, 2] })
        .score,
    ).toBe(0);
  });
});

describe("scoreProcedural", () => {
  it("scores by position", () => {
    const r = scoreProcedural({
      correctSteps: ["Create VPC", "Add subnet", "Launch instance"],
      submittedSteps: ["Create VPC", "Launch instance", "Add subnet"],
    });
    expect(r.score).toBeCloseTo(1 / 3);
  });

  it("is case/punct insensitive", () => {
    expect(
      scoreProcedural({
        correctSteps: ["Create VPC!"],
        submittedSteps: ["create vpc"],
      }).score,
    ).toBe(1);
  });
});

describe("scoreIdentification fuzzy rules", () => {
  it("matches Amazon/AWS naming variants via normalize/alias", () => {
    expect(
      scoreIdentification({
        acceptedAnswers: ["Amazon CloudWatch"],
        aliases: ["CloudWatch"],
        submitted: "cloudwatch",
      }).score,
    ).toBe(1);
  });

  it("accepts Elastik Block Store for Elastic Block Store", () => {
    const r = scoreIdentificationDeterministic({
      acceptedAnswers: ["Elastic Block Store"],
      submitted: "Elastik Block Store",
    });
    expect(r.score).toBe(1);
    expect(r.stage).toBe("fuzzy");
  });

  it("does not accept EFS for EBS (short exact-only)", () => {
    const r = scoreIdentificationDeterministic({
      acceptedAnswers: ["EBS"],
      aliases: ["Elastic Block Store"],
      submitted: "EFS",
    });
    expect(r.score).toBe(0);
    expect(r.shouldTryLlm).toBe(false);
  });

  it("does not accept ECS for EKS", () => {
    expect(
      scoreIdentificationDeterministic({
        acceptedAnswers: ["EKS"],
        submitted: "ECS",
      }).score,
    ).toBe(0);
  });

  it("rejects unrelated long answers without LLM", () => {
    const r = scoreIdentificationDeterministic({
      acceptedAnswers: ["Amazon S3"],
      submitted: "Amazon EC2",
    });
    expect(r.score).toBe(0);
  });
});

describe("idLlmVerdictSchema", () => {
  it("accepts valid verdict JSON", () => {
    const r = idLlmVerdictSchema.parse({
      verdict: "spelling_error",
      confidence: 0.9,
      reason: "Typo in Elastic",
    });
    expect(r.verdict).toBe("spelling_error");
  });

  it("rejects unknown verdicts", () => {
    expect(() =>
      idLlmVerdictSchema.parse({
        verdict: "maybe",
        confidence: 1,
        reason: "x",
      }),
    ).toThrow();
  });
});

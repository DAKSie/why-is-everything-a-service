import { describe, expect, it } from "vitest";
import {
  answerAppearsInEvidence,
  answerLeaksInPrompt,
  looksLikeListBlob,
  normalizeServiceName,
  validateIdentification,
  validateMultipleChoiceOptions,
  validateNotExceptMultipleChoice,
} from "./validateQuestions.js";

describe("validateMultipleChoiceOptions", () => {
  it("accepts short options", () => {
    expect(
      validateMultipleChoiceOptions([
        "Application Load Balancer",
        "Network Load Balancer",
        "Classic Load Balancer",
        "Gateway Load Balancer",
      ]).ok,
    ).toBe(true);
  });

  it("rejects list blobs and long options", () => {
    expect(looksLikeListBlob("1. ALB\n2. NLB\n3. CLB")).toBe(true);
    expect(
      validateMultipleChoiceOptions([
        "1. Application Load Balancer\n2. Network Load Balancer\n3. Classic Load Balancer",
        "Other",
      ]).ok,
    ).toBe(false);
    expect(
      validateMultipleChoiceOptions([
        "Application Network and Classic Load Balancers plus many extra filler words here now",
        "Short option",
      ]).ok,
    ).toBe(false);
  });
});

describe("normalizeServiceName / answerAppearsInEvidence", () => {
  it("matches Amazon CloudWatch vs CloudWatch", () => {
    expect(normalizeServiceName("Amazon CloudWatch")).toBe("cloudwatch");
    expect(
      answerAppearsInEvidence(
        "Amazon CloudWatch",
        "CloudWatch alarms can send notifications to an Amazon SNS topic",
      ),
    ).toBe(true);
  });

  it("matches Amazon EC2 Auto Scaling vs Auto Scaling", () => {
    expect(normalizeServiceName("Amazon EC2 Auto Scaling")).toBe("auto scaling");
    expect(
      answerAppearsInEvidence(
        "Amazon EC2 Auto Scaling",
        "An Auto Scaling group is a collection of EC2 instances",
      ),
    ).toBe(true);
  });

  it("matches application load balancer naming variants", () => {
    expect(
      answerAppearsInEvidence(
        "application load balancer",
        "Application Load Balancer — Load balancing of HTTP and HTTPS traffic",
      ),
    ).toBe(true);
  });

  it("accepts aliases when primary form is missing from the quote", () => {
    expect(
      answerAppearsInEvidence("Amazon Simple Notification Service", "Send notifications to an SNS topic", [
        "SNS",
      ]),
    ).toBe(true);
  });

  it("still rejects a genuine mismatch", () => {
    expect(
      answerAppearsInEvidence(
        "Network Load Balancer",
        "Elastic Load Balancing distributes incoming application or network traffic across multiple targets",
      ),
    ).toBe(false);
    expect(
      validateIdentification({
        prompt:
          "Elastic Load Balancing scales via which service at the transport layer?",
        acceptedAnswers: ["Network Load Balancer"],
        evidenceQuote:
          "Elastic Load Balancing distributes incoming application or network traffic across multiple targets",
      }).ok,
    ).toBe(false);
  });
});

describe("validateIdentification", () => {
  it("accepts CloudWatch naming variants in evidence", () => {
    expect(
      validateIdentification({
        prompt: "Which Amazon service monitors AWS resources and applications?",
        acceptedAnswers: ["Amazon CloudWatch"],
        aliases: ["CloudWatch"],
        evidenceQuote:
          "CloudWatch Collects and tracks: Standard and custom metrics",
      }).ok,
    ).toBe(true);
  });

  it("rejects underspecified prompts", () => {
    const r = validateIdentification({
      prompt: "This is done via the service that operates at the transport layer",
      acceptedAnswers: ["Network Load Balancer"],
      evidenceQuote: "Network Load Balancer Operate at the transport layer",
    });
    expect(r.ok).toBe(false);
  });
});

describe("answerLeaksInPrompt", () => {
  it("rejects when EC2 answer leaks from EC2 instances in the prompt", () => {
    expect(
      answerLeaksInPrompt(
        "Which AWS service provides the EC2 instances that are included in an Auto Scaling group?",
        "Amazon EC2",
      ),
    ).toBe(true);
  });

  it("allows target-groups rewrite that does not contain the full answer", () => {
    expect(
      answerLeaksInPrompt(
        "In Application and Network Load Balancers, targets are registered in what?",
        "target groups",
      ),
    ).toBe(false);
  });
});

describe("validateNotExceptMultipleChoice", () => {
  it("rejects when the supposed NOT answer still appears in evidence", () => {
    const r = validateNotExceptMultipleChoice({
      prompt:
        "Which of the following is NOT a scaling option provided by Amazon EC2 Auto Scaling?",
      options: [
        "Manual scaling",
        "Scheduled scaling",
        "Dynamic scaling",
        "On-demand scaling",
        "Predictive scaling",
      ],
      correctIndices: [3],
      evidenceQuote:
        "Provides several scaling options: Manual, scheduled, dynamic or on-demand, and predictive",
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/correct answer appears in evidence/i);
  });

  it("accepts a true NOT when distractors are in evidence and answer is not", () => {
    const r = validateNotExceptMultipleChoice({
      prompt: "Which is NOT listed as an ELB monitoring method?",
      options: [
        "Amazon CloudWatch",
        "access logs",
        "AWS CloudTrail logs",
        "AWS Config",
      ],
      correctIndices: [3],
      evidenceQuote:
        "Monitoring is done via Amazon CloudWatch, access logs, and AWS CloudTrail logs",
    });
    expect(r.ok).toBe(true);
  });
});

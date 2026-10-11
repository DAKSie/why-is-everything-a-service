import { describe, expect, it } from "vitest";
import {
  looksLikeListBlob,
  validateIdentification,
  validateMultipleChoiceOptions,
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

describe("validateIdentification", () => {
  it("requires normalized answer inside evidenceQuote", () => {
    const ok = validateIdentification({
      prompt: "What is an Amazon CloudWatch alarm feature?",
      acceptedAnswers: ["anomaly detection"],
      evidenceQuote: "Create alarms based on: Static threshold Anomaly detection",
    });
    expect(ok.ok).toBe(true);

    const bad = validateIdentification({
      prompt: "Elastic Load Balancing scales via which service at transport layer?",
      acceptedAnswers: ["Network Load Balancer"],
      evidenceQuote:
        "Elastic Load Balancing distributes incoming application or network traffic across multiple targets",
    });
    expect(bad.ok).toBe(false);
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

import { describe, expect, it } from "vitest";
import { dedupeAgainstBank } from "./job.js";

describe("dedupeAgainstBank", () => {
  it("drops candidates with near-identical prompts to the bank", () => {
    const bank = ["What is Amazon EC2 used for in the notes?"];
    const { kept, duplicatesDropped } = dedupeAgainstBank(
      [
        { prompt: "What is Amazon EC2 used for in the notes?" },
        { prompt: "Which service provides block storage?" },
      ],
      bank,
    );
    expect(duplicatesDropped).toBe(1);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.prompt).toMatch(/block storage/i);
  });

  it("keeps distinct prompts", () => {
    const { kept, duplicatesDropped } = dedupeAgainstBank(
      [
        { prompt: "What is an AMI?" },
        { prompt: "What is a security group?" },
      ],
      ["What is Amazon VPC?"],
    );
    expect(duplicatesDropped).toBe(0);
    expect(kept).toHaveLength(2);
  });
});

import { describe, expect, it } from "vitest";
import {
  isMcOptionDisabled,
  isTrueFalseOptions,
  mcSelectionMode,
} from "./mcInput.js";

describe("mcSelectionMode", () => {
  it("uses radio for a single correct answer", () => {
    const m = mcSelectionMode({
      options: ["A", "B", "C", "D"],
      correctIndices: [2],
    });
    expect(m.mode).toBe("radio");
    expect(m.chooseHint).toBe("Choose 1");
    expect(m.correctCount).toBe(1);
    expect(m.isTrueFalse).toBe(false);
  });

  it("uses checkboxes for multiple correct answers", () => {
    const m = mcSelectionMode({
      options: ["EC2", "Lambda", "RDS", "ECS"],
      correctIndices: [0, 1, 3],
    });
    expect(m.mode).toBe("checkbox");
    expect(m.chooseHint).toBe("Choose 3");
    expect(m.correctCount).toBe(3);
  });

  it("uses radio for true/false", () => {
    expect(isTrueFalseOptions(["True", "False"])).toBe(true);
    const m = mcSelectionMode({
      options: ["True", "False"],
      correctIndices: [0],
    });
    expect(m.mode).toBe("radio");
    expect(m.isTrueFalse).toBe(true);
    expect(m.chooseHint).toBe("Choose 1");
  });
});

describe("isMcOptionDisabled", () => {
  it("disables unselected options once N are chosen", () => {
    expect(
      isMcOptionDisabled({
        mode: "checkbox",
        correctCount: 2,
        selectedIndices: [0, 2],
        optionIndex: 1,
      }),
    ).toBe(true);
    expect(
      isMcOptionDisabled({
        mode: "checkbox",
        correctCount: 2,
        selectedIndices: [0, 2],
        optionIndex: 0,
      }),
    ).toBe(false);
  });

  it("never disables radio options by count", () => {
    expect(
      isMcOptionDisabled({
        mode: "radio",
        correctCount: 1,
        selectedIndices: [0],
        optionIndex: 1,
      }),
    ).toBe(false);
  });
});

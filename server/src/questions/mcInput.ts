/** How the learner should select MC options (UI + hints). */

export type McSelectionMode = {
  mode: "radio" | "checkbox";
  /** Correct answers required (for hint + checkbox cap). */
  correctCount: number;
  chooseHint: string;
  isTrueFalse: boolean;
};

export function isTrueFalseOptions(options: string[]): boolean {
  if (options.length !== 2) return false;
  const norm = options.map((o) => o.trim().toLowerCase());
  return (
    norm.includes("true") &&
    norm.includes("false") &&
    norm.every((o) => o === "true" || o === "false")
  );
}

/**
 * exactly one correct → radio ("Choose 1")
 * true/false → radio
 * multiple correct → checkbox ("Choose N")
 */
export function mcSelectionMode(input: {
  options: string[];
  correctIndices: number[];
}): McSelectionMode {
  const correctCount = new Set(input.correctIndices).size;
  const tf = isTrueFalseOptions(input.options);
  if (tf || correctCount <= 1) {
    return {
      mode: "radio",
      correctCount: Math.max(1, correctCount),
      chooseHint: "Choose 1",
      isTrueFalse: tf,
    };
  }
  return {
    mode: "checkbox",
    correctCount,
    chooseHint: `Choose ${correctCount}`,
    isTrueFalse: false,
  };
}

/** After N checkbox picks, unselected options are disabled (selected stay toggleable). */
export function isMcOptionDisabled(input: {
  mode: "radio" | "checkbox";
  correctCount: number;
  selectedIndices: number[];
  optionIndex: number;
}): boolean {
  if (input.mode !== "checkbox") return false;
  if (input.selectedIndices.includes(input.optionIndex)) return false;
  return input.selectedIndices.length >= input.correctCount;
}

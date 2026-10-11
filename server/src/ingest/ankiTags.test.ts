import { describe, expect, it } from "vitest";
import { isModulesSixToTen, moduleFromAnkiTags } from "./ankiTags.js";

describe("Anki tag → module mapping", () => {
  it("maps Module-6..10 tags", () => {
    expect(moduleFromAnkiTags(" Module-6 ")).toBe(6);
    expect(moduleFromAnkiTags("Module-10")).toBe(10);
    expect(moduleFromAnkiTags("foo Module-7 bar")).toBe(7);
  });

  it("rejects Modules 1–5 and untagged notes", () => {
    expect(moduleFromAnkiTags(" Module-1 ")).toBeNull();
    expect(moduleFromAnkiTags(" Module-5 ")).toBeNull();
    expect(moduleFromAnkiTags("")).toBeNull();
    expect(isModulesSixToTen(" Module-3 ")).toBe(false);
    expect(isModulesSixToTen(" Module-8 ")).toBe(true);
  });

  it("rejects ambiguous multi-module in-scope tags", () => {
    expect(moduleFromAnkiTags("Module-6 Module-7")).toBeNull();
  });
});

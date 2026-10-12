import { describe, expect, it } from "vitest";
import {
  PROMPT_TEMPLATE_VERSION,
  cacheKey,
  chunkHash,
  generationCacheKey,
} from "./cache.js";

describe("generationCacheKey", () => {
  it("is keyed by module, chunk hash, type, model, and prompt-template version", () => {
    const chunk = chunkHash("hello chunk");
    const a = generationCacheKey({
      module: 10,
      chunkHash: chunk,
      type: "identification",
      model: "qwen2.5:7b-instruct",
    });
    const b = generationCacheKey({
      module: 10,
      chunkHash: chunk,
      type: "identification",
      model: "qwen2.5:7b-instruct",
      templateVersion: PROMPT_TEMPLATE_VERSION,
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{32}$/);

    // Explicit material matches helper fields.
    const manual = cacheKey({
      module: 10,
      chunkHash: chunk,
      type: "identification",
      model: "qwen2.5:7b-instruct",
      templateVersion: PROMPT_TEMPLATE_VERSION,
    });
    expect(a).toBe(manual);
  });

  it("changes when any required field changes", () => {
    const base = {
      module: 10,
      chunkHash: chunkHash("same"),
      type: "multiple_choice",
      model: "qwen2.5:7b-instruct",
      templateVersion: "v3",
    };
    const root = generationCacheKey(base);
    expect(generationCacheKey({ ...base, module: 9 })).not.toBe(root);
    expect(
      generationCacheKey({ ...base, chunkHash: chunkHash("other") }),
    ).not.toBe(root);
    expect(generationCacheKey({ ...base, type: "situational" })).not.toBe(root);
    expect(generationCacheKey({ ...base, model: "qwen2.5:14b-instruct" })).not.toBe(
      root,
    );
    expect(generationCacheKey({ ...base, templateVersion: "v4" })).not.toBe(root);
  });
});

import { describe, expect, it } from "vitest";
import { stripHtml } from "./html.js";

describe("stripHtml", () => {
  it("removes tags and decodes common entities", () => {
    const input =
      "<div>True or False:</div><div><br></div>AWS&nbsp;charges&amp; fees<br/>extra";
    expect(stripHtml(input)).toBe(
      "True or False:\n\nAWS charges& fees\nextra",
    );
  });

  it("collapses noisy Anki markup into readable text", () => {
    const input =
      "-&nbsp;EC2<br><div>2. Economies of scale</div><div>3. Scaling</div>";
    const out = stripHtml(input);
    expect(out).toContain("EC2");
    expect(out).toContain("Economies of scale");
    expect(out).not.toMatch(/<div>/i);
    expect(out).not.toMatch(/&nbsp;/i);
  });
});

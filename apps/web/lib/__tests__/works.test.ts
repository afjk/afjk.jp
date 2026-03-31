import { describe, expect, it } from "vitest";
import { works } from "../../data/works";

describe("works data", () => {
  it("contains at least one highlighted project", () => {
    expect(works.length).toBeGreaterThan(0);
  });

  it("uses unique ids", () => {
    const ids = new Set(works.map((work) => work.id));
    expect(ids.size).toBe(works.length);
  });

  it("exposes outbound links for each entry", () => {
    for (const work of works) {
      expect(work.links.length).toBeGreaterThan(0);
      for (const link of work.links) {
        expect(link.url.startsWith("http")).toBe(true);
      }
    }
  });
});

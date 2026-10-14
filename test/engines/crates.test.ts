import { describe, expect, it } from "vitest";
import { crates } from "../../src/searx/engines/crates";
import fx from "../fixtures/crates.json?raw";
import { PARAMS, fakeResponse } from "../helpers";

describe("crates.io", () => {
  it("builds the API request", () => {
    const req = crates.request({ ...PARAMS, query: "async runtime", pageno: 2 }, {} as any) as { url: string };
    const u = new URL(req.url);
    expect(u.origin + u.pathname).toBe("https://crates.io/api/v1/crates");
    expect(u.searchParams.get("q")).toBe("async runtime");
    expect(u.searchParams.get("page")).toBe("2");
    expect(u.searchParams.get("per_page")).toBe("10");
  });
  it("parses results", async () => {
    const results = await crates.response(fakeResponse(fx), PARAMS);
    expect(results.length).toBe(10);
    for (const r of results) {
      expect(r.url).toBe(`https://crates.io/crates/${r.title}`);
      expect(r.title.length).toBeGreaterThan(0);
      expect(r.content).toMatch(/^v\d/);
      expect(r.publishedDate).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });
});

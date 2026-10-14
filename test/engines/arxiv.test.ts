import { describe, expect, it } from "vitest";
import { arxiv } from "../../src/searx/engines/arxiv";
import fx from "../fixtures/arxiv.xml?raw";
import { PARAMS, fakeResponse } from "../helpers";

describe("arxiv", () => {
  it("builds the API request with paging", () => {
    const req = arxiv.request({ ...PARAMS, query: "transformer attention", pageno: 2 }, {} as any) as { url: string };
    const u = new URL(req.url);
    expect(u.origin + u.pathname).toBe("https://export.arxiv.org/api/query");
    expect(u.searchParams.get("search_query")).toBe("all:transformer attention");
    expect(u.searchParams.get("start")).toBe("10");
    expect(u.searchParams.get("max_results")).toBe("10");
  });
  it("parses the Atom feed", async () => {
    const results = await arxiv.response(fakeResponse(fx), PARAMS);
    expect(results.length).toBe(10);
    for (const r of results) {
      expect(r.url).toMatch(/^https?:\/\/arxiv\.org\/abs\//);
      expect(r.title.length).toBeGreaterThan(0);
      expect(r.title).not.toMatch(/\s{2,}|</);
      expect(r.content!.length).toBeGreaterThan(50);
      expect(r.publishedDate).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
    expect(results[0].title).toBe("Dilated Neighborhood Attention Transformer");
    expect(results[0].author).toBe("Ali Hassani, Humphrey Shi");
    expect(results[0].content).toContain("cs.CV");
  });
});

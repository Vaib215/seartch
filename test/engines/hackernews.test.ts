import { describe, expect, it } from "vitest";
import { hackernews } from "../../src/searx/engines/hackernews";
import fx from "../fixtures/hackernews.json?raw";
import { PARAMS, fakeResponse } from "../helpers";

describe("hackernews", () => {
  it("builds a relevance search", () => {
    const req = hackernews.request({ ...PARAMS, query: "async runtime", pageno: 2 }, {} as any) as { url: string };
    const u = new URL(req.url);
    expect(u.origin + u.pathname).toBe("https://hn.algolia.com/api/v1/search");
    expect(u.searchParams.get("query")).toBe("async runtime");
    expect(u.searchParams.get("page")).toBe("1");
    expect(u.searchParams.get("hitsPerPage")).toBe("30");
    expect(u.searchParams.get("tagFilters")).toBe('["story",[]]');
  });
  it("switches to search_by_date for a time range", () => {
    const req = hackernews.request({ ...PARAMS, query: "rust", timeRange: "week" }, {} as any) as { url: string };
    const u = new URL(req.url);
    expect(u.pathname).toBe("/api/v1/search_by_date");
    const ts = Number(u.searchParams.get("numericFilters")!.replace("created_at_i>", ""));
    expect(Date.now() / 1000 - ts).toBeGreaterThan(6.9 * 86400);
    expect(Date.now() / 1000 - ts).toBeLessThan(7.1 * 86400);
  });
  it("uses the front page for an empty query", () => {
    const req = hackernews.request({ ...PARAMS, query: "" }, {} as any) as { url: string };
    expect(req.url).toBe("https://hn.algolia.com/api/v1/search_by_date?tags=front_page&page=0");
  });
  it("parses results", async () => {
    const results = await hackernews.response(fakeResponse(fx), PARAMS);
    expect(results.length).toBe(30);
    for (const r of results) {
      expect(r.url).toMatch(/^https:\/\/news\.ycombinator\.com\/item\?id=\d+$/);
      expect(r.title.length).toBeGreaterThan(0);
      expect(r.publishedDate).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
    expect(results[0].title).toBe("Tokio 1.0 – async runtime for Rust");
    expect(results[0].content).toBe("https://tokio.rs/blog/2020-12-tokio-1-0 / points: 769 | comments: 402");
    expect(results[0].author).toBe("carllerche");
  });
});

import { describe, expect, it } from "vitest";
import { npm } from "../../src/searx/engines/npm";
import fx from "../fixtures/npm.json?raw";
import { PARAMS, fakeResponse } from "../helpers";

describe("npm", () => {
  it("builds the API request with paging", () => {
    const req = npm.request({ ...PARAMS, query: "async runtime", pageno: 2 }, {} as any) as { url: string };
    const u = new URL(req.url);
    expect(u.origin + u.pathname).toBe("https://api.npms.io/v2/search");
    expect(u.searchParams.get("q")).toBe("async runtime");
    expect(u.searchParams.get("from")).toBe("25");
    expect(u.searchParams.get("size")).toBe("25");
  });
  it("parses results", async () => {
    const results = await npm.response(fakeResponse(fx), PARAMS);
    expect(results.length).toBe(25);
    for (const r of results) {
      expect(r.url).toMatch(/^https:\/\/www\.npmjs\.com\/package\//);
      expect(r.title.length).toBeGreaterThan(0);
      expect(r.content).toMatch(/^v\d/);
    }
    expect(results[0].title).toBe("regenerator-runtime");
    expect(results[0].author).toBe("Ben Newman");
    expect(results[0].publishedDate).toBe("2021-07-22T22:21:44.111Z");
  });
});

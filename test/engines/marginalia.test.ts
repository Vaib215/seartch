import { describe, expect, it } from "vitest";
import { marginalia } from "../../src/searx/engines/marginalia";
// Hand-made fixture: the public API key was rate limited (429) when capturing.
import fx from "../fixtures/marginalia.json?raw";
import { PARAMS, fakeResponse } from "../helpers";

describe("marginalia", () => {
  it("builds the request with paging, nsfw and API key", () => {
    const req = marginalia.request({ ...PARAMS, query: "rust", pageno: 2, safesearch: 2 }, {} as any) as {
      url: string;
      headers: Record<string, string>;
    };
    expect(req.url).toBe("https://api2.marginalia-search.com/search?page=2&count=20&nsfw=1&query=rust");
    expect(req.headers["API-Key"]).toBeTruthy();
  });
  it("parses results", async () => {
    const results = await marginalia.response(fakeResponse(fx), PARAMS);
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.url).toMatch(/^https?:\/\//);
      expect(r.title.length).toBeGreaterThan(0);
    }
  });
});

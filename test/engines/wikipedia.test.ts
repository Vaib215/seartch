import { describe, expect, it } from "vitest";
import { wikipedia } from "../../src/searx/engines/wikipedia";
import fx from "../fixtures/wikipedia.json?raw";
import { PARAMS, fakeResponse } from "../helpers";

describe("wikipedia", () => {
  it("builds the summary request", () => {
    const req = wikipedia.request({ ...PARAMS, query: "Rust (programming language)" }, {} as any) as { url: string };
    expect(req.url).toBe("https://en.wikipedia.org/api/rest_v1/page/summary/Rust%20%28programming%20language%29");
  });
  it("title-cases lowercase queries and picks the language subdomain", () => {
    const req = wikipedia.request({ ...PARAMS, query: "kite surfing", language: "de-DE" }, {} as any) as { url: string };
    expect(req.url).toBe("https://de.wikipedia.org/api/rest_v1/page/summary/Kite%20Surfing");
  });
  it("parses the summary", async () => {
    const results = await wikipedia.response(fakeResponse(fx), PARAMS);
    expect(results).toHaveLength(1);
    expect(results[0].url).toBe("https://en.wikipedia.org/wiki/Rust_(programming_language)");
    expect(results[0].title).toBe("Rust (programming language)");
    expect(results[0].content!.length).toBeGreaterThan(50);
    expect(results[0].thumbnail).toMatch(/^https:\/\//);
  });
  it("returns nothing for missing pages", async () => {
    expect(await wikipedia.response(fakeResponse("{}", { status: 404 }), PARAMS)).toEqual([]);
  });
});

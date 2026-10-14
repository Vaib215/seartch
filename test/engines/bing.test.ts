import { describe, expect, it } from "vitest";
import { bing, unwrapBingUrl } from "../../src/searx/engines/bing";
// Real response: www.bing.com/search?q=rust+async+runtime&adlt=off (Chrome UA).
import fx from "../fixtures/bing.html?raw";
import { PARAMS, fakeResponse } from "../helpers";

describe("bing", () => {
  it("builds the request", () => {
    const req = bing.request({ ...PARAMS, query: "rust async", safesearch: 1 }, {} as any) as { url: string };
    expect(req.url).toBe("https://www.bing.com/search?q=rust+async&adlt=moderate");
  });
  it("maps locales to setlang / cc", () => {
    const us = bing.request({ ...PARAMS, language: "en-US" }, {} as any) as { url: string };
    expect(us.url).toBe("https://www.bing.com/search?q=test&adlt=off&setlang=en");
    const de = bing.request({ ...PARAMS, language: "de-DE", safesearch: 2 }, {} as any) as { url: string };
    expect(de.url).toBe("https://www.bing.com/search?q=test&adlt=strict&setlang=de&cc=de");
    const en = bing.request({ ...PARAMS, language: "en" }, {} as any) as { url: string };
    expect(en.url).toContain("setlang=en");
    expect(en.url).not.toContain("cc=");
  });
  it("unwraps ck/a redirect links", () => {
    expect(unwrapBingUrl("https://www.bing.com/ck/a?!&&p=abc&u=a1aHR0cHM6Ly9ydXN0LWxhbmcub3JnLw&ntb=1")).toBe("https://rust-lang.org/");
    expect(unwrapBingUrl("https://example.com/x")).toBe("https://example.com/x");
  });
  it("parses results", async () => {
    const results = await bing.response(fakeResponse(fx), PARAMS);
    expect(results.length).toBeGreaterThanOrEqual(5);
    for (const r of results) {
      expect(r.url).toMatch(/^https?:\/\//);
      expect(r.url).not.toContain("bing.com/ck/a");
      expect(r.title.length).toBeGreaterThan(0);
    }
    expect(results.some((r) => (r.content ?? "").length > 20)).toBe(true);
  });
});

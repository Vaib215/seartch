import { describe, expect, it } from "vitest";
import { brave, jsObjToJson } from "../../src/searx/engines/brave";
import { EngineCaptcha, type EngineRequest } from "../../src/searx/types";
import fx from "../fixtures/brave.html?raw";
import { PARAMS, fakeResponse } from "../helpers";

const ctx = {} as any;

describe("brave", () => {
  it("builds the search URL and cookies", async () => {
    const req = (await brave.request({ ...PARAMS, query: "rust async" }, ctx)) as EngineRequest;
    const url = new URL(req.url);
    expect(url.origin + url.pathname).toBe("https://search.brave.com/search");
    expect(url.searchParams.get("q")).toBe("rust async");
    expect(url.searchParams.get("source")).toBe("web");
    expect(url.searchParams.has("offset")).toBe(false);
    expect(req.cookies).toEqual({ safesearch: "off", useLocation: "0", summarizer: "0", country: "all", ui_lang: "en-us" });
  });

  it("maps paging, time range, safesearch and locale", async () => {
    const req = (await brave.request(
      { ...PARAMS, pageno: 3, timeRange: "month", safesearch: 2, language: "en-GB" },
      ctx,
    )) as EngineRequest;
    const url = new URL(req.url);
    expect(url.searchParams.get("offset")).toBe("2");
    expect(url.searchParams.get("tf")).toBe("pm");
    expect(req.cookies).toMatchObject({ safesearch: "strict", country: "gb", ui_lang: "en-gb" });
  });

  it("converts JS object literals to JSON", () => {
    expect(JSON.parse(jsObjToJson(`{a:1,b:'it\\'s "x"',c:void 0,d:.5,e:[1,2,],f:"a:b"}`))).toEqual({
      a: 1, b: `it's "x"`, c: null, d: 0.5, e: [1, 2], f: "a:b",
    });
  });

  it("parses web results from the kit.start payload", async () => {
    const results = await brave.response(fakeResponse(fx), PARAMS);
    expect(results.length).toBe(5);
    for (const r of results) {
      expect(r.url).toMatch(/^https?:\/\//);
      expect(r.title.length).toBeGreaterThan(0);
    }
    expect(results[0]).toMatchObject({ url: "https://tokio.rs/", title: "Tokio - An asynchronous Rust runtime" });
    expect(results[0].content).toContain("Tokio is a runtime for writing");
    expect(results[0].thumbnail).toBeUndefined(); // logos are skipped
    expect(results[0].publishedDate).toMatch(/^2025-06-12/);
    expect(results[2].thumbnail).toBe("https://imgs.search.brave.com/smol-og.png");
    expect(results[4].content).toContain('"async"');
  });

  it("detects the captcha page", async () => {
    const body = '<html><script>kit.start(app, element, {data: null, page:"/captcha",searchPage:"/search"})</script>Your request has been flagged as being suspicious</html>';
    expect(() => brave.response(fakeResponse(body, { status: 429 }), PARAMS)).toThrow(EngineCaptcha);
  });
});

import { describe, expect, it } from "vitest";
import { EngineError } from "../../src/searx/types";
import { parseYahooUrl, yahoo } from "../../src/searx/engines/yahoo";
// Real response: search.yahoo.com/search?p=rust+async+runtime after the YBV cookie hop.
import fx from "../fixtures/yahoo.html?raw";
import { PARAMS, fakeResponse } from "../helpers";

describe("yahoo", () => {
  it("builds the first-page request", () => {
    const req = yahoo.request({ ...PARAMS, query: "rust async", timeRange: "week" }, {} as any) as any;
    expect(req.url).toBe("https://search.yahoo.com/search?p=rust+async&btf=w&iscqry=");
    expect(req.redirect).toBe("manual");
    expect(req.cookies.sB).toBe("v=1&vm=p&fl=1&vl=lang_any&pn=10&rw=new&userset=1");
  });
  it("builds paged / localized requests", () => {
    const req = yahoo.request({ ...PARAMS, pageno: 3, language: "de-DE", safesearch: 2 }, {} as any) as any;
    expect(req.url).toBe("https://de.search.yahoo.com/search?p=test&b=22&pz=7&bct=0&xargs=0");
    expect(req.cookies.sB).toContain("vm=r");
    expect(req.cookies.sB).toContain("vl=lang_de");
  });
  it("removes the tracking redirect", () => {
    expect(
      parseYahooUrl("https://r.search.yahoo.com/_ylt=A;_ylu=B/RV=2/RE=1/RO=10/RU=https%3a%2f%2ftokio.rs%2f/RK=2/RS=xyz-"),
    ).toBe("https://tokio.rs/");
  });
  it("parses results", async () => {
    const results = await yahoo.response(fakeResponse(fx, { url: "https://search.yahoo.com/search?p=x" }), PARAMS);
    expect(results.length).toBeGreaterThanOrEqual(5);
    for (const r of results) {
      expect(r.url).toMatch(/^https?:\/\//);
      expect(r.url).not.toContain("r.search.yahoo.com");
      expect(r.title.length).toBeGreaterThan(0);
    }
    expect(results[0].url).toBe("https://rust-lang.github.io/async-book/08_ecosystem/00_chapter.html");
    expect(results[0].title).toBe("The Async Ecosystem - Asynchronous Programming in Rust");
    expect(results[0].content).toContain("it’s recommended");
  });
  it("fails on a non-200 answer without a redirect", async () => {
    await expect(yahoo.response(fakeResponse("", { status: 500 }), PARAMS)).rejects.toBeInstanceOf(EngineError);
  });
});

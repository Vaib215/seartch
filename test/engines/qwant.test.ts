import { describe, expect, it } from "vitest";
import { EngineAccessDenied, EngineCaptcha, EngineTooManyRequests } from "../../src/searx/types";
import { qwant } from "../../src/searx/engines/qwant";
// Hand-made fixture (shape of api.qwant.com/v3/search/web): the API served a
// DataDome captcha to this machine. qwant-captcha.json is that real captcha body.
import fx from "../fixtures/qwant.json?raw";
import captcha from "../fixtures/qwant-captcha.json?raw";
import { PARAMS, fakeResponse } from "../helpers";

describe("qwant", () => {
  it("builds the request", () => {
    const req = qwant.request({ ...PARAMS, query: "rust async", pageno: 2, safesearch: 1, language: "de-DE" }, {} as any) as any;
    const u = new URL(req.url);
    expect(u.origin + u.pathname).toBe("https://api.qwant.com/v3/search/web");
    expect([...u.searchParams.keys()]).toEqual(["q", "count", "locale", "offset", "tgp", "device", "safesearch", "displayed", "llm"]);
    expect(u.searchParams.get("q")).toBe("rust async");
    expect(u.searchParams.get("locale")).toBe("de_DE");
    expect(u.searchParams.get("offset")).toBe("10");
    expect(u.searchParams.get("safesearch")).toBe("1");
    expect(req.headers.referer).toBe("https://www.qwant.com/");
    expect(qwant.raiseForHttpError).toBe(false);
    const all = qwant.request(PARAMS, {} as any) as any;
    expect(new URL(all.url).searchParams.get("locale")).toBe("en_US");
  });
  it("parses web results only", async () => {
    const results = await qwant.response(fakeResponse(fx), PARAMS);
    expect(results.map((r) => r.url)).toEqual([
      "https://tokio.rs/",
      "https://rust-lang.github.io/async-book/08_ecosystem/00_chapter.html",
      "https://async.rs/",
    ]);
    expect(results[0].title).toBe("Tokio - An asynchronous Rust runtime");
    expect(results[0].content).toContain("asynchronous runtime");
  });
  it("detects the DataDome captcha", async () => {
    expect(() => qwant.response(fakeResponse(captcha, { status: 403 }), PARAMS)).toThrow(EngineCaptcha);
  });
  it("maps API errors", async () => {
    const rate = JSON.stringify({ status: "error", data: { error_code: 24 } });
    expect(() => qwant.response(fakeResponse(rate, { status: 429 }), PARAMS)).toThrow(EngineTooManyRequests);
    expect(() => qwant.response(fakeResponse("<html>blocked</html>", { status: 403 }), PARAMS)).toThrow(EngineAccessDenied);
  });
});

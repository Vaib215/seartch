import { describe, expect, it } from "vitest";
import { EngineCaptcha } from "../../src/searx/types";
import { NOKIA_USERAGENTS, google } from "../../src/searx/engines/google";
// Hand-made fixture following google.py's XPaths: /wml/search answered 403 here.
import fx from "../fixtures/google.html?raw";
import { PARAMS, fakeResponse } from "../helpers";

const OK_URL = "https://www.google.com/wml/search?q=rust";

describe("google", () => {
  it("builds the WML request with a Nokia UA", () => {
    const req = google.request({ ...PARAMS, query: "rust async" }, {} as any) as any;
    expect(req.url).toBe("https://www.google.com/wml/search?q=rust+async&sca_esv=1&hl=en&lr=&cr=&ie=utf8&oe=utf8");
    expect(NOKIA_USERAGENTS).toContain(req.headers["user-agent"]);
    expect(req.headers.accept).toBe("*/*");
    expect(req.cookies).toEqual({ CONSENT: "YES+" });
    expect(req.redirect).toBe("manual");
  });
  it("adds locale, paging, time range and safesearch", () => {
    const req = google.request({ ...PARAMS, language: "de-DE", pageno: 3, timeRange: "month", safesearch: 2 }, {} as any) as any;
    const u = new URL(req.url);
    expect(u.searchParams.get("hl")).toBe("de");
    expect(u.searchParams.get("lr")).toBe("lang_de");
    expect(u.searchParams.get("cr")).toBe("countryDE");
    expect(u.searchParams.get("start")).toBe("20");
    expect(u.searchParams.get("tbs")).toBe("qdr:m");
    expect(u.searchParams.get("safe")).toBe("high");
    const en = new URL((google.request({ ...PARAMS, language: "en" }, {} as any) as any).url);
    expect(en.searchParams.get("lr")).toBe("lang_en");
    expect(en.searchParams.get("cr")).toBe("");
  });
  it("parses results and unwraps /url?q= links", async () => {
    const results = await google.response(fakeResponse(fx, { url: OK_URL }), PARAMS);
    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({ url: "https://tokio.rs/", title: "Tokio - An asynchronous Rust runtime" });
    expect(results[0].content).toContain("asynchronous runtime");
    expect(results[1].content).toContain("bare essentials");
    expect(results[1].content).toContain("Async runtimes");
    expect(results[1].thumbnail).toContain("encrypted-tbn");
    expect(results[2].url).toBe("https://docs.rs/async-std/latest/async_std/?tab=readme");
    expect(results[2].title).toBe("async_std - Rust & friends");
  });
  it("detects the sorry page", () => {
    const sorry = `<html><body><a href="https://www.google.com/sorry/index?continue=x">here</a></body></html>`;
    expect(() => google.response(fakeResponse(sorry, { url: OK_URL }), PARAMS)).toThrow(EngineCaptcha);
    expect(() => google.response(fakeResponse("", { status: 302, url: OK_URL }), PARAMS)).toThrow(EngineCaptcha);
    const sorryUrl = "https://www.google.com/sorry/index?continue=1";
    expect(() => google.response(fakeResponse("x", { url: sorryUrl }), PARAMS)).toThrow(EngineCaptcha);
  });
});

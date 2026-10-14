import { describe, expect, it } from "vitest";
import { anubisPow, parsePublishedDate, startpage } from "../../src/searx/engines/startpage";
import { EngineCaptcha, type EngineRequest } from "../../src/searx/types";
import fx from "../fixtures/startpage.html?raw";
import { PARAMS, fakeResponse } from "../helpers";

const memo = () => new Map([["startpage:sc", { value: "SCCODE", expires: Date.now() + 60_000 }]]);

describe("startpage", () => {
  it("builds the POST form and preferences cookie", async () => {
    const req = (await startpage.request({ ...PARAMS, query: "rust async" }, { fetch, memo: memo() })) as EngineRequest;
    expect(req.url).toBe("https://www.startpage.com/sp/search");
    expect(req.method).toBe("POST");
    expect(req.form).toMatchObject({
      query: "rust async", cat: "web", t: "device", sc: "SCCODE", with_date: "", qadf: "none",
      language: "english", lui: "english", segment: "startpage.udog",
    });
    expect(req.form).not.toHaveProperty("page");
    expect(req.cookies?.preferences).toContain("disable_family_filterEEEnoneN1N");
    expect(req.cookies?.preferences).toContain("search_results_regionEEEen_US");
  });

  it("maps paging, time range, safesearch and locale", async () => {
    const req = (await startpage.request(
      { ...PARAMS, pageno: 2, timeRange: "year", safesearch: 2, language: "de-DE" },
      { fetch, memo: memo() },
    )) as EngineRequest;
    expect(req.form).toMatchObject({ page: "2", with_date: "y", qadf: "heavy", language: "deutsch" });
    expect(req.cookies?.preferences).toContain("search_results_regionEEEde_DE");
  });

  it("parses web results and skips ads", async () => {
    const results = await startpage.response(fakeResponse(fx), PARAMS);
    expect(results.length).toBe(4);
    for (const r of results) {
      expect(r.url).toMatch(/^https?:\/\//);
      expect(r.title.length).toBeGreaterThan(0);
    }
    expect(results[0]).toMatchObject({ url: "https://tokio.rs/", title: "Tokio - An asynchronous Rust runtime" });
    expect(results[1].publishedDate).toMatch(/^2025-03-12/);
    expect(results[1].content).toMatch(/^A small and fast/);
    expect(results[2].publishedDate).toBeDefined();
  });

  it("parses date prefixes", () => {
    expect(parsePublishedDate("2 Sep 2014 ... hello").content).toBe("hello");
    expect(parsePublishedDate("plain text").publishedDate).toBeUndefined();
  });

  it("detects Anubis challenges and captcha redirects", async () => {
    const anubis = '<html><script id="anubis_challenge" type="application/json">{"rules":{"difficulty":6}}</script></html>';
    expect(() => startpage.response(fakeResponse(anubis), PARAMS)).toThrow(EngineCaptcha);
    const redirect = fakeResponse("", { status: 302, headers: { location: "https://www.startpage.com/sp/captcha?x=1" } });
    expect(() => startpage.response(redirect, PARAMS)).toThrow(EngineCaptcha);
  });

  it("solves a small Anubis proof of work", async () => {
    const solved = await anubisPow("abc", 2);
    expect(solved?.digest.startsWith("00")).toBe(true);
  });
});

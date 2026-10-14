import { describe, expect, it } from "vitest";
import { duckduckgo, quoteDdgBangs } from "../../src/searx/engines/duckduckgo";
import { EngineCaptcha, type EngineRequest } from "../../src/searx/types";
import fx from "../fixtures/duckduckgo.html?raw";
import challengeFx from "../fixtures/duckduckgo-challenge.html?raw";
import { PARAMS, fakeResponse } from "../helpers";

const ctx = { fetch, memo: new Map() } as any;

describe("duckduckgo", () => {
  it("builds the first-page POST form", async () => {
    const req = (await duckduckgo.request({ ...PARAMS, query: "rust async" }, ctx)) as EngineRequest;
    expect(req.url).toBe("https://html.duckduckgo.com/html/");
    expect(req.method).toBe("POST");
    expect(req.form).toEqual({ q: "rust async", b: "", kl: "wt-wt" });
    expect(req.cookies).toEqual({});
    expect(req.headers?.Referer).toBe("https://html.duckduckgo.com/html/");
  });

  it("maps language and time range to kl/df form fields and cookies", async () => {
    const req = (await duckduckgo.request({ ...PARAMS, language: "en-US", timeRange: "week" }, ctx)) as EngineRequest;
    expect(req.form).toMatchObject({ kl: "us-en", df: "w" });
    expect(req.cookies).toEqual({ kl: "us-en", df: "w" });
    const de = (await duckduckgo.request({ ...PARAMS, language: "de" }, ctx)) as EngineRequest;
    expect(de.form?.kl).toBe("de-de");
  });

  it("quotes !bangs", () => {
    expect(quoteDdgBangs("!w  paris")).toBe("'!w' paris");
  });

  it("refuses page 2 without a vqd (would look like a bot)", async () => {
    await expect(async () => duckduckgo.request({ ...PARAMS, query: "never searched", pageno: 2 }, ctx)).rejects.toBeInstanceOf(EngineCaptcha);
  });

  it("parses results and remembers the vqd for the next page", async () => {
    const params = { ...PARAMS, query: "rust async runtime" };
    const results = await duckduckgo.response(fakeResponse(fx), params);
    expect(results.length).toBeGreaterThanOrEqual(8);
    for (const r of results) {
      expect(r.url).toMatch(/^https?:\/\//);
      expect(r.title.length).toBeGreaterThan(0);
    }
    expect(results.some((r) => r.url.startsWith("https://tokio.rs"))).toBe(true);
    expect(results[0].content).toContain("Async");

    const req = (await duckduckgo.request({ ...params, pageno: 2 }, ctx)) as EngineRequest;
    expect(req.form).toMatchObject({ vqd: "4-206265362772485474247256926687665623360", s: "10", dc: "11", api: "d.js", o: "json", v: "l", nextParams: "" });
    expect(req.form).not.toHaveProperty("b");
  });

  it("detects the challenge form as a CAPTCHA", async () => {
    const body = '<html><body><form id="challenge-form" action="/anomaly.js"><div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div></form></body></html>';
    expect(() => duckduckgo.response(fakeResponse(body), PARAMS)).toThrow(EngineCaptcha);
  });

  it("detects the real anomaly page (HTTP 202) as a CAPTCHA", async () => {
    expect(() => duckduckgo.response(fakeResponse(challengeFx, { status: 202 }), PARAMS, ctx)).toThrow(EngineCaptcha);
  });

  it("treats a 303 as no results", async () => {
    expect(await duckduckgo.response(fakeResponse("", { status: 303 }), PARAMS)).toEqual([]);
  });
});

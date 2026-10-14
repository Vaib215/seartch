import { describe, expect, it } from "vitest";
import { yandex } from "../../src/searx/engines/yandex";
import { EngineCaptcha } from "../../src/searx/types";
import fx from "../fixtures/yandex.html?raw";
import { PARAMS, fakeResponse } from "../helpers";

describe("yandex", () => {
  it("builds the web request", () => {
    const req = yandex.request({ ...PARAMS, query: "rust", pageno: 3, language: "en-US" }, {} as any) as { url: string };
    const u = new URL(req.url);
    expect(u.origin + u.pathname).toBe("https://yandex.com/search/site/");
    expect(u.searchParams.get("text")).toBe("rust");
    expect(u.searchParams.get("p")).toBe("2");
    expect(u.searchParams.get("lang")).toBe("en");
    expect(u.searchParams.get("searchid")).toBe("3131712");
  });
  it("adds time range params", () => {
    const req = yandex.request({ ...PARAMS, timeRange: "week" }, {} as any) as { url: string };
    const u = new URL(req.url);
    expect(u.searchParams.get("within")).toBe("777");
    expect(u.searchParams.get("from_year")).toMatch(/^\d{4}$/);
  });
  it("parses results", async () => {
    const results = await yandex.response(fakeResponse(fx), PARAMS);
    expect(results.length).toBeGreaterThan(5);
    for (const r of results) {
      expect(r.url).toMatch(/^https?:\/\//);
      expect(r.title.length).toBeGreaterThan(0);
    }
  });
  it("detects the captcha header", () => {
    const resp = fakeResponse("<html>captcha</html>", { headers: { "x-yandex-captcha": "captcha" } });
    expect(() => yandex.response(resp, PARAMS)).toThrow(EngineCaptcha);
  });
});

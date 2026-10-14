import { describe, expect, it } from "vitest";
import { mojeek, solveAltcha } from "../../src/searx/engines/mojeek";
import type { EngineRequest } from "../../src/searx/types";
import fx from "../fixtures/mojeek.html?raw";
import { PARAMS, fakeResponse } from "../helpers";

const ctx = { fetch, memo: new Map([["mojeek:chllg", { value: "TOKEN", expires: Date.now() + 60_000 }]]) } as any;

describe("mojeek", () => {
  it("builds the search URL and cookies", async () => {
    const req = (await mojeek.request({ ...PARAMS, query: "rust async" }, ctx)) as EngineRequest;
    const url = new URL(req.url);
    expect(url.origin + url.pathname).toBe("https://www.mojeek.com/search");
    expect(url.searchParams.get("q")).toBe("rust async");
    expect(url.searchParams.get("safe")).toBe("0");
    expect(url.searchParams.has("s")).toBe(false); // s=0 on page 1 triggers a rate-limit
    expect(req.cookies).toEqual({ lb: "", arc: "none", chllg: "TOKEN" });
  });

  it("maps paging, safesearch, time range and locale", async () => {
    const req = (await mojeek.request(
      { ...PARAMS, pageno: 3, safesearch: 2, timeRange: "day", language: "de-AT" },
      ctx,
    )) as EngineRequest;
    const url = new URL(req.url);
    expect(url.searchParams.get("s")).toBe("20");
    expect(url.searchParams.get("safe")).toBe("1");
    expect(url.searchParams.get("since")).toMatch(/^\d{8}$/);
    expect(req.cookies).toMatchObject({ lb: "de", arc: "at" });
  });

  it("parses results", async () => {
    const results = await mojeek.response(fakeResponse(fx), PARAMS);
    expect(results.length).toBe(5);
    for (const r of results) {
      expect(r.url).toMatch(/^https?:\/\//);
      expect(r.title.length).toBeGreaterThan(0);
    }
    expect(results[0]).toMatchObject({ url: "https://tokio.rs/", title: "Tokio - An asynchronous Rust runtime" });
    expect(results[0].content).toContain("Tokio is a runtime");
  });

  it("solves a real ALTCHA challenge", async () => {
    // Captured from https://www.mojeek.com/captcha/challenge; solution checked with node:crypto.
    const solved = await solveAltcha({
      algorithm: "PBKDF2/SHA-256",
      cost: 8000,
      keyLength: 32,
      keyPrefix: "438d9f2930065482e68993385b98b5fa",
      nonce: "fcbb3773e56408b9e5103a50cc6521db",
      salt: "ba2826a8b6a7e66ea04df49cc4d7243d",
    });
    expect(solved).toEqual({ counter: 266, key: "438d9f2930065482e68993385b98b5facac5318c1fbd31dbf5fdb6cec46a56bc" });
  });
});

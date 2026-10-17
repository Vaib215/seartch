import { describe, expect, it } from "vitest";
import { suspensionSeconds } from "../src/searx/health";
import { raiseForHttpError } from "../src/searx/http";
import { ResultContainer, normalizeUrl } from "../src/searx/results";
import { parseBangs } from "../src/searx/search";
import type { Engine } from "../src/searx/types";
import { fakeResponse } from "./helpers";

const eng = (name: string, weight = 1) => ({ name, weight }) as Engine;

describe("ResultContainer (searx/results.py)", () => {
  it("merges duplicates across engines, ignoring scheme and tracker params", () => {
    const c = new ResultContainer(new Map([["a", 1], ["b", 1]]));
    c.extend(eng("a"), [{ url: "http://x.com/p?utm_source=z", title: "X", content: "short" }]);
    c.extend(eng("b"), [{ url: "https://x.com/p", title: "X longer", content: "much longer content" }]);
    const [r] = c.ordered();
    expect(r.url).toBe("https://x.com/p");
    expect(r.engines).toEqual(["a", "b"]);
    expect(r.title).toBe("X longer");
    expect(r.content).toBe("much longer content");
  });

  it("scores like calculate_score: weight*len(positions)/position summed", () => {
    const c = new ResultContainer(new Map([["a", 1], ["b", 2]]));
    c.extend(eng("a"), [{ url: "https://one.com", title: "1" }, { url: "https://two.com", title: "2" }]);
    c.extend(eng("b", 2), [{ url: "https://two.com", title: "2" }]);
    const [first, second] = c.ordered();
    // two.com: weight = 1*2 (engines) * 2 (positions) = 4; score = 4/2 + 4/1 = 6
    expect(first.url).toBe("https://two.com/");
    expect(first.score).toBe(6);
    expect(second.score).toBe(1);
  });

  it("drops non-http URLs and empty titles", () => {
    const c = new ResultContainer(new Map());
    c.extend(eng("a"), [{ url: "javascript:alert(1)", title: "x" }, { url: "https://ok.com", title: " " }]);
    expect(c.ordered()).toEqual([]);
    expect(normalizeUrl("//cdn.com/a")?.href).toBe("https://cdn.com/a");
  });
});

describe("bangs", () => {
  it("extracts engine and category bangs", () => {
    expect(parseBangs("!et polycab results")).toEqual({ query: "polycab results", engines: ["economic times"], categories: [] });
    expect(parseBangs("!filings tata elxsi")).toEqual({ query: "tata elxsi", engines: [], categories: ["filings"] });
    expect(parseBangs("!analysis genus power")).toEqual({ query: "genus power", engines: [], categories: ["analysis"] });
    expect(parseBangs("!an genus power")).toEqual({ query: "genus power", engines: ["analysis"], categories: [] });
    expect(parseBangs("hello !nope")).toEqual({ query: "hello !nope", engines: [], categories: [] });
  });
});

describe("raiseForHttpError", () => {
  it("classifies blocks like raise_for_httperror.py", () => {
    expect(() => raiseForHttpError(fakeResponse("", { status: 403 }))).toThrow(/HTTP 403/);
    expect(() => raiseForHttpError(fakeResponse("", { status: 429 }))).toThrow(/too many/);
    expect(() =>
      raiseForHttpError(fakeResponse('x "https://www.google.com/recaptcha/ y', { status: 503 })),
    ).toThrow(/reCAPTCHA/);
    expect(() =>
      raiseForHttpError(fakeResponse("", { status: 403, headers: { server: "cloudflare", "cf-mitigated": "challenge" } })),
    ).toThrow(/Cloudflare CAPTCHA/);
    expect(() => raiseForHttpError(fakeResponse("", { status: 200 }))).not.toThrow();
  });

  it("backs off exponentially and caps suspension", () => {
    expect(suspensionSeconds("too_many_requests", 1)).toBe(180);
    expect(suspensionSeconds("too_many_requests", 2)).toBe(360);
    expect(suspensionSeconds("too_many_requests", 10)).toBe(3600);
    expect(suspensionSeconds("captcha", 1, 1_296_000)).toBe(24 * 3600);
    expect(suspensionSeconds("timeout", 1)).toBe(5);
    expect(suspensionSeconds("captcha", 1, 0)).toBe(3600);
  });
});

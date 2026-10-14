import { describe, expect, it } from "vitest";
import { stackoverflow } from "../../src/searx/engines/stackoverflow";
import fx from "../fixtures/stackoverflow.json?raw";
import { PARAMS, fakeResponse } from "../helpers";

describe("stackoverflow", () => {
  it("is configured as in settings.yml", () => {
    expect(stackoverflow.name).toBe("stackoverflow");
    expect(stackoverflow.shortcut).toBe("st");
    expect(stackoverflow.categories).toEqual(["it", "q&a"]);
  });
  it("builds the API request", () => {
    const req = stackoverflow.request({ ...PARAMS, query: "async runtime", pageno: 3 }, {} as any) as { url: string };
    const u = new URL(req.url);
    expect(u.origin + u.pathname).toBe("https://api.stackexchange.com/2.3/search/advanced");
    expect(u.searchParams.get("q")).toBe("async runtime");
    expect(u.searchParams.get("page")).toBe("3");
    expect(u.searchParams.get("pagesize")).toBe("10");
    expect(u.searchParams.get("site")).toBe("stackoverflow");
    expect(u.searchParams.get("sort")).toBe("activity");
  });
  it("parses results", async () => {
    const results = await stackoverflow.response(fakeResponse(fx), PARAMS);
    expect(results.length).toBe(10);
    for (const r of results) {
      expect(r.url).toMatch(/^https:\/\/stackoverflow\.com\/q\/\d+$/);
      expect(r.title.length).toBeGreaterThan(0);
      expect(r.title).not.toMatch(/&(quot|amp|#39);/);
      expect(r.content).toMatch(/^\[.*\] .* \/\/ score: -?\d+$/);
    }
  });
});

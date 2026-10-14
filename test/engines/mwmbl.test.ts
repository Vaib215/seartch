import { describe, expect, it } from "vitest";
import { mwmbl } from "../../src/searx/engines/mwmbl";
import fx from "../fixtures/mwmbl.json?raw";
import { PARAMS, fakeResponse } from "../helpers";

describe("mwmbl", () => {
  it("builds the request", () => {
    const req = mwmbl.request({ ...PARAMS, query: "rust async" }, {} as any) as { url: string };
    expect(req.url).toBe("https://api.mwmbl.org/api/v1/search/?s=rust+async");
  });
  it("parses results", async () => {
    const results = await mwmbl.response(fakeResponse(fx), PARAMS);
    expect(results.length).toBeGreaterThan(10);
    for (const r of results) {
      expect(r.url).toMatch(/^https?:\/\//);
      expect(r.title.length).toBeGreaterThan(0);
    }
  });
});

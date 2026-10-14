import { describe, expect, it } from "vitest";
import { semanticScholar } from "../../src/searx/engines/semantic_scholar";
import type { EngineContext } from "../../src/searx/types";
import fx from "../fixtures/semantic_scholar.json?raw";
import { PARAMS, fakeResponse } from "../helpers";

describe("semantic scholar", () => {
  it("pre-fetches the UI version once and builds the POST request", async () => {
    let calls = 0;
    const ctx: EngineContext = {
      memo: new Map(),
      fetch: async () => {
        calls++;
        return new Response('<html><head><meta name="s2-ui-version" content="abc123"></head></html>');
      },
    };
    const req = await semanticScholar.request({ ...PARAMS, query: "transformer attention", pageno: 2 }, ctx);
    expect(req.url).toBe("https://www.semanticscholar.org/api/1/search");
    expect(req.method).toBe("POST");
    expect(req.headers?.["X-S2-UI-Version"]).toBe("abc123");
    expect(req.json).toMatchObject({ queryString: "transformer attention", page: 2, pageSize: 10 });
    await semanticScholar.request(PARAMS, ctx);
    expect(calls).toBe(1);
  });
  it("fails when the UI version is missing", async () => {
    const ctx: EngineContext = { memo: new Map(), fetch: async () => new Response("<html></html>") };
    await expect(async () => semanticScholar.request(PARAMS, ctx)).rejects.toThrow(/UI version/);
  });
  it("parses results", async () => {
    const results = await semanticScholar.response(fakeResponse(fx), PARAMS);
    expect(results.length).toBe(10);
    for (const r of results) {
      expect(r.url).toMatch(/^https?:\/\//);
      expect(r.title.length).toBeGreaterThan(0);
      expect(r.content!.length).toBeGreaterThan(50);
    }
    expect(results[0].title).toBe("Masked-attention Mask Transformer for Universal Image Segmentation");
    expect(results[0].content).toContain("DOI 10.1109/CVPR52688.2022.00135");
    expect(results[0].publishedDate).toBe("2021-12-02T00:00:00.000Z");
  });
});

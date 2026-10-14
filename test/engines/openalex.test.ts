import { describe, expect, it } from "vitest";
import { openalex } from "../../src/searx/engines/openalex";
import fx from "../fixtures/openalex.json?raw";
import { PARAMS, fakeResponse } from "../helpers";

describe("openalex", () => {
  it("builds the works request", () => {
    const req = openalex.request({ ...PARAMS, query: "transformer attention", pageno: 2 }, {} as any) as { url: string };
    const u = new URL(req.url);
    expect(u.origin + u.pathname).toBe("https://api.openalex.org/works");
    expect(u.searchParams.get("search")).toBe("transformer attention");
    expect(u.searchParams.get("page")).toBe("2");
    expect(u.searchParams.get("per-page")).toBe("10");
    expect(u.searchParams.get("sort")).toBe("relevance_score:desc");
    expect(u.searchParams.has("filter")).toBe(false);
  });
  it("adds a language filter", () => {
    const req = openalex.request({ ...PARAMS, language: "fr-FR" }, {} as any) as { url: string };
    expect(new URL(req.url).searchParams.get("filter")).toBe("language:fr");
  });
  it("parses results and rebuilds abstracts", async () => {
    const results = await openalex.response(fakeResponse(fx), PARAMS);
    expect(results.length).toBe(10);
    for (const r of results) {
      expect(r.url).toMatch(/^https?:\/\//);
      expect(r.title.length).toBeGreaterThan(0);
      expect(r.content).toMatch(/citations/);
    }
    const first = results[0];
    expect(first.title).toBe("AttentionViz: A Global View of Transformer Attention");
    expect(first.url).toBe("https://doi.org/10.1109/tvcg.2023.3327163");
    expect(first.content).toContain("IEEE Transactions on Visualization and Computer Graphics");
    expect(first.content).toContain("DOI 10.1109/tvcg.2023.3327163");
    expect(first.content).toContain("vol. 30, no. 1, pp. 1-11");
    expect(first.publishedDate).toBe("2023-01-01T00:00:00.000Z");
  });
});

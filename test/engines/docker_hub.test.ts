import { describe, expect, it } from "vitest";
import { dockerHub } from "../../src/searx/engines/docker_hub";
import fx from "../fixtures/docker_hub.json?raw";
import { PARAMS, fakeResponse } from "../helpers";

describe("docker hub", () => {
  it("builds the catalog search request", () => {
    expect(dockerHub.name).toBe("docker hub");
    const req = dockerHub.request({ ...PARAMS, query: "async runtime", pageno: 3 }, {} as any) as { url: string };
    const u = new URL(req.url);
    expect(u.origin + u.pathname).toBe("https://hub.docker.com/api/search/v3/catalog/search");
    expect(u.searchParams.get("query")).toBe("async runtime");
    expect(u.searchParams.get("from")).toBe("20");
    expect(u.searchParams.get("size")).toBe("10");
  });
  it("parses results", async () => {
    const results = await dockerHub.response(fakeResponse(fx), PARAMS);
    expect(results.length).toBe(10);
    for (const r of results) {
      expect(r.url).toMatch(/^https:\/\/hub\.docker\.com\/(_|r)\/.+/);
      expect(r.title.length).toBeGreaterThan(0);
      expect(r.content).toMatch(/stars/);
    }
    expect(results[0].url).toBe("https://hub.docker.com/_/ibm-semeru-runtimes");
    expect(results[0].content).toContain("10M+ pulls, 61 stars");
    expect(results[0].thumbnail).toMatch(/^https:\/\//);
  });
});

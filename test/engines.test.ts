// Fixture tests: each engine's parser against a saved real response.
// Refresh fixtures with scripts/refresh-fixtures (see README) when a site changes.
import { describe, expect, it } from "vitest";
import { github } from "../src/searx/engines/github";
import githubFixture from "./fixtures/github.json?raw";
import { PARAMS, fakeResponse } from "./helpers";

describe("github", () => {
  it("builds the API request", () => {
    const req = github.request({ ...PARAMS, query: "tokio" }, {} as any) as { url: string };
    expect(req.url).toContain("api.github.com/search/repositories");
    expect(req.url).toContain("q=tokio");
  });
  it("parses results", async () => {
    const results = await github.response(fakeResponse(githubFixture), PARAMS);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].url).toMatch(/^https:\/\/github\.com\//);
    expect(results[0].title).toContain("/");
  });
});

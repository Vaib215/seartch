import { describe, expect, it } from "vitest";
import { pypi } from "../../src/searx/engines/pypi";
import challenge from "../fixtures/pypi-challenge.html?raw";
import fx from "../fixtures/pypi.html?raw";
import { PARAMS, fakeResponse } from "../helpers";

describe("pypi", () => {
  it("builds the search URL", () => {
    const req = pypi.request({ ...PARAMS, query: "async runtime", pageno: 2 }, {} as any) as { url: string };
    expect(req.url).toBe("https://pypi.org/search/?q=async+runtime&page=2");
  });
  it("parses package snippets (hand-made fixture in PyPI's markup)", async () => {
    const results = await pypi.response(fakeResponse(fx), PARAMS);
    expect(results.length).toBe(3);
    expect(results[0]).toEqual({
      url: "https://pypi.org/project/async-runtime/",
      title: "async-runtime",
      content: "v0.3.1 / A small & fast async runtime for Python",
      publishedDate: "2024-02-11T09:15:27.000Z",
    });
    for (const r of results) expect(r.url).toMatch(/^https:\/\/pypi\.org\/project\/[^/]+\/$/);
  });
  it("reports the Fastly JS challenge (real response) as a CAPTCHA", async () => {
    await expect(async () => pypi.response(fakeResponse(challenge), PARAMS)).rejects.toMatchObject({ kind: "captcha" });
  });
});

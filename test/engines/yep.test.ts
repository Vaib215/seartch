import { describe, expect, it } from "vitest";
import { yep } from "../../src/searx/engines/yep";
// Hand-made fixture: api.yep.com served a Cloudflare block page to this machine.
import fx from "../fixtures/yep.json?raw";
import { PARAMS, fakeResponse } from "../helpers";

describe("yep", () => {
  it("builds the request", () => {
    const req = yep.request({ ...PARAMS, query: "rust", safesearch: 1, language: "en-US" }, {} as any) as {
      url: string;
      headers: Record<string, string>;
    };
    expect(req.url).toBe("https://api.yep.com/search?query=rust&safeSearch=moderate&limit=20&hl=en");
    expect(req.headers.referer).toBe("https://yep.com/");
  });
  it("parses results", async () => {
    const results = await yep.response(fakeResponse(fx), PARAMS);
    expect(results).toHaveLength(2);
    expect(results[0].url).toBe("https://tokio.rs/");
    expect(results[0].title).toBeTruthy();
    expect(results[0].content).toBe("Tokio is an asynchronous runtime for the Rust programming language.");
    expect(results[1].content).toContain("async & await");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { configureTinyfish, tinyfishSearch } from "../src/searx/tinyfish";
import { EngineTooManyRequests } from "../src/searx/types";

const ok = (title: string) =>
  new Response(JSON.stringify({ results: [{ title, url: `https://example.com/${title}`, site_name: "www.example.com" }] }));

function stubFetch(answer: (url: string, init?: RequestInit) => Promise<Response>) {
  const calls: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    return answer(url, init);
  });
  return calls;
}

afterEach(() => vi.restoreAllMocks());

describe("tinyfish key pool", () => {
  it("uses the fastest route first and sends each route its own auth", async () => {
    configureTinyfish({ tinyfish: "tf1", treg: "tg1", monid: "m1" });
    let headers: Headers | undefined;
    const calls = stubFetch(async (_url, init) => {
      headers = new Headers(init?.headers);
      return ok("a");
    });
    const results = await tinyfishSearch("Genus Power order", { domainType: "news" }, AbortSignal.timeout(5000));
    expect(results.map((r) => r.title)).toEqual(["a"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^https:\/\/api\.search\.tinyfish\.ai\/\?query=Genus\+Power\+order&domain_type=news/);
    expect(headers?.get("x-api-key")).toBe("tf1");
  });

  it("moves on to treg with a zero cost cap when the direct key is rate limited", async () => {
    configureTinyfish({ tinyfish: "tf2", treg: "tg2" });
    let tregHeaders: Headers | undefined;
    const calls = stubFetch(async (url, init) => {
      if (url.startsWith("https://api.search.tinyfish.ai/")) return new Response("slow down", { status: 429 });
      tregHeaders = new Headers(init?.headers);
      return ok("b");
    });
    const results = await tinyfishSearch("RIL", { domainType: "news" }, AbortSignal.timeout(5000));
    expect(results.map((r) => r.title)).toEqual(["b"]);
    expect(calls[1]).toMatch(/^https:\/\/treg\.to\/call\/tinyfish\.web\.search\.news\?/);
    expect(tregHeaders?.get("x-treg-token")).toBe("tg2");
    expect(tregHeaders?.get("x-treg-route-max-cost")).toBe("0");
    // The rested direct key goes last for the next search.
    calls.length = 0;
    await tinyfishSearch("RIL", {}, AbortSignal.timeout(5000));
    expect(calls[0]).toMatch(/^https:\/\/treg\.to\/call\/tinyfish\.web\.search\?/);
  });

  it("hedges a stuck call onto the next key and takes the first answer", async () => {
    configureTinyfish({ tinyfish: "tf3", treg: "tg3" });
    let stuckAborted = false;
    stubFetch((url, init) => {
      if (url.startsWith("https://treg.to/")) return Promise.resolve(ok("hedged"));
      return new Promise((_, reject) =>
        init?.signal?.addEventListener("abort", () => {
          stuckAborted = true;
          reject(new DOMException("aborted", "AbortError"));
        }),
      );
    });
    const started = Date.now();
    const results = await tinyfishSearch("Tata Elxsi", {}, AbortSignal.timeout(7000));
    expect(results.map((r) => r.title)).toEqual(["hedged"]);
    expect(Date.now() - started).toBeLessThan(4000);
    expect(stuckAborted).toBe(true);
  });

  it("rotates through a route's keys", async () => {
    configureTinyfish({ tinyfish: "r1,r2,r3" });
    const used: string[] = [];
    stubFetch(async (_url, init) => {
      used.push(new Headers(init?.headers).get("x-api-key")!);
      return ok("x");
    });
    for (let i = 0; i < 4; i++) {
      await tinyfishSearch(`q${i}`, {}, AbortSignal.timeout(5000));
      await new Promise((r) => setTimeout(r, 2));
    }
    expect(used).toEqual(["r1", "r2", "r3", "r1"]);
  });

  it("reports rate limiting when every key is limited", async () => {
    configureTinyfish({ treg: "tg4", monid: "m4" });
    stubFetch(async () => new Response("", { status: 429 }));
    await expect(tinyfishSearch("x", {}, AbortSignal.timeout(5000))).rejects.toBeInstanceOf(EngineTooManyRequests);
  });
});

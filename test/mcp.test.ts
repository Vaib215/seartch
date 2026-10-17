import { createMcpHandler } from "agents/mcp/server";
import { describe, expect, it } from "vitest";
import { type ToolBackends, createServer } from "../src/mcp";

const backends: ToolBackends = {
  search: async (body) => ({
    results: [
      {
        query: (body.queries as string[])[0],
        results: [{ url: "https://a.com/", title: "A", content: "snippet", engines: ["x", "y"], positions: [1, 1], score: 4 }],
        unresponsiveEngines: [{ engine: "yep", error: "captcha", suspended: true }],
      },
    ],
  }),
  fetch: async () => ({
    results: [
      { url: "https://p.com/", via: "fetch", markdown: "# Teaser", paywalled: true, partial: true },
      { url: "https://gone.com/", error: "HTTP 404" },
    ],
  }),
};

async function rpc(method: string, params: unknown = {}) {
  const handler = createMcpHandler(() => createServer(backends));
  const res = await handler(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        // Synthetic Requests carry no Host header; the handler's DNS-rebinding check wants one.
        host: "localhost",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    {},
    { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext,
  );
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  return JSON.parse(line ? line.slice(6) : text);
}

describe("MCP server", () => {
  it("lists both tools", async () => {
    const r = await rpc("tools/list");
    expect(r.result.tools.map((t: { name: string }) => t.name)).toEqual(["web_search", "web_fetch"]);
  });

  it("formats search results as Markdown", async () => {
    const r = await rpc("tools/call", { name: "web_search", arguments: { queries: ["q"] } });
    const text = r.result.content[0].text;
    expect(text).toContain('## Results for "q"');
    expect(text).toContain("1. [A](https://a.com/)");
    expect(text).toContain("yep (suspended)");
  });

  it("marks paywalled teasers and errors in fetch output", async () => {
    const r = await rpc("tools/call", { name: "web_fetch", arguments: { urls: ["https://p.com/", "https://gone.com/"] } });
    const text = r.result.content[0].text;
    expect(text).toContain("[PAYWALLED: only a teaser or barrier page was available]");
    expect(text).toContain("Error: HTTP 404");
  });
});

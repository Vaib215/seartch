import { expect, it } from "vitest";
import { runEngine } from "../src/searx/search";
import type { Engine, SearchParams } from "../src/searx/types";

// Picks up engine modules without needing them registered in engines/index.ts.
const modules = import.meta.glob<Record<string, unknown>>("../src/searx/engines/*.ts", { eager: true });
const all = new Map<string, Engine>();
for (const mod of Object.values(modules)) {
  for (const v of Object.values(mod)) {
    if (v && typeof v === "object" && "request" in v && "response" in v && "name" in v) all.set((v as Engine).name, v as Engine);
  }
}

declare const __LIVE__: { engines: string; query: string; params: string };
const names = __LIVE__.engines.split(",").map((s) => s.trim()).filter(Boolean);

it("live engines", async () => {
  expect(names.length, "set LIVE_ENGINES").toBeGreaterThan(0);
  const params: SearchParams = { query: __LIVE__.query, pageno: 1, language: "all", safesearch: 0, ...JSON.parse(__LIVE__.params) };
  for (const name of names) {
    const engine = all.get(name);
    if (!engine) {
      console.log(`[${name}] NOT FOUND (known: ${[...all.keys()].join(", ")})`);
      continue;
    }
    const t = Date.now();
    try {
      const { results } = await runEngine({ ...engine, timeout: 15_000 }, params);
      console.log(`[${name}] OK ${results.length} results in ${Date.now() - t}ms`);
      for (const r of results.slice(0, 5)) console.log(`   - ${r.title} | ${r.url} | ${(r.content ?? "").slice(0, 100)}`);
    } catch (err: any) {
      console.log(`[${name}] FAIL in ${Date.now() - t}ms: ${err?.kind ?? err?.name}: ${err?.message}`);
    }
  }
});

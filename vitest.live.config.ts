// Live engine check: runs real requests from this machine through the Workers runtime.
//   LIVE_ENGINES=yandex,yep LIVE_QUERY="polycab results" npx vitest run -c vitest.live.config.ts
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  define: {
    __LIVE__: JSON.stringify({
      engines: process.env.LIVE_ENGINES ?? "",
      query: process.env.LIVE_QUERY ?? "Tata Elxsi Q2 results",
      params: process.env.LIVE_PARAMS ?? "{}",
    }),
  },
  test: {
    // node-html-parser is CommonJS and require()s css-select, whose "import" export
    // is ESM; pre-bundle them so the Workers test runtime can load them.
    deps: { optimizer: { ssr: { enabled: true, include: ["node-html-parser", "node-html-markdown"] } } }, include: ["test/live.ts"],
    // Print engine output directly instead of buffering it per test.
    disableConsoleIntercept: true, testTimeout: 120_000 },
});

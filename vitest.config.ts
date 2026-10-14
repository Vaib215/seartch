import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  test: {
    // node-html-parser is CommonJS and require()s css-select, whose "import" export
    // is ESM; pre-bundle them so the Workers test runtime can load them.
    deps: { optimizer: { ssr: { enabled: true, include: ["node-html-parser", "node-html-markdown"] } } },
  },
});

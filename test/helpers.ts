import type { EngineResponse, SearchParams } from "../src/searx/types";

export const PARAMS: SearchParams = { query: "test", pageno: 1, language: "all", safesearch: 0 };

/** Builds an EngineResponse from fixture text, as http.ts send() would. */
export function fakeResponse(text: string, init: { status?: number; url?: string; headers?: Record<string, string> } = {}): EngineResponse {
  return {
    status: init.status ?? 200,
    url: init.url ?? "https://example.invalid/",
    headers: new Headers(init.headers ?? {}),
    text,
    json: () => JSON.parse(text),
  };
}

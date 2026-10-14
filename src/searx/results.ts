// Port of searx/results.py: merge duplicate results across engines and score them.

import { dateFromUrl } from "./dates";
import type { Engine, EngineResult } from "./types";

export interface MergedResult extends EngineResult {
  engines: string[];
  /** 1-based rank of this result in each engine that returned it. */
  positions: number[];
  score: number;
}

// Subset of the ClearURLs rules SearXNG's tracker_url_remover plugin applies.
const TRACKER_PARAMS = /^(utm_\w+|fbclid|gclid|gclsrc|dclid|msclkid|mc_cid|mc_eid|yclid|_hsenc|_hsmi|igshid|ref_src|spm|si)$/i;

/** Returns a cleaned https?: URL, or undefined when the URL is unusable. */
export function normalizeUrl(raw: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKER_PARAMS.test(key)) url.searchParams.delete(key);
  }
  canonicalizeAmp(url);
  return url;
}

/** Folds AMP copies into the canonical article URL so they merge as duplicates. */
function canonicalizeAmp(url: URL) {
  url.pathname = url.pathname
    .replace(/\/amp_articleshow\//, "/articleshow/") // Economic Times, Times of India
    .replace(/^\/amp\//, "/") // India Today, NDTV Profit
    .replace(/\/amp\/?$/, "/"); // WordPress-style /amp suffix
  for (const key of ["amp", "outputType", "amp_js_v"]) {
    if (key === "outputType" && url.searchParams.get(key) !== "amp") continue;
    url.searchParams.delete(key);
  }
}

/**
 * Equivalent of MainResult.__hash__: results are the same when everything but
 * the scheme matches.
 */
function resultKey(url: URL): string {
  return `${url.host}|${url.pathname}|${url.search}|${url.hash}`;
}

export class ResultContainer {
  private byKey = new Map<string, MergedResult>();

  constructor(private weights: Map<string, number>) {}

  extend(engine: Engine, results: EngineResult[]) {
    results.forEach((r, i) => this.merge(engine.name, r, i + 1));
  }

  private merge(engine: string, r: EngineResult, position: number) {
    const url = normalizeUrl(r.url);
    if (!url || !r.title?.trim()) return;
    const key = resultKey(url);
    const existing = this.byKey.get(key);
    if (!existing) {
      const publishedDate = r.publishedDate ?? dateFromUrl(url.href);
      this.byKey.set(key, { ...r, url: url.href, publishedDate, engines: [engine], positions: [position], score: 0 });
      return;
    }
    // merge_two_main_results: keep the longer text, fill gaps, prefer https.
    if ((r.content?.length ?? 0) > (existing.content?.length ?? 0)) existing.content = r.content;
    if (r.title.length > existing.title.length) existing.title = r.title;
    existing.publishedDate ??= r.publishedDate;
    existing.thumbnail ??= r.thumbnail;
    existing.author ??= r.author;
    if (existing.url.startsWith("http:") && url.protocol === "https:") existing.url = url.href;
    if (!existing.engines.includes(engine)) existing.engines.push(engine);
    existing.positions.push(position);
  }

  /** calculate_score + the first sort pass of get_ordered_results. */
  ordered(): MergedResult[] {
    for (const r of this.byKey.values()) {
      let weight = 1;
      for (const e of r.engines) weight *= this.weights.get(e) ?? 1;
      weight *= r.positions.length;
      r.score = r.positions.reduce((s, p) => s + weight / p, 0);
    }
    return [...this.byKey.values()].sort((a, b) => b.score - a.score);
  }
}

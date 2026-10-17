// ValuePickr forum threads about the company a query names. ValuePickr is where
// Indian retail investors write up a company's business model, capital
// allocation and red flags, and keep the thread going for years.
//
// forum.valuepickr.com is Discourse, but its robots.txt disallows /search for all
// agents, so threads are found from the forum's sitemap (every topic with its
// last-activity time; allowed, and cached for hours) by matching the company's
// names against topic slugs. The best matches are then read from topic JSON
// (/t/<id>.json, allowed) for the title, first post and activity counts.

import { type Company, resolveCompanies } from "../companies";
import { splitQuery } from "../terms";
import type { Engine, EngineContext, EngineResult, SearchParams, TimeRange } from "../types";
import { EngineError } from "../types";
import { Budget, cacheGet, cachePut, clip, dayMonthYear, getJson, getText, htmlText, monthYear } from "./research_common";

const VP = "https://forum.valuepickr.com";
const ENGINE_TIMEOUT_MS = 6500;
const BUDGET_MS = 6000;
const INDEX_TTL_S = 6 * 3600;
const RECENT_TTL_S = 900;
const TOPIC_TTL_S = 3 * 3600;
const MAX_RESULTS = 5;
const READ_TOPICS = 3;
const TOPIC_MIN_MS = 800;

export interface VpTopic {
  slug: string;
  id: number;
  /** Last activity, epoch ms. */
  lastmod?: number;
}

/** Topic URLs and last-activity times from a Discourse sitemap. */
export function parseSitemap(xml: string): VpTopic[] {
  const out: VpTopic[] = [];
  const re = /<loc>https:\/\/forum\.valuepickr\.com\/t\/([^/<]+)\/(\d+)<\/loc>\s*(?:<lastmod>([^<]+)<\/lastmod>)?/g;
  for (const m of xml.matchAll(re)) {
    const t = m[3] ? Date.parse(m[3]) : NaN;
    out.push({ slug: m[1], id: Number(m[2]), lastmod: Number.isNaN(t) ? undefined : t });
  }
  return out;
}

/** Sitemap files listed in the sitemap index (sitemap_1.xml, sitemap_2.xml...). */
export function parseSitemapIndex(xml: string): string[] {
  return [...xml.matchAll(/<loc>(https:\/\/forum\.valuepickr\.com\/sitemap_\d+\.xml)<\/loc>/g)].map((m) => m[1]);
}

type Compact = [string, number, number | null][];

async function loadAllTopics(ctx: EngineContext, budget: Budget): Promise<VpTopic[]> {
  const key = "vp-index";
  let compact = await cacheGet<Compact>(key);
  if (!compact) {
    const index = await budget.race(getText(ctx, `${VP}/sitemap.xml`, "ValuePickr sitemap"), "ValuePickr sitemap");
    const files = parseSitemapIndex(index);
    if (!files.length) throw new EngineError("parse", "ValuePickr: sitemap index lists no topic sitemaps");
    const parts = await Promise.all(files.map((f) => budget.race(getText(ctx, f, "ValuePickr sitemap"), "ValuePickr sitemap")));
    compact = parts.flatMap(parseSitemap).map((t) => [t.slug, t.id, t.lastmod ?? null]);
    if (!compact.length) throw new EngineError("parse", "ValuePickr: sitemap has no topics");
    await cachePut(key, compact, INDEX_TTL_S);
  }
  const topics = new Map<number, VpTopic>(compact.map(([slug, id, lastmod]) => [id, { slug, id, lastmod: lastmod ?? undefined }]));
  // Activity in the last few days, which the big sitemap may not have caught up with.
  try {
    let recent = await cacheGet<Compact>("vp-recent");
    if (!recent) {
      const xml = await budget.race(getText(ctx, `${VP}/sitemap_recent.xml`, "ValuePickr sitemap"), "ValuePickr sitemap");
      recent = parseSitemap(xml).map((t) => [t.slug, t.id, t.lastmod ?? null]);
      await cachePut("vp-recent", recent, RECENT_TTL_S);
    }
    for (const [slug, id, lastmod] of recent) topics.set(id, { slug, id, lastmod: lastmod ?? undefined });
  } catch {
    // the main index is enough
  }
  return [...topics.values()];
}

/** Whole-word match: "infosys" names "infosys-limited" but not "hcl-infosystems". */
function hasWords(text: string, phrase: string): boolean {
  const p = phrase.toLowerCase().replace(/[.'’]/g, "").replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").trim();
  return p.length >= 2 && ` ${text} `.includes(` ${p} `);
}

/**
 * Threads whose slug names the company ("genus-power-smart-metering"), threads
 * dedicated to it first (slug starts with its name), then by latest activity.
 */
export function matchTopics(topics: VpTopic[], query: string, aliases: string[]): VpTopic[] {
  const terms = splitQuery(query);
  const aliasWords = new Set(aliases.flatMap((a) => a.toLowerCase().split(/[^a-z0-9&]+/)).filter(Boolean));
  // Query words that belong to the company's name ("genus", "power").
  const nameWords = terms.subject.filter((w) => aliasWords.has(w));
  const scored: { t: VpTopic; lead: boolean }[] = [];
  for (const t of topics) {
    const words = t.slug.replace(/-/g, " ");
    const named = aliases.some((a) => hasWords(words, a)) || (nameWords.length > 0 && nameWords.every((w) => hasWords(words, w)));
    if (!named) continue;
    const lead = aliases.some((a) => a.length >= 3 && hasWords(words.split(" ").slice(0, a.split(/\s+/).length).join(" "), a));
    scored.push({ t, lead });
  }
  scored.sort((a, b) => Number(b.lead) - Number(a.lead) || (b.t.lastmod ?? 0) - (a.t.lastmod ?? 0));
  return scored.map((s) => s.t);
}

export interface VpTopicJson {
  id?: number;
  title?: string;
  fancy_title?: string;
  slug?: string;
  posts_count?: number;
  views?: number;
  like_count?: number;
  created_at?: string;
  last_posted_at?: string;
  post_stream?: { posts?: { post_number?: number; cooked?: string }[] };
}

/** The search result for a topic, from its JSON when read, else from the sitemap entry. */
export function toResult(t: VpTopic, json?: VpTopicJson): EngineResult {
  const url = `${VP}/t/${t.slug}/${t.id}`;
  const fallbackTitle = t.slug.replace(/-/g, " ").replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
  if (!json) {
    return {
      url,
      title: fallbackTitle,
      content: t.lastmod ? `ValuePickr thread; last activity ${dayMonthYear(t.lastmod)}.` : undefined,
      publishedDate: t.lastmod ? new Date(t.lastmod).toISOString() : undefined,
      author: "ValuePickr",
    };
  }
  const last = json.last_posted_at ? Date.parse(json.last_posted_at) : (t.lastmod ?? NaN);
  const started = json.created_at ? Date.parse(json.created_at) : NaN;
  const first = json.post_stream?.posts?.find((p) => p.post_number === 1) ?? json.post_stream?.posts?.[0];
  const excerpt = first?.cooked ? clip(htmlText(first.cooked.replace(/<(aside|blockquote)[\s\S]*?<\/\1>/g, " ")), 420) : "";
  const stats = [
    json.posts_count !== undefined && `${json.posts_count} posts`,
    json.views !== undefined && `${json.views} views`,
    !Number.isNaN(started) && `started ${monthYear(started)}`,
    !Number.isNaN(last) && `last post ${dayMonthYear(last)}`,
  ].filter(Boolean);
  return {
    url,
    title: htmlText(json.fancy_title ?? json.title ?? "") || fallbackTitle,
    content: [stats.length ? `${stats.join(" · ")}.` : "", excerpt].filter(Boolean).join(" ") || undefined,
    publishedDate: Number.isNaN(last) ? undefined : new Date(last).toISOString(),
    author: "ValuePickr",
  };
}

async function readTopic(ctx: EngineContext, t: VpTopic): Promise<VpTopicJson> {
  // Keyed by last activity, so a thread with new posts is read again.
  const key = `vp-topic?id=${t.id}&m=${t.lastmod ?? 0}`;
  const hit = await cacheGet<VpTopicJson>(key);
  if (hit) return hit;
  const json = await getJson<VpTopicJson>(ctx, `${VP}/t/${t.id}.json`, "ValuePickr topic");
  // Keep only what the result uses (topic JSON carries 20 full posts).
  const slim: VpTopicJson = {
    id: json.id,
    title: json.title,
    fancy_title: json.fancy_title,
    slug: json.slug,
    posts_count: json.posts_count,
    views: json.views,
    like_count: json.like_count,
    created_at: json.created_at,
    last_posted_at: json.last_posted_at,
    post_stream: { posts: (json.post_stream?.posts ?? []).filter((p) => p.post_number === 1).map((p) => ({ post_number: 1, cooked: p.cooked?.slice(0, 6000) })) },
  };
  await cachePut(key, slim, TOPIC_TTL_S);
  return slim;
}

const TIME_RANGE_MS: Record<TimeRange, number> = { day: 86_400_000, week: 7 * 86_400_000, month: 30 * 86_400_000, quarter: 91 * 86_400_000, year: 365 * 86_400_000 };

export const valuepickr: Engine = {
  name: "valuepickr",
  shortcut: "vp",
  categories: ["analysis"],
  timeout: ENGINE_TIMEOUT_MS,
  timeRangeSupport: true,
  about: "ValuePickr forum threads about the company a query names (found via the forum sitemap; /search is disallowed by robots.txt)",
  request() {
    return null; // not used: see search()
  },
  response() {
    return [];
  },
  async search(params: SearchParams, ctx: EngineContext) {
    const budget = Budget.start(BUDGET_MS);
    const companies = (await budget.race(resolveCompanies(params.query), "company lookup").catch(() => [] as Company[])).slice(0, 2);
    if (!companies.length) return [];
    const topics = await loadAllTopics(ctx, budget);
    const cutoff = params.timeRange ? Date.now() - TIME_RANGE_MS[params.timeRange] : 0;
    const matches = [...new Map(companies.flatMap((c) => matchTopics(topics, params.query, c.aliases)).map((t) => [t.id, t])).values()]
      .filter((t) => !cutoff || !t.lastmod || t.lastmod >= cutoff)
      .slice(0, MAX_RESULTS);
    const read = await Promise.all(
      matches.map((t, i) =>
        i < READ_TOPICS && budget.left() >= TOPIC_MIN_MS
          ? budget.race(readTopic(ctx, t), "ValuePickr topic").catch(() => undefined)
          : Promise.resolve(undefined),
      ),
    );
    return matches.map((t, i) => toResult(t, read[i]));
  },
};

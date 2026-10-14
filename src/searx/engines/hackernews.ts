// Port of searx/engines/hackernews.py (HN Algolia API).
// Simplified: the "points | comments" metadata line is appended to `content`.
// Disabled as in settings.yml.

import { htmlToText } from "../html";
import type { Engine, TimeRange } from "../types";

interface HnSearch {
  hits?: {
    objectID: string;
    title?: string | null;
    url?: string | null;
    author: string;
    points?: number | null;
    num_comments?: number | null;
    comment_text?: string | null;
    story_text?: string | null;
    created_at_i: number;
  }[];
}

const BASE_URL = "https://hn.algolia.com/api/v1";
const RESULTS_PER_PAGE = 30;
const RANGE_DAYS: Record<TimeRange, (d: Date) => void> = {
  day: (d) => d.setUTCDate(d.getUTCDate() - 1),
  week: (d) => d.setUTCDate(d.getUTCDate() - 7),
  month: (d) => d.setUTCMonth(d.getUTCMonth() - 1),
  quarter: (d) => d.setUTCMonth(d.getUTCMonth() - 3),
  year: (d) => d.setUTCFullYear(d.getUTCFullYear() - 1),
};

export const hackernews: Engine = {
  name: "hackernews",
  shortcut: "hn",
  categories: ["it"],
  paging: true,
  timeRangeSupport: true,
  disabled: true,
  about: "Hacker News via the Algolia API (disabled by default in SearXNG)",
  request(params) {
    let searchType = "search";
    const q: Record<string, string> = {};
    if (!params.query) {
      searchType = "search_by_date";
      q.tags = "front_page";
      q.page = String(params.pageno - 1);
    } else {
      Object.assign(q, {
        query: params.query,
        page: String(params.pageno - 1),
        hitsPerPage: String(RESULTS_PER_PAGE),
        minWordSizefor1Typo: "4",
        minWordSizefor2Typos: "8",
        advancedSyntax: "true",
        ignorePlurals: "false",
        minProximity: "7",
        numericFilters: "[]",
        tagFilters: '["story",[]]',
        typoTolerance: "true",
        queryType: "prefixLast",
        restrictSearchableAttributes: '["title","comment_text","url","story_text","author"]',
        getRankingInfo: "true",
      });
      if (params.timeRange) {
        searchType = "search_by_date";
        const d = new Date();
        RANGE_DAYS[params.timeRange](d);
        q.numericFilters = `created_at_i>${Math.floor(d.getTime() / 1000)}`;
      }
    }
    return { url: `${BASE_URL}/${searchType}?${new URLSearchParams(q)}`, headers: { accept: "application/json" } };
  },
  response(resp) {
    return (resp.json<HnSearch>().hits ?? []).map((hit) => {
      const points = hit.points || 0;
      const comments = hit.num_comments || 0;
      let content = hit.url || htmlToText(hit.comment_text) || htmlToText(hit.story_text);
      if (points !== 0 || comments !== 0) {
        content = [content, `points: ${points} | comments: ${comments}`].filter(Boolean).join(" / ");
      }
      return {
        title: hit.title || `author: ${hit.author}`,
        url: `https://news.ycombinator.com/item?id=${hit.objectID}`,
        content,
        author: hit.author,
        publishedDate: new Date(hit.created_at_i * 1000).toISOString(),
      };
    });
  },
};

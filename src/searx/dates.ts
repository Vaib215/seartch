// Publish dates that can be trusted. Search engines like Yandex report crawl or
// modification times, which made year-old articles look new; these helpers read
// the date from the article URL or from the page's own metadata instead.

import { CHROME_UA } from "./http";

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
// Dates further than this in the future are parse errors, not articles.
const FUTURE_SLACK_MS = 2 * 86_400_000;

function iso(y: number, m: number, d: number): string | undefined {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 2000) return undefined;
  const t = Date.UTC(y, m - 1, d);
  if (t > Date.now() + FUTURE_SLACK_MS) return undefined;
  return new Date(t).toISOString();
}

function fromEpochMs(ms: number): string | undefined {
  if (ms < Date.UTC(2005, 0, 1) || ms > Date.now() + FUTURE_SLACK_MS) return undefined;
  return new Date(ms).toISOString();
}

/** Publish date encoded in an article URL, or undefined. */
export function dateFromUrl(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const host = url.hostname;
  const path = url.pathname;

  // Mint and Hindustan Times (same CMS): article id = prefix + 13-digit epoch ms.
  if (/(^|\.)livemint\.com$/.test(host)) {
    const m = /-1(\d{13})\.html$/.exec(path);
    if (m) return fromEpochMs(Number(m[1]));
  }
  if (/(^|\.)hindustantimes\.com$/.test(host)) {
    const m = /-10(\d{13})\.html$/.exec(path);
    if (m) return fromEpochMs(Number(m[1]));
  }
  // Business Standard: ...-1YYMMDDnnnnn_1.html
  if (/(^|\.)business-standard\.com$/.test(host)) {
    const m = /-1(\d{2})(\d{2})(\d{2})\d{5}_1\.html$/.exec(path);
    if (m) return iso(2000 + Number(m[1]), Number(m[2]), Number(m[3]));
  }
  // /2026/10/08/, /2026-10-08/, -2026-10-08 (Reuters, Bloomberg, India Today, many WordPress sites)
  let m = /(?:^|[/-])(20\d{2})[/-](\d{1,2})[/-](\d{1,2})(?=$|[/.-])/.exec(path);
  if (m) return iso(Number(m[1]), Number(m[2]), Number(m[3]));
  // /2026/oct/08/ (Guardian)
  m = /\/(20\d{2})\/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\/(\d{1,2})\//i.exec(path);
  if (m) return iso(Number(m[1]), MONTHS[m[2].toLowerCase()], Number(m[3]));
  return undefined;
}

const HTML_DATE_PATTERNS = [
  /"datePublished"\s*:\s*"([^"]+)"/i,
  /<meta[^>]+(?:property|name)=["'](?:article:published_time|og:published_time|publish-date|publishdate|pubdate|DC\.date\.issued|sailthru\.date|parsely-pub-date)["'][^>]*content=["']([^"']+)["']/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:article:published_time|og:published_time|publish-date|publishdate|pubdate)["']/i,
  /itemprop=["']datePublished["'][^>]*(?:content|datetime)=["']([^"']+)["']/i,
];

/** Publish date from a page's metadata (JSON-LD datePublished, article:published_time, ...). */
export function dateFromHtml(html: string): string | undefined {
  for (const re of HTML_DATE_PATTERNS) {
    const m = re.exec(html);
    if (!m) continue;
    const t = Date.parse(m[1].trim());
    if (!Number.isNaN(t) && t <= Date.now() + FUTURE_SLACK_MS && t > Date.UTC(2000, 0, 1)) return new Date(t).toISOString();
  }
  return undefined;
}

// Metadata sits near the top of the page; never download more than this.
const MAX_SCAN_BYTES = 400_000;

/**
 * Reads only as much of the page as needed to find its publish date, then
 * cancels the download. Undefined if the page has no machine-readable date.
 */
export async function fetchPublishedDate(url: string, timeoutMs = 3000): Promise<string | undefined> {
  const res = await fetch(url, {
    headers: { "user-agent": CHROME_UA, accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8" },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok || !res.body || !/html/i.test(res.headers.get("content-type") ?? "")) {
    await res.body?.cancel();
    return undefined;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (buf.length < MAX_SCAN_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const found = dateFromHtml(buf);
      if (found) return found;
    }
    return dateFromHtml(buf);
  } finally {
    await reader.cancel().catch(() => {});
  }
}

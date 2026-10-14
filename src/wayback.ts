// Wayback Machine fallback for pages that are blocked, dead or timing out.
// `web/2id_/<url>` redirects to the latest capture and `id_` returns the page as
// archived, without the Wayback toolbar or rewritten links.

import { decodeBody } from "./decode";
import { BROWSER_HEADERS } from "./util";

const ARCHIVE_TIMEOUT_MS = 15_000;
// archive.org rate-limits hard (HTTP 429 after a handful of quick requests),
// so lookups from one isolate are spaced out.
const MIN_INTERVAL_MS = 1500;
let nextSlot = 0;

export interface ArchivedPage {
  html: string;
  archiveUrl: string;
  /** ISO timestamp of the capture. */
  archivedAt?: string;
}

export async function fetchArchived(url: string): Promise<ArchivedPage> {
  await throttle();
  const res = await fetch(`https://web.archive.org/web/2id_/${url}`, {
    headers: BROWSER_HEADERS,
    redirect: "follow",
    signal: AbortSignal.timeout(ARCHIVE_TIMEOUT_MS),
  });
  if (!res.ok) {
    await res.body?.cancel();
    // id_ replays the original status, so an error on a capture URL means the
    // site itself served an error (often its bot-block page) to the crawler.
    const ts = captureTime(res.url);
    if (ts) throw new Error(`latest capture (${ts}) is an HTTP ${res.status} page from the site`);
    if (res.status === 404) throw new Error("no archived snapshot");
    if (res.status === 429) throw new Error("archive.org rate limit (HTTP 429)");
    throw new Error(`archive.org HTTP ${res.status}`);
  }
  const type = res.headers.get("content-type") ?? "";
  if (!/html/i.test(type)) {
    await res.body?.cancel();
    throw new Error(`archived copy is not HTML (${type || "unknown type"})`);
  }
  return { html: await decodeBody(res, type), archiveUrl: res.url, archivedAt: captureTime(res.url) };
}

/** 20261008175318 in /web/20261008175318id_/... → 2026-10-08T17:53:18Z */
export function captureTime(archiveUrl: string): string | undefined {
  const m = /\/web\/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:id_)?\//.exec(archiveUrl);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : undefined;
}

async function throttle() {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + MIN_INTERVAL_MS;
  if (wait) await new Promise((r) => setTimeout(r, wait));
}

import puppeteer, { type Browser } from "@cloudflare/puppeteer";
import { decodeBody } from "./decode";
import {
  STRUCT_TREE_MAX_BYTES,
  TooLargeError,
  convertDocument,
  documentName,
  readDocument,
  reserveConversionMemory,
} from "./doc_convert";
import { type StoredDoc, clipAtBoundary, documentByteLimit, joinPages, loadDoc, pageWindow, saveDoc, splitPages } from "./doc_pages";
import { htmlToMarkdown, wordCount } from "./extract";
import type { Env } from "./index";
import { focusPassages } from "./passages";
import { detectPaywall } from "./paywall";
import { BROWSER_HEADERS, errorMessage, mapLimit } from "./util";
import { fetchArchived } from "./wayback";

export const RENDER_MODES = ["auto", "never", "always"] as const;
export type RenderMode = (typeof RENDER_MODES)[number];

export interface FetchOptions {
  render: RenderMode;
  /** Fall back to the latest Wayback Machine capture when the live page fails. */
  archiveFallback?: boolean;
  /** PDFs: pages per part (default 60). */
  maxPages?: number;
  /** PDFs: first page to return, 1-based (default 1). Pass the previous part's nextPage. */
  pageStart?: number;
  /**
   * Character budget for markdown. PDFs default to 60,000; with focus, 10,000
   * of passages. Other pages are returned whole unless it is set.
   */
  maxChars?: number;
  /** A question: return the passages that best answer it instead of the whole text (any page type). */
  focus?: string;
}

/** The FetchOptions that shape a fetched page's text. */
export type ShapeOptions = Pick<FetchOptions, "maxPages" | "pageStart" | "maxChars" | "focus">;

export interface PageResult {
  url: string;
  finalUrl?: string;
  title?: string;
  markdown?: string;
  via?: "fetch" | "browser" | "convert" | "wayback";
  /** Set when the article is behind a paywall (see paywall.ts). */
  paywalled?: true;
  /** With paywalled: the markdown is a teaser or barrier page, not the full article. */
  partial?: boolean;
  paywallSignals?: string[];
  /** Wayback results: capture time and the archive URL used. */
  archivedAt?: string;
  archiveUrl?: string;
  /** Wayback results: why the live page could not be used. */
  liveError?: string;
  /** PDFs: page count, and how many pages are scanned images with no extractable text. */
  pages?: number;
  scannedPages?: number;
  /** The document continues past what was returned (see nextPage), or was cut at maxChars. */
  truncated?: boolean;
  /** PDFs: the pageStart that returns the next part. */
  nextPage?: number;
  /** PDFs: first and last page returned (with focus: the pages searched). */
  pageRange?: [number, number];
  /** With focus: the passages that best answer it, best first. */
  passages?: { page?: number; text: string; score: number }[];
  error?: string;
}

const FETCH_CONCURRENCY = 6;
const FETCH_TIMEOUT_MS = 10_000;
// Large filings download at 2.5-4.5 MB/s from NSE's archive.
const DOCUMENT_DOWNLOAD_MS = 25_000;
// How long a document waits for another conversion in this isolate to finish.
const CONVERSION_QUEUE_MS = 45_000;
const MAX_HTML_BYTES = 5_000_000;
const PDF_DEFAULT_MAX_CHARS = 60_000;
const PDF_DEFAULT_MAX_PAGES = 60;
const FOCUS_DEFAULT_MAX_CHARS = 10_000;
const DOCUMENT_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "text/csv",
]);
// Below this many words, plain-fetch output is treated as a JS shell or a block page.
const THIN_PAGE_WORDS = 80;
// Statuses that a real browser can often get past (bot walls, JS challenges).
const BROWSER_RETRY_STATUSES = new Set([401, 403, 429, 503]);
const BLOCKED_SUFFIX = " (blocked?)";
// archive.org is slow and rate-limited; cap lookups per request.
const MAX_ARCHIVE_LOOKUPS = 5;

export async function fetchPages(urls: string[], env: Env, opts: FetchOptions): Promise<PageResult[]> {
  const { render } = opts;
  const browser = env.BROWSER && render !== "never" ? new BrowserSession(env.BROWSER) : undefined;
  let archiveBudget = opts.archiveFallback ? MAX_ARCHIVE_LOOKUPS : 0;
  const fetchOne = async (url: string): Promise<PageResult> => {
    // A document converted earlier (an earlier part, or a focus question) comes from the cache.
    const stored = render !== "always" && /^https?:\/\//i.test(url) ? await loadDoc(url) : undefined;
    if (stored) return storedResult(stored);
    const live = await fetchPage(url, render, env.AI, browser);
    if (!live.error || !isArchivable(live.error)) return live;
    if (archiveBudget <= 0) {
      return opts.archiveFallback ? { ...live, error: `${live.error}; archive: skipped (lookup limit reached)` } : live;
    }
    archiveBudget--;
    return viaWayback(url, live.error);
  };
  try {
    return await mapLimit(urls, FETCH_CONCURRENCY, async (url) => shapePage(await fetchOne(url), opts));
  } finally {
    await browser?.close();
  }
}

function storedResult(s: StoredDoc): PageResult {
  return { url: s.url, finalUrl: s.finalUrl, title: s.title, markdown: joinPages(s.doc), via: "convert", pages: s.pages, scannedPages: s.scannedPages };
}

/**
 * Cuts a fetched page down to what was asked for: a window of PDF pages, the
 * passages that answer `focus`, or (for other pages, only when maxChars is set)
 * the first maxChars characters.
 */
export function shapePage(page: PageResult, opts: ShapeOptions): PageResult {
  if (page.error || page.markdown === undefined) return page;
  const focus = opts.focus?.trim();
  const doc = page.via === "convert" ? splitPages(page.markdown) : undefined;
  if (doc?.pages.length) {
    const start = Math.max(1, Math.floor(opts.pageStart ?? 1));
    if (!focus) {
      const w = pageWindow(doc, start, positive(opts.maxPages, PDF_DEFAULT_MAX_PAGES), positive(opts.maxChars, PDF_DEFAULT_MAX_CHARS));
      if ("error" in w) return { ...page, markdown: undefined, error: w.error };
      return { ...page, markdown: w.markdown, pageRange: w.pageRange, truncated: w.truncated, ...(w.nextPage === undefined ? {} : { nextPage: w.nextPage }) };
    }
    // Focus searches every page from pageStart unless maxPages narrows it.
    const from = doc.pages.findIndex((p) => p.n >= start);
    if (from < 0) return { ...page, markdown: undefined, error: `pageStart ${start} is past the last page (${doc.pages.at(-1)!.n})` };
    const searched = doc.pages.slice(from, from + positive(opts.maxPages, doc.pages.length));
    const found = focusPassages(searched.map((p) => ({ page: p.n, text: p.text })), focus, positive(opts.maxChars, FOCUS_DEFAULT_MAX_CHARS));
    const last = searched.at(-1)!.n;
    const next = doc.pages.find((p) => p.n > last)?.n;
    return {
      ...page,
      markdown: found.passages.length ? found.markdown : noPassages(focus),
      passages: found.passages,
      pageRange: [searched[0].n, last],
      truncated: next !== undefined,
      ...(next === undefined ? {} : { nextPage: next }),
    };
  }
  if (focus) {
    const found = focusPassages([{ text: page.markdown }], focus, positive(opts.maxChars, FOCUS_DEFAULT_MAX_CHARS));
    return { ...page, markdown: found.passages.length ? found.markdown : noPassages(focus), passages: found.passages };
  }
  if (opts.maxChars !== undefined && page.markdown.length > opts.maxChars) {
    return { ...page, markdown: clipAtBoundary(page.markdown, positive(opts.maxChars, page.markdown.length)), truncated: true };
  }
  return page;
}

function positive(n: number | undefined, fallback: number): number {
  return n !== undefined && Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

function noPassages(focus: string): string {
  return `[No passage matches "${focus}". Fetch without focus to read the document, or ask in other words.]`;
}

/** Errors where an archived copy could help (not bad input or unsupported formats). */
function isArchivable(error: string): boolean {
  return !/^only http|unsupported content type|too large/.test(error);
}

async function viaWayback(url: string, liveError: string): Promise<PageResult> {
  try {
    const { html, archiveUrl, archivedAt } = await fetchArchived(url);
    const { title, markdown } = htmlToMarkdown(html, url);
    return { url, title, markdown, via: "wayback", archivedAt, archiveUrl, liveError, ...detectPaywall(html, markdown) };
  } catch (e) {
    return { url, error: `${liveError}; archive: ${errorMessage(e)}` };
  }
}

async function fetchPage(url: string, render: RenderMode, ai?: Ai, browser?: BrowserSession): Promise<PageResult> {
  if (!/^https?:\/\//i.test(url)) return { url, error: "only http(s) URLs are supported" };
  if (render === "always") {
    if (!browser) return { url, error: "browser rendering is not configured" };
    return viaBrowser(url, browser);
  }

  let plain: PageResult;
  let retryable = false;
  try {
    plain = await viaFetch(url, ai);
    retryable = plain.error?.endsWith(BLOCKED_SUFFIX) ?? false;
  } catch (e) {
    // Network errors and timeouts; a browser sometimes gets through.
    plain = { url, error: errorMessage(e) };
    retryable = true;
  }
  const isThin = !plain.error && plain.markdown !== undefined && wordCount(plain.markdown) < THIN_PAGE_WORDS;
  if (render === "auto" && browser && (isThin || retryable)) {
    const rendered = await viaBrowser(url, browser);
    if (!rendered.error) return rendered;
    // Keep whatever plain fetch got rather than reporting only the browser failure.
    if (!plain.error) return plain;
    return { url, error: `${plain.error}; browser: ${rendered.error}` };
  }
  return plain;
}

async function viaFetch(url: string, ai?: Ai): Promise<PageResult> {
  // One timer for headers and HTML bodies; documents get longer to download.
  const abort = new AbortController();
  let timer = setTimeout(() => abort.abort(new Error(`timed out after ${FETCH_TIMEOUT_MS / 1000}s`)), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: BROWSER_HEADERS, redirect: "follow", signal: abort.signal });
    if (!res.ok) {
      await res.body?.cancel();
      const suffix = BROWSER_RETRY_STATUSES.has(res.status) ? BLOCKED_SUFFIX : "";
      return { url, finalUrl: res.url, error: `HTTP ${res.status}${suffix}` };
    }
    const contentType = res.headers.get("content-type") ?? "";
    const type = contentType.split(";")[0].trim().toLowerCase();
    const isDocument = DOCUMENT_TYPES.has(type);
    const maxBytes = isDocument ? documentByteLimit(res.url || url, type) : MAX_HTML_BYTES;
    const size = Number(res.headers.get("content-length") ?? 0);
    if (size > maxBytes) {
      await res.body?.cancel();
      return { url, error: `too large (${size} bytes; the limit is ${maxBytes} bytes)` };
    }
    if (isDocument) {
      if (!ai) {
        await res.body?.cancel();
        return { url, error: `unsupported content type: ${type} (AI binding not configured)` };
      }
      clearTimeout(timer);
      // The download clock starts when the document's turn to convert comes, not while it queues.
      const startDownload = () => {
        timer = setTimeout(() => abort.abort(new Error(`download timed out after ${DOCUMENT_DOWNLOAD_MS / 1000}s`)), DOCUMENT_DOWNLOAD_MS);
      };
      return await viaToMarkdown(url, res, type, ai, maxBytes, startDownload);
    }
    if (type === "text/markdown" || type === "text/plain") {
      return { url, finalUrl: res.url, markdown: (await decodeBody(res, contentType)).trim(), via: "fetch" };
    }
    if (type && type !== "text/html" && type !== "application/xhtml+xml") {
      await res.body?.cancel();
      return { url, error: `unsupported content type: ${type}` };
    }
    const html = await decodeBody(res, contentType);
    const { title, markdown } = htmlToMarkdown(html, res.url || url);
    return { url, finalUrl: res.url, title, markdown, via: "fetch", ...detectPaywall(html, markdown) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * PDFs and office documents go through Workers AI's converter (free for these
 * formats); see doc_convert.ts. The converted, page-split text is cached so
 * later parts and focus questions skip the download and conversion.
 */
async function viaToMarkdown(url: string, res: Response, type: string, ai: Ai, maxBytes: number, startDownload: () => void): Promise<PageResult> {
  const size = Number(res.headers.get("content-length") ?? 0);
  const release = await reserveConversionMemory(size || maxBytes, CONVERSION_QUEUE_MS);
  if (!release) {
    await res.body?.cancel();
    return { url, error: "busy converting other large documents; try again shortly" };
  }
  startDownload();
  try {
    const hideStructTree = type === "application/pdf" && size > STRUCT_TREE_MAX_BYTES;
    const bytes = await readDocument(res, type, maxBytes, hideStructTree);
    const name = documentName(res.url || url, type);
    const out = await convertDocument(ai, name, bytes);
    if ("error" in out) return { url, finalUrl: res.url, error: `conversion failed: ${out.error}` };
    const markdown = stripDocumentMetadata(out.markdown.trim());
    const stats = pdfPageStats(markdown);
    await saveDoc({ url, finalUrl: res.url, title: name, doc: splitPages(markdown), ...stats });
    return { url, finalUrl: res.url, title: name, markdown, via: "convert", ...stats };
  } catch (e) {
    if (e instanceof TooLargeError) return { url, error: `too large (over ${maxBytes} bytes)` };
    throw e;
  } finally {
    release();
  }
}

/**
 * toMarkdown opens with a "## Metadata" list (author names, internal IDs, creator
 * software) that only spends the reader's character budget; keep the contents.
 */
export function stripDocumentMetadata(markdown: string): string {
  return markdown.replace(/^## Metadata\s*\n(?:- .*\n?)*/m, "").replace(/^## Contents\s*\n/m, "").trim();
}

/**
 * toMarkdown marks PDF pages "### Page N"; a page with (almost) no text is a
 * scanned image, which free conversion can't read. Exchange results filings are
 * often scanned past the cover letter.
 */
export function pdfPageStats(markdown: string): { pages?: number; scannedPages?: number } {
  const body = markdown.split(/^## Contents\s*$/m)[1] ?? markdown;
  // (Also works after stripDocumentMetadata has removed the headers.)
  const pages = body.split(/^### Page \d+\s*$/m).slice(1);
  if (!pages.length) return {};
  const scanned = pages.filter((p) => p.replace(/!\[[^\]]*\]\([^)]*\)|[#|\-\s]/g, "").length < 40).length;
  return { pages: pages.length, scannedPages: scanned };
}

const DOCUMENT_TIMEOUT_MS = 6000;
const MAX_FILING_PDF_BYTES = 10_000_000;
// Filing subjects are best-effort; don't hold a search up behind a large conversion.
const FILING_QUEUE_MS = 1500;

/**
 * A PDF's text as Markdown (free conversion, images off, metadata stripped), or
 * undefined. Used for filing snippets; shares the document cache with /fetch.
 */
export async function pdfToMarkdown(url: string, ai: Ai): Promise<string | undefined> {
  const stored = await loadDoc(url);
  if (stored) return joinPages(stored.doc);
  const res = await fetch(url, {
    headers: { ...BROWSER_HEADERS, accept: "application/pdf,*/*;q=0.8" },
    redirect: "follow",
    signal: AbortSignal.timeout(DOCUMENT_TIMEOUT_MS),
  });
  const size = Number(res.headers.get("content-length") ?? 0);
  if (!res.ok || size > MAX_FILING_PDF_BYTES || !/pdf/i.test(res.headers.get("content-type") ?? "")) {
    await res.body?.cancel();
    return undefined;
  }
  const release = await reserveConversionMemory(size || MAX_FILING_PDF_BYTES, FILING_QUEUE_MS);
  if (!release) {
    await res.body?.cancel();
    return undefined;
  }
  try {
    const type = "application/pdf";
    const bytes = await readDocument(res, type, MAX_FILING_PDF_BYTES, size > STRUCT_TREE_MAX_BYTES);
    const name = documentName(res.url || url, type);
    const out = await convertDocument(ai, name, bytes);
    if ("error" in out) return undefined;
    const markdown = stripDocumentMetadata(out.markdown.trim());
    await saveDoc({ url, finalUrl: res.url, title: name, doc: splitPages(markdown), ...pdfPageStats(markdown) });
    return markdown;
  } catch {
    return undefined;
  } finally {
    release();
  }
}

async function viaBrowser(url: string, browser: BrowserSession): Promise<PageResult> {
  try {
    const { html, finalUrl } = await browser.render(url);
    const { title, markdown } = htmlToMarkdown(html, finalUrl);
    return { url, finalUrl, title, markdown, via: "browser", ...detectPaywall(html, markdown) };
  } catch (e) {
    return { url, error: errorMessage(e) };
  }
}

/** One Browser Run session per request, launched lazily, with a cap on open tabs. */
class BrowserSession {
  private browser?: Promise<Browser>;
  private open = 0;
  private waiting: (() => void)[] = [];

  constructor(private binding: Fetcher, private maxTabs = 3) {}

  async render(url: string): Promise<{ html: string; finalUrl: string }> {
    await this.acquire();
    try {
      this.browser ??= puppeteer.launch(this.binding);
      const page = await (await this.browser).newPage();
      try {
        await page.setUserAgent(BROWSER_HEADERS["user-agent"]);
        try {
          await page.goto(url, { waitUntil: "networkidle2", timeout: 20_000 });
        } catch (e) {
          // Pages that never go network-idle still usually have content by now.
          if (!/timeout/i.test(errorMessage(e))) throw e;
        }
        return { html: await page.content(), finalUrl: page.url() };
      } finally {
        await page.close().catch(() => {});
      }
    } finally {
      this.release();
    }
  }

  async close() {
    if (!this.browser) return;
    const browser = await this.browser.catch(() => undefined);
    await browser?.close().catch(() => {});
  }

  private async acquire() {
    if (this.open < this.maxTabs) {
      this.open++;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private release() {
    const next = this.waiting.shift();
    if (next) next();
    else this.open--;
  }
}

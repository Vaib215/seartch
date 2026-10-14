import puppeteer, { type Browser } from "@cloudflare/puppeteer";
import { decodeBody } from "./decode";
import { htmlToMarkdown, wordCount } from "./extract";
import type { Env } from "./index";
import { detectPaywall } from "./paywall";
import { BROWSER_HEADERS, errorMessage, mapLimit } from "./util";
import { fetchArchived } from "./wayback";

export const RENDER_MODES = ["auto", "never", "always"] as const;
export type RenderMode = (typeof RENDER_MODES)[number];

export interface FetchOptions {
  render: RenderMode;
  /** Fall back to the latest Wayback Machine capture when the live page fails. */
  archiveFallback?: boolean;
}

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
  error?: string;
}

const FETCH_CONCURRENCY = 6;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_HTML_BYTES = 5_000_000;
const MAX_DOCUMENT_BYTES = 20_000_000;
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
  try {
    return await mapLimit(urls, FETCH_CONCURRENCY, async (url) => {
      const live = await fetchPage(url, render, env.AI, browser);
      if (!live.error || !isArchivable(live.error)) return live;
      if (archiveBudget <= 0) {
        return opts.archiveFallback ? { ...live, error: `${live.error}; archive: skipped (lookup limit reached)` } : live;
      }
      archiveBudget--;
      return viaWayback(url, live.error);
    });
  } finally {
    await browser?.close();
  }
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
  const res = await fetch(url, {
    headers: BROWSER_HEADERS,
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    await res.body?.cancel();
    const suffix = BROWSER_RETRY_STATUSES.has(res.status) ? BLOCKED_SUFFIX : "";
    return { url, finalUrl: res.url, error: `HTTP ${res.status}${suffix}` };
  }
  const contentType = res.headers.get("content-type") ?? "";
  const type = contentType.split(";")[0].trim().toLowerCase();
  const isDocument = DOCUMENT_TYPES.has(type);
  const maxBytes = isDocument ? MAX_DOCUMENT_BYTES : MAX_HTML_BYTES;
  const size = Number(res.headers.get("content-length") ?? 0);
  if (size > maxBytes) {
    await res.body?.cancel();
    return { url, error: `too large (${size} bytes)` };
  }
  if (isDocument) {
    if (!ai) {
      await res.body?.cancel();
      return { url, error: `unsupported content type: ${type} (AI binding not configured)` };
    }
    return viaToMarkdown(url, res, type, ai);
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
}

// toMarkdown is free except where it runs AI models on images; turning off
// embedded-image conversion keeps every conversion on the free path.
const NO_IMAGE_MODELS: ConversionRequestOptions = {
  conversionOptions: {
    pdf: { images: { convert: false } },
    docx: { images: { convert: false } },
  },
};

/** PDFs and office documents go through Workers AI's converter (free for these formats). */
async function viaToMarkdown(url: string, res: Response, type: string, ai: Ai): Promise<PageResult> {
  const blob = new Blob([await res.arrayBuffer()], { type });
  const name = new URL(res.url || url).pathname.split("/").pop() || "document";
  const out = await ai.toMarkdown({ name, blob }, NO_IMAGE_MODELS);
  if (out.format === "error") return { url, finalUrl: res.url, error: `conversion failed: ${out.error}` };
  const markdown = stripDocumentMetadata(out.data.trim());
  return { url, finalUrl: res.url, title: name, markdown, via: "convert", ...pdfPageStats(markdown) };
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

/** A PDF's text as Markdown (free conversion, images off), or undefined. Used for filing snippets. */
export async function pdfToMarkdown(url: string, ai: Ai): Promise<string | undefined> {
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
  const blob = new Blob([await res.arrayBuffer()], { type: "application/pdf" });
  const out = await ai.toMarkdown({ name: "filing.pdf", blob }, NO_IMAGE_MODELS);
  return out.format === "error" ? undefined : out.data;
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

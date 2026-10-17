// Long documents in parts. Converted PDFs are split on their "### Page N"
// markers, returned a window of pages at a time within a character budget, and
// remembered (per isolate and in the Cache API) so the next part, or a focus
// question about the same file, doesn't download and convert it again.

export interface DocPage {
  n: number;
  text: string;
}

/** A converted document: the text before the first page marker, then its pages. */
export interface SplitDoc {
  head: string;
  pages: DocPage[];
}

const PAGE_MARKER = /^### Page (\d+)[ \t]*$/gm;

export function splitPages(markdown: string): SplitDoc {
  const marks = [...markdown.matchAll(PAGE_MARKER)];
  if (!marks.length) return { head: markdown.trim(), pages: [] };
  const pages = marks.map((m, i) => {
    const start = m.index + m[0].length;
    const end = i + 1 < marks.length ? marks[i + 1].index : markdown.length;
    return { n: Number(m[1]), text: markdown.slice(start, end).trim() };
  });
  return { head: markdown.slice(0, marks[0].index).trim(), pages };
}

const pageBlock = (p: DocPage) => (p.text ? `### Page ${p.n}\n${p.text}` : `### Page ${p.n}`);

/** Inverse of splitPages (up to whitespace). */
export function joinPages(doc: SplitDoc): string {
  return [doc.head, ...doc.pages.map(pageBlock)].filter(Boolean).join("\n\n");
}

export interface PageWindow {
  markdown: string;
  /** First and last page returned. */
  pageRange: [number, number];
  /** The document continues past the last page returned (or that page was cut). */
  truncated: boolean;
  /** pageStart for the next part. */
  nextPage?: number;
}

/**
 * Pages [start, start + maxPages) that fit in maxChars. The first page is
 * always returned, cut to maxChars if it alone is longer, so callers can't get
 * stuck on an oversized page.
 */
export function pageWindow(doc: SplitDoc, start: number, maxPages: number, maxChars: number): PageWindow | { error: string } {
  const from = doc.pages.findIndex((p) => p.n >= start);
  if (from < 0) {
    const last = doc.pages.at(-1)?.n ?? 0;
    return { error: `pageStart ${start} is past the last page (${last})` };
  }
  const parts: string[] = [];
  let used = 0;
  // The title line only belongs to the first part.
  if (doc.head && from === 0) {
    parts.push(doc.head);
    used = doc.head.length;
  }
  let i = from;
  let cut = false;
  for (; i < doc.pages.length && i - from < maxPages; i++) {
    const block = pageBlock(doc.pages[i]);
    const sep = parts.length ? 2 : 0;
    if (used + sep + block.length <= maxChars) {
      parts.push(block);
      used += sep + block.length;
      continue;
    }
    if (i === from) {
      const note = `\n\n[... page ${doc.pages[i].n} cut at ${maxChars} characters; pass a larger maxChars for all of it]`;
      parts.push(clipAtBoundary(block, Math.max(0, maxChars - used - sep - note.length)) + note);
      cut = true;
      i++;
    }
    break;
  }
  const first = doc.pages[from].n;
  const last = doc.pages[i - 1].n;
  const next = doc.pages[i]?.n;
  return { markdown: parts.join("\n\n"), pageRange: [first, last], truncated: cut || next !== undefined, nextPage: next };
}

/** Text cut to at most max characters, at a paragraph, line or word break when one is near. */
export function clipAtBoundary(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  for (const sep of ["\n\n", "\n", " "]) {
    const at = slice.lastIndexOf(sep);
    if (at >= max * 0.6) return slice.slice(0, at).trimEnd();
  }
  return slice;
}

// --- Size limits -----------------------------------------------------------

const MB = 1_000_000;
/**
 * Workers AI's converter rejects files whose base64 form is over 50,000,000
 * characters ("Too big", code 7001), i.e. over 37.5 MB, however the request is
 * sent. Exchange filings may use all of that: on Cloudflare (Oct 2026) a 32.3 MB
 * annual report converted with 80 MB of extra heap held, and a 20.8 MB
 * investor presentation with 115 MB of extra ArrayBuffers. Other sites keep a
 * smaller limit. Conversions also share a per-isolate budget
 * (reserveConversionMemory in doc_convert.ts).
 */
export const CONVERTER_MAX_BYTES = 37_500_000;
export const EXCHANGE_PDF_MAX_BYTES = CONVERTER_MAX_BYTES;
export const PDF_MAX_BYTES = 25 * MB;
export const OTHER_DOCUMENT_MAX_BYTES = 20 * MB;

const EXCHANGE_HOSTS = new Set(["nsearchives.nseindia.com", "archives.nseindia.com", "www.nseindia.com", "bseindia.com"]);

/** NSE archive hosts and BSE (any subdomain), which serve large filings such as investor presentations. */
export function isExchangeHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return EXCHANGE_HOSTS.has(h) || h.endsWith(".bseindia.com");
}

/** Largest document fetched from url (after redirects) for a content type. */
export function documentByteLimit(url: string, type: string): number {
  if (type !== "application/pdf") return OTHER_DOCUMENT_MAX_BYTES;
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    // Not a URL: the default limit.
  }
  return isExchangeHost(host) ? EXCHANGE_PDF_MAX_BYTES : PDF_MAX_BYTES;
}

// --- Cache of converted documents -------------------------------------------

export interface StoredDoc {
  url: string;
  finalUrl?: string;
  title?: string;
  doc: SplitDoc;
  pages?: number;
  scannedPages?: number;
}

// Bump when conversion or page splitting changes, so older entries are ignored.
const CACHE_VERSION = 1;
// Exchange filings never change; a day keeps "next part" and focus requests cheap.
const CACHE_TTL_SECONDS = 86_400;
const MEMO_MAX_DOCS = 24;
const MEMO_MAX_CHARS = 8_000_000;

const memo = new Map<string, StoredDoc>();
let memoChars = 0;

const docChars = (d: StoredDoc) => d.doc.head.length + d.doc.pages.reduce((n, p) => n + p.text.length, 0);

export function docCacheKey(url: string): string {
  return `https://seartch.internal/doc-pages/v${CACHE_VERSION}?u=${encodeURIComponent(url)}`;
}

function remember(entry: StoredDoc) {
  const prev = memo.get(entry.url);
  if (prev) {
    memo.delete(entry.url);
    memoChars -= docChars(prev);
  }
  memo.set(entry.url, entry);
  memoChars += docChars(entry);
  for (const [key, old] of memo) {
    if (memo.size <= MEMO_MAX_DOCS && memoChars <= MEMO_MAX_CHARS) break;
    if (key === entry.url) continue;
    memo.delete(key);
    memoChars -= docChars(old);
  }
}

/** This isolate's copy only (no I/O). */
export function memoDoc(url: string): StoredDoc | undefined {
  const hit = memo.get(url);
  if (hit) {
    // Refresh its place in the LRU order.
    memo.delete(url);
    memo.set(url, hit);
  }
  return hit;
}

export async function loadDoc(url: string): Promise<StoredDoc | undefined> {
  const hit = memoDoc(url);
  if (hit) return hit;
  const cache = defaultCache();
  if (!cache) return undefined;
  try {
    const res = await cache.match(docCacheKey(url));
    if (!res) return undefined;
    const entry = (await res.json()) as StoredDoc;
    if (!entry?.doc || !Array.isArray(entry.doc.pages)) return undefined;
    remember(entry);
    return entry;
  } catch {
    return undefined;
  }
}

export async function saveDoc(entry: StoredDoc): Promise<void> {
  remember(entry);
  const cache = defaultCache();
  if (!cache) return;
  try {
    await cache.put(
      docCacheKey(entry.url),
      new Response(JSON.stringify(entry), {
        headers: { "content-type": "application/json", "cache-control": `max-age=${CACHE_TTL_SECONDS}` },
      }),
    );
  } catch {
    // The isolate memo still has it.
  }
}

function defaultCache(): Cache | undefined {
  return typeof caches === "undefined" ? undefined : caches.default;
}

export function _clearDocMemo() {
  memo.clear();
  memoChars = 0;
}

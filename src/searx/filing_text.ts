// What a filing is about, read from its PDF. Exchange metadata often says only
// "General Updates" or "the financial results for the period ended September 30",
// while the filing's cover letter states its subject ("Sub: Financial Results ...
// and declaration of second interim dividend").

export type DocumentText = (url: string) => Promise<string | undefined>;

let documentText: DocumentText | undefined;

/** Called per request with a PDF-to-text converter (Workers AI toMarkdown), or undefined. */
export function configureDocumentText(fn: DocumentText | undefined) {
  documentText = fn;
}

// Where a cover letter's subject line ends and its body begins.
const SUBJECT_END =
  /\s*(?:dear\s+(?:sir|madam|members)|ref(?:erence)?\s*[:.]|in accordance with|pursuant to|with reference to|further to|in terms of|we wish to|we would like|we enclose|we are enclosing|we hereby|we write|please find|this is to|kindly|in compliance with|in continuation|as per regulation|enclosed (?:herewith|please)|the board of directors)\b/i;
// Subjects that only cite the disclosure rule; the letter's first sentence says more.
const BOILERPLATE_SUBJECT = /^(?:intimation|disclosure|information|submission)s?\s+(?:under|pursuant to|of)\s+(?:regulation|reg\.|sebi)|^regulation\s+\d+/i;
// Lead-ins that precede the actual news in a letter body.
const LEAD_IN =
  /^(?:.*?\b(?:we (?:wish|would like) to (?:inform|intimate)(?: you)?(?: that)?|this is to (?:inform|intimate)(?: you)?(?: that)?|please be informed that|we hereby inform(?: you)? that|we are pleased to inform(?: you)? that)\s*,?\s*)/i;
const MAX_SUBJECT = 220;

/** The "Sub:" / "Subject:" line of a filing, or the first sentence of its body. */
export function extractSubject(markdown: string): string | undefined {
  const text = markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/#+\s*Page \d+/g, " ")
    .replace(/^#+\s*/gm, "")
    .replace(/^- [A-Za-z]+(?:=|:).*$/gm, " ") // metadata bullets
    .replace(/[|*_`]+/g, " ")
    .replace(/\s+/g, " ");
  // "Re:" only with a colon, so words like "re-appointment" don't count.
  const sub = /\b(?:sub(?:ject)?\s*[:.\-–]|re\s*:)\s*(.{10,400})/i.exec(text);
  if (sub) {
    const [line, ...rest] = sub[1].split(SUBJECT_END);
    const subject = line.trim().replace(/[\s,;:-]+$/, "");
    if (subject.length >= 10 && !BOILERPLATE_SUBJECT.test(subject)) return clip(subject);
    // Boilerplate subject: use the first sentence of the body that follows it.
    const after = text.slice(text.indexOf(sub[1]) + line.length);
    const sentence = firstSentence(after.replace(/^[^a-z0-9]*/i, ""));
    if (sentence) return clip(sentence);
    if (subject.length >= 10) return clip(subject);
  }
  const body = /dear\s+(?:sir|madam)[^,]{0,20},?\s*(.{20,400})/i.exec(text);
  if (body) return clip(body[1].split(/(?<=[.!?])\s/)[0].trim());
  return undefined;
}

// A body sentence must say something: long enough, and not more rule-citing.
const BOILERPLATE_SENTENCE = /^(?:in accordance with|pursuant to|in compliance with|in terms of|as per)\b/i;

function firstSentence(body: string): string | undefined {
  const s = body
    .replace(LEAD_IN, "")
    // Sentence ends, but not after abbreviations like "Mr." or "Rs.".
    .split(/(?<!\b(?:Mr|Ms|Mrs|Dr|Sr|Jr|No|Nos|Rs|Ltd|Co|Inc|vs|St|Smt|Shri)\.)(?<=[.!?])\s+(?=[A-Z])/)[0]
    ?.trim();
  return s && s.length >= 40 && !BOILERPLATE_SENTENCE.test(s) ? s : undefined;
}

function clip(s: string): string {
  return s.length <= MAX_SUBJECT ? s : `${s.slice(0, MAX_SUBJECT - 1).replace(/\s+\S*$/, "")}…`;
}

// Filings never change, so subjects are cached for a long time: per isolate and
// in the data center's Cache API. An empty string records "no subject found".
const memo = new Map<string, string>();
const MEMO_MAX = 5000;
const CACHE_TTL_SECONDS = 7 * 86_400;
// Bump when extraction changes, so cached subjects from older logic are ignored.
const EXTRACTION_VERSION = 2;

export async function filingSubject(url: string): Promise<string | undefined> {
  const convert = documentText;
  if (!convert) return undefined;
  const hit = memo.get(url);
  if (hit !== undefined) return hit || undefined;
  const key = `https://seartch.internal/filing-subject/v${EXTRACTION_VERSION}?u=${encodeURIComponent(url)}`;
  try {
    const cached = await caches.default.match(key);
    if (cached) {
      const text = await cached.text();
      remember(url, text);
      return text || undefined;
    }
  } catch {
    // No Cache API here (tests): convert directly.
  }
  const markdown = await convert(url).catch(() => undefined);
  if (markdown === undefined) return undefined; // fetch/convert failed: don't cache, retry later
  const subject = extractSubject(markdown) ?? "";
  remember(url, subject);
  try {
    await caches.default.put(key, new Response(subject, { headers: { "cache-control": `max-age=${CACHE_TTL_SECONDS}` } }));
  } catch {
    // Best-effort.
  }
  return subject || undefined;
}

function remember(url: string, subject: string) {
  if (memo.size >= MEMO_MAX) memo.clear();
  memo.set(url, subject);
}

export function _clearFilingMemo() {
  memo.clear();
}

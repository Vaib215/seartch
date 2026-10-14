// Flags pages whose article text is (partly) behind a paywall, so callers don't
// mistake a subscribe page or a teaser for the full story.

import { wordCount } from "./extract";

export interface PaywallInfo {
  paywalled: true;
  /** True when the returned text is clearly not the whole article. */
  partial: boolean;
  paywallSignals: string[];
}

// Phrases that appear in the extracted text of paywall / registration barriers.
const BARRIER_PHRASES = [
  "subscribe to unlock this article",
  "register to unlock this article",
  "subscribe to continue reading",
  "subscribe to read",
  "subscribe now to continue",
  "this article is for subscribers",
  "this article is exclusive to subscribers",
  "this content is for subscribers",
  "already a subscriber? sign in",
  "sign in to continue reading",
  "log in to continue reading",
  "create a free account to continue",
  "register for free to continue",
  "you have reached your limit of free articles",
  "you've reached your free article limit",
  "member-only story",
  "become a member to read",
  "unlock this article",
  "premium story",
  "subscriber-only",
];

// When schema.org says the article is paywalled and we got less than this share
// of its declared length, treat the text as a teaser.
const PARTIAL_RATIO = 0.7;
// Paywalled article with no declared length: this few words is a teaser.
const PARTIAL_WORDS = 300;

export function detectPaywall(html: string, markdown: string): PaywallInfo | undefined {
  const signals: string[] = [];
  const { notFree, declaredWords } = schemaAccess(html);
  if (notFree) signals.push("schema.org isAccessibleForFree=false");

  const text = markdown.toLowerCase();
  const phrase = BARRIER_PHRASES.find((p) => text.includes(p));
  if (phrase) signals.push(`text: "${phrase}"`);

  if (!signals.length) return undefined;

  const words = wordCount(markdown);
  let partial = !!phrase;
  if (!partial && declaredWords) {
    partial = words < declaredWords * PARTIAL_RATIO;
    if (partial) signals.push(`got ${words} of ${declaredWords} declared words`);
  } else if (!partial) {
    partial = words < PARTIAL_WORDS;
  }
  return { paywalled: true, partial, paywallSignals: signals };
}

/** Reads schema.org paywall markup (isAccessibleForFree, wordCount) from JSON-LD. */
function schemaAccess(html: string): { notFree: boolean; declaredWords?: number } {
  let notFree = false;
  let declaredWords: number | undefined;
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    const block = m[1];
    // Regex rather than JSON.parse: publishers' JSON-LD is often slightly invalid,
    // and the value shows up as false, "false" or "False".
    if (/"isAccessibleForFree"\s*:\s*"?false"?/i.test(block)) notFree = true;
    const wc = /"wordCount"\s*:\s*"?(\d+)/.exec(block);
    if (wc) declaredWords = Math.max(declaredWords ?? 0, Number(wc[1]));
  }
  return { notFree, declaredWords };
}

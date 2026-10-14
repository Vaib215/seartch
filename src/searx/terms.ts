// Query understanding for finance/news searches: which words name the subject
// ("tata", "elxsi") and which are reporting jargon ("q2", "results", "fy27")
// that publishers phrase many ways.

const STOPWORDS = new Set([
  "the", "a", "an", "of", "in", "on", "for", "and", "to", "is", "are", "was", "what", "why", "how", "when", "did",
  "does", "do", "has", "have", "with", "by", "at", "from", "about", "vs", "or", "its", "it", "this", "that", "any",
  "news", "latest", "today", "update", "updates", "india", "indian",
  // Question and reporting verbs: an article about the event never uses the asker's verb.
  "publish", "published", "publishes", "announce", "announced", "announces", "declare", "declared", "declares",
  "reported", "reports", "release", "released", "releases", "post", "posted", "posts", "say", "says", "said",
  "expect", "expected", "will", "would", "should", "can", "could", "show", "find", "get", "give", "list", "tell",
  "me", "us", "my", "our", "please", "yesterday", "tomorrow", "this", "week", "month", "year", "recent", "new",
  "one", "two", "three", "five", "ten", "last", "past", "since", "over", "much", "many", "current", "currently",
]);

// Reporting vocabulary. These never decide whether a story is about the subject.
const JARGON = new Set([
  "result", "results", "earnings", "quarter", "quarterly", "profit", "net", "revenue", "income", "pat", "ebitda",
  "margin", "margins", "growth", "share", "shares", "stock", "stocks", "price", "target", "buy", "sell", "hold",
  "rating", "dividend", "outcome", "board", "meeting", "announcement", "announcements", "filing", "filings",
  "q1", "q2", "q3", "q4", "h1", "h2", "fy", "yoy", "qoq", "consolidated", "standalone", "analysis", "review",
  "preview", "report", "estimates", "guidance", "call", "conference", "concall", "transcript", "performance",
  "april", "june", "july", "september", "october", "december", "january", "march",
  // Price action and the questions around it.
  "falling", "fall", "falls", "fell", "rising", "rise", "rises", "rose", "jump", "jumps", "jumped", "surge", "surges",
  "surged", "crash", "crashes", "crashed", "slump", "slumps", "plunge", "plunges", "rally", "rallies", "soar", "soars",
  "gain", "gains", "drop", "drops", "dropped", "decline", "declines", "up", "down", "high", "low", "outlook", "why",
  "trend", "forecast", "valuation", "upgrade", "downgrade", "brokerage", "brokerages", "analyst", "analysts",
  "return", "returns", "performance", "level", "levels", "value", "close", "closing", "open", "opening", "today's",
]);

// How publishers and exchange filings name each quarter.
const QUARTER_MONTHS: Record<string, string[]> = {
  q1: ["q1", "june quarter", "april-june", "apr-jun", "first quarter", "ended june 30", "june 30", "30th june", "30 june"],
  q2: ["q2", "september quarter", "july-september", "jul-sep", "second quarter", "ended september 30", "september 30", "30th september", "30 september", "half year"],
  q3: ["q3", "december quarter", "october-december", "oct-dec", "third quarter", "ended december 31", "december 31", "31st december", "31 december"],
  q4: ["q4", "march quarter", "january-march", "jan-mar", "fourth quarter", "ended march 31", "march 31", "31st march", "31 march", "full year"],
};

export interface QueryTerms {
  /** Words that name the subject; a relevant story mentions all of them. */
  subject: string[];
  /** Reporting jargon; optional, used for ranking. Quarters are expanded to their phrasings. */
  jargon: string[];
}

/** Lowercases and splits glued period labels ("Q2FY27" → "q2 fy27") so text and queries agree. */
export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/(q[1-4]|h[12])\s*-?\s*(fy\s*'?\d{2,4})/g, "$1 $2");
}

function words(query: string): string[] {
  return normalizeText(query)
    .split(/[^\p{L}\p{N}&.]+/u)
    .map((w) => w.replace(/^[.]+|[.]+$/g, ""))
    .filter((w) => w.length > 1 || /\d/.test(w));
}

export function splitQuery(query: string): QueryTerms {
  const subject: string[] = [];
  const jargon = new Set<string>();
  for (const w of words(query)) {
    if (STOPWORDS.has(w)) continue;
    if (JARGON.has(w) || /^fy'?\d{2,4}$/.test(w) || /^20\d{2}(-\d{2})?$/.test(w)) {
      for (const phrase of QUARTER_MONTHS[w] ?? [w]) jargon.add(phrase);
    } else {
      subject.push(w);
    }
  }
  return { subject: [...new Set(subject)], jargon: [...jargon] };
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether one term or phrase occurs in already-lowercased text. Short terms
 * must be whole words ("ril" must not hit "april"); longer ones may sit inside
 * a word, so "elxsi" still hits the ticker "tataelxsi".
 */
export function containsTerm(hay: string, term: string): boolean {
  if (term.length > 4) return hay.includes(term);
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escape(term)}($|[^\\p{L}\\p{N}])`, "u").test(hay);
}

/**
 * True when the text mentions the subject: every subject term, except that
 * queries with three or more subject terms may miss one.
 */
export function mentionsSubject(text: string, terms: QueryTerms): boolean {
  if (!terms.subject.length) return true;
  const hay = normalizeText(text);
  const missing = terms.subject.filter((t) => !containsTerm(hay, t)).length;
  return missing === 0 || (terms.subject.length >= 3 && missing <= 1);
}

/**
 * Index names (NIFTY 50, Bank Nifty, Sensex, India VIX...). Queries about an
 * index are not about a company.
 */
export const INDEX_WORDS = /\b(nifty\s*\d*|bank\s*nifty|fin\s*nifty|sensex|bankex|india\s*vix|vix|midcap|smallcap|largecap)\b/i;

/** Topic words: the subject words that don't name the company ("infosys deal wins" → deal, wins). */
export function topicTerms(query: string, aliases: string[]): string[] {
  const aliasWords = new Set(aliases.flatMap((a) => a.toLowerCase().split(/[^\p{L}\p{N}&]+/u)).filter(Boolean));
  return splitQuery(query).subject.filter((w) => !aliasWords.has(w) && ![...aliasWords].some((a) => a.length > 4 && a.includes(w)));
}

/**
 * With a resolved company, the text must name it: by an alias, or by every query
 * word that belongs to the company name. Topic words alone ("deal wins") never
 * make a story about the company.
 */
export function namesCompany(text: string, terms: QueryTerms, aliases: string[]): boolean {
  const hay = normalizeText(text).replace(/[.'’]/g, "");
  if (aliases.some((a) => containsTerm(hay, a.toLowerCase().replace(/[.'’]/g, "")))) return true;
  const aliasWords = new Set(aliases.flatMap((a) => a.toLowerCase().split(/[^\p{L}\p{N}&]+/u)).filter(Boolean));
  const nameWords = terms.subject.filter((w) => aliasWords.has(w));
  return nameWords.length > 0 && nameWords.every((w) => containsTerm(hay, w));
}

// How news and filings phrase common research topics.
const TOPIC_SYNONYMS: Record<string, string[]> = {
  deal: ["deal", "deals", "contract", "contracts", "order", "orders", "agreement", "pact", "partnership", "mandate", "engagement", "tcv"],
  win: ["win", "wins", "won", "winning", "bag", "bags", "bagged", "secure", "secures", "secured", "sign", "signs", "signed", "award", "awarded", "clinch", "clinches", "clinched", "selected"],
  order: ["order", "orders", "contract", "contracts", "deal", "deals", "award", "awarded", "work order"],
  acquisition: ["acquisition", "acquire", "acquires", "acquired", "buyout", "takeover", "stake"],
  merger: ["merger", "merge", "merges", "amalgamation", "demerger"],
  layoff: ["layoff", "layoffs", "job cuts", "retrenchment", "fired"],
  hiring: ["hiring", "hire", "hires", "headcount", "recruit", "recruitment", "job offers"],
  ceo: ["ceo", "chief executive", "managing director", "md and ceo", "md & ceo"],
  fraud: ["fraud", "probe", "investigation", "raid", "scam", "irregularities"],
  buyback: ["buyback", "buy-back", "share repurchase"],
  ipo: ["ipo", "public issue", "listing", "drhp", "rhp", "anchor"],
  expansion: ["expansion", "expand", "expands", "capex", "capacity", "new plant"],
  stake: ["stake", "stake sale", "shareholding", "block deal", "bulk deal", "promoter"],
  guidance: ["guidance", "outlook", "forecast"],
};

/** The phrasings a topic word may take: "wins" → win, won, bags, secures, signs... */
export function topicVariants(term: string): string[] {
  const stem = term.replace(/(?<=[a-z]{3})(?:es|s)$/, "");
  return TOPIC_SYNONYMS[term] ?? TOPIC_SYNONYMS[stem] ?? [...new Set([term, stem, `${stem}s`])];
}

/** How many of the given topic terms appear in the text, in any of their phrasings. */
export function termHits(text: string, terms: string[]): number {
  const hay = normalizeText(text);
  return terms.filter((t) => topicVariants(t).some((v) => containsTerm(hay, v))).length;
}

/** How many jargon phrasings appear, for ranking. */
export function jargonHits(text: string, terms: QueryTerms): number {
  const hay = normalizeText(text);
  return terms.jargon.filter((t) => containsTerm(hay, t)).length;
}

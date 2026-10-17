// Passages of a long document that answer a question. The text is cut into
// ~600-900 character passages on paragraph boundaries (each keeps its page),
// scored against the question with BM25, and the best ones are returned
// within a character budget.

export interface Passage {
  page?: number;
  text: string;
  score: number;
}

export interface PassageSource {
  page?: number;
  text: string;
}

interface Piece {
  page?: number;
  text: string;
  /** Position in the document, for putting selected passages back in reading order. */
  index: number;
}

const MIN_PASSAGE = 600;
const MAX_PASSAGE = 900;
// A short tail (or a one-line page such as a slide title) joins its neighbour when it fits.
const TAIL_PASSAGE = 200;

/** Splits each source (a page, or a whole page-less document) into passages; passages never cross pages. */
export function splitPassages(sources: PassageSource[], min = MIN_PASSAGE, max = MAX_PASSAGE): Piece[] {
  const out: Piece[] = [];
  for (const { page, text } of sources) {
    const units = cleanText(text)
      .split(/\n[ \t]*\n/)
      .map((u) => u.trim())
      .filter(Boolean)
      .flatMap((u) => breakLong(u, max));
    let cur = "";
    const flush = () => {
      if (!cur) return;
      const prev = out.at(-1);
      // Glue a short tail onto the previous passage from the same page.
      if (cur.length < TAIL_PASSAGE && prev && prev.page === page && prev.index >= out.length - 1 && prev.text.length + cur.length + 2 <= max + TAIL_PASSAGE) {
        prev.text += `\n\n${cur}`;
      } else {
        out.push({ page, text: cur, index: out.length });
      }
      cur = "";
    };
    for (const unit of units) {
      if (!cur) cur = unit;
      else if (cur.length + 2 + unit.length <= max || cur.length < min / 2) cur += `\n\n${unit}`;
      else {
        flush();
        cur = unit;
      }
      if (cur.length > max + TAIL_PASSAGE) {
        // A very short lead-in glued to a long unit: split again so passages stay near max.
        const [head, ...rest] = breakLong(cur, max);
        cur = head;
        for (const r of rest) {
          flush();
          cur = r;
        }
      }
    }
    flush();
  }
  return out;
}

function cleanText(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/^#{1,6}\s*Page \d+\s*$/gm, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

/** Splits a paragraph longer than max on sentences, then lines, then words. */
function breakLong(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  for (const sep of [/(?<=[.!?:;])\s+(?=["“(₹]?[A-Z0-9])/, /\n/]) {
    const pieces = text.split(sep).filter((s) => s.trim());
    if (pieces.length > 1) return pack(pieces, max, sep.source === "\\n" ? "\n" : " ").flatMap((p) => breakLong(p, max));
  }
  // No sentence or line breaks: cut at a space near max.
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let at = rest.lastIndexOf(" ", max);
    if (at < max * 0.5) at = max;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

function pack(pieces: string[], max: number, joiner: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (const p of pieces.map((s) => s.trim())) {
    if (cur && cur.length + joiner.length + p.length > max) {
      out.push(cur);
      cur = p;
    } else {
      cur = cur ? cur + joiner + p : p;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// --- Terms -------------------------------------------------------------------

const STOPWORDS = new Set(
  (
    "a about above after again against all also am an and any are as at be because been before being below between both but by can " +
    "could did do does doing down during each few for from further had has have having he her here hers him his how i if in into is it its " +
    "itself just me more most my no nor not now of off on once only or other our ours out over own same she should so some such than that " +
    "the their theirs them then there these they this those through to too under until up very was we were what when where which while who " +
    "whom why will with would you your yours " +
    // Question phrasing that says nothing about the topic.
    "tell give show explain describe discuss mention mentioned say said says talk talked please detail details regarding related " +
    "much many latest current kind any get got"
  ).split(" "),
);

/** Light suffix stripping so "days"/"day", "operating"/"operations" and "reduced"/"reducing" match. */
export function stem(word: string): string {
  let w = word;
  if (w.length <= 3 || /\d/.test(w)) return w;
  if (w.endsWith("ies") && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (w.endsWith("sses")) w = w.slice(0, -2);
  else if (w.endsWith("s") && !/(?:ss|us|is)$/.test(w)) w = w.slice(0, -1);
  if (w.endsWith("ing") && w.length > 5) w = w.slice(0, -3);
  else if (w.endsWith("ed") && w.length > 4) w = w.slice(0, -2);
  if (w.endsWith("ation") && w.length > 7) w = `${w.slice(0, -5)}at`;
  if (w.endsWith("e") && w.length > 4) w = w.slice(0, -1);
  return w;
}

function normalize(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[’‘`]/g, "'")
      // 1,573 -> 1573 so figures are single tokens.
      .replace(/(\d),(?=\d)/g, "$1")
      // FY'28, FY 28, FY2028, FY-28 -> fy28
      .replace(/\bfy\s*'?\s*-?\s*(?:20)?(\d{2})\b/g, "fy$1")
      // INR1573, Rs.500 -> "inr 1573", "rs 500"
      .replace(/\b(inr|rs\.?|usd)(?=\d)/g, "$1 ")
  );
}

/** Stemmed, stopword-free tokens. */
export function terms(text: string): string[] {
  const out: string[] = [];
  for (const t of normalize(text).match(/[a-z]+\d*|\d+(?:\.\d+)?/g) ?? []) {
    if (!STOPWORDS.has(t)) out.push(stem(t));
  }
  return out;
}

// Finance vocabulary: a filing often answers in other words. Related terms count
// at a fraction of a direct match.
const RELATED: Record<string, string[]> = {
  debt: ["borrow", "loan", "leverag"],
  borrow: ["debt", "loan"],
  loan: ["debt", "borrow"],
  revenu: ["sale", "turnover", "topline", "incom"],
  sale: ["revenu", "turnover"],
  turnover: ["revenu", "sale"],
  profit: ["pat", "earn"],
  earn: ["profit", "pat"],
  margin: ["ebitda"],
  guidanc: ["outlook", "expect", "target"],
  outlook: ["guidanc", "expect", "target"],
  forecast: ["expect", "guidanc", "outlook"],
  timelin: ["expect", "onward", "target", "by"],
  capex: ["expenditur", "invest"],
  order: ["pipelin", "backlog", "inflow"],
  backlog: ["order", "pipelin"],
  dividend: ["payout"],
  receivabl: ["debtor"],
  debtor: ["receivabl"],
  inventory: ["stock"],
  liquidity: ["cash"],
};
const RELATED_WEIGHT = 0.35;

// Questions about figures: amounts, ratios, durations, dates.
const FIGURE_QUESTION =
  /\d|%|\b(?:how (?:much|many|long)|days?|crores?|cr|lakhs?|million|billion|bps|percent|percentage|margins?|cash ?flows?|debt|borrowings?|revenues?|sales|ebitda|pat|profits?|growth|guidance|targets?|capex|order ?book|order inflow|working capital|ratio|yoy|qoq|eps|dividend|roce|roe|cost|price|valuation|timeline|when|by when|outlook)\b/i;
// A figure in the text: amounts with units, percentages, fiscal years, larger numbers.
const FIGURE =
  /(?:₹|\brs\.?|\binr|\busd|\$)\s?\d[\d,.]*|\d[\d,]*(?:\.\d+)?\s?(?:%|crores?\b|cr\b|lakhs?\b|mn\b|bn\b|million\b|billion\b|days\b|bps\b|x\b)|\bfy\s?'?\d{2,4}\b|\bq[1-4]\b|\b\d{2,}(?:[.,]\d+)*\b/gi;

export function asksForFigures(focus: string): boolean {
  return FIGURE_QUESTION.test(focus);
}

export function figureCount(text: string): number {
  return text.match(FIGURE)?.length ?? 0;
}

// --- Scoring -----------------------------------------------------------------

const K1 = 1.2;
const B = 0.75;

interface Scored extends Piece {
  score: number;
}

/** Passages scored against the focus (BM25 plus phrase, coverage and figure terms), best first; zero scores dropped. */
export function rankPassages(pieces: Piece[], focus: string): Scored[] {
  const direct = [...new Set(terms(focus))];
  if (!direct.length || !pieces.length) return [];
  const related = [...new Set(direct.flatMap((t) => RELATED[t] ?? []))].filter((t) => !direct.includes(t));
  const weights = new Map<string, number>([...related.map((t) => [t, RELATED_WEIGHT] as const), ...direct.map((t) => [t, 1] as const)]);
  // Adjacent pairs from the question ("working capital", "cash flow") score extra as phrases.
  const focusSeq = terms(focus);
  const pairs = new Set(focusSeq.slice(1).map((t, i) => `${focusSeq[i]} ${t}`));

  const docs = pieces.map((p) => {
    const toks = terms(p.text);
    const tf = new Map<string, number>();
    for (const t of toks) if (weights.has(t)) tf.set(t, (tf.get(t) ?? 0) + 1);
    let phraseHits = 0;
    for (let i = 1; i < toks.length; i++) if (pairs.has(`${toks[i - 1]} ${toks[i]}`)) phraseHits++;
    return { len: toks.length, tf, phraseHits };
  });
  const n = docs.length;
  const avgLen = docs.reduce((s, d) => s + d.len, 0) / n || 1;
  const idf = new Map<string, number>();
  for (const t of weights.keys()) {
    const df = docs.filter((d) => d.tf.has(t)).length;
    idf.set(t, Math.log(1 + (n - df + 0.5) / (df + 0.5)));
  }
  const directIdf = direct.reduce((s, t) => s + (idf.get(t) ?? 0), 0) || 1;
  const pairIdf = direct.length > 1 ? directIdf / direct.length : 0;
  const figures = asksForFigures(focus);

  const scored: Scored[] = [];
  pieces.forEach((p, i) => {
    const d = docs[i];
    let score = 0;
    let covered = 0;
    for (const [t, f] of d.tf) {
      const w = weights.get(t)!;
      const termIdf = idf.get(t)!;
      score += w * termIdf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.len) / avgLen)));
      if (w === 1) covered += termIdf;
    }
    if (score <= 0) return;
    score += Math.min(d.phraseHits, 3) * 0.5 * pairIdf;
    // Passages that touch more of the question (weighted by rarity) beat ones repeating one word.
    score *= 0.5 + covered / directIdf;
    // A slide title or page footer alone isn't an answer.
    if (p.text.length < TAIL_PASSAGE) score *= 0.5 + (0.5 * p.text.length) / TAIL_PASSAGE;
    if (figures) score *= 1 + Math.min(0.25, 0.05 * figureCount(p.text));
    scored.push({ ...p, score });
  });
  return scored.sort((a, b) => b.score - a.score || a.index - b.index);
}

// Passages scoring below this fraction of the best one are noise.
const RELATIVE_CUTOFF = 0.15;
const MAX_PASSAGES = 40;

export interface FocusResult {
  /** Best first. */
  passages: Passage[];
  /** The same passages in reading order, each marked "[page N]". */
  markdown: string;
}

/** The passages that best answer focus, within maxChars of passage text. */
export function focusPassages(sources: PassageSource[], focus: string, maxChars: number): FocusResult {
  const ranked = rankPassages(splitPassages(sources), focus);
  const picked: Scored[] = [];
  let used = 0;
  const floor = (ranked[0]?.score ?? 0) * RELATIVE_CUTOFF;
  for (const p of ranked) {
    if (p.score < floor || picked.length >= MAX_PASSAGES) break;
    if (used + p.text.length > maxChars) {
      // The best passage always comes back, cut to the budget if need be.
      if (!picked.length) {
        picked.push({ ...p, text: p.text.slice(0, maxChars) });
        used = maxChars;
      }
      continue;
    }
    picked.push(p);
    used += p.text.length;
  }
  const passages = picked.map(({ page, text, score }) => ({ ...(page === undefined ? {} : { page }), text, score: Math.round(score * 100) / 100 }));
  const markdown = [...picked]
    .sort((a, b) => a.index - b.index)
    .map((p) => (p.page === undefined ? p.text : `[page ${p.page}]\n${p.text}`))
    .join(picked.some((p) => p.page !== undefined) ? "\n\n" : "\n\n[...]\n\n");
  return { passages, markdown };
}

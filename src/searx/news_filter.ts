// Relevance and noise rules for news/filings searches, where a result is only
// useful if it is an article (or filing) about the thing asked for.

import { type QueryTerms, mentionsSubject, namesCompany } from "./terms";

/** Pages that are listings, quotes or social posts rather than articles. */
const NON_ARTICLE_URL = [
  /economictimes\.indiatimes\.com\/topic\//i,
  /economictimes\.indiatimes\.com\/[^?]*\/(stocksupdate|stocks\/companyid-|stockreports)/i,
  /economictimes\.indiatimes\.com\/[^?]*companyid-\d+\.cms/i,
  /livemint\.com\/market\/market-stats\//i,
  /moneycontrol\.com\/(india\/stockpricequote|markets\/financials|stocks\/company_info|company-article|stock-charts)/i,
  /moneycontrol\.com\/news\/tags\//i,
  /business-standard\.com\/(topic|company|stock-market-quote)\//i,
  /ndtvprofit\.com\/(topic|stock)\//i,
  /cnbctv18\.com\/(tags|market\/stocks)\//i,
  /financialexpress\.com\/(about|market\/stock-market-quote)\//i,
  /\/(tag|tags|topic|topics|quote|quotes|stock-price|share-price)\/[^/]*\/?$/i,
  /(groww\.in\/stocks|screener\.in\/company|tickertape\.in\/stocks|trendlyne\.com\/equity|investing\.com\/equities|marketscreener\.com\/quote|finance\.yahoo\.com\/quote|google\.com\/finance)\//i,
  /^https?:\/\/([^/]+\.)?(facebook|instagram|linkedin|x|twitter|threads|youtube|reddit|quora|telegram|t)\.(com|me)\//i,
];

// Gambling/crypto spam and SEO pages that ride on finance queries.
const SPAM_WORDS = /\b(casino|betting|bet app|satta|matka|aviator|rummy|teen patti|sports? bet|crypto (signals?|pump)|airdrop|forex signals?|escort|loan app download)\b/i;

export function isNonArticle(url: string): boolean {
  return NON_ARTICLE_URL.some((re) => re.test(url));
}

export function isSpam(title: string, content: string | undefined, query: string): boolean {
  // Don't drop them when the user is actually asking about these topics.
  if (SPAM_WORDS.test(query)) return false;
  return SPAM_WORDS.test(`${title} ${content ?? ""}`);
}

export interface CompanyLike {
  aliases: string[];
}

/**
 * Whether a result is about the query's subject: it names a resolved company
 * (any name, ticker or code), or it contains the query's subject words.
 */
export function isAbout(
  result: { url: string; title: string; content?: string },
  terms: QueryTerms,
  companies: CompanyLike[],
): boolean {
  const text = `${result.title} ${result.content ?? ""} ${urlWords(result.url)}`;
  if (companies.length) return companies.some((c) => namesCompany(text, terms, c.aliases));
  return mentionsSubject(text, terms);
}

/** The URL path as words; article slugs usually repeat the headline. */
function urlWords(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname).replace(/[-_/.]+/g, " ");
  } catch {
    return "";
  }
}

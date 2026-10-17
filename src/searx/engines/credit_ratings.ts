// Credit-rating rationales for the company a query names, from the Indian
// rating agencies. A rationale is the best free account of how a company makes
// and collects money: business profile, order book, working-capital cycle,
// receivables, liquidity, and the agency's view of them.
//
// Sources (each checked from Cloudflare's network, 2026-10-17):
// - CRISIL:      the JSON listing behind crisilratings.com's rating-rationale page
//                (latest rationale per entity), then the rationale page itself for
//                the rating action, detailed rationale and "About the Company".
//                "Update" bulletins link the previous full rationale, which is added too.
// - CARE:        careratings.com's company search, then its press releases by year.
// - India Ratings: indiaratings.co.in/home/GetSearch (issuers + dated press releases),
//                then the newest release's overview.
// - Acuité:      acuite.in company search, then the company's rating history page.
// - Infomerics:  cms.infomerics.com (the site's Strapi API): autocomplete, then the
//                company's rated instruments with their press-release PDFs.
// - ICRA and Brickwork: TinyFish restricted to icra.in / brickworkratings.com. ICRA
//                answers Cloudflare with a Barracuda "Blocked" page; Brickwork's
//                origin is unreachable (HTTP 523).
// Any agency whose own lookup fails falls back to TinyFish on its domains.

import { type Company, coreName, resolveCompanies } from "../companies";
import { namesCompany, splitQuery } from "../terms";
import { tinyfishSearch } from "../tinyfish";
import type { Engine, EngineContext, EngineResult, SearchParams, TimeRange } from "../types";
import { EngineError } from "../types";
import { shortName } from "./exchange_filings";
import {
  Budget,
  cacheGet,
  cachePut,
  clip,
  companyKey,
  dateInText,
  getJson,
  getText,
  htmlText,
  monthYear,
  parseDay,
  sameEntity,
  tidyName,
  urlWords,
} from "./research_common";

export type Agency = "crisil" | "icra" | "care" | "indra" | "acuite" | "infomerics" | "brickwork";

export const AGENCIES: Record<Agency, { label: string; author: string; domains: string[]; keep: number }> = {
  crisil: { label: "CRISIL", author: "CRISIL Ratings", domains: ["crisil.com", "crisilratings.com"], keep: 2 },
  icra: { label: "ICRA", author: "ICRA", domains: ["icra.in"], keep: 3 },
  care: { label: "CARE", author: "CARE Ratings (CareEdge)", domains: ["careratings.com", "careedge.in"], keep: 2 },
  indra: { label: "India Ratings", author: "India Ratings and Research", domains: ["indiaratings.co.in"], keep: 3 },
  acuite: { label: "Acuité", author: "Acuité Ratings", domains: ["acuite.in"], keep: 2 },
  infomerics: { label: "Infomerics", author: "Infomerics Ratings", domains: ["infomerics.com"], keep: 2 },
  brickwork: { label: "Brickwork", author: "Brickwork Ratings", domains: ["brickworkratings.com"], keep: 2 },
};

export interface RatingDoc {
  agency: Agency;
  /** The rated entity as the agency names it. */
  entity: string;
  url: string;
  /** Epoch ms (the rationale's date). */
  time?: number;
  /** Rating action or headline: "Ratings reaffirmed at 'Crisil AA-/Stable/Crisil A1+'". */
  action?: string;
  /** Excerpt: detailed rationale, business description. */
  detail?: string;
  kind?: "rationale" | "update";
}

const ENGINE_TIMEOUT_MS = 6500;
// Leaves time to rank and cache before the engine's own timeout.
const BUDGET_MS = 6000;
// Optional second steps (reading a rationale) only start with this much time left.
const ENRICH_MIN_MS = 1200;
// A TinyFish run takes about 3.5-5 s.
const TINYFISH_MIN_MS = 2500;
const CACHE_TTL_S = 6 * 3600;
const PARTIAL_CACHE_TTL_S = 600;
const DOC_CACHE_TTL_S = 7 * 86_400; // rationales never change once published
const MAX_RESULTS = 15;
const TINYFISH_PURPOSE = "Credit rating rationales from Indian rating agencies (rating action, outlook, business profile)";

// --- search keys ------------------------------------------------------------------------

/**
 * What to type into an agency's company search: the first two words of the name
 * when both are plain words (agencies match substrings: "genus power"), else the
 * first distinctive word ("larsen" for "Larsen & Toubro", "reddy" for "Dr. Reddy's").
 */
export function searchKey(c: Company): string {
  const words = coreName(c.name).split(" ").filter(Boolean);
  const plain = (w: string | undefined) => !!w && /^[a-z0-9]+$/.test(w);
  if (plain(words[0]) && words[0].length >= 3) return plain(words[1]) ? `${words[0]} ${words[1]}` : words[0];
  const word = words.map((w) => w.replace(/['’]s$/, "")).find((w) => plain(w) && w.length >= 4);
  return word ?? coreName(c.name);
}

// --- CRISIL --------------------------------------------------------------------------------

const CRISIL_LIST =
  "https://www.crisilratings.com/content/crisilratings/en/home/our-business/ratings/rating-rationale/_jcr_content/wrapper_100_par/ratingresultlisting.results.json";
const CRISIL_DOCS = "https://www.crisilratings.com/mnt/winshare/Ratings/RatingList/RatingDocs/";

interface CrisilListing {
  docs?: { companyName?: string; heading?: string; ratingDate?: string; ratingFileName?: string }[];
}

export function parseCrisilList(body: CrisilListing): RatingDoc[] {
  const out: RatingDoc[] = [];
  for (const d of body.docs ?? []) {
    if (!d.ratingFileName || !d.companyName) continue;
    const action = (d.heading ?? "").replace(/^[^:]*:\s*/, "").trim();
    out.push({
      agency: "crisil",
      entity: d.companyName.trim(),
      url: CRISIL_DOCS + encodeURI(d.ratingFileName),
      time: parseDay(d.ratingDate),
      action: action || undefined,
      kind: /^update on\b/i.test(action) ? "update" : "rationale",
    });
  }
  return out;
}

const CRISIL_RATING = /\b(?:Crisil|CRISIL)\s+(?:[A-D]{1,3}[+-]?(?:\s*\/\s*(?:Stable|Positive|Negative|Developing))?|A[1-4]\+?)(?=[\s,;)'’]|$)/g;

export interface CrisilRationale {
  /** Headline under the entity name: "Ratings reaffirmed at ...". */
  action?: string;
  detailed?: string;
  about?: string;
  /** Distinct ratings mentioned ("Crisil AA-/Stable", "Crisil A1+"). */
  ratings: string[];
  /** Update bulletins: the full rationale they refer to. */
  previous?: { url: string; time?: number };
}

/** Reads the parts of a CRISIL rationale (or update bulletin) page that answer "how does this business work". */
export function parseCrisilRationale(html: string, entity: string): CrisilRationale {
  const text = htmlText(html);
  const ratings = [...new Set([...text.matchAll(CRISIL_RATING)].map((m) => m[0].replace(/\s*\/\s*/g, "/").replace(/\s+/g, " ")))].slice(0, 4);
  const after = (marker: string, end: RegExp, max: number) => {
    const i = text.indexOf(marker);
    if (i < 0) return undefined;
    const rest = text.slice(i + marker.length);
    const stop = rest.search(end);
    const s = clip(stop > 0 ? rest.slice(0, stop) : rest, max);
    return s || undefined;
  };
  // "<date> | Mumbai <Entity> <headline> Rating Action ..."
  let action: string | undefined;
  const e = text.indexOf(entity);
  const ra = text.indexOf("Rating Action");
  if (e >= 0 && ra > e) action = clip(text.slice(e + entity.length, ra), 200) || undefined;
  let previous: CrisilRationale["previous"];
  const prev = /previous Rating Rationale\s+([A-Za-z]+ \d{1,2}, \d{4})/i.exec(text);
  const link = /<a[^>]+href="(https?:\/\/www\.crisil(?:ratings)?\.com\/mnt\/winshare\/Ratings\/RatingList\/RatingDocs\/[^"]+)"[^>]*>\s*Click here/i.exec(html);
  if (link) previous = { url: link[1].replace("//www.crisil.com/", "//www.crisilratings.com/"), time: parseDay(prev?.[1]) };
  return {
    action,
    detailed: after("Detailed Rationale", /\bKey Rating Drivers\b|\bAnalytical Approach\b/, 900),
    about: after("About the Company", /\bKey Financial Indicators\b|\bAny other information\b/, 360),
    ratings,
    previous,
  };
}

async function crisilDoc(ctx: EngineContext, url: string): Promise<string> {
  const key = `crisil-doc?u=${encodeURIComponent(url)}`;
  const hit = await cacheGet<string>(key);
  if (hit !== undefined) return hit;
  const html = await getText(ctx, url, "CRISIL rationale", { headers: { accept: "text/html" } });
  // Keep the useful part only: everything before the rating history and regulatory annexures.
  const cut = html.search(/Annexure\s*-\s*Rating History|List of instruments and names of regulators/i);
  const kept = cut > 0 ? html.slice(0, cut) : html.slice(0, 200_000);
  await cachePut(key, kept, DOC_CACHE_TTL_S);
  return kept;
}

function crisilDetail(r: CrisilRationale): string | undefined {
  const parts = [r.detailed, r.about && `About the company: ${r.about}`].filter(Boolean);
  return parts.length ? parts.join(" ") : undefined;
}

async function crisil(c: Company, ctx: EngineContext, budget: Budget): Promise<RatingDoc[]> {
  const filters = encodeURIComponent(JSON.stringify({ company_name: searchKey(c) }));
  const text = await getText(ctx, `${CRISIL_LIST}?cmd=RR&start=0&limit=30&filters=${filters}`, "CRISIL", {
    headers: { accept: "application/json", "x-requested-with": "XMLHttpRequest" },
  });
  // CRISIL answers an empty body when nothing matches.
  if (!text.trim()) return [];
  let body: CrisilListing;
  try {
    body = JSON.parse(text);
  } catch {
    throw new EngineError("parse", "CRISIL: listing is not JSON");
  }
  const docs = parseCrisilList(body)
    .filter((d) => sameEntity(d.entity, c))
    .sort((a, b) => (b.time ?? 0) - (a.time ?? 0))
    .slice(0, 1);
  const top = docs[0];
  if (!top || budget.left() < ENRICH_MIN_MS) return docs;
  try {
    const page = parseCrisilRationale(await budget.race(crisilDoc(ctx, top.url), "CRISIL rationale"), top.entity);
    if (top.kind === "update") {
      const ratings = page.ratings.length ? ` Ratings: ${page.ratings.join(", ")}.` : "";
      const prev = page.previous?.time ? ` Full rationale: ${monthYear(page.previous.time)}.` : "";
      top.detail = `Update bulletin (bank facility details).${ratings}${prev}`;
      if (page.previous) {
        const full: RatingDoc = { agency: "crisil", entity: top.entity, url: page.previous.url, time: page.previous.time, kind: "rationale" };
        docs.push(full);
        if (budget.left() >= ENRICH_MIN_MS) {
          const r = parseCrisilRationale(await budget.race(crisilDoc(ctx, full.url), "CRISIL rationale"), full.entity);
          full.action = r.action;
          full.detail = crisilDetail(r);
        }
      }
    } else {
      top.action = page.action ?? top.action;
      top.detail = crisilDetail(page);
    }
  } catch {
    // The listing alone still names the rationale and its date.
  }
  return docs;
}

// --- CARE ---------------------------------------------------------------------------------------

const CARE = "https://www.careratings.com";

interface CareSearch {
  data?: { CompanyID?: string; CompanyName?: string }[];
}
interface CarePrDocs {
  data?: { PRDocument?: { FileTitle?: string; FileURL?: string; PublishedDate?: string }[] }[];
}

export function parseCarePr(body: CarePrDocs, entity: string): RatingDoc[] {
  const out: RatingDoc[] = [];
  for (const block of body.data ?? []) {
    for (const d of block.PRDocument ?? []) {
      if (!d.FileURL) continue;
      out.push({
        agency: "care",
        entity: d.FileTitle?.trim() || entity,
        url: `${CARE}/upload/CompanyFiles/PR/${encodeURI(d.FileURL)}`,
        time: parseDay(d.PublishedDate),
        action: "Press release (rating rationale, PDF)",
        kind: "rationale",
      });
    }
  }
  return out;
}

function istYear(): number {
  return new Date(Date.now() + 330 * 60_000).getUTCFullYear();
}

async function care(c: Company, ctx: EngineContext, budget: Budget): Promise<RatingDoc[]> {
  const search = await getJson<CareSearch>(ctx, `${CARE}/header/searchlist?cinput=${encodeURIComponent(searchKey(c))}`, "CARE", {
    headers: { "x-requested-with": "XMLHttpRequest" },
  });
  const match = (search.data ?? []).find((d) => d.CompanyID && d.CompanyName && sameEntity(d.CompanyName, c));
  if (!match) return [];
  const id = encodeURIComponent(match.CompanyID!);
  const name = tidyName(match.CompanyName!);
  const year = istYear();
  const prs = (y: number) =>
    getJson<CarePrDocs>(ctx, `${CARE}/getSearchprdocument?companyName=${id}&YearID=${y}`, "CARE", {
      headers: { "x-requested-with": "XMLHttpRequest" },
    }).then((b) => parseCarePr(b, name));
  let docs = (await Promise.all([prs(year), prs(year - 1)])).flat();
  if (!docs.length && budget.left() >= ENRICH_MIN_MS) {
    // Nothing in two years: ask which years have releases and read the latest.
    const years = await getJson<{ data?: { PublishedDate?: string }[] }>(ctx, `${CARE}/pryear?companyName=${id}`, "CARE");
    const latest = (years.data ?? []).map((y) => Number(y.PublishedDate)).filter((y) => y > 2000 && y < year - 1).sort((a, b) => b - a)[0];
    if (latest) docs = await budget.race(prs(latest), "CARE");
  }
  return docs.map((d) => ({ ...d, entity: name }));
}

// --- India Ratings --------------------------------------------------------------------------------

const INDRA = "https://www.indiaratings.co.in";

interface IndraSearch {
  pressreleaseList?: { pressReleaseID?: string; pressReleaseTitle?: string; issuerName?: string; prDate?: string }[];
}

export function parseIndraSearch(body: IndraSearch): RatingDoc[] {
  return (body.pressreleaseList ?? [])
    .filter((p) => p.pressReleaseID && p.issuerName)
    .map((p) => ({
      agency: "indra" as const,
      entity: p.issuerName!.trim(),
      url: `${INDRA}/pressrelease/${p.pressReleaseID}`,
      time: parseDay(p.prDate),
      action: p.pressReleaseTitle?.trim() || undefined,
      kind: /^update on\b/i.test(p.pressReleaseTitle ?? "") ? ("update" as const) : ("rationale" as const),
    }));
}

async function indra(c: Company, ctx: EngineContext, budget: Budget): Promise<RatingDoc[]> {
  const body = await getJson<IndraSearch>(ctx, `${INDRA}/home/GetSearch?searchKey=${encodeURIComponent(searchKey(c))}`, "India Ratings");
  const docs = parseIndraSearch(body)
    .filter((d) => sameEntity(d.entity, c))
    .sort((a, b) => (b.time ?? 0) - (a.time ?? 0))
    .slice(0, AGENCIES.indra.keep);
  const top = docs[0];
  if (top && budget.left() >= ENRICH_MIN_MS) {
    try {
      const id = top.url.split("/").pop()!;
      const pr = await budget.race(
        getJson<{ overview?: string }[]>(ctx, `${INDRA}/pressReleases/GetPressreleaseData_BeforeLogin?pressReleaseId=${id}`, "India Ratings"),
        "India Ratings",
      );
      const overview = htmlText(pr[0]?.overview ?? "");
      if (overview) top.detail = clip(overview, 520);
    } catch {
      // keep the headline
    }
  }
  return docs;
}

// --- Acuité ------------------------------------------------------------------------------------------

/** Company links in the search endpoint's HTML fragment. */
export function parseAcuiteSearch(body: { mtype?: string; companies?: string }): { cid: string; name: string }[] {
  if (body.mtype !== "success" || !body.companies) return [];
  return [...body.companies.matchAll(/newCompany\?cid=(\d+)'[^>]*>([^<]+)</g)].map((m) => ({ cid: m[1], name: m[2].trim() }));
}

/** Rating history rows: date and press release (a page for recent ones, a PDF for older ones). */
export function parseAcuiteCompany(html: string, entity: string): RatingDoc[] {
  const out: RatingDoc[] = [];
  for (const row of html.split('class="td-date"').slice(1)) {
    const date = /^[^>]*>\s*([^<]+?)\s*</.exec(row)?.[1];
    const link = /href=["'](https?:\/\/(?:connect\.acuite\.in\/fcompany-details\/|(?:www\.)?acuite\.in\/documents\/ratings\/)[^"']+)["']/.exec(row)?.[1];
    if (!link) continue;
    out.push({ agency: "acuite", entity, url: link, time: parseDay(date), action: "Rating press release", kind: "rationale" });
  }
  return out;
}

async function acuite(c: Company, ctx: EngineContext, budget: Budget): Promise<RatingDoc[]> {
  const key = searchKey(c);
  if (key.length <= 3) return []; // the site needs at least four characters
  const res = await getText(ctx, "https://www.acuite.in/Home/searchCompanyData", "Acuité", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8", "x-requested-with": "XMLHttpRequest" },
    body: `company_name_search=${encodeURIComponent(key)}`,
  });
  let body: { mtype?: string; companies?: string };
  try {
    body = JSON.parse(res);
  } catch {
    throw new EngineError("parse", "Acuité: search is not JSON");
  }
  const match = parseAcuiteSearch(body).find((m) => sameEntity(m.name, c));
  if (!match || budget.left() < ENRICH_MIN_MS) return [];
  const html = await getText(ctx, `https://connect.acuite.in/newCompany?cid=${match.cid}`, "Acuité", { headers: { accept: "text/html" } });
  return parseAcuiteCompany(html, tidyName(match.name));
}

// --- Infomerics --------------------------------------------------------------------------------------

const INFOMERICS_API = "https://cms.infomerics.com/api";

interface InfomericsInstrument {
  InstrumentTitle?: string;
  Rating?: string;
  InstrumentAmount?: string;
  Date?: string;
  outlook?: { Title?: string } | null;
  PressRelease?: { Date?: string; Document?: { DocumentFile?: { url?: string } } } | null;
}

export function parseInfomericsCompany(body: {
  company?: { CompanyName?: string };
  companyInstrument?: InfomericsInstrument[];
  pastInstruments?: InfomericsInstrument[];
}): RatingDoc[] {
  const entity = body.company?.CompanyName?.trim() ?? "";
  const byUrl = new Map<string, RatingDoc & { ratings: string[] }>();
  for (const i of [...(body.companyInstrument ?? []), ...(body.pastInstruments ?? [])]) {
    const url = i.PressRelease?.Document?.DocumentFile?.url;
    if (!url) continue;
    let doc = byUrl.get(url);
    if (!doc) {
      doc = { agency: "infomerics", entity, url, time: parseDay(i.PressRelease?.Date ?? i.Date), kind: "rationale", ratings: [] };
      byUrl.set(url, doc);
    }
    const outlook = i.outlook?.Title ? `/${i.outlook.Title}` : "";
    const rating = i.Rating ? `${i.InstrumentTitle ?? "Rating"}: ${i.Rating.replace(/\s*\(/, `${outlook} (`)}` : "";
    if (rating && doc.ratings.length < 3) doc.ratings.push(i.InstrumentAmount ? `${rating}, ${i.InstrumentAmount}` : rating);
  }
  return [...byUrl.values()].map(({ ratings, ...d }) => ({ ...d, action: ratings.join("; ") || undefined }));
}

async function infomerics(c: Company, ctx: EngineContext, budget: Budget): Promise<RatingDoc[]> {
  // The autocomplete matches case-sensitively; agency names are in title case.
  const key = searchKey(c).replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
  const found = await getJson<{ CompanyName?: string; slug?: string }[]>(ctx, `${INFOMERICS_API}/companies/autocomplete?query=${encodeURIComponent(key)}`, "Infomerics");
  const match = (Array.isArray(found) ? found : []).find((m) => m.slug && m.CompanyName && sameEntity(m.CompanyName, c));
  if (!match || budget.left() < ENRICH_MIN_MS) return [];
  const body = await getJson<Parameters<typeof parseInfomericsCompany>[0]>(ctx, `${INFOMERICS_API}/companies/${encodeURIComponent(match.slug!)}`, "Infomerics");
  return parseInfomericsCompany(body);
}

// --- TinyFish (ICRA, Brickwork, and agencies whose own lookup failed) -------------------------

function agencyOf(url: string): Agency | undefined {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return undefined;
  }
  return (Object.keys(AGENCIES) as Agency[]).find((a) => AGENCIES[a].domains.some((d) => host === d || host.endsWith(`.${d}`)));
}

/** ICRA serves one rationale under several URLs; all carry its numeric id. */
export function icraId(url: string): string | undefined {
  const decoded = decodeURIComponent(url);
  return /(?:[?&]id=|\/(?:ShowRationalReportFilePdf(?:Viewer)?|ShowRationaleReport)\/(?:\?Id=)?)(\d{3,8})\b/i.exec(decoded)?.[1];
}

// Rationale documents, not company or listing pages.
const RATIONALE_URL: Partial<Record<Agency, RegExp>> = {
  icra: /Rational/i,
  crisil: /\/RatingDocs\//i,
  care: /\/upload\/CompanyFiles\/(PR|RR)\//i,
  indra: /\/pressrelease\/\d+/i,
  acuite: /fcompany-details|\/documents\/ratings\//i,
  infomerics: /\.pdf$|\/pressrelease\//i,
  brickwork: /rationale|\.pdf$/i,
};

const ENTITY_WORDS = /\b(limited|ltd|private|pvt|llp|corporation|company|bank|trust|spv|industries|enterprises)\b/i;

/** The rated entity named by a search title ("Tata Elxsi Limited: Ratings reaffirmed") or file name. */
export function entityFromTitle(title: string, url: string): string | undefined {
  const head = title
    .split(/\s*(?::|\s-\s|\|)\s*/)[0]
    .replace(/^rating rationale\s*/i, "") // Brickwork: "RATING RATIONALE 27 Nov 2020 Tata Steel Ltd. ..."
    .replace(DATE_WORDS, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (ENTITY_WORDS.test(head)) return head;
  // CRISIL file names: "GenusPowerInfrastructuresLimited_November 20_ 2025_RR_380934.html"
  const file = /\/RatingDocs\/([^/_]+)_/.exec(decodeURIComponent(url))?.[1];
  if (file) {
    const name = file.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ");
    if (ENTITY_WORDS.test(name)) return name;
  }
  return undefined;
}

const DATE_WORDS = /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+\d{4}\b/gi;
// "... of Tata Steel Utilities and Infrastructure Services Limited's ...": the first company named.
const NAMED_ENTITY = /\b((?:[A-Z][\w&.'’-]*|and|of|&)(?:\s+(?:[A-Z(][\w&.'’()-]*|and|of|&)){0,8}?\s+(?:Limited|Ltd\.?|Private Limited|LLP))\b/;

/** The first company a snippet names, if any. */
export function entityInText(text: string | undefined): string | undefined {
  const m = NAMED_ENTITY.exec((text ?? "").replace(/\s+/g, " "));
  return m?.[1].replace(/^(?:and|of|&)\s+/i, "").trim();
}

/** Maps search hits on agency sites to rationales of this company, one per document. */
export function fromSearchResults(results: EngineResult[], c: Company, query: string): RatingDoc[] {
  const terms = splitQuery(query);
  const byId = new Map<string, RatingDoc>();
  for (const r of results) {
    const agency = agencyOf(r.url);
    if (!agency || !RATIONALE_URL[agency]?.test(r.url)) continue;
    // The entity from the title or file name, else the first one the snippet names.
    const entity = entityFromTitle(r.title, r.url) ?? entityInText(r.content?.slice(0, 300));
    if (entity) {
      if (!sameEntity(entity, c)) continue;
    } else if (!namesCompany(`${r.title} ${urlWords(r.url)} ${(r.content ?? "").slice(0, 300)}`, terms, c.aliases)) {
      continue;
    }
    const id = agency === "icra" ? icraId(r.url) : undefined;
    const url = id ? `https://www.icra.in/Rationale/ShowRationaleReport?Id=${id}` : r.url;
    const time = (r.publishedDate ? Date.parse(r.publishedDate) : undefined) ?? dateInText(r.title) ?? dateInText(r.content);
    // Search titles are cut short: "Ratings reaffirmed Summary of ...".
    const action = /:\s*(.+)$/.exec(r.title)?.[1]?.replace(/\s*(\.\.\.|…)$/, "").replace(/\s+summary of.*$/i, "");
    const doc: RatingDoc = {
      agency,
      entity: entity?.replace(/\s*(\.\.\.|…)$/, "") ?? tidyName(c.name),
      url,
      time: Number.isNaN(time) ? undefined : time,
      action: action && !/^rating rationale$/i.test(action) ? action : undefined,
      detail: r.content ? clip(r.content, 400) : undefined,
      kind: "rationale",
    };
    const key = id ? `icra:${id}` : url;
    const seen = byId.get(key);
    if (!seen) {
      byId.set(key, doc);
      continue;
    }
    // The same rationale found twice: keep what each copy knows.
    seen.time ??= doc.time;
    seen.action ??= doc.action;
    if ((doc.detail?.length ?? 0) > (seen.detail?.length ?? 0)) seen.detail = doc.detail;
    if (seen.entity === tidyName(c.name) && entity) seen.entity = doc.entity;
  }
  return [...byId.values()];
}

async function viaTinyfish(c: Company, agencies: Agency[], ctx: EngineContext, budget: Budget): Promise<RatingDoc[]> {
  if (budget.left() < TINYFISH_MIN_MS) throw new EngineError("timeout", "no time left for TinyFish");
  const query = `${shortName(tidyName(c.name))} rating rationale`;
  const results = await budget.race(
    tinyfishSearch(query, { includeDomains: agencies.flatMap((a) => AGENCIES[a].domains), purpose: TINYFISH_PURPOSE }, budget.signal(ctx.signal)),
    "TinyFish",
  );
  return fromSearchResults(results, c, query).filter((d) => agencies.includes(d.agency));
}

// --- engine ----------------------------------------------------------------------------------

const OWN_SITE: [Agency, (c: Company, ctx: EngineContext, budget: Budget) => Promise<RatingDoc[]>][] = [
  ["crisil", crisil],
  ["care", care],
  ["indra", indra],
  ["acuite", acuite],
  ["infomerics", infomerics],
];
const TINYFISH_ONLY: Agency[] = ["icra", "brickwork"];

interface Collected {
  docs: RatingDoc[];
  errors: EngineError[];
}

/** Every agency's latest rationales for one company. */
async function collect(c: Company, ctx: EngineContext, budget: Budget): Promise<Collected> {
  const errors: EngineError[] = [];
  const failed = (agency: Agency, e: unknown): EngineError => {
    const err = e instanceof EngineError ? e : new EngineError("network", e instanceof Error ? e.message : String(e));
    err.message = `${AGENCIES[agency].label}: ${err.message.replace(/^[^:]+:\s*/, "")}`;
    errors.push(err);
    return err;
  };
  const tasks: Promise<RatingDoc[]>[] = OWN_SITE.map(([agency, lookup]) =>
    budget.race(lookup(c, ctx, budget), AGENCIES[agency].label).catch(async (e) => {
      failed(agency, e);
      // Fall back to TinyFish on this agency's domains while there's time for it.
      if (budget.left() < TINYFISH_MIN_MS) return [];
      return viaTinyfish(c, [agency], ctx, budget).catch(() => []);
    }),
  );
  tasks.push(viaTinyfish(c, TINYFISH_ONLY, ctx, budget).catch((e) => (failed("icra", e), [])));
  const docs = (await Promise.all(tasks)).flat();
  return { docs, errors };
}

/** The newest few per agency, newest first; undated ones only for agencies with no dated rationale. */
export function pickLatest(docs: RatingDoc[]): RatingDoc[] {
  const seen = new Set<string>();
  const perAgency = new Map<Agency, number>();
  const dated = new Set(docs.filter((d) => d.time).map((d) => d.agency));
  const out: RatingDoc[] = [];
  for (const d of [...docs].sort((a, b) => (b.time ?? 0) - (a.time ?? 0))) {
    if (seen.has(d.url) || (!d.time && dated.has(d.agency))) continue;
    seen.add(d.url);
    const n = perAgency.get(d.agency) ?? 0;
    if (n >= AGENCIES[d.agency].keep) continue;
    perAgency.set(d.agency, n + 1);
    out.push(d);
  }
  return out;
}

export function toResult(d: RatingDoc, c: Company): EngineResult {
  const a = AGENCIES[d.agency];
  const name = shortName(tidyName(d.entity || c.name));
  const what = d.kind === "update" ? "rating update" : "rating rationale";
  const when = d.time ? ` (${monthYear(d.time)})` : "";
  const action = d.action?.replace(/\.$/, "");
  const content = [action && `${action}.`, d.detail].filter(Boolean).join(" ");
  return {
    url: d.url,
    title: `${a.label}: ${name} — ${what}${when}`,
    content: content ? clip(content, 1400) : undefined,
    publishedDate: d.time ? new Date(d.time).toISOString() : undefined,
    author: a.author,
    docType: "credit_rating",
  };
}

const TIME_RANGE_MS: Record<TimeRange, number> = { day: 86_400_000, week: 7 * 86_400_000, month: 30 * 86_400_000, quarter: 91 * 86_400_000, year: 365 * 86_400_000 };

async function ratingsFor(c: Company, ctx: EngineContext, budget: Budget): Promise<Collected> {
  const key = `ratings?c=${companyKey(c)}`;
  const hit = await cacheGet<RatingDoc[]>(key);
  if (hit) return { docs: hit, errors: [] };
  const got = await collect(c, ctx, budget);
  const docs = pickLatest(got.docs);
  // A partial answer (some agency failed) is kept briefly, a complete one for hours.
  if (docs.length || !got.errors.length) await cachePut(key, docs, got.errors.length ? PARTIAL_CACHE_TTL_S : CACHE_TTL_S);
  return { docs, errors: got.errors };
}

export const creditRatings: Engine = {
  name: "credit ratings",
  shortcut: "cr",
  categories: ["ratings"],
  timeout: ENGINE_TIMEOUT_MS,
  timeRangeSupport: true,
  about: "Latest credit-rating rationales (CRISIL, ICRA, CARE, India Ratings, Acuité, Infomerics, Brickwork) for the company a query names",
  request() {
    return null; // not used: see search()
  },
  response() {
    return [];
  },
  async search(params: SearchParams, ctx: EngineContext) {
    const budget = Budget.start(BUDGET_MS);
    const companies = (await budget.race(resolveCompanies(params.query), "company lookup").catch(() => [] as Company[])).slice(0, 2);
    if (!companies.length) return [];
    const perCompany = await Promise.all(companies.map((c) => ratingsFor(c, ctx, budget)));
    const terms = splitQuery(params.query);
    const cutoff = params.timeRange ? Date.now() - TIME_RANGE_MS[params.timeRange] : 0;
    const results: EngineResult[] = [];
    perCompany.forEach(({ docs }, i) => {
      const c = companies[i];
      for (const d of docs) {
        if (cutoff && d.time && d.time < cutoff) continue;
        const r = toResult(d, c);
        // Every result must name the company (by entity, title or file name).
        if (!namesCompany(`${d.entity} ${r.title} ${urlWords(r.url)}`, terms, c.aliases)) continue;
        results.push(r);
      }
    });
    if (!results.length) {
      const errors = perCompany.flatMap((p) => p.errors);
      if (errors.length) throw errors[0];
    }
    return results
      .sort((a, b) => (b.publishedDate ? Date.parse(b.publishedDate) : 0) - (a.publishedDate ? Date.parse(a.publishedDate) : 0))
      .slice(0, MAX_RESULTS);
  },
};

// Exported for tests.
export const _internal = { collect };

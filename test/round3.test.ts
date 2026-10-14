import { afterEach, describe, expect, it } from "vitest";
import { pdfPageStats } from "../src/fetch";
import { _clearCompanyMemo, configureTickerSearch, resolveCompanies, subjectPhrases } from "../src/searx/companies";
import {
  type Filing,
  isEmptyFiling,
  isWeakFiling,
  mergeSummaries,
  parseScreenerAnnouncements,
  rankFilings,
} from "../src/searx/engines/exchange_filings";
import { regulatorFeedsFor } from "../src/searx/engines/india_news";
import { _clearFilingMemo, configureDocumentText, extractSubject, filingSubject } from "../src/searx/filing_text";
import type { MergedResult } from "../src/searx/results";
import { rankByRecency, refineNews } from "../src/searx/search";
import { topicTerms } from "../src/searx/terms";
import screenerFx from "./fixtures/screener-documents.html?raw";

const INFY = { name: "Infosys Ltd.", nse: "INFY", bse: "500209", aliases: ["infosys", "infy", "500209"] };

describe("regulator gating", () => {
  it("runs RBI/SEBI/PIB feeds only when the query is about them", () => {
    expect(regulatorFeedsFor("Nifty 50 one year return")).toEqual([]);
    expect(regulatorFeedsFor("Infosys deal wins")).toEqual([]);
    expect(regulatorFeedsFor("RBI repo rate decision")).toEqual(["RBI Press Releases", "RBI Notifications"]);
    expect(regulatorFeedsFor("SEBI circular on F&O")).toEqual(["SEBI"]);
    expect(regulatorFeedsFor("new regulation for NBFCs")).toEqual(expect.arrayContaining(["RBI Press Releases", "SEBI", "PIB"]));
  });
});

describe("topic terms", () => {
  it("separates the topic from the company", () => {
    expect(topicTerms("Infosys deal wins", INFY.aliases)).toEqual(["deal", "wins"]);
    expect(topicTerms("Tata Elxsi Q2 results", ["tata elxsi", "tataelxsi", "500408"])).toEqual([]);
    expect(topicTerms("Reliance Jio IPO", ["reliance industries", "reliance", "ril"])).toEqual(["jio", "ipo"]);
  });

  it("ranks on-topic company news above general company news", () => {
    const r = (url: string, title: string): MergedResult => ({ url, title, engines: ["x"], positions: [1], score: 1, publishedDate: "2026-10-13T00:00:00Z" });
    const dropped = { nonArticle: 0, spam: 0, offTopic: 0 };
    const kept = refineNews(
      [
        r("https://n.example/infosys-foundation", "Infosys Foundation enables 2.5 lakh job offers"),
        r("https://n.example/infosys-wins-deal", "Infosys wins $1.5 billion deal from European bank"),
      ],
      "Infosys deal wins",
      [INFY],
      dropped,
    );
    expect(rankByRecency(kept, Date.parse("2026-10-14T00:00:00Z"))[0].url).toBe("https://n.example/infosys-wins-deal");
  });

  it("drops other companies' stories that only share the topic words", () => {
    const r = (url: string, title: string): MergedResult => ({ url, title, engines: ["x"], positions: [1], score: 1 });
    const dropped = { nonArticle: 0, spam: 0, offTopic: 0 };
    const kept = refineNews(
      [
        r("https://n.example/hcltech-deal-wins", "HCLTech jumps as margin beat, deal wins outweigh software weakness"),
        r("https://n.example/csm-tech", "CSM Tech wins $174,000 deal to digitise Beira trade corridor"),
        r("https://n.example/infosys-deal", "Infosys bags multi-year deal from Danish retailer"),
      ],
      "Infosys deal wins",
      [INFY],
      dropped,
    );
    expect(kept.map((x) => x.url)).toEqual(["https://n.example/infosys-deal"]);
    expect(dropped.offTopic).toBe(2);
  });

  it("ranks on-topic filings first", () => {
    const f = (category: string, text: string, time: string): Filing => ({ source: "NSE", company: INFY, time: Date.parse(time), category, text, url: `https://x/${category}` });
    const ranked = rankFilings(
      [
        f("Updates", "Infosys Foundation Enables Over 2.5 Lakh Job Offers", "2026-10-13T06:00:00Z"),
        f("Updates", "Infosys and a European bank sign a strategic deal for core banking", "2026-10-01T12:00:00Z"),
      ],
      "Infosys deal wins",
    );
    expect(ranked[0].text).toMatch(/strategic deal/);
  });
});

describe("company resolution guards", () => {
  afterEach(() => {
    configureTickerSearch(undefined);
    _clearCompanyMemo();
  });

  it("doesn't resolve index or sector queries to companies", () => {
    expect(subjectPhrases("Nifty 50 one year return")).toEqual([]);
    expect(subjectPhrases("Bank Nifty today")).toEqual([]);
    expect(subjectPhrases("gold price today")).toEqual([]);
    expect(subjectPhrases("pharma stocks")).toEqual([]);
  });

  it("falls back to the leading words when a name plus topic doesn't match", async () => {
    const asked: string[] = [];
    configureTickerSearch(async (q) => {
      asked.push(q);
      return q === "infosys"
        ? [{ nseTicker: "INFY", bseTicker: "500209", companyName: "Infosys Ltd.", marketCap: 431029, matchType: "exact_name", confidence: 1 }]
        : [];
    });
    const [c] = await resolveCompanies("Infosys deal wins");
    expect(c.nse).toBe("INFY");
    expect(asked).toEqual(["infosys deal wins", "infosys deal", "infosys"]);
    expect(c.aliases).not.toContain("infosys deal wins");
  });
});

describe("filing PDFs", () => {
  afterEach(() => {
    configureDocumentText(undefined);
    _clearFilingMemo();
  });

  it("extracts the subject line from real cover letters", () => {
    expect(
      extractSubject(
        "### Page 1 TCS/BM/100/SE/2026-27 October 8, 2026 National Stock Exchange of India Limited Dear Sirs, Sub: Financial Results for the quarter and six-month period ended September 30, 2026 and declaration of second interim dividend In accordance with Regulation 33",
      ),
    ).toBe("Financial Results for the quarter and six-month period ended September 30, 2026 and declaration of second interim dividend");
    expect(
      extractSubject("TO ALL STOCK EXCHANGES October 10, 2026 Dear Sir/ Madam, Sub: Company statement on the U.S. Permanent Labor Certification Program Infosys Limited (“the Company”) is a"),
    ).toMatch(/^Company statement on the U\.S\. Permanent Labor Certification Program/);
    expect(
      extractSubject("Ref. No. SE/2026-27/118 Sub: Intimation under SEBI (Listing Obligations and Disclosure Requirements) Regulations, 2015In accordance with SEBI"),
    ).toBe("Intimation under SEBI (Listing Obligations and Disclosure Requirements) Regulations, 2015");
  });

  it("counts scanned pages", () => {
    const md = "# x.pdf\n## Metadata\n- A=1\n## Contents\n### Page 1\nDear Sirs, Sub: Financial Results for the quarter ended September 30\n### Page 2\n\n### Page 3\n![]()\n";
    expect(pdfPageStats(md)).toEqual({ pages: 3, scannedPages: 2 });
  });

  it("caches subjects per PDF", async () => {
    let calls = 0;
    configureDocumentText(async () => {
      calls++;
      return "Dear Sir, Sub: Outcome of Board Meeting held on October 13, 2026 Pursuant to Regulation 30";
    });
    expect(await filingSubject("https://nsearchives.nseindia.com/corporate/x.pdf")).toBe("Outcome of Board Meeting held on October 13, 2026");
    await filingSubject("https://nsearchives.nseindia.com/corporate/x.pdf");
    expect(calls).toBe(1);
  });

  it("knows which snippets are weak and which filings are empty", () => {
    const f = (category: string, text: string): Filing => ({ source: "NSE", company: INFY, time: 0, category, text, url: "https://x/a.pdf" });
    expect(isWeakFiling(f("General Updates", "General Updates"))).toBe(true);
    expect(isWeakFiling(f("Outcome of Board Meeting", "the financial results for the period ended September 30, 2026."))).toBe(true);
    expect(isWeakFiling(f("Press Release", "Infosys signs a 10-year AI partnership with a global retailer to modernise its stores"))).toBe(false);
    expect(isEmptyFiling(f("General Updates", "General Updates"))).toBe(true);
    expect(isEmptyFiling(f("Outcome of Board Meeting", ""))).toBe(false);
  });
});

describe("Screener summaries", () => {
  const TE = { name: "Tata Elxsi Ltd.", nse: "TATAELXSI", bse: "500408", aliases: ["tata elxsi"] };

  it("parses dated BSE announcements with summaries", () => {
    const items = parseScreenerAnnouncements(screenerFx, TE);
    expect(items.length).toBe(5);
    const pr = items.find((i) => /Press Release/.test(i.category))!;
    expect(pr.text).toMatch(/revenue of Rs 1,055\.7 Cr/);
    expect(new Date(pr.time).toISOString()).toBe("2026-10-13T12:31:15.000Z");
    expect(pr.url).toMatch(/^https:\/\/www\.bseindia\.com\/stockinfo\/AnnPdfOpen\.aspx\?Pname=.+\.pdf$/);
  });

  it("copies a summary onto the matching NSE filing instead of duplicating it", () => {
    const nse: Filing[] = [
      { source: "NSE", company: TE, time: Date.parse("2026-10-13T12:27:17Z"), category: "Press Release", text: "a press release dated October 13, 2026", url: "https://nse/pr.pdf" },
    ];
    const extra = mergeSummaries(nse, parseScreenerAnnouncements(screenerFx, TE));
    expect(nse[0].text).toMatch(/revenue of Rs 1,055\.7 Cr/);
    expect(extra.some((x) => /Press Release/.test(x.category))).toBe(false);
  });
});

describe("subject lines, harder cases", () => {
  it("stops at the letter body and skips rule-citing subjects", () => {
    expect(
      extractSubject("Dear Sirs, Sub: Financial Results for the quarter and six-month period ended September 30, 2026 and declaration of second interim dividend We enclose the audited standalone financial results"),
    ).toBe("Financial Results for the quarter and six-month period ended September 30, 2026 and declaration of second interim dividend");
    expect(
      extractSubject("Sub: Newspaper publication confirming the dispatch of Postal Ballot NoticeIn continuation to our earlier intimation dated October 7"),
    ).toBe("Newspaper publication confirming the dispatch of Postal Ballot Notice");
    expect(
      extractSubject(
        "Sub: Intimation under Regulation 30 of the SEBI (Listing Obligations and Disclosure Requirements) Regulations, 2015 Pursuant to Regulation 30, we wish to inform you that the Bank has received approval from the RBI for the re-appointment of Mr. X as Director. The approval is effective immediately.",
      ),
    ).toBe("the Bank has received approval from the RBI for the re-appointment of Mr. X as Director.");
  });
});

describe("PDF metadata", () => {
  it("drops the metadata block and keeps the contents", async () => {
    const { stripDocumentMetadata } = await import("../src/fetch");
    const letter = "Dear Sirs, Sub: Financial Results for the quarter ended September 30, 2026";
    const md = `# x.pdf\n## Metadata\n- Author=Someone\n- CreationDate=D:2026\n\n## Contents\n### Page 1\n${letter}`;
    expect(stripDocumentMetadata(md)).toBe(`# x.pdf\n\n### Page 1\n${letter}`);
    expect(pdfPageStats(stripDocumentMetadata(md))).toEqual({ pages: 1, scannedPages: 0 });
  });
});

describe("topic strictness", () => {
  it("matches topic words in their usual phrasings", async () => {
    const { termHits, topicVariants } = await import("../src/searx/terms");
    expect(topicVariants("wins")).toEqual(expect.arrayContaining(["bags", "secures", "signs"]));
    expect(termHits("Infosys bags multi-year contract from Danish retailer", ["deal", "wins"])).toBe(2);
    expect(termHits("Infosys Foundation enables 2.5 lakh job offers", ["deal", "wins"])).toBe(0);
  });

  it("drops off-topic stories once enough on-topic ones exist", () => {
    const r = (slug: string, title: string): MergedResult => ({ url: `https://n.example/${slug}`, title, engines: ["x"], positions: [1], score: 1 });
    const dropped = { nonArticle: 0, spam: 0, offTopic: 0 };
    const kept = refineNews(
      [
        r("a", "Infosys bags $1.5 billion deal from European bank"),
        r("b", "Infosys signs multi-year contract with Danish retailer"),
        r("c", "Infosys wins TCV of $3 billion in Q2"),
        r("d", "Infosys Foundation enables 2.5 lakh job offers"),
      ],
      "Infosys deal wins",
      [INFY],
      dropped,
    );
    expect(kept.map((x) => x.url.slice(-1))).toEqual(["a", "b", "c"]);
    expect(dropped.offTopic).toBe(1);
  });

  it("keeps off-topic stories (ranked lower) when on-topic ones are scarce", () => {
    const r = (slug: string, title: string): MergedResult => ({ url: `https://n.example/${slug}`, title, engines: ["x"], positions: [1], score: 1 });
    const dropped = { nonArticle: 0, spam: 0, offTopic: 0 };
    const kept = refineNews([r("a", "Infosys bags deal"), r("d", "Infosys Foundation news")], "Infosys deal wins", [INFY], dropped);
    expect(kept).toHaveLength(2);
    expect(kept.find((x) => x.url.endsWith("d"))!.score).toBeLessThan(1);
  });
});

describe("topic strictness counts only stories about the company", () => {
  it("doesn't let other companies' on-topic stories trigger dropping", () => {
    const r = (slug: string, title: string): MergedResult => ({ url: `https://n.example/${slug}`, title, engines: ["x"], positions: [1], score: 1 });
    const dropped = { nonArticle: 0, spam: 0, offTopic: 0 };
    const kept = refineNews(
      [
        r("h1", "HCLTech wins deal"),
        r("h2", "Wipro bags contract"),
        r("h3", "TCS signs agreement"),
        r("i1", "Infosys bags deal from bank"),
        r("i2", "Infosys Foundation enables job offers"),
      ],
      "Infosys deal wins",
      [INFY],
      dropped,
    );
    expect(kept.map((x) => x.url.slice(-2))).toEqual(["i1", "i2"]);
  });
});

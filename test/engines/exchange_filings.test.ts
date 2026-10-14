import { afterEach, describe, expect, it } from "vitest";
import { _clearCompanyMemo, type Company, configureTickerSearch } from "../../src/searx/companies";
import {
  type Filing,
  cleanSummary,
  dropCrossListed,
  exchangeFilings,
  mapNseAnnouncements,
  mapUpcomingMeetings,
  parseBseFeed,
  parseIst,
  rankFilings,
  toResult,
} from "../../src/searx/engines/exchange_filings";
import bseFx from "../fixtures/bse-announcements.xml?raw";
import nseAnnFx from "../fixtures/nse-announcements.json?raw";
import nseBmFx from "../fixtures/nse-board-meetings.json?raw";
import { PARAMS } from "../helpers";

const TE: Company = { name: "Tata Elxsi Ltd.", nse: "TATAELXSI", bse: "500408", aliases: ["tata elxsi"] };

describe("exchange filings parsing", () => {
  it("parses IST timestamps", () => {
    expect(new Date(parseIst("13-Oct-2026 17:35:36")!).toISOString()).toBe("2026-10-13T12:05:36.000Z");
    expect(new Date(parseIst("21-Oct-2026")!).toISOString()).toBe("2026-10-20T18:30:00.000Z");
    expect(parseIst("garbage")).toBeUndefined();
  });

  it("strips NSE boilerplate from summaries", () => {
    expect(cleanSummary("Tata Elxsi Limited has submitted to the Exchange, the financial results for the period ended September 30, 2026.")).toBe(
      "the financial results for the period ended September 30, 2026.",
    );
    expect(cleanSummary("Tata Elxsi Limited has informed the Exchange about Investor Presentation")).toBe("Investor Presentation");
  });

  it("maps NSE announcements to dated filings with PDF links", () => {
    const filings = mapNseAnnouncements(JSON.parse(nseAnnFx), TE);
    expect(filings.length).toBeGreaterThan(5);
    const outcome = filings.find((f) => f.category === "Outcome of Board Meeting" && /financial results/i.test(f.text))!;
    expect(outcome.url).toMatch(/^https:\/\/nsearchives\.nseindia\.com\/corporate\/.+\.pdf$/);
    expect(new Date(outcome.time).toISOString()).toBe("2026-10-13T12:05:36.000Z");
  });

  it("keeps only upcoming board meetings, once per date", () => {
    const rows = JSON.parse(nseBmFx);
    expect(mapUpcomingMeetings(rows, TE, Date.parse("2026-10-14T06:00:00Z"))).toEqual([]);
    const before = mapUpcomingMeetings(rows, TE, Date.parse("2026-10-10T06:00:00Z"));
    expect(before).toHaveLength(1);
    expect(before[0].category).toBe("Board meeting on 13-Oct-2026");
  });

  it("indexes the BSE feed by scrip code", () => {
    const byCode = parseBseFeed(bseFx);
    const te = byCode.get("500408")!;
    expect(te).toHaveLength(1);
    expect(te[0].link).toMatch(/^https:\/\/www\.bseindia\.com\/xml-data\/corpfiling\/AttachLive\/.+\.pdf$/);
    expect(te[0].time).toBeGreaterThan(Date.parse("2026-10-13T00:00:00Z"));
  });
});

describe("exchange filings ranking", () => {
  const f = (category: string, text: string, time: string, source: "NSE" | "BSE" = "NSE"): Filing => ({
    source,
    company: TE,
    time: Date.parse(time),
    category,
    text,
    url: `https://x/${category}`,
  });

  it("drops a BSE copy of a filing already on NSE", () => {
    const nse = [f("Outcome of Board Meeting", "the financial results for the period ended September 30, 2026", "2026-10-13T12:05:00Z")];
    const bse = [
      f("BSE announcement", "Audited Financial Results for the quarter ended September 30, 2026", "2026-10-13T12:10:00Z", "BSE"),
      f("BSE announcement", "Intimation of loss of share certificate", "2026-10-13T12:12:00Z", "BSE"),
    ];
    expect(dropCrossListed(bse, nse).map((x) => x.text)).toEqual(["Intimation of loss of share certificate"]);
  });

  it("puts results filings first for a results question", () => {
    const filings = [
      f("Copy of Newspaper Publication", "Copy of Newspaper Publication", "2026-10-14T05:45:00Z"),
      f("Outcome of Board Meeting", "the financial results for the period ended September 30, 2026", "2026-10-13T12:05:00Z"),
      f("Trading Window", "closure of trading window", "2026-09-25T10:00:00Z"),
    ];
    expect(rankFilings(filings, "Did Tata Elxsi publish Q2 results")[0].category).toBe("Outcome of Board Meeting");
    expect(rankFilings(filings, "Tata Elxsi filings")[0].category).toBe("Copy of Newspaper Publication");
  });

  it("titles results with the company, category and summary", () => {
    const r = toResult(f("Outcome of Board Meeting", "the financial results for the period ended September 30, 2026.", "2026-10-13T12:05:00Z"));
    expect(r.title).toBe("Tata Elxsi: Outcome of Board Meeting — the financial results for the period ended September 30, 2026");
    expect(r.author).toBe("NSE");
  });
});

describe("exchange filings engine", () => {
  afterEach(() => {
    configureTickerSearch(undefined);
    _clearCompanyMemo();
  });

  it("returns nothing when no company resolves", async () => {
    expect(await exchangeFilings.search!({ ...PARAMS, query: "Q2 results today" }, { fetch, memo: new Map() })).toEqual([]);
  });

  it("combines NSE announcements with today's BSE filings for the resolved company", async () => {
    configureTickerSearch(async () => [
      { nseTicker: "TATAELXSI", bseTicker: "500408", companyName: "Tata Elxsi Ltd.", isinNumber: "INE670A01012", marketCap: 21350.3, matchType: "exact_ticker", confidence: 1 },
    ]);
    const urls: string[] = [];
    const ctx = {
      memo: new Map(),
      fetch: async (input: string | URL) => {
        const url = String(input);
        urls.push(url);
        if (url.includes("corporate-announcements")) return Response.json(JSON.parse(nseAnnFx));
        if (url.includes("corporate-board-meetings")) return Response.json(JSON.parse(nseBmFx));
        if (url.includes("bseindia.com")) return new Response(bseFx, { headers: { "content-type": "application/rss+xml" } });
        return new Response("not found", { status: 404 });
      },
    };
    const results = await exchangeFilings.search!({ ...PARAMS, query: "Tata Elxsi Q2 results", timeRange: "month" }, ctx);
    expect(urls.some((u) => /symbol=TATAELXSI&from_date=\d{2}-\d{2}-\d{4}&to_date=/.test(u))).toBe(true);
    expect(results[0].title).toMatch(/^Tata Elxsi: Outcome of Board Meeting — the financial results/);
    expect(results.every((r) => r.title.startsWith("Tata Elxsi:"))).toBe(true);
    expect(new Set(results.map((r) => r.author))).toContain("NSE");
  });
});

describe("exchange filings titles", () => {
  it("doesn't repeat a summary that equals the category", () => {
    const r = toResult({
      source: "NSE",
      company: TE,
      time: Date.parse("2026-10-08T10:00:00Z"),
      category: "General Updates",
      text: "General Updates",
      url: "https://x/1",
    });
    expect(r.title).toBe("Tata Elxsi: General Updates");
  });
});

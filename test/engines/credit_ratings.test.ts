import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Company, type FuzzyMatch, _clearCompanyMemo, aliasesFor, configureTickerSearch } from "../../src/searx/companies";
import {
  creditRatings,
  entityFromTitle,
  entityInText,
  fromSearchResults,
  icraId,
  parseAcuiteCompany,
  parseAcuiteSearch,
  parseCarePr,
  parseCrisilList,
  parseCrisilRationale,
  parseIndraSearch,
  parseInfomericsCompany,
  pickLatest,
  searchKey,
  toResult,
} from "../../src/searx/engines/credit_ratings";
import { _resetResearchCache, _setResearchBudget, parseDay, sameEntity } from "../../src/searx/engines/research_common";
import { configureTinyfish, mapTinyfishResults } from "../../src/searx/tinyfish";
import { EngineError } from "../../src/searx/types";
import acuiteCompanyFx from "../fixtures/ratings-acuite-company.html?raw";
import acuiteSearchFx from "../fixtures/ratings-acuite-search.json?raw";
import carePrFx from "../fixtures/ratings-care-pr.json?raw";
import careSearchFx from "../fixtures/ratings-care-search.json?raw";
import crisilBulletinFx from "../fixtures/ratings-crisil-bulletin.html?raw";
import crisilListFx from "../fixtures/ratings-crisil-list.json?raw";
import crisilRationaleFx from "../fixtures/ratings-crisil-rationale.html?raw";
import indraPrFx from "../fixtures/ratings-indra-pr.json?raw";
import indraSearchFx from "../fixtures/ratings-indra-search.json?raw";
import infomericsFx from "../fixtures/ratings-infomerics-company.json?raw";
import tfIcraGenusFx from "../fixtures/ratings-tinyfish-icra-genus.json?raw";
import tfIcraFx from "../fixtures/ratings-tinyfish-icra.json?raw";
import { PARAMS } from "../helpers";

const match = (nse: string, bse: string, name: string): FuzzyMatch => ({
  nseTicker: nse,
  bseTicker: bse,
  companyName: name,
  isinNumber: `IN${nse}`,
  marketCap: 10000,
  matchType: "exact",
  confidence: 1,
});
const company = (m: FuzzyMatch, phrase: string): Company => ({
  name: m.companyName,
  nse: m.nseTicker,
  bse: m.bseTicker,
  isin: m.isinNumber,
  aliases: aliasesFor(m, phrase),
});

const GENUS_M = match("GENUSPOWER", "530343", "Genus Power Infrastructures Ltd.");
const GENUS = company(GENUS_M, "genus power");
const TATA_ELXSI = company(match("TATAELXSI", "500408", "Tata Elxsi Ltd."), "tata elxsi");
const TATA_POWER = company(match("TATAPOWER", "500400", "Tata Power Co. Ltd."), "tata power");
const LT = company(match("LT", "500510", "Larsen & Toubro Ltd."), "larsen");
const TATA_STEEL = company(match("TATASTEEL", "500470", "Tata Steel Ltd."), "tata steel");

/** Monid-run fixtures → what tinyfishSearch returns. */
const tfResults = (fx: string) => mapTinyfishResults(JSON.parse(fx).output.results);

describe("rated-entity matching", () => {
  it("accepts the listed company under the agencies' spellings", () => {
    expect(sameEntity("Genus Power Infrastructures Limited", GENUS)).toBe(true);
    expect(sameEntity("Genus Power Infrastructures Ltd", GENUS)).toBe(true);
    expect(sameEntity("GENUS POWER INFRASTRUCTURE LTD", GENUS)).toBe(true);
    expect(sameEntity("Genus Power Infrastructures ...", GENUS)).toBe(true);
    expect(sameEntity("The Tata Power Company Limited", TATA_POWER)).toBe(true);
    expect(sameEntity("Larsen and Toubro Limited", LT)).toBe(true);
  });

  it("rejects subsidiaries, SPVs and namesakes", () => {
    expect(sameEntity("Genus Mewar Smart Metering SPV Private Limited", GENUS)).toBe(false);
    expect(sameEntity("Genus Innovation Limited", GENUS)).toBe(false);
    expect(sameEntity("Tata Power Renewable Energy Limited", TATA_POWER)).toBe(false);
    expect(sameEntity("Tata Steel Utilities and Infrastructure Services Limited", TATA_STEEL)).toBe(false);
    expect(sameEntity("Larsen & Toubro Infotech Limited", LT)).toBe(false);
  });

  it("types the substring agencies match on", () => {
    expect(searchKey(GENUS)).toBe("genus power");
    expect(searchKey(LT)).toBe("larsen");
    expect(searchKey(company(match("DRREDDY", "500124", "Dr. Reddy's Laboratories Ltd."), "dr reddy"))).toBe("reddy");
    expect(searchKey(company(match("INFY", "500209", "Infosys Ltd."), "infosys"))).toBe("infosys");
  });

  it("reads the rated entity from titles, CRISIL file names and snippets", () => {
    expect(entityFromTitle("Tata Elxsi Limited: Ratings reaffirmed", "https://www.icra.in/x")).toBe("Tata Elxsi Limited");
    expect(entityFromTitle("RATING RATIONALE 27 Nov 2020 Tata Steel Ltd. ...", "https://www.brickworkratings.com/a.pdf")).toBe("Tata Steel Ltd. ...");
    expect(
      entityFromTitle(
        "Rating Rationale",
        "https://www.crisil.com/mnt/winshare/Ratings/RatingList/RatingDocs/GenusPowerInfrastructuresLimited_November%2020_%202025_RR_380934.html",
      ),
    ).toBe("Genus Power Infrastructures Limited");
    expect(entityInText("Rationale. The rating upgrade takes into account Tata Steel Utilities and Infrastructure Services Limited's strengthening")).toBe(
      "Tata Steel Utilities and Infrastructure Services Limited",
    );
  });

  it("parses the agencies' date formats as calendar days", () => {
    expect(new Date(parseDay("Apr 30, 2026")!).toISOString()).toBe("2026-04-30T00:00:00.000Z");
    expect(new Date(parseDay("05 Dec 2024")!).toISOString()).toBe("2024-12-05T00:00:00.000Z");
    expect(new Date(parseDay("19th Mar 26")!).toISOString()).toBe("2026-03-19T00:00:00.000Z");
    expect(new Date(parseDay("2026-07-08 00:00:00.000")!).toISOString()).toBe("2026-07-08T00:00:00.000Z");
    expect(new Date(parseDay("November 20, 2025")!).toISOString()).toBe("2025-11-20T00:00:00.000Z");
    expect(parseDay("soon")).toBeUndefined();
  });
});

describe("agency parsers", () => {
  it("CRISIL: keeps the company, not its SPVs or namesakes", () => {
    const docs = parseCrisilList(JSON.parse(crisilListFx));
    expect(docs.length).toBeGreaterThan(5);
    const genus = docs.filter((d) => sameEntity(d.entity, GENUS));
    expect(genus).toHaveLength(1);
    expect(genus[0]).toMatchObject({ kind: "update", action: "Update on Genus Power Infrastructures Limited" });
    expect(genus[0].url).toBe(
      "https://www.crisilratings.com/mnt/winshare/Ratings/RatingList/RatingDocs/GenusPowerInfrastructuresLimited_April%2030_%202026_RR_394763.html",
    );
    expect(new Date(genus[0].time!).toISOString()).toBe("2026-04-30T00:00:00.000Z");
  });

  it("CRISIL: an update bulletin points to the full rationale and lists the ratings", () => {
    const page = parseCrisilRationale(crisilBulletinFx, "Genus Power Infrastructures Limited");
    expect(page.previous?.url).toMatch(/GenusPowerInfrastructuresLimited_November%2020_%202025_RR_380934\.html$/);
    expect(new Date(page.previous!.time!).toISOString()).toBe("2025-11-20T00:00:00.000Z");
    expect(page.ratings).toEqual(expect.arrayContaining(["Crisil AA-/Stable", "Crisil A1+"]));
  });

  it("CRISIL: a full rationale gives the action, the detailed rationale and the business", () => {
    const page = parseCrisilRationale(crisilRationaleFx, "Genus Power Infrastructures Limited");
    expect(page.action).toMatch(/^Ratings reaffirmed at 'Crisil AA- \/ Stable \/ Crisil A1\+/);
    expect(page.detailed).toMatch(/working capital cycle/);
    expect(page.about).toMatch(/makes electricity meters, smart meters and gas meters/);
  });

  it("CARE: press releases with their dates", () => {
    const docs = parseCarePr(JSON.parse(carePrFx), "Tata Steel Limited");
    expect(docs).toEqual([
      expect.objectContaining({
        agency: "care",
        url: "https://www.careratings.com/upload/CompanyFiles/PR/202607120713_Tata_Steel_Limited.pdf",
        time: Date.parse("2026-07-08T00:00:00Z"),
      }),
    ]);
    expect(JSON.parse(careSearchFx).data.some((d: { CompanyName: string }) => d.CompanyName === "Tata Steel Limited")).toBe(true);
  });

  it("India Ratings: dated press releases by issuer", () => {
    const docs = parseIndraSearch(JSON.parse(indraSearchFx));
    expect(docs[0]).toMatchObject({ url: "https://www.indiaratings.co.in/pressrelease/73745", time: Date.parse("2024-12-05T00:00:00Z") });
    expect(docs[0].action).toMatch(/Affirms Genus Power Infrastructures .* Withdraws Ratings/);
    expect(docs.every((d) => sameEntity(d.entity, GENUS))).toBe(true);
    expect(docs.find((d) => d.url.endsWith("/62714"))?.kind).toBe("update");
  });

  it("Acuité: search hits and the rating history rows", () => {
    expect(parseAcuiteSearch(JSON.parse(acuiteSearchFx))[0]).toEqual({ cid: "27768", name: "INDUCTO STEEL LIMITED" });
    expect(parseAcuiteSearch({ mtype: "error" })).toEqual([]);
    const rows = parseAcuiteCompany(acuiteCompanyFx, "Inducto Steel Limited");
    expect(rows).toHaveLength(6);
    expect(rows[0]).toMatchObject({
      url: "https://connect.acuite.in/fcompany-details/INDUCTO_STEEL_LIMITED/19th_Mar_26",
      time: Date.parse("2026-03-19T00:00:00Z"),
    });
  });

  it("Infomerics: one rationale per press release, with its ratings", () => {
    const docs = parseInfomericsCompany(JSON.parse(infomericsFx));
    const latest = docs.sort((a, b) => (b.time ?? 0) - (a.time ?? 0))[0];
    expect(latest.url).toBe("https://infomericstorage.blob.core.windows.net/uploads/pr_capithan_exporting_16oct26_2bcfa01b6f.pdf");
    expect(latest.time).toBe(Date.parse("2026-10-16T00:00:00Z"));
    expect(latest.action).toMatch(/IVR BB-\/Stable \(Reaffirmed\)/);
    expect(new Set(docs.map((d) => d.url)).size).toBe(docs.length);
  });

  it("ICRA via search: one result per rationale id, dates merged, newest kept", () => {
    expect(icraId("https://www.icra.in/pdfjs/web/viewer_no_control.html?file=%2FRating%2FShowRationalReportFilePdfViewer%2F78778")).toBe("78778");
    expect(icraId("https://www.icra.in/Rationale/ShowRationaleReport/?Id=101073")).toBe("101073");
    const docs = fromSearchResults(tfResults(tfIcraFx), TATA_ELXSI, "Tata Elxsi rating rationale");
    const ids = docs.map((d) => icraId(d.url));
    expect(new Set(ids).size).toBe(ids.length);
    expect(docs.every((d) => d.url.startsWith("https://www.icra.in/Rationale/ShowRationaleReport?Id="))).toBe(true);
    const latest = pickLatest(docs);
    expect(latest).toHaveLength(3);
    expect(latest[0]).toMatchObject({ url: "https://www.icra.in/Rationale/ShowRationaleReport?Id=101073", time: Date.parse("2021-02-02T00:00:00Z") });
    expect(latest[0].action).toBe("Ratings reaffirmed and withdrawn");
  });

  it("ICRA via search: drops rationales of the company's SPVs and namesakes", () => {
    expect(fromSearchResults(tfResults(tfIcraGenusFx), GENUS, "Genus Power rating rationale")).toEqual([]);
  });

  it("titles a result with agency, company, kind and month", () => {
    const r = toResult(
      { agency: "crisil", entity: "Genus Power Infrastructures Limited", url: "https://x/1", time: Date.parse("2025-11-20T00:00:00Z"), action: "Ratings reaffirmed", kind: "rationale" },
      GENUS,
    );
    expect(r).toMatchObject({
      title: "CRISIL: Genus Power Infrastructures — rating rationale (Nov 2025)",
      content: "Ratings reaffirmed.",
      publishedDate: "2025-11-20T00:00:00.000Z",
      author: "CRISIL Ratings",
    });
  });
});

// --- the engine, with every site stubbed -------------------------------------------------

type Route = (url: string, init?: RequestInit) => Response | Promise<Response> | undefined;

function ctxWith(route: Route) {
  const urls: string[] = [];
  return {
    urls,
    ctx: {
      memo: new Map(),
      fetch: async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        urls.push(url);
        return (await route(url, init)) ?? new Response("not found", { status: 404 });
      },
    },
  };
}

/** Answers TinyFish's direct endpoint, per include_domains. */
function stubTinyfish(byDomains: (domains: string) => unknown[]) {
  configureTinyfish({ tinyfish: "test-key" });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.hostname !== "api.search.tinyfish.ai") return new Response("unexpected", { status: 500 });
    return Response.json({ results: byDomains(url.searchParams.get("include_domains") ?? "") });
  });
}

const genusSites: Route = (url) => {
  if (url.includes("ratingresultlisting.results.json")) return new Response(crisilListFx);
  if (url.includes("_April%2030_%202026_RR_394763")) return new Response(crisilBulletinFx);
  if (url.includes("_November%2020_%202025_RR_380934")) return new Response(crisilRationaleFx);
  if (url.includes("careratings.com/header/searchlist")) return Response.json({ data: [], report: [] });
  if (url.includes("indiaratings.co.in/home/GetSearch")) return new Response(indraSearchFx);
  if (url.includes("GetPressreleaseData_BeforeLogin")) return new Response(indraPrFx);
  if (url.includes("acuite.in/Home/searchCompanyData")) return Response.json({ mtype: "error", message: "No company data found" });
  if (url.includes("cms.infomerics.com/api/companies/autocomplete")) return Response.json([]);
  return undefined;
};

describe("credit ratings engine", () => {
  beforeEach(() => {
    _resetResearchCache();
    configureTickerSearch(async () => [GENUS_M]);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    configureTickerSearch(undefined);
    configureTinyfish({});
    _clearCompanyMemo();
    _setResearchBudget(undefined);
  });

  it("returns nothing when no company resolves", async () => {
    configureTickerSearch(undefined);
    const { ctx, urls } = ctxWith(() => undefined);
    expect(await creditRatings.search!({ ...PARAMS, query: "credit rating outlook" }, ctx)).toEqual([]);
    expect(urls).toEqual([]);
  });

  it("returns each agency's latest rationales, dated and naming the company", async () => {
    stubTinyfish(() => JSON.parse(tfIcraGenusFx).output.results);
    const { ctx } = ctxWith(genusSites);
    const results = await creditRatings.search!({ ...PARAMS, query: "Genus Power credit rating" }, ctx);
    expect(results.map((r) => r.title)).toEqual([
      "CRISIL: Genus Power Infrastructures — rating update (Apr 2026)",
      "CRISIL: Genus Power Infrastructures — rating rationale (Nov 2025)",
      "India Ratings: Genus Power Infrastructures — rating rationale (Dec 2024)",
      "India Ratings: Genus Power Infrastructures — rating rationale (Dec 2023)",
      "India Ratings: Genus Power Infrastructures — rating update (Jul 2023)",
    ]);
    expect(results.every((r) => r.publishedDate)).toBe(true);
    const full = results[1];
    expect(full.url).toMatch(/_November%2020_%202025_RR_380934\.html$/);
    expect(full.content).toMatch(/^Ratings reaffirmed at 'Crisil AA- \/ Stable \/ Crisil A1\+ '; Rated amount enhanced for Bank Debt\. Crisil Ratings has reaffirmed/);
    expect(full.content).toMatch(/About the company: Incorporated in 1992/);
    expect(results[0].content).toMatch(/Ratings: Crisil AA-\/Stable, Crisil A1\+\. Full rationale: Nov 2025\./);
    expect(results[2].content).toMatch(/has affirmed Genus Power Infrastructures/);
    expect(new Set(results.map((r) => r.author))).toEqual(new Set(["CRISIL Ratings", "India Ratings and Research"]));
  });

  it("falls back to TinyFish for an agency whose own site fails", async () => {
    stubTinyfish((domains) =>
      domains.includes("crisilratings.com")
        ? [
            {
              title: "Genus Power Infrastructures Limited - Rating Rationale",
              url: "https://www.crisil.com/mnt/winshare/Ratings/RatingList/RatingDocs/GenusPowerInfrastructuresLimited_November%2020_%202025_RR_380934.html",
              snippet: "Crisil Ratings has reaffirmed its 'Crisil AA-/Stable/Crisil A1+' ratings",
              date: "Nov 20, 2025",
            },
          ]
        : [],
    );
    const { ctx } = ctxWith((url) => (url.includes("crisilratings.com") ? new Response("down", { status: 503 }) : genusSites(url)));
    const results = await creditRatings.search!({ ...PARAMS, query: "Genus Power credit rating" }, ctx);
    const crisil = results.find((r) => r.author === "CRISIL Ratings");
    expect(crisil).toMatchObject({ title: "CRISIL: Genus Power Infrastructures — rating rationale (Nov 2025)", publishedDate: "2025-11-20T00:00:00.000Z" });
    expect(results.some((r) => r.author === "India Ratings and Research")).toBe(true);
  });

  it("throws an EngineError when every source fails", async () => {
    stubTinyfish(() => []);
    vi.mocked(globalThis.fetch).mockImplementation(async () => new Response("no", { status: 500 }));
    const { ctx } = ctxWith(() => new Response("blocked", { status: 403 }));
    await expect(creditRatings.search!({ ...PARAMS, query: "Genus Power credit rating" }, ctx)).rejects.toBeInstanceOf(EngineError);
  });

  it("never waits past its budget for a stalled site", async () => {
    _setResearchBudget(300);
    stubTinyfish(() => []);
    const { ctx } = ctxWith((url) => (url.includes("indiaratings") ? new Promise<Response>(() => {}) : genusSites(url)));
    const started = Date.now();
    const results = await creditRatings.search!({ ...PARAMS, query: "Genus Power credit rating" }, ctx);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(results.some((r) => r.author === "CRISIL Ratings")).toBe(true);
    expect(results.some((r) => r.author === "India Ratings and Research")).toBe(false);
  });

  it("serves a repeat search for the same company from its cache", async () => {
    stubTinyfish(() => []);
    const first = ctxWith(genusSites);
    await creditRatings.search!({ ...PARAMS, query: "Genus Power credit rating" }, first.ctx);
    const again = ctxWith(genusSites);
    const results = await creditRatings.search!({ ...PARAMS, query: "Genus Power ratings" }, again.ctx);
    expect(results.length).toBeGreaterThan(0);
    expect(again.urls).toEqual([]);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import {
  type FuzzyMatch,
  _clearCompanyMemo,
  aliasesFor,
  configureTickerSearch,
  coreName,
  pickMatch,
  resolveCompanies,
  subjectPhrases,
} from "../src/searx/companies";

// Shapes taken from the ticker service's real responses.
const m = (nse: string, bse: string, name: string, matchType: string, confidence: number, marketCap: number): FuzzyMatch => ({
  nseTicker: nse,
  bseTicker: bse,
  companyName: name,
  isinNumber: `IN${nse}`,
  marketCap,
  matchType,
  confidence,
});

const TATA_ELXSI = m("TATAELXSI", "500408", "Tata Elxsi Ltd.", "exact_ticker", 1, 21350.3);

describe("pickMatch", () => {
  it("accepts exact and confident fuzzy matches", () => {
    expect(pickMatch([TATA_ELXSI])?.nseTicker).toBe("TATAELXSI");
    expect(pickMatch([{ ...TATA_ELXSI, matchType: "fuzzy", confidence: 0.89 }, m("TATASTEEL", "500470", "Tata Steel Ltd.", "fuzzy", 0.48, 218461)])?.nseTicker).toBe("TATAELXSI");
  });

  it("rejects weak guesses for non-company queries", () => {
    expect(pickMatch([m("ASOCSTONE", "502015", "ASI Industries Ltd.", "fuzzy", 0.36, 224)])).toBeUndefined();
    expect(pickMatch([m("HUIL", "539984", "Hindusthan Urban Infrastructure", "fuzzy", 0.75, 1283)])).toBeUndefined();
  });

  it("skips delisted lines, rights entitlements and funds", () => {
    const hdfc = [
      m("HDFC", "500010", "Housing Development Finance Corporation Ltd.", "exact_ticker", 1, 0),
      m("HDFCBANK", "500180", "HDFC Bank Ltd.", "ticker_prefix", 0.99, 1100887),
      m("HDFCLIFE", "540777", "HDFC Life Insurance Company Ltd.", "ticker_prefix", 0.99, 150000),
    ];
    expect(pickMatch(hdfc)?.nseTicker).toBe("HDFCBANK");
    expect(pickMatch([m("RIL-RE", "750634", "Reliance Industries Limited-Rights Entitlement", "ticker_prefix", 0.99, 5)])).toBeUndefined();
  });

  it("takes a prefix match only when one company dominates", () => {
    const sbi = [
      m("SBIN", "500112", "State Bank of India", "ticker_prefix", 0.99, 883384),
      m("SBILIFE", "540719", "SBI Life Insurance Company Ltd.", "ticker_prefix", 0.99, 167946),
    ];
    expect(pickMatch(sbi)?.nseTicker).toBe("SBIN");
    const tata = [
      m("TATASTEEL", "500470", "Tata Steel Ltd.", "ticker_prefix", 0.99, 218461),
      m("TATAMOTORS", "500570", "Tata Motors Ltd.", "ticker_prefix", 0.99, 153383),
    ];
    expect(pickMatch(tata)).toBeUndefined();
  });
});

describe("aliases", () => {
  it("covers name, tickers, codes, nicknames and the user's wording", () => {
    expect(coreName("Dr. Reddy's Laboratories Ltd")).toBe("dr reddy's laboratories");
    expect(aliasesFor(TATA_ELXSI, "tata elxsi")).toEqual(expect.arrayContaining(["tata elxsi", "tataelxsi", "500408"]));
    const ril = aliasesFor(m("RELIANCE", "500325", "Reliance Industries Ltd.", "exact_name", 1, 1578840), "reliance industries");
    expect(ril).toEqual(expect.arrayContaining(["reliance industries", "ril", "reliance", "500325"]));
    const tcs = aliasesFor(m("TCS", "532540", "Tata Consultancy Services Ltd.", "exact_ticker", 1, 821052), "tcs");
    expect(tcs).toEqual(expect.arrayContaining(["tata consultancy services", "tata consultancy", "tcs"]));
  });

  it("splits comparisons and expands problem abbreviations", () => {
    expect(subjectPhrases("TCS vs Infosys Q2 results")).toEqual(["tcs", "infosys"]);
    expect(subjectPhrases("RIL dividend")).toEqual(["reliance industries"]);
    expect(subjectPhrases("why is PB Fintech falling")).toEqual(["pb fintech"]);
    expect(subjectPhrases("Q2 results today")).toEqual([]);
  });
});

describe("resolveCompanies", () => {
  afterEach(() => {
    configureTickerSearch(undefined);
    _clearCompanyMemo();
  });

  it("returns nothing without a ticker service", async () => {
    expect(await resolveCompanies("tata elxsi")).toEqual([]);
  });

  it("resolves each compared company once, and memoises", async () => {
    const calls: string[] = [];
    configureTickerSearch(async (q) => {
      calls.push(q);
      if (q === "tcs") return [m("TCS", "532540", "Tata Consultancy Services Ltd.", "exact_ticker", 1, 821052)];
      if (q === "infosys") return [m("INFY", "500209", "Infosys Ltd.", "exact_name", 1, 431029)];
      return [];
    });
    const out = await resolveCompanies("TCS vs Infosys Q2 results");
    expect(out.map((c) => [c.nse, c.bse])).toEqual([["TCS", "532540"], ["INFY", "500209"]]);
    await resolveCompanies("TCS vs Infosys Q2 results");
    expect(calls).toEqual(["tcs", "infosys"]);
  });

  it("finds the company anywhere in a long query with one batch lookup", async () => {
    const exact: Record<string, FuzzyMatch> = {
      "genus power infrastructures": m("GENUSPOWER", "530343", "Genus Power Infrastructures Ltd.", "exact_name", 1, 8832),
      "genus power": m("GENUSPOWER", "530343", "Genus Power Infrastructures Ltd.", "exact_ticker", 1, 8832),
      polycab: m("POLYCAB", "542652", "Polycab India Ltd.", "exact_ticker", 1, 123865),
      crisil: m("CRISIL", "500092", "Crisil Ltd.", "exact_ticker", 1, 33258),
      "kpi green energy": m("KPIGREEN", "542323", "KPI Green Energy Ltd.", "exact_name", 1, 6321),
      ntpc: m("NTPC", "532555", "NTPC Ltd.", "exact_ticker", 1, 305590),
      idea: m("IDEA", "532822", "Vodafone Idea Ltd.", "exact_ticker", 1, 136403),
      win: m("WINDMACHIN", "522029", "Windsor Machines Ltd.", "ticker_prefix", 0.99, 3016),
    };
    const batches: string[][] = [];
    configureTickerSearch(
      async () => [],
      async (qs) => {
        batches.push(qs);
        return qs.map((q) => exact[q]);
      },
    );
    const nse = async (q: string) => (await resolveCompanies(q)).map((c) => c.nse);
    expect(await nse("Genus Power Infrastructures smart meter order book")).toEqual(["GENUSPOWER"]);
    expect(batches[0]).toEqual(expect.arrayContaining(["genus power infrastructures", "smart meter", "book"]));
    expect(await nse("what did management say about margins in Genus Power concall")).toEqual(["GENUSPOWER"]);
    // The rating agency is the source, not the subject.
    expect(await nse("latest CRISIL rating rationale for Polycab India")).toEqual(["POLYCAB"]);
    // The longest exact name wins over a counterparty's ticker.
    expect(await nse("KPI Green Energy order win from NTPC")).toEqual(["KPIGREEN"]);
    // Ordinary words that happen to be tickers, and prefix matches, never count.
    expect(await nse("investment idea smart meter stocks to win")).toEqual([]);
  });

  it("survives a failing service", async () => {
    configureTickerSearch(async () => {
      throw new Error("down");
    });
    expect(await resolveCompanies("tata elxsi")).toEqual([]);
  });
});

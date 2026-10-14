import { describe, expect, it } from "vitest";
import { indexCard, indexData, matchIndices } from "../../src/searx/engines/index_data";
import fx from "../fixtures/nse-all-indices.json?raw";
import { PARAMS } from "../helpers";

const data = JSON.parse(fx);
const names: string[] = data.data.map((x: { index: string }) => x.index);

describe("matchIndices", () => {
  it("finds the index a query names", () => {
    expect(matchIndices("Nifty 50 one year return", names)).toEqual(["NIFTY 50"]);
    expect(matchIndices("nifty50 returns", names)).toEqual(["NIFTY 50"]);
    expect(matchIndices("Bank Nifty today", names)).toEqual(["NIFTY BANK"]);
    expect(matchIndices("finnifty expiry", names)).toEqual(["NIFTY FINANCIAL SERVICES"]);
    expect(matchIndices("India VIX spike", names)).toEqual(["INDIA VIX"]);
    expect(matchIndices("Nifty Midcap 100 vs Nifty Smallcap 100", names)).toEqual(["NIFTY MIDCAP 100", "NIFTY SMALLCAP 100"]);
    expect(matchIndices("Nifty IT index performance", names)).toEqual(["NIFTY IT"]);
  });

  it("doesn't read ordinary words as index names", () => {
    expect(matchIndices("is it a good time to buy nifty", names)).toEqual(["NIFTY 50"]);
    expect(matchIndices("Tata Elxsi Q2 results", names)).toEqual([]);
  });
});

describe("index card", () => {
  it("states level, returns over each period, range and valuation", () => {
    const nifty = data.data.find((x: { index: string }) => x.index === "NIFTY 50");
    const card = indexCard(nifty, data.timestamp);
    const fmt = (n: number) => n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const pct = (n: number) => `${n < 0 ? "−" : "+"}${Math.abs(n).toFixed(2)}%`;
    expect(card.title).toBe(`NIFTY 50: ${fmt(nifty.last)} (${pct(nifty.percentChange)} today) · 1Y ${pct(nifty.perChange365d)}`);
    expect(card.content).toContain(`1 year ${pct(nifty.perChange365d)} (from ${fmt(nifty.oneYearAgoVal)} on ${nifty.date365dAgo})`);
    expect(card.content).toContain(`1 month ${pct(nifty.perChange30d)}`);
    expect(card.content).toContain(`P/E ${nifty.pe}`);
    expect(card.content).toContain("exclude dividends");
    expect(card.publishedDate?.slice(0, 10)).toBe("2026-10-14");
  });

  it("returns cards only for index queries", async () => {
    const ctx = { memo: new Map(), fetch: async () => Response.json(data) };
    expect(await indexData.search!({ ...PARAMS, query: "Infosys deal wins" }, ctx)).toEqual([]);
    const cards = await indexData.search!({ ...PARAMS, query: "Nifty 50 one year return" }, ctx);
    expect(cards.map((c) => c.title.split(":")[0])).toEqual(["NIFTY 50"]);
  });
});

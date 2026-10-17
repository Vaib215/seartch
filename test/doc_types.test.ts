import { describe, expect, it } from "vitest";
import { classifyFiling } from "../src/searx/engines/exchange_filings";

const f = (category: string, text = "", url = "https://nsearchives.nseindia.com/corporate/X.pdf", meetingOn?: string) => ({
  category,
  text,
  url,
  meetingOn,
});

describe("classifyFiling", () => {
  it("tells documents apart from their category, summary and file name", () => {
    const con = "Analysts/Institutional Investor Meet/Con. Call Updates";
    expect(classifyFiling(f(con, "Genus Power has informed the Exchange about Transcript of the earnings call"))).toBe("transcript");
    expect(classifyFiling(f(con, "", "https://nsearchives.nseindia.com/corporate/GENUSPOWER_26052026155846_Transcript_signed.pdf"))).toBe("transcript");
    expect(classifyFiling(f(con, "Schedule of earnings call on 12 November; the transcript will be uploaded on the website"))).toBe("intimation");
    expect(classifyFiling(f("Investor Presentation", "Q1 FY27 investor presentation"))).toBe("presentation");
    expect(classifyFiling(f("Financial Result Updates", "Unaudited financial results for the quarter ended June 30, 2026"))).toBe("results");
    expect(classifyFiling(f("Board Meeting Intimation", "to consider and approve the financial results for the quarter"))).toBe("intimation");
    expect(classifyFiling(f("Annual Report", "Annual Report for FY 2025-26"))).toBe("annual_report");
    expect(classifyFiling(f("Credit Rating", "CRISIL has reaffirmed the long-term rating"))).toBe("credit_rating");
    expect(classifyFiling(f("Bagging/Receiving of orders/contracts", "Received a letter of award worth Rs 2,260 crore"))).toBe("order_win");
    expect(classifyFiling(f("General Updates", "Company secures new order from Maharashtra discom for smart meters"))).toBe("order_win");
    expect(classifyFiling(f("Board meeting", "Financial results", "https://www.nseindia.com/x", "12-Nov-2026"))).toBe("intimation");
    expect(classifyFiling(f("Change in Directorate", "Appointment of independent director"))).toBe("other");
  });
});

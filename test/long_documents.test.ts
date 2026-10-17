import { afterEach, describe, expect, it } from "vitest";
import {
  TooLargeError,
  convertDocument,
  documentName,
  hideStructTreeIn,
  mostlyEmpty,
  readDocument,
  reserveConversionMemory,
} from "../src/doc_convert";
import {
  CONVERTER_MAX_BYTES,
  PDF_MAX_BYTES,
  OTHER_DOCUMENT_MAX_BYTES,
  _clearDocMemo,
  documentByteLimit,
  isExchangeHost,
  joinPages,
  loadDoc,
  pageWindow,
  saveDoc,
  splitPages,
} from "../src/doc_pages";
import { type PageResult, shapePage } from "../src/fetch";
import { asksForFigures, focusPassages, rankPassages, splitPassages, stem, terms } from "../src/passages";
// A synthetic Q4 FY26 earnings-call transcript for a fictional company (Northwind
// Metering), shaped like Workers AI's Markdown for pages 1, 2, 4, 5, 6, 13, 15 and
// 18 of a converted PDF, as /fetch returns it.
import transcript from "./fixtures/sample-transcript.md?raw";

const TRANSCRIPT_URL = "https://nsearchives.nseindia.com/corporate/NORTHWIND_26052026_Transcript.pdf";

/** A converted PDF with `count` pages of `size` characters each. */
function syntheticPdf(count: number, size = 1000): string {
  const pages = Array.from({ length: count }, (_, i) => `### Page ${i + 1}\n${`p${i + 1} `.repeat(size).slice(0, size)}`);
  return `# deck.pdf\n\n${pages.join("\n\n")}`;
}

describe("page splitting", () => {
  it("splits on page markers and keeps their numbers", () => {
    const doc = splitPages(transcript);
    expect(doc.head).toBe("# NORTHWIND_26052026_Transcript.pdf");
    expect(doc.pages.map((p) => p.n)).toEqual([1, 2, 4, 5, 6, 13, 15, 18]);
    expect(doc.pages[0].text).toBe("");
    expect(doc.pages[3].text).toMatch(/stood at 343 on March '25 has reduced to 274 days/);
  });

  it("round-trips through joinPages", () => {
    const doc = splitPages(transcript);
    expect(splitPages(joinPages(doc))).toEqual(doc);
  });

  it("treats a document without markers as one block", () => {
    expect(splitPages("# Sheet\n\n| a | b |")).toEqual({ head: "# Sheet\n\n| a | b |", pages: [] });
  });
});

describe("page windows", () => {
  const doc = splitPages(syntheticPdf(50));

  it("returns everything that fits, with no next part", () => {
    const w = pageWindow(doc, 1, 60, 60_000);
    expect(w).toMatchObject({ pageRange: [1, 50], truncated: false });
    expect("nextPage" in w && w.nextPage).toBeFalsy();
  });

  it("stops at maxChars and points at the next page", () => {
    const w = pageWindow(doc, 1, 60, 10_000);
    if ("error" in w) throw new Error(w.error);
    // Title (10) + 9 pages of 1,000 characters and their markers fit; a tenth doesn't.
    expect(w.pageRange).toEqual([1, 9]);
    expect(w).toMatchObject({ truncated: true, nextPage: 10 });
    expect(w.markdown.length).toBeLessThanOrEqual(10_000);
    expect(w.markdown.startsWith("# deck.pdf")).toBe(true);
  });

  it("stops at maxPages", () => {
    expect(pageWindow(doc, 5, 3, 60_000)).toMatchObject({ pageRange: [5, 7], truncated: true, nextPage: 8 });
  });

  it("walks the whole document part by part without gaps or repeats", () => {
    const seen: number[] = [];
    let start: number | undefined = 1;
    let parts = 0;
    while (start !== undefined) {
      const w = pageWindow(doc, start, 60, 7_500);
      if ("error" in w) throw new Error(w.error);
      for (const m of w.markdown.matchAll(/^### Page (\d+)$/gm)) seen.push(Number(m[1]));
      if (parts > 0) expect(w.markdown).not.toMatch(/^# deck\.pdf/);
      start = w.nextPage;
      parts++;
    }
    expect(seen).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(parts).toBe(8);
  });

  it("cuts a page longer than maxChars instead of getting stuck", () => {
    const big = splitPages(syntheticPdf(3, 5000));
    const w = pageWindow(big, 2, 60, 2000);
    if ("error" in w) throw new Error(w.error);
    expect(w.markdown.length).toBeLessThanOrEqual(2000);
    expect(w.markdown).toMatch(/page 2 cut at 2000 characters/);
    expect(w).toMatchObject({ pageRange: [2, 2], truncated: true, nextPage: 3 });
  });

  it("starts at the first page at or after pageStart, using the markers' numbers", () => {
    const w = pageWindow(splitPages(transcript), 3, 2, 60_000);
    expect(w).toMatchObject({ pageRange: [4, 5], nextPage: 6 });
  });

  it("reports a pageStart past the end", () => {
    expect(pageWindow(doc, 51, 60, 60_000)).toEqual({ error: "pageStart 51 is past the last page (50)" });
  });
});

describe("document size limits", () => {
  it("allows large PDFs from the exchanges' archives", () => {
    for (const host of ["nsearchives.nseindia.com", "archives.nseindia.com", "www.nseindia.com", "bseindia.com", "www.bseindia.com", "api.bseindia.com"]) {
      expect(isExchangeHost(host)).toBe(true);
      expect(documentByteLimit(`https://${host}/corporate/x.pdf`, "application/pdf")).toBe(CONVERTER_MAX_BYTES);
    }
    expect(CONVERTER_MAX_BYTES).toBe(37_500_000);
  });

  it("keeps the smaller limit elsewhere", () => {
    for (const url of ["https://example.com/x.pdf", "https://evilbseindia.com/x.pdf", "https://nseindia.com.evil.example/x.pdf", "https://nseindia.com/x.pdf", "not a url"]) {
      expect(documentByteLimit(url, "application/pdf")).toBe(PDF_MAX_BYTES);
    }
    expect(documentByteLimit("https://www.bseindia.com/x.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe(
      OTHER_DOCUMENT_MAX_BYTES,
    );
  });
});

describe("terms", () => {
  it("stems plurals and verb forms to the same term", () => {
    expect(stem("days")).toBe(stem("day"));
    expect(stem("operating")).toBe(stem("operations"));
    expect(stem("reduced")).toBe(stem("reducing"));
    expect(stem("borrowings")).toBe("borrow");
    expect(stem("business")).toBe("business");
  });

  it("normalizes fiscal years and figures and drops question words", () => {
    expect(terms("What is the FY'28 net debt?")).toEqual(["fy28", "net", "debt"]);
    expect(terms("from FY 2028 onwards, INR1,573 crores")).toEqual(["fy28", "onward", "inr", "1573", "cror"]);
  });

  it("knows when a question asks for figures", () => {
    expect(asksForFigures("working capital days and operating cash flow timeline")).toBe(true);
    expect(asksForFigures("who is the CEO")).toBe(false);
  });
});

describe("passages", () => {
  const pages = splitPages(transcript).pages.map((p) => ({ page: p.n, text: p.text }));

  it("splits on paragraphs into ~600-900 character passages within a page", () => {
    const pieces = splitPassages(pages);
    expect(pieces.length).toBeGreaterThan(15);
    for (const p of pieces) expect(p.text.length).toBeLessThanOrEqual(1100);
    const sizable = pieces.filter((p) => p.text.length >= 400).length;
    expect(sizable / pieces.length).toBeGreaterThan(0.7);
    // Every word of each page (images aside) survives, in order, in that page's passages.
    const words = (s: string) => s.replace(/!\[[^\]]*\]\([^)]*\)/g, " ").split(/\s+/).filter(Boolean).join(" ");
    for (const { page, text } of pages) {
      expect(words(pieces.filter((p) => p.page === page).map((p) => p.text).join(" "))).toBe(words(text));
    }
  });

  it("breaks text without paragraph breaks on sentences, then words", () => {
    const sentences = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} talks about order book growth.`).join(" ");
    const pieces = splitPassages([{ page: 3, text: sentences }, { text: "x".repeat(2500) }]);
    expect(pieces.every((p) => p.text.length <= 1100)).toBe(true);
    expect(pieces.filter((p) => p.page === 3).length).toBeGreaterThan(2);
    expect(pieces.filter((p) => p.page === undefined).length).toBeGreaterThan(2);
  });

  it("finds the working-capital and debt timeline in the transcript", () => {
    const focus = "working capital days and operating cash flow timeline";
    const { passages, markdown } = focusPassages(pages, focus, 10_000);
    const text = passages.map((p) => p.text).join("\n");
    expect(text).toMatch(/343 on March '25 has reduced to 274 days/);
    expect(text).toMatch(/start reducing from FY28 onwards/);
    expect(text).toMatch(/we will be cash\s+positive/);
    expect(passages[0].text).toMatch(/working capital/i);
    // Best first, within the budget, each with its page.
    expect(passages.map((p) => p.score)).toEqual([...passages.map((p) => p.score)].sort((a, b) => b - a));
    expect(passages.reduce((n, p) => n + p.text.length, 0)).toBeLessThanOrEqual(10_000);
    expect(passages.every((p) => typeof p.page === "number")).toBe(true);
    // markdown: the same passages in page order, marked.
    const marked = [...markdown.matchAll(/^\[page (\d+)\]$/gm)].map((m) => Number(m[1]));
    expect(marked.length).toBe(passages.length);
    expect(marked).toEqual([...marked].sort((a, b) => a - b));
  });

  it("keeps to a small budget", () => {
    const { passages } = focusPassages(pages, "net debt peak borrowing", 1500);
    expect(passages.length).toBeGreaterThan(0);
    expect(passages.reduce((n, p) => n + p.text.length, 0)).toBeLessThanOrEqual(1500);
    expect(passages[0].text).toMatch(/net debt/i);
  });

  it("gives figure-bearing passages a small boost only for figure questions", () => {
    const plain = "The company discussed working capital and the plan to improve it over the coming period in detail with analysts.";
    const figures = "The company discussed working capital and the plan to improve it: 343 days in FY25, 274 days in FY26, INR 1,573 crores.";
    const pieces = splitPassages([{ page: 1, text: plain }, { page: 2, text: figures }]);
    expect(rankPassages(pieces, "working capital days")[0].page).toBe(2);
    const noFigures = rankPassages(pieces, "working capital plan");
    expect(noFigures.find((p) => p.page === 2)!.score / noFigures.find((p) => p.page === 1)!.score).toBeLessThan(1.1);
  });

  it("returns nothing for an unrelated question", () => {
    expect(focusPassages(pages, "lithium battery recycling", 5000).passages).toEqual([]);
  });
});

describe("shaping /fetch results", () => {
  const pdf: PageResult = { url: TRANSCRIPT_URL, via: "convert", markdown: syntheticPdf(80), pages: 80, scannedPages: 0 };

  it("returns PDFs in parts by default (60,000 characters, 60 pages)", () => {
    const r = shapePage(pdf, {});
    // Title + 59 pages of ~1,000 characters fit in 60,000.
    expect(r).toMatchObject({ pageRange: [1, 59], truncated: true, nextPage: 60, pages: 80, scannedPages: 0 });
    expect(r.markdown!.length).toBeLessThanOrEqual(60_000);
    expect(shapePage(pdf, { pageStart: 60 })).toMatchObject({ pageRange: [60, 80], truncated: false });
    expect(shapePage(pdf, { maxPages: 10, maxChars: 200_000 })).toMatchObject({ pageRange: [1, 10], nextPage: 11 });
  });

  it("answers a focus question from a PDF with page-marked passages", () => {
    const r = shapePage({ url: TRANSCRIPT_URL, via: "convert", markdown: transcript }, { focus: "net debt reducing from FY28" });
    expect(r.passages![0]).toMatchObject({ page: 5 });
    expect(r.markdown).toMatch(/^\[page 5\]\n/m);
    expect(r).toMatchObject({ pageRange: [1, 18], truncated: false });
  });

  it("searches only the pages asked for", () => {
    const r = shapePage({ url: TRANSCRIPT_URL, via: "convert", markdown: transcript }, { focus: "net debt", pageStart: 13, maxPages: 2 });
    // Two pages from 13: 13 and 15 (the excerpt has no 14), then 18 is next.
    expect(r).toMatchObject({ pageRange: [13, 15], truncated: true, nextPage: 18 });
    expect(r.passages!.length).toBeGreaterThan(0);
    expect(r.passages!.every((p) => p.page === 13 || p.page === 15)).toBe(true);
  });

  it("leaves HTML alone unless maxChars or focus is given", () => {
    const html: PageResult = { url: "https://example.com/a", via: "fetch", markdown: `# Title\n\n${"Revenue grew 12% to Rs 500 crore. ".repeat(200)}` };
    expect(shapePage(html, {})).toBe(html);
    expect(shapePage(html, { pageStart: 2, maxPages: 1 })).toBe(html);
    const clipped = shapePage(html, { maxChars: 1000 });
    expect(clipped.markdown!.length).toBeLessThanOrEqual(1000);
    expect(clipped).toMatchObject({ truncated: true });
    expect(clipped.nextPage).toBeUndefined();
    const focused = shapePage(html, { focus: "revenue growth", maxChars: 2000 });
    expect(focused.passages!.length).toBeGreaterThan(0);
    expect(focused.passages![0].page).toBeUndefined();
    expect(focused.markdown!.length).toBeLessThanOrEqual(2000 + 20 * focused.passages!.length);
  });

  it("says so when nothing matches, and passes errors through", () => {
    const r = shapePage({ url: TRANSCRIPT_URL, via: "convert", markdown: transcript }, { focus: "lithium recycling" });
    expect(r.passages).toEqual([]);
    expect(r.markdown).toMatch(/^\[No passage matches "lithium recycling"/);
    const failed: PageResult = { url: "https://x/a.pdf", error: "too large (99 bytes; the limit is 9 bytes)" };
    expect(shapePage(failed, { focus: "x" })).toBe(failed);
    expect(shapePage(pdf, { pageStart: 81 })).toMatchObject({ error: "pageStart 81 is past the last page (80)", markdown: undefined });
  });
});

describe("converted-document cache", () => {
  afterEach(() => _clearDocMemo());

  it("keeps documents per isolate and in the Cache API", async () => {
    const url = `${TRANSCRIPT_URL}?test=${Date.now()}`;
    const entry = { url, title: "t.pdf", doc: splitPages(transcript), pages: 18, scannedPages: 1 };
    expect(await loadDoc(url)).toBeUndefined();
    await saveDoc(entry);
    expect(await loadDoc(url)).toEqual(entry);
    _clearDocMemo();
    expect(await loadDoc(url)).toEqual(entry);
  });
});

/** A response whose body arrives in the given chunks. */
function chunked(parts: string[]): Response {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(c) {
        for (const p of parts) c.enqueue(enc.encode(p));
        c.close();
      },
    }),
  );
}

describe("reading and converting documents", () => {
  it("finds the structure-tree key even when it straddles chunks, and can hide it", async () => {
    const parts = ["%PDF-1.7\n1 0 obj <</Type/Catalog/StructTr", "eeRoot 5 0 R/Pages 2 0 R>> endobj\n", "trailer"];
    const seen = await readDocument(chunked(parts), "application/pdf", 1000);
    expect(seen.structTreeAt).toEqual([32]);
    expect(seen.structTreeHidden).toBe(false);
    expect(await seen.blob.text()).toBe(parts.join(""));
    expect(seen.blob.type).toBe("application/pdf");

    const hidden = await readDocument(chunked(parts), "application/pdf", 1000, true);
    expect(hidden.structTreeHidden).toBe(true);
    expect(await hidden.blob.text()).toBe(parts.join("").replace("/StructTreeRoot", "/StructTreeRooX"));
    // The same edit made after the fact.
    expect(await hideStructTreeIn(seen.blob, seen.structTreeAt, "application/pdf").text()).toBe(await hidden.blob.text());
  });

  it("stops reading past the limit", async () => {
    await expect(readDocument(chunked(["x".repeat(600), "y".repeat(600)]), "application/pdf", 1000)).rejects.toBeInstanceOf(TooLargeError);
  });

  it("knows mostly-empty conversions", () => {
    expect(mostlyEmpty("## Contents\n### Page 1\n\n### Page 2\n\n### Page 3\nSome real text on this page, long enough to count as text.")).toBe(true);
    expect(mostlyEmpty(transcript)).toBe(false);
  });

  it("converts again without the structure tree when it gave empty pages", async () => {
    const sent: string[] = [];
    const ai = {
      async toMarkdown(file: { name: string; blob: Blob }) {
        const body = await file.blob.text();
        sent.push(body);
        const data = body.includes("/StructTreeRooX") ? "### Page 1\nWorking capital days fell from 343 to 274.\n### Page 2\nNet debt peaks at INR 2,000 crore." : "### Page 1\n\n### Page 2\n";
        return { id: "1", name: file.name, mimeType: "application/pdf", format: "markdown", tokens: 1, data };
      },
    } as unknown as Ai;
    const doc = await readDocument(chunked(["%PDF <</StructTreeRoot 9 0 R>> rest"]), "application/pdf", 1000);
    const out = await convertDocument(ai, "x.pdf", doc);
    expect(out).toMatchObject({ structTreeHidden: true, markdown: expect.stringMatching(/343 to 274/) });
    expect(sent).toHaveLength(2);

    // No retry when the first conversion has text, or the PDF has no structure tree.
    sent.length = 0;
    await convertDocument(ai, "x.pdf", await readDocument(chunked(["%PDF no tree"]), "application/pdf", 1000));
    expect(sent).toHaveLength(1);
  });

  it("names documents with an extension that matches their type", () => {
    expect(documentName("https://www.bseindia.com/stockinfo/AnnPdfOpen.aspx?Pname=abc.pdf", "application/pdf")).toBe("AnnPdfOpen.aspx.pdf");
    expect(documentName("https://nsearchives.nseindia.com/corporate/X_IR.pdf", "application/pdf")).toBe("X_IR.pdf");
  });
});

describe("conversion memory budget", () => {
  it("makes a large conversion wait for the one before it", async () => {
    const first = await reserveConversionMemory(30_000_000, 0);
    expect(first).toBeDefined();
    // Too big to run alongside: times out without waiting long.
    expect(await reserveConversionMemory(20_000_000, 150)).toBeUndefined();
    // Small ones fit beside it.
    const small = await reserveConversionMemory(1_000_000, 0);
    expect(small).toBeDefined();
    small!();
    const waiting = reserveConversionMemory(20_000_000, 2000);
    setTimeout(() => first!(), 50);
    const second = await waiting;
    expect(second).toBeDefined();
    second!();
    first!(); // Releasing twice is harmless.
    const again = await reserveConversionMemory(37_000_000, 0);
    expect(again).toBeDefined();
    again!();
  });
});

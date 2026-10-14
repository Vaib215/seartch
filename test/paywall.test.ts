import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "../src/extract";
import { detectPaywall } from "../src/paywall";
import { captureTime } from "../src/wayback";
import hardPaywallHtml from "./fixtures/page-hard-paywall.html?raw";
import freeArticleHtml from "./fixtures/page-free-article.html?raw";
import teaserHtml from "./fixtures/page-teaser.html?raw";

const check = (html: string, url: string) => detectPaywall(html, htmlToMarkdown(html, url).markdown);

describe("detectPaywall", () => {
  it("passes a free article (isAccessibleForFree=true)", () => {
    expect(check(freeArticleHtml, "https://news.example/x")).toBeUndefined();
  });

  it("flags a barrier page as paywalled and partial", () => {
    const r = check(hardPaywallHtml, "https://paper.example/content/x");
    expect(r).toMatchObject({ paywalled: true, partial: true });
    expect(r!.paywallSignals.join()).toMatch(/isAccessibleForFree/);
  });

  it("flags a short teaser of a paywalled article as partial", () => {
    // The word count lives in app state, not JSON-LD, so this relies on the length rule.
    expect(check(teaserHtml, "https://journal.example/articles/x")).toMatchObject({ paywalled: true, partial: true });
  });

  it("uses the JSON-LD word count when present", () => {
    const html = '<script type="application/ld+json">{"isAccessibleForFree":false,"wordCount":2000}</script>';
    const r = detectPaywall(html, Array(500).fill("word").join(" "));
    expect(r).toMatchObject({ paywalled: true, partial: true });
    expect(r!.paywallSignals.join()).toMatch(/got 500 of 2000 declared words/);
  });

  it("reports full text of a paywalled article as not partial", () => {
    const html = '<script type="application/ld+json">{"isAccessibleForFree":"False","wordCount":100}</script>';
    const md = Array(120).fill("word").join(" ");
    expect(detectPaywall(html, md)).toMatchObject({ paywalled: true, partial: false });
  });

  it("catches barrier wording without schema.org markup (Medium)", () => {
    expect(detectPaywall("<html></html>", "# Title\n\nMember-only story\n\nSome intro")).toMatchObject({
      paywalled: true,
      partial: true,
    });
  });
});

describe("captureTime", () => {
  it("parses Wayback capture timestamps", () => {
    expect(captureTime("https://web.archive.org/web/20261008175318id_/https://news.example/x")).toBe("2026-10-08T17:53:18Z");
    expect(captureTime("https://example.com/")).toBeUndefined();
  });
});

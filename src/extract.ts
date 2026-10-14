import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { NodeHtmlMarkdown } from "node-html-markdown";

const nhm = new NodeHtmlMarkdown({ maxConsecutiveNewlines: 2, useInlineLinks: true });

const NOISE = "script, style, noscript, template, svg, iframe, nav, header, footer, aside, form, button";

export interface Extracted {
  title: string;
  markdown: string;
}

/** Pulls the main content out of an HTML page and converts it to Markdown. */
export function htmlToMarkdown(html: string, pageUrl: string): Extracted {
  // linkedom's types don't line up with lib.dom, which Readability expects.
  const { document } = parseHTML(html) as any;
  absolutize(document, pageUrl);
  const pageTitle: string = document.title?.trim() ?? "";

  let title = pageTitle;
  let content: string | undefined;
  try {
    const article = new Readability(document.cloneNode(true), { charThreshold: 200 }).parse();
    if (article?.content) {
      content = article.content;
      title = article.title?.trim() || pageTitle;
    }
  } catch {
    // Fall through to the whole-body fallback below.
  }
  if (!content) {
    for (const el of document.querySelectorAll(NOISE)) el.remove();
    content = document.body?.innerHTML ?? "";
  }

  let markdown = nhm.translate(content ?? "").trim();
  if (title && !markdown.startsWith("# ")) markdown = `# ${title}\n\n${markdown}`;
  return { title, markdown };
}

/** Rewrites relative links and image sources so they still work in the Markdown. */
function absolutize(document: any, base: string) {
  for (const [selector, attr] of [["a[href]", "href"], ["img[src]", "src"]] as const) {
    for (const el of document.querySelectorAll(selector)) {
      const value = el.getAttribute(attr);
      if (!value || value.startsWith("#") || /^(data|javascript|mailto|tel):/i.test(value)) continue;
      try {
        el.setAttribute(attr, new URL(value, base).href);
      } catch {
        // Leave malformed URLs as they are.
      }
    }
  }
}

/** Rough count of visible words, used to decide whether a page needs a real browser. */
export function wordCount(markdown: string): number {
  return markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .split(/\s+/)
    .filter((w) => /\w/.test(w)).length;
}

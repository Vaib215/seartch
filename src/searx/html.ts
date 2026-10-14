// Helpers standing in for searx/utils.py (extract_text, eval_xpath, ...).
// node-html-parser is used instead of lxml: CSS selectors rather than XPath.

import { type HTMLElement, parse } from "node-html-parser";
import { decodeEntities } from "../util";

export type { HTMLElement };

export function parseHtml(html: string): HTMLElement {
  return parse(html, { comment: false, blockTextElements: { script: true, style: true, noscript: false, pre: true } });
}

/** Visible text of an element (or a string of HTML), whitespace-collapsed. */
export function extractText(node: HTMLElement | string | null | undefined): string {
  if (node == null) return "";
  if (typeof node === "string") return decodeEntities(node.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
  return decodeEntities(node.textContent).replace(/\s+/g, " ").trim();
}

/** Text of the first element matching selector under root, or "". */
export function textOf(root: HTMLElement, selector: string): string {
  return extractText(root.querySelector(selector));
}

export function attrOf(root: HTMLElement, selector: string, attr: string): string | undefined {
  return root.querySelector(selector)?.getAttribute(attr) ?? undefined;
}

/** Strip HTML tags and decode entities in API-provided snippets. */
export function htmlToText(s: string | null | undefined): string {
  return extractText(s ?? "");
}

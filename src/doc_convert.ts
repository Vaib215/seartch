// Documents (PDFs, office files) to Markdown with Workers AI's toMarkdown(),
// which is free as long as embedded images aren't converted. Large filings need
// care on two fronts:
//
// Memory. toMarkdown() copies the file into an ArrayBuffer, base64-encodes it
// into a string and wraps that in a JSON string, all inside the isolate, so a
// conversion briefly holds several copies of the file. Bytes are read once
// (straight into the Blob that is converted) and conversions share a
// per-isolate budget.
//
// Tagged PDFs. toMarkdown() builds Markdown from a PDF's structure tree when it
// has one. For many filings (PowerPoint investor presentations, InDesign annual
// reports) that yields empty pages although the text is there. Renaming the
// catalog's /StructTreeRoot key in place (same length, so every offset stays
// valid) makes the converter read each page's text as-is instead.

import { CONVERTER_MAX_BYTES, splitPages } from "./doc_pages";

// toMarkdown is free except where it runs AI models on images; turning off
// embedded-image conversion keeps every conversion on the free path.
export const NO_IMAGE_MODELS: ConversionRequestOptions = {
  conversionOptions: {
    pdf: { images: { convert: false } },
    docx: { images: { convert: false } },
  },
};

const MB = 1_000_000;
// One maximum-size conversion at a time per isolate; smaller ones share it.
const CONVERSION_BUDGET_BYTES = CONVERTER_MAX_BYTES;
// Above this, PDFs skip the structure tree from the start: most large filings
// tried (investor presentations; Genus, Infosys, ITC, L&T, Power Grid annual
// reports) came back empty with it, and converting a large file twice costs
// seconds and memory. Smaller PDFs try it first and retry without it.
export const STRUCT_TREE_MAX_BYTES = 5 * MB;

const STRUCT_TREE_KEY = new TextEncoder().encode("/StructTreeRoot");
// "/StructTreeRooX": an unknown key the converter ignores.
const HIDDEN_LAST_BYTE = 0x58;

let reservedBytes = 0;

/**
 * Waits (up to maxWaitMs) until this isolate has room to convert a document of
 * the given size, and returns the release function, or undefined on timeout.
 * Polls rather than queueing promises so no request waits on another's I/O.
 */
export async function reserveConversionMemory(bytes: number, maxWaitMs: number): Promise<(() => void) | undefined> {
  const need = Math.max(1, Math.min(bytes, CONVERSION_BUDGET_BYTES));
  const deadline = Date.now() + maxWaitMs;
  while (reservedBytes > 0 && reservedBytes + need > CONVERSION_BUDGET_BYTES) {
    if (Date.now() >= deadline) return undefined;
    await new Promise((r) => setTimeout(r, 100));
  }
  reservedBytes += need;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    reservedBytes -= need;
  };
}

export class TooLargeError extends Error {
  constructor(public limit: number) {
    super(`too large (over ${limit} bytes)`);
  }
}

export interface DocumentBytes {
  blob: Blob;
  /** Offsets of "/StructTreeRoot" in the bytes as served. */
  structTreeAt: number[];
  /** Whether those keys were already renamed in blob. */
  structTreeHidden: boolean;
}

/**
 * Reads a response body once, into the Blob that gets converted, failing past
 * limit bytes. For PDFs it notes where the structure-tree key is, and renames
 * it on the way through when hideStructTree is set.
 */
export async function readDocument(res: Response, type: string, limit: number, hideStructTree = false): Promise<DocumentBytes> {
  if (!res.body) return { blob: new Blob([], { type }), structTreeAt: [], structTreeHidden: false };
  const isPdf = type === "application/pdf";
  const structTreeAt: number[] = [];
  const hold = STRUCT_TREE_KEY.length - 1;
  let total = 0;
  let overLimit = false;
  let carry = new Uint8Array(0);
  const scan = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > limit) {
        overLimit = true;
        throw new TooLargeError(limit);
      }
      if (!isPdf) {
        controller.enqueue(chunk);
        return;
      }
      // Keep the last few bytes back so a key split across chunks is still found.
      let buf = chunk;
      if (carry.length) {
        buf = new Uint8Array(carry.length + chunk.length);
        buf.set(carry);
        buf.set(chunk, carry.length);
      }
      const base = total - buf.length;
      for (const at of findAll(buf, STRUCT_TREE_KEY)) {
        structTreeAt.push(base + at);
        if (hideStructTree) buf[at + hold] = HIDDEN_LAST_BYTE;
      }
      const keep = Math.min(buf.length, hold);
      carry = buf.slice(buf.length - keep);
      if (buf.length > keep) controller.enqueue(buf.subarray(0, buf.length - keep));
    },
    flush(controller) {
      if (carry.length) controller.enqueue(carry);
    },
  });
  try {
    // Body.blob() wraps the bytes it read without another copy.
    const raw = await new Response(res.body.pipeThrough(scan)).blob();
    return { blob: raw.slice(0, raw.size, type), structTreeAt, structTreeHidden: hideStructTree && structTreeAt.length > 0 };
  } catch (e) {
    if (overLimit) throw new TooLargeError(limit);
    throw e;
  }
}

function* findAll(haystack: Uint8Array, needle: Uint8Array): Generator<number> {
  const first = needle[0];
  for (let i = haystack.indexOf(first); i >= 0 && i + needle.length <= haystack.length; i = haystack.indexOf(first, i + 1)) {
    let j = 1;
    while (j < needle.length && haystack[i + j] === needle[j]) j++;
    if (j === needle.length) yield i;
  }
}

/** A copy of blob with the structure-tree keys at the given offsets renamed. */
export function hideStructTreeIn(blob: Blob, offsets: number[], type: string): Blob {
  const parts: (Blob | Uint8Array)[] = [];
  let pos = 0;
  const hidden = new Uint8Array(STRUCT_TREE_KEY);
  hidden[hidden.length - 1] = HIDDEN_LAST_BYTE;
  for (const at of [...offsets].sort((a, b) => a - b)) {
    if (at < pos) continue;
    parts.push(blob.slice(pos, at), hidden);
    pos = at + STRUCT_TREE_KEY.length;
  }
  parts.push(blob.slice(pos));
  return new Blob(parts, { type });
}

/** Characters of real text across a converted document's pages (markers and whitespace excluded). */
export function textChars(markdown: string): number {
  const { head, pages } = splitPages(markdown);
  const body = pages.length ? pages.map((p) => p.text).join("") : head;
  return body.replace(/!\[[^\]]*\]\([^)]*\)|[#|\-\s]/g, "").length;
}

/** Most pages came back without text: scanned, or a structure tree the converter couldn't use. */
export function mostlyEmpty(markdown: string): boolean {
  const { pages } = splitPages(markdown.split(/^## Contents\s*$/m)[1] ?? markdown);
  if (!pages.length) return false;
  const empty = pages.filter((p) => p.text.replace(/!\[[^\]]*\]\([^)]*\)|[#|\-\s]/g, "").length < 40).length;
  return empty * 2 >= pages.length;
}

export type Conversion = { markdown: string; structTreeHidden: boolean } | { error: string };

/**
 * Converts a document; a PDF whose structure tree gave mostly empty pages is
 * converted again with the tree hidden, keeping whichever has more text.
 */
export async function convertDocument(ai: Ai, name: string, doc: DocumentBytes): Promise<Conversion> {
  const type = doc.blob.type;
  const first = await ai.toMarkdown({ name, blob: doc.blob }, NO_IMAGE_MODELS);
  const canRetry = type === "application/pdf" && !doc.structTreeHidden && doc.structTreeAt.length > 0;
  if (!canRetry || (first.format !== "error" && !mostlyEmpty(first.data))) {
    return first.format === "error" ? { error: first.error } : { markdown: first.data, structTreeHidden: doc.structTreeHidden };
  }
  const second = await ai.toMarkdown({ name, blob: hideStructTreeIn(doc.blob, doc.structTreeAt, type) }, NO_IMAGE_MODELS);
  if (second.format === "error") return first.format === "error" ? { error: first.error } : { markdown: first.data, structTreeHidden: false };
  if (first.format === "error" || textChars(second.data) > textChars(first.data)) return { markdown: second.data, structTreeHidden: true };
  return { markdown: first.data, structTreeHidden: false };
}

/** A file name for the converter, with an extension that matches the content type. */
export function documentName(url: string, type: string): string {
  let name = "document";
  try {
    name = decodeURIComponent(new URL(url).pathname.split("/").pop() || "") || "document";
  } catch {
    // Keep the default.
  }
  if (type === "application/pdf" && !/\.pdf$/i.test(name)) name += ".pdf";
  return name;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new HttpError(400, "body must be valid JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

/** Accepts a string or an array of strings; trims, drops empties, de-duplicates. */
export function stringList(value: unknown, field: string, max: number): string[] {
  const raw = typeof value === "string" ? [value] : value;
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== "string")) {
    throw new HttpError(400, `"${field}" must be a string or an array of strings`);
  }
  const list = [...new Set(raw.map((v: string) => v.trim()).filter(Boolean))];
  if (list.length === 0) throw new HttpError(400, `"${field}" must not be empty`);
  if (list.length > max) throw new HttpError(400, `"${field}" accepts at most ${max} items`);
  return list;
}

export function intInRange(value: unknown, field: string, min: number, max: number, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new HttpError(400, `"${field}" must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function oneOf<T extends string>(value: unknown, field: string, options: readonly T[], fallback: T): T {
  if (value === undefined || value === null) return fallback;
  if (!options.includes(value as T)) {
    throw new HttpError(400, `"${field}" must be one of: ${options.join(", ")}`);
  }
  return value as T;
}

/** Runs fn over items with at most `limit` in flight, preserving order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function cleanText(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const BROWSER_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
  "accept-language": "en-US,en;q=0.9",
};

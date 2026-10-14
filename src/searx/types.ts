// Port of SearXNG's engine model (searx/engines, searx/search/processors/online.py)
// to Cloudflare Workers. An engine builds one HTTP request for a query and
// parses the response into results; the orchestrator does everything else.

export type Category = "general" | "it" | "science" | "news" | "filings" | "packages" | "repos" | "q&a";

export type SafeSearch = 0 | 1 | 2;
export type TimeRange = "day" | "week" | "month" | "quarter" | "year";

export interface SearchParams {
  query: string;
  /** 1-based page number. */
  pageno: number;
  /** "all", a language ("en") or a locale ("en-US"). */
  language: string;
  safesearch: SafeSearch;
  timeRange?: TimeRange;
}

export interface EngineRequest {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  /** Form body for POST requests. */
  form?: Record<string, string>;
  /** JSON body for POST requests. */
  json?: unknown;
  cookies?: Record<string, string>;
  /** Defaults to "follow". SearXNG defaults to not following; most engines don't care. */
  redirect?: "follow" | "manual";
}

export interface EngineResponse {
  status: number;
  url: string;
  headers: Headers;
  text: string;
  json<T = any>(): T;
}

export interface EngineResult {
  url: string;
  title: string;
  content?: string;
  /** ISO 8601 date string. */
  publishedDate?: string;
  thumbnail?: string;
  author?: string;
}

/** Utilities an engine may use while building its request (token pre-fetches, etc.). */
export interface EngineContext {
  fetch(input: string | URL, init?: RequestInit): Promise<Response>;
  /** Small per-isolate memo for tokens like Startpage's `sc` code. */
  memo: Map<string, { value: string; expires: number }>;
}

export interface Engine {
  name: string;
  /** Used for `!shortcut` bangs. */
  shortcut: string;
  categories: Category[];
  /** Multiplies this engine's contribution to a result's score. Default 1. */
  weight?: number;
  /** Per-engine timeout in ms. Default 3000 (SearXNG's request_timeout). */
  timeout?: number;
  paging?: boolean;
  timeRangeSupport?: boolean;
  safesearch?: boolean;
  /** Set false when the engine inspects non-2xx responses itself. Default true. */
  raiseForHttpError?: boolean;
  /** Engines that are known to misbehave can ship disabled; they still run when named explicitly. */
  disabled?: boolean;
  /** Short human note shown in /engines (e.g. why disabled). */
  about?: string;
  /** Highest page the engine serves (SearXNG's max_page). */
  maxPage?: number;
  /**
   * Engines that don't map to one HTTP request (e.g. several RSS feeds) implement
   * this instead; request/response are then unused. Mirrors SearXNG's offline engines.
   */
  search?(params: SearchParams, ctx: EngineContext): Promise<EngineResult[]>;
  /** Return null to skip this query (SearXNG: params["url"] = None). */
  request(params: SearchParams, ctx: EngineContext): EngineRequest | null | Promise<EngineRequest | null>;
  response(resp: EngineResponse, params: SearchParams, ctx: EngineContext): EngineResult[] | Promise<EngineResult[]>;
}

// Errors mirror searx/exceptions.py. Each kind maps to a suspension policy in health.ts.

export type EngineErrorKind = "access_denied" | "captcha" | "too_many_requests" | "http" | "parse" | "timeout" | "network";

export class EngineError extends Error {
  constructor(
    public kind: EngineErrorKind,
    message: string,
    /** Overrides the default suspension, in seconds. */
    public suspendSeconds?: number,
  ) {
    super(message);
  }
}

export class EngineAccessDenied extends EngineError {
  constructor(message = "access denied", suspendSeconds?: number) {
    super("access_denied", message, suspendSeconds);
  }
}

export class EngineCaptcha extends EngineError {
  constructor(message = "CAPTCHA", suspendSeconds?: number) {
    super("captcha", message, suspendSeconds);
  }
}

export class EngineTooManyRequests extends EngineError {
  constructor(message = "too many requests", suspendSeconds?: number) {
    super("too_many_requests", message, suspendSeconds);
  }
}

export class EngineParseError extends EngineError {
  constructor(message: string) {
    super("parse", message);
  }
}

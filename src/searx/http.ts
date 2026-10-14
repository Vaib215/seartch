// Port of searx/network/raise_for_httperror.py plus the request plumbing that
// SearXNG's network layer provides (cookies, form/JSON bodies, timeouts).

import {
  type EngineRequest,
  type EngineResponse,
  EngineAccessDenied,
  EngineCaptcha,
  EngineError,
  EngineTooManyRequests,
} from "./types";

export const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

const DEFAULT_HEADERS: Record<string, string> = {
  "user-agent": CHROME_UA,
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
};

export async function send(req: EngineRequest, signal: AbortSignal): Promise<EngineResponse> {
  const headers = new Headers({ ...DEFAULT_HEADERS, ...lowerKeys(req.headers ?? {}) });
  if (req.cookies && Object.keys(req.cookies).length) {
    headers.set("cookie", Object.entries(req.cookies).map(([k, v]) => `${k}=${v}`).join("; "));
  }
  let body: BodyInit | undefined;
  if (req.form) {
    body = new URLSearchParams(req.form);
    headers.set("content-type", "application/x-www-form-urlencoded");
  } else if (req.json !== undefined) {
    body = JSON.stringify(req.json);
    headers.set("content-type", "application/json");
  }
  const res = await fetch(req.url, {
    method: req.method ?? (body ? "POST" : "GET"),
    headers,
    body,
    redirect: req.redirect ?? "follow",
    signal,
  });
  const text = await res.text();
  return {
    status: res.status,
    url: res.url || req.url,
    headers: res.headers,
    text,
    json: () => {
      try {
        return JSON.parse(text);
      } catch {
        throw new EngineError("parse", "response is not valid JSON");
      }
    },
  };
}

function lowerKeys(h: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
}

// SearXNG's suspended_times for Cloudflare and reCAPTCHA blocks (15 days, 1 day,
// 7 days) assume one long-lived server IP. Worker egress IPs vary by data
// center, so these are capped in health.ts.
const CF_CAPTCHA_SECONDS = 1_296_000;
const CF_FIREWALL_SECONDS = 86_400;
const RECAPTCHA_SECONDS = 604_800;

export function raiseForHttpError(resp: EngineResponse) {
  if (resp.status < 400) return;
  raiseForCaptcha(resp);
  if (resp.status === 402 || resp.status === 403) throw new EngineAccessDenied(`HTTP ${resp.status}`);
  if (resp.status === 429) throw new EngineTooManyRequests();
  throw new EngineError("http", `HTTP ${resp.status}`);
}

export function raiseForCaptcha(resp: EngineResponse) {
  const server = resp.headers.get("server") ?? "";
  const t = resp.text;
  if (server.startsWith("cloudflare")) {
    const challenge =
      ([429, 503].includes(resp.status) &&
        (t.includes("__cf_chl_jschl_tk__=") ||
          (t.includes("/cdn-cgi/challenge-platform/") && t.includes("orchestrate/jsch/v1") && t.includes("window._cf_chl_enter(")))) ||
      (resp.status === 403 && t.includes("__cf_chl_captcha_tk__=")) ||
      resp.headers.get("cf-mitigated") === "challenge";
    if (challenge) throw new EngineCaptcha("Cloudflare CAPTCHA", CF_CAPTCHA_SECONDS);
    if (resp.status === 403 && t.includes('<span class="cf-error-code">1020</span>')) {
      throw new EngineAccessDenied("Cloudflare firewall", CF_FIREWALL_SECONDS);
    }
  }
  if (resp.status === 503 && t.includes('"https://www.google.com/recaptcha/')) {
    throw new EngineCaptcha("reCAPTCHA", RECAPTCHA_SECONDS);
  }
}

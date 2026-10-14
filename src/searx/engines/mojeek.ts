// Port of searx/engines/mojeek.py (general search only)
// Simplified: no images/news search types or spelling suggestions; language and
// region cookies use a hard-coded mapping instead of engine_traits; the "chllg"
// captcha token is cached per isolate (ctx.memo) instead of EngineCache;
//.
//
// Mojeek gates search behind an ALTCHA proof-of-work (PBKDF2). Like SearXNG we
// solve it in request() and send the resulting "chllg" cookie. SearXNG ships
// this engine inactive because solving costs CPU, so it is disabled here too.

import { extractText, parseHtml } from "../html";
import { type Engine, type EngineContext, type EngineResult, EngineError } from "../types";

const BASE_URL = "https://www.mojeek.com";
const TOKEN_KEY = "mojeek:chllg";
// Mojeek's cookie lives ~1 month; SearXNG's EngineCache default expiry is 1 day.
const TOKEN_TTL_MS = 24 * 3600_000;

// traits.languages (Mojeek "lb" cookie); "" means all languages.
const LANGUAGES = new Set(["de", "en", "es", "fr", "it", "nl", "pt", "pl", "ru", "sv", "da", "fi", "no", "ja", "zh"]);
// traits.regions are keyed by country; "none" means all regions. A plain
// language maps to its home country, as locales.get_engine_locale does.
const REGION_ALL = "none";
const LANG_HOME: Record<string, string> = { en: "us", de: "de", fr: "fr", es: "es", it: "it", nl: "nl", pt: "pt", pl: "pl", ru: "ru" };

const DELTA: Record<string, (d: Date) => void> = {
  day: (d) => d.setDate(d.getDate() - 1),
  week: (d) => d.setDate(d.getDate() - 7),
  month: (d) => d.setMonth(d.getMonth() - 1),
  year: (d) => d.setFullYear(d.getFullYear() - 1),
};

function ymd(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

function cookiesFor(language: string): { lb: string; arc: string } {
  if (language === "all") return { lb: "", arc: REGION_ALL };
  const [lang, country] = language.split("-");
  return {
    lb: LANGUAGES.has(lang) ? lang : "",
    arc: country ? country.toLowerCase() : (LANG_HOME[lang] ?? REGION_ALL),
  };
}

export const mojeek: Engine = {
  name: "mojeek",
  maxPage: 10,
  shortcut: "mjk",
  categories: ["general"],
  paging: true,
  timeRangeSupport: true,
  safesearch: true,
  disabled: true,
  about: "SearXNG ships this inactive: Mojeek requires solving an ALTCHA proof-of-work captcha.",
  async request(params, ctx) {
    const url = new URL(`${BASE_URL}/search`);
    url.searchParams.set("q", params.query);
    url.searchParams.set("safe", String(Math.min(params.safesearch, 1)));
    // setting the page number on the first page (s=0) triggers a rate-limit
    if (params.pageno > 1) url.searchParams.set("s", String(10 * (params.pageno - 1)));
    if (params.timeRange) {
      const d = new Date();
      DELTA[params.timeRange](d);
      url.searchParams.set("since", ymd(d));
    }
    return {
      url: url.href,
      cookies: { ...cookiesFor(params.language), chllg: await captchaToken(ctx) },
    };
  },

  response(resp) {
    const doc = parseHtml(resp.text);
    const results: EngineResult[] = [];
    // //ul[@class="results-standard"]/li/a[@class="ob"]
    for (const a of doc.querySelectorAll('ul[class="results-standard"] > li > a[class="ob"]')) {
      const li = a.parentNode;
      const titleA = li.querySelectorAll("h2 > a").find((x) => x.parentNode.parentNode === li);
      results.push({
        url: a.getAttribute("href") ?? "",
        title: extractText(titleA),
        content: extractText(li.querySelector('p[class="s"]')),
      });
    }
    return results;
  },
};

interface AltchaChallenge {
  parameters: {
    algorithm: string;
    cost: number;
    keyLength: number;
    keyPrefix: string;
    nonce: string;
    salt: string;
  };
  [k: string]: unknown;
}

async function captchaToken(ctx: EngineContext): Promise<string> {
  const hit = ctx.memo.get(TOKEN_KEY);
  if (hit && hit.expires > Date.now()) return hit.value;

  const challenge = (await (await ctx.fetch(`${BASE_URL}/captcha/challenge`)).json()) as AltchaChallenge;
  const solution = await solveAltcha(challenge.parameters);
  if (!solution) throw new EngineError("http", "failed to solve CAPTCHA");

  const payload = {
    challenge,
    solution: { counter: solution.counter, derivedKey: solution.key, time: 100 + Math.floor(Math.random() * 101) },
  };
  const body = new FormData();
  body.append("altcha", btoa(JSON.stringify(payload)));
  const resp = await ctx.fetch(`${BASE_URL}/captcha/verify`, { method: "POST", body, redirect: "manual" });
  const token = resp.headers
    .getSetCookie()
    .map((c) => /^chllg=([^;]*)/.exec(c)?.[1])
    .find(Boolean);
  if (!token) throw new EngineError("http", `captcha verify returned no chllg cookie (HTTP ${resp.status})`);
  ctx.memo.set(TOKEN_KEY, { value: token, expires: Date.now() + TOKEN_TTL_MS });
  return token;
}

const hexToBytes = (h: string) => new Uint8Array(h.match(/../g)!.map((b) => parseInt(b, 16)));
const bytesToHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

/** Port of searx.utils.solve_altcha: PBKDF2 until the key starts with keyPrefix. */
export async function solveAltcha(
  p: AltchaChallenge["parameters"],
  maxCounter = 1000,
): Promise<{ key: string; counter: number } | null> {
  const nonce = hexToBytes(p.nonce);
  const salt = hexToBytes(p.salt);
  const prefix = hexToBytes(p.keyPrefix);
  const hash = p.algorithm.split("/").pop()!.toUpperCase(); // "SHA-256"
  const secret = new Uint8Array(nonce.length + 4);
  secret.set(nonce);
  for (let counter = 0; counter < maxCounter; counter++) {
    new DataView(secret.buffer).setUint32(nonce.length, counter);
    const material = await crypto.subtle.importKey("raw", secret, "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash, salt, iterations: p.cost },
      material,
      p.keyLength * 8,
    );
    const key = new Uint8Array(bits);
    if (prefix.every((b, i) => key[i] === b)) return { key: bytesToHex(key), counter };
  }
  return null;
}

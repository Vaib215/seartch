// Port of searx/engines/startpage.py (startpage_categ "web")
// Simplified: web category only (no news/images); language/region from a small
// hard-coded map instead of engine_traits; sc code and Anubis auth cached per
// isolate (ctx.memo) instead of EngineCache. When the *search* response is an
// Anubis challenge, Python solves it and re-POSTs; response() has no ctx/fetch
// here, so it raises EngineCaptcha instead (the homepage pre-fetch in request()
// still solves Anubis and caches the auth cookie for later searches).
//.

import { htmlToText, parseHtml } from "../html";
import { CHROME_UA } from "../http";
import { type Engine, type EngineContext, type EngineResult, EngineCaptcha } from "../types";

const BASE_URL = "https://www.startpage.com";
const SEARCH_URL = `${BASE_URL}/sp/search`;
const SC_CODE_TTL_MS = 3600_000;
const AUTH_TTL_MS = 240_000;
const MAX_DIFFICULTY = 4;

const TIME_RANGE: Record<string, string> = { day: "d", week: "w", month: "m", year: "y" };
const SAFESEARCH: Record<number, string> = { 0: "none", 1: "moderate", 2: "heavy" };

// traits.languages (subset)
const LANGUAGES: Record<string, string> = {
  en: "english", de: "deutsch", fr: "francais", es: "espanol", it: "italiano", nl: "nederlands",
  pt: "portugues", ja: "nihongo", zh: "jiantizhongwen", ru: "russian", pl: "polski", sv: "svenska",
  da: "dansk", fi: "suomi", ko: "hangul", tr: "turkce",
};
// traits.regions (subset)
const REGIONS: Record<string, string> = {
  "en-US": "en_US", "en-GB": "en-GB_GB", "en-CA": "en_CA", "en-AU": "en_AU", "en-IN": "en_IN",
  "de-DE": "de_DE", "de-AT": "de_AT", "de-CH": "de_CH", "fr-FR": "fr_FR", "fr-CA": "fr_CA",
  "es-ES": "es_ES", "es-MX": "es_MX", "it-IT": "it_IT", "nl-NL": "nl_NL", "pt-BR": "pt-BR_BR",
  "ja-JP": "ja_JP", "zh-CN": "zh-CN_CN", "ru-RU": "ru_RU",
};

function engineLanguage(language: string): string {
  return LANGUAGES[language.split("-")[0]] ?? "english";
}

function engineRegion(language: string): string {
  const lang = language.split("-")[0];
  const home = `${lang}-${lang === "en" ? "US" : lang.toUpperCase()}`;
  return REGIONS[language] ?? REGIONS[home] ?? "en_US";
}

const BROWSER_HEADERS = {
  "user-agent": CHROME_UA,
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
};

export const startpage: Engine = {
  name: "startpage",
  maxPage: 18,
  shortcut: "sp",
  categories: ["general"],
  paging: true,
  timeRangeSupport: true,
  safesearch: true,
  disabled: true,
  about: "SearXNG ships this inactive: Startpage requires solving an Anubis proof-of-work captcha.",
  async request(params, ctx) {
    const language = engineLanguage(params.language);
    const region = engineRegion(params.language);
    const safe = SAFESEARCH[params.safesearch];

    const form: Record<string, string> = {
      query: params.query,
      cat: "web",
      t: "device",
      sc: await getScCode(ctx),
      with_date: params.timeRange ? TIME_RANGE[params.timeRange] : "",
      abd: "1",
      abe: "1",
      qsr: "all",
      qadf: safe,
      language,
      lui: language,
      segment: "startpage.udog",
    };
    if (params.pageno > 1) form.page = String(params.pageno);

    const prefs: [string, string][] = [
      ["date_time", "world"],
      ["disable_family_filter", safe],
      ["disable_open_in_new_window", "0"],
      ["enable_post_method", "1"],
      ["enable_proxy_safety_suggest", "1"],
      ["enable_stay_control", "1"],
      ["instant_answers", "1"],
      ["lang_homepage", "s/device/en/"],
      ["num_of_results", "10"],
      ["suggestions", "1"],
      ["wt_unit", "celsius"],
      ["language", language],
      ["language_ui", language],
      ["search_results_region", region],
    ];
    const cookies: Record<string, string> = { preferences: prefs.map(([k, v]) => `${k}EEE${v}`).join("N1N") };
    const auth = memoGet(ctx, "startpage:auth");
    if (auth) cookies["spchal-auth"] = auth;

    return {
      url: SEARCH_URL,
      method: "POST",
      headers: { Origin: BASE_URL, Referer: `${BASE_URL}/` },
      form,
      cookies,
      redirect: "manual",
    };
  },

  response(resp) {
    if (resp.text.includes('id="anubis_challenge"')) {
      throw new EngineCaptcha("startpage: Anubis challenge on search");
    }
    const location = resp.headers.get("location") ?? "";
    if (location.startsWith(`${BASE_URL}/sp/captcha`) || resp.url.startsWith(`${BASE_URL}/sp/captcha`)) {
      throw new EngineCaptcha();
    }
    const raw = extr(resp.text, "React.createElement(UIStartpage.AppSerpWeb, {", "}})");
    const json = JSON.parse("{" + raw + "}}");
    const mainline: { display_type?: string; results?: SpWebResult[] }[] =
      json?.render?.presenter?.regions?.mainline ?? [];
    const results: EngineResult[] = [];
    for (const categ of mainline) {
      if (categ.display_type !== "web-google") continue;
      for (const item of categ.results ?? []) results.push(webResult(item));
    }
    return results;
  },
};

interface SpWebResult {
  clickUrl: string;
  title: string;
  description?: string;
}

function webResult(r: SpWebResult): EngineResult {
  const { content, publishedDate } = parsePublishedDate(htmlToText(r.description ?? ""));
  const out: EngineResult = { url: r.clickUrl, title: htmlToText(r.title), content };
  if (publishedDate) out.publishedDate = publishedDate;
  return out;
}

/** "2 Sep 2014 ... text" or "5 days ago ... text" -> date + text. */
export function parsePublishedDate(content: string): { content: string; publishedDate?: string } {
  if (/^([1-9]|[1-2][0-9]|3[0-1]) [A-Z][a-z]{2} [0-9]{4} \.\.\. /.test(content)) {
    const datePos = content.indexOf("...") + 4;
    const dateString = content.slice(0, datePos - 5);
    const t = Date.parse(`${dateString} UTC`);
    return { content: content.slice(datePos), publishedDate: Number.isNaN(t) ? undefined : new Date(t).toISOString() };
  }
  const ago = /^([0-9]+) days? ago \.\.\. /.exec(content);
  if (ago) {
    const datePos = content.indexOf("...") + 4;
    const d = new Date(Date.now() - Number(ago[1]) * 86_400_000);
    return { content: content.slice(datePos), publishedDate: d.toISOString() };
  }
  return { content };
}

function extr(txt: string, begin: string, end: string): string {
  const first = txt.indexOf(begin);
  if (first < 0) return "";
  const stop = txt.indexOf(end, first + begin.length);
  return stop < 0 ? "" : txt.slice(first + begin.length, stop);
}

function memoGet(ctx: EngineContext, key: string): string | undefined {
  const hit = ctx.memo.get(key);
  return hit && hit.expires > Date.now() ? hit.value : undefined;
}

/** get_sc_code(): scrape the `sc` value from the homepage search form, cached for an hour. */
async function getScCode(ctx: EngineContext): Promise<string> {
  const cached = memoGet(ctx, "startpage:sc");
  if (cached) return cached;

  let resp = await ctx.fetch(`${BASE_URL}/`, { headers: BROWSER_HEADERS });
  let text = await resp.text();
  if (text.includes('id="anubis_challenge"')) {
    const auth = await solveAnubis(ctx, resp, text);
    resp = await ctx.fetch(`${BASE_URL}/`, { headers: { ...BROWSER_HEADERS, cookie: `spchal-auth=${auth}` } });
    text = await resp.text();
  }
  if (resp.url.startsWith(`${BASE_URL}/sp/captcha`)) {
    throw new EngineCaptcha(`get_sc_code: got redirected to ${BASE_URL}/sp/captcha`);
  }
  const sc = parseHtml(text).querySelector('form#search input[name="sc"]')?.getAttribute("value");
  if (!sc) throw new EngineCaptcha(`get_sc_code: [PR-695] querying new sc timestamp failed! (${resp.url})`);
  ctx.memo.set("startpage:sc", { value: sc, expires: Date.now() + SC_CODE_TTL_MS });
  return sc;
}

interface AnubisPayload {
  rules: { difficulty: number | string };
  challenge: { id: string; randomData: string };
}

/** _solve_anubis(): SHA-256 proof of work, then trade it for an spchal-auth cookie. */
async function solveAnubis(ctx: EngineContext, resp: Response, text: string): Promise<string> {
  const payload = JSON.parse(
    extr(text, '<script id="anubis_challenge" type="application/json">', "</script>"),
  ) as AnubisPayload;
  const difficulty = Number(payload.rules.difficulty);
  if (difficulty > MAX_DIFFICULTY) throw new EngineCaptcha("startpage: Anubis difficulty too high");

  const solved = await anubisPow(payload.challenge.randomData, difficulty);
  if (!solved) throw new EngineCaptcha("startpage: Anubis failed");

  const url = new URL(`${BASE_URL}/.within.website/x/cmd/anubis/api/pass-challenge`);
  url.searchParams.set("id", payload.challenge.id);
  url.searchParams.set("response", solved.digest);
  url.searchParams.set("nonce", String(solved.nonce));
  url.searchParams.set("redir", resp.url);
  url.searchParams.set("elapsedTime", "1");
  const cookie = resp.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const pass = await ctx.fetch(url.href, { headers: { ...BROWSER_HEADERS, cookie }, redirect: "manual" });
  const auth = pass.headers
    .getSetCookie()
    .map((c) => /^spchal-auth=([^;]*)/.exec(c)?.[1])
    .find(Boolean);
  if (!auth) throw new EngineCaptcha("startpage: Anubis pass-challenge failed");
  ctx.memo.set("startpage:auth", { value: auth, expires: Date.now() + AUTH_TTL_MS });
  return auth;
}

export async function anubisPow(
  randomData: string,
  difficulty: number,
): Promise<{ digest: string; nonce: number } | null> {
  const prefix = "0".repeat(difficulty);
  const enc = new TextEncoder();
  // max search is 8x the average search
  for (let nonce = 0; nonce < 16 ** difficulty * 8; nonce++) {
    const buf = await crypto.subtle.digest("SHA-256", enc.encode(randomData + nonce));
    const digest = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (digest.startsWith(prefix)) return { digest, nonce };
  }
  return null;
}

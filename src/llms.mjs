// llms.ink API (https://llms.ink/docs/): GET /api/v0/llms, GET and POST /api/v0/check, GET /api/v0/report.

export const API = 'https://llms.ink/api/v0';
export const USER_AGENT = 'llms-txt-action (+https://github.com/lukax/llms-txt-action)';
const RETRY = new Set([408, 429, 500, 502, 503, 504]);
const TIMEOUT = 300_000;

export class LlmsInkError extends Error {
  constructor(status, detail, code) {
    super(detail);
    this.status = status;
    this.code = code;
  }
}

/**
 * GET (or POST `body` as text/markdown) with the same retry policy the composite action had with curl --retry 2: up to two more tries on timeouts,
 * network errors, 408, 429 and 5xx, waiting Retry-After (capped at a minute) or 1s, then 2s.
 */
async function request(path, params, { fetch, apiKey, sleep, api = API, source }, body) {
  const url = new URL(`${api}/${path}`);
  for (const [k, v] of Object.entries({ ...params, source })) if (v !== undefined) url.searchParams.set(k, v);
  const headers = { 'User-Agent': USER_AGENT, Accept: 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (body !== undefined) headers['Content-Type'] = 'text/markdown; charset=utf-8';
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { method: body === undefined ? 'GET' : 'POST', headers, body, signal: AbortSignal.timeout(TIMEOUT) });
    } catch (err) {
      if (attempt < 2) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      throw new LlmsInkError(0, `Couldn’t reach llms.ink: ${err.message}`);
    }
    if (res.ok) return res.json();
    if (RETRY.has(res.status) && attempt < 2) {
      const after = Number(res.headers.get('retry-after'));
      await sleep(after > 0 ? Math.min(after, 60) * 1000 : 1000 * 2 ** attempt);
      continue;
    }
    const raw = await res.text();
    let problem = {};
    try {
      problem = JSON.parse(raw);
    } catch {}
    throw new LlmsInkError(res.status, problem.detail || problem.title || `HTTP ${res.status} from llms.ink`, problem.code);
  }
}

/**
 * llms.txt (`mode: 'llms'`) or llms-full.txt (`mode: 'full'`) for a link.
 * `generated` sends native=0: always generate, never copy the site's own file (for sites whose /llms.txt is
 * served from llms.ink).
 */
export function generate(url, { mode = 'llms', fresh = false, generated = false }, deps) {
  return request('llms', { url, mode, fresh: fresh ? '1' : '0', native: generated ? '0' : undefined }, deps);
}

/** The checker: format issues and broken links of the llms.txt the site publishes. */
export function check(url, deps) {
  return request('check', { url }, deps);
}

/**
 * The checker on llms.txt text (POST /api/v0/check): `base` resolves relative links; `links` also checks up to 25
 * linked URLs and llms-full.txt next to `base`.
 */
export function checkText(text, { base, links = false }, deps) {
  return request('check', { base: base || undefined, links: links ? '1' : '0' }, deps, text);
}

/** Whether a check result should fail the job: any error, or any broken link. */
export const checkFailed = (result) => result.summary.errors > 0 || result.links.broken.length > 0 || !result.found;

/** The agent's-eye report (GET /api/v0/report): `summary` counts and `sections` of checks with their fixes. */
export function report(url, deps) {
  return request('report', { url }, deps);
}

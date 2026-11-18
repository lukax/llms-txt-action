// In-memory llms.ink API and GitHub REST API, as a fetch function (unit tests) or an HTTP server (harness).

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

export const LLMS_API = 'https://llms.mock/api/v0';
export const GITHUB_API = 'https://github.mock';
export const REPO = 'acme/site';

export const LLMS_TXT = `# Acme

> Acme makes things.

## Docs

- [Start](https://acme.test/start): Getting started
- [API](https://acme.test/api): The API

<!-- Generated with https://llms.ink -->
`;

export const SITE = 'https://acme.test';
export const INDEXNOW_API = 'https://indexnow.mock/indexnow';
export const INDEXNOW_KEY = 'a1b2c3d4e5f6';

/** An agent's-eye report (GET /api/v0/report) with one check per interesting case. */
export const REPORT = {
  url: 'https://acme.test/',
  site: 'https://acme.test',
  checkedAt: '2026-11-14T00:00:00Z',
  summary: { pass: 2, warn: 3, fail: 1, info: 1 },
  sections: [
    {
      id: 'access',
      title: 'Access',
      checks: [
        {
          id: 'robots-oai-searchbot',
          status: 'fail',
          title: 'OAI-SearchBot blocked by robots.txt',
          detail: 'robots.txt disallows / for OAI-SearchBot | ChatGPT search can’t cite you.',
          evidence: 'User-agent: OAI-SearchBot\nDisallow: /',
          fix: { kind: 'robots', summary: 'Allow OAI-SearchBot, keep GPTBot (training) blocked.', patch: { file: 'robots.txt', content: 'User-agent: GPTBot\nDisallow: /\n\nUser-agent: OAI-SearchBot\nAllow: /\n' } },
        },
        { id: 'probe-claudebot', status: 'pass', title: 'ClaudeBot gets the page', detail: '200 with the same HTML.' },
      ],
    },
    {
      id: 'agent-files',
      title: 'Agent files',
      checks: [
        {
          id: 'vary-accept',
          status: 'warn',
          title: 'No Vary: Accept',
          detail: 'Markdown negotiation without Vary: Accept can be cached for browsers.',
          fix: { kind: 'headers', summary: 'Add Vary: Accept to pages.', patch: { file: '/_headers', content: '/*\n  Vary: Accept' } },
        },
        {
          id: 'llms-txt',
          status: 'warn',
          title: 'llms.txt is stale',
          detail: '3 links answer 404.',
          fix: { kind: 'llms-txt', summary: 'Regenerate llms.txt.', patch: { file: 'llms.txt', content: '# Acme\n\n> Acme makes things.\n' } },
        },
        {
          id: 'md-urls',
          status: 'warn',
          title: 'No .md versions',
          detail: '/docs.md answers 404.',
          fix: { kind: 'markdown', summary: 'Serve .md pages with the build plugin.', patch: { file: 'astro.config.mjs', content: 'export default {}' } },
        },
        { id: 'ard', status: 'info', title: 'No ard.json', detail: 'Optional; few readers yet.' },
        { id: 'llms-found', status: 'pass', title: 'llms.txt found', detail: 'https://acme.test/llms.txt' },
      ],
    },
  ],
};

const sha = (v) => createHash('sha1').update(JSON.stringify(v)).digest('hex');
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const problem = (status, code, detail) => json(status, { type: 'https://llms.ink/docs/#errors', title: 'Error', status, code, detail });

/**
 * @param {{ files?: Record<string,string>, branches?: Record<string, Record<string,string>> }} [repo]
 *   files on main, or files per branch
 */
export function mockApi(repo = {}) {
  const state = {
    llms: { text: LLMS_TXT, source: 'generated', pages: 2 },
    full: { text: `${LLMS_TXT}\n---\n\n# Start\n\nHello.\n`, source: 'generated', pages: 1 },
    check: {
      site: 'https://acme.test',
      url: 'https://acme.test/llms.txt',
      found: true,
      status: 200,
      title: 'Acme',
      tokens: 40,
      sections: 1,
      links: { total: 2, checked: 2, broken: [] },
      llmsFull: false,
      issues: [],
      summary: { errors: 0, warnings: 0 },
      checkedAt: '2026-11-14T00:00:00Z',
      parsed: {
        title: 'Acme',
        summary: 'Acme makes things.',
        details: null,
        sections: [
          {
            name: 'Docs',
            optional: false,
            text: null,
            links: [
              { title: 'Start', url: 'https://acme.test/start', notes: 'Getting started', line: 7 },
              { title: 'API', url: 'https://acme.test/api', notes: 'The API', line: 8 },
            ],
          },
        ],
      },
    },
    /** When set, answers POST /check: (body, query) => Response. */
    checkPost: null,
    /** Responses to serve before the normal one for /llms, e.g. [{ status: 503 }]. */
    llmsFailures: [],
    /** When set, POST /pulls answers 403 with this message. */
    forbidPulls: null,
    forbidComments: false,
    report: REPORT,
    /** Site files served at SITE: path → { status, body }. */
    site: {
      [`/${INDEXNOW_KEY}.txt`]: { status: 200, body: `${INDEXNOW_KEY}\n` },
      '/sitemap.xml': {
        status: 200,
        body: '<?xml version="1.0"?><sitemapindex><sitemap><loc>https://acme.test/sitemap-0.xml</loc></sitemap></sitemapindex>',
      },
      '/sitemap-0.xml': {
        status: 200,
        body: `<urlset>${['/', '/docs/', '/docs/intro/', '/blog/hello/', '/pricing', '/about'].map((p) => `<url><loc>https://acme.test${p}</loc></url>`).join('')}</urlset>`,
      },
    },
    /** Bodies POSTed to IndexNow, and the status it answers. */
    indexnow: [],
    indexnowStatus: 200,
    trees: new Map(),
    commits: new Map(),
    refs: new Map(),
    pulls: [],
    /** Tracking issues (POST /issues); a pull request listed here would carry `pull_request`. */
    issues: [],
    /** When set, issue writes answer 403. */
    forbidIssues: false,
    comments: new Map(),
    nextId: 1,
  };
  const calls = [];

  const putTree = (files) => {
    const s = sha(Object.entries(files).sort());
    state.trees.set(s, { ...files });
    return s;
  };
  const putCommit = (tree, parents, message) => {
    const s = sha([tree, parents, message, state.commits.size]);
    state.commits.set(s, { tree, parents, message });
    return s;
  };
  for (const [branch, files] of Object.entries(repo.branches ?? { main: repo.files ?? {} })) {
    state.refs.set(branch, putCommit(putTree(files), [], 'init'));
  }
  const filesAt = (branch) => state.trees.get(state.commits.get(state.refs.get(branch)).tree);

  async function handle(method, url, body, headers) {
    const u = new URL(url);
    const p = u.pathname;
    const q = Object.fromEntries(u.searchParams);
    calls.push({ method, path: p, query: q, body, headers });

    if (url.startsWith(LLMS_API)) {
      if (headers.authorization === 'Bearer lk_bad') return problem(401, 'invalid_key', 'That API key isn’t valid.');
      if (p.endsWith('/llms')) {
        const fail = state.llmsFailures.shift();
        if (fail) return problem(fail.status, fail.code ?? 'error', fail.detail ?? `HTTP ${fail.status}`);
        const r = q.mode === 'full' ? state.full : state.llms;
        return json(200, { url: q.url, kind: 'site', mode: q.mode, title: 'Acme', tokens: Math.ceil(r.text.length / 4), model: null, cached: q.fresh !== '1', generatedAt: '2026-11-14T00:00:00Z', ...r });
      }
      if (p.endsWith('/check') && method === 'POST') {
        if (state.checkPost) return state.checkPost(body, q);
        return json(200, { ...state.check, site: q.base ?? null, url: q.base ? new URL('/llms.txt', q.base).href : null, llmsFull: q.links === '1' && q.base ? false : null });
      }
      if (p.endsWith('/check')) return json(200, state.check);
      if (p.endsWith('/report')) return state.report ? json(200, { ...state.report, url: state.report.url ?? q.url }) : problem(404, 'not_found', 'No such endpoint');
      return problem(404, 'not_found', 'No such endpoint');
    }
    if (url.startsWith(INDEXNOW_API)) {
      state.indexnow.push(body);
      return new Response('', { status: state.indexnowStatus });
    }
    if (url.startsWith(SITE)) {
      const f = state.site[p];
      return f ? new Response(f.body, { status: f.status }) : new Response('Not found', { status: 404 });
    }

    const m = p.match(/^\/repos\/[^/]+\/[^/]+(.*)$/);
    if (!m) return json(404, { message: 'Not Found' });
    const r = m[1];
    let x;
    if (method === 'GET' && r === '') return json(200, { full_name: REPO, default_branch: 'main' });
    if (method === 'GET' && (x = r.match(/^\/git\/ref\/heads\/(.+)$/))) {
      const s = state.refs.get(decodeURIComponent(x[1]));
      return s ? json(200, { ref: `refs/heads/${x[1]}`, object: { sha: s, type: 'commit' } }) : json(404, { message: 'Not Found' });
    }
    if (method === 'GET' && (x = r.match(/^\/commits\/(\w+)$/))) {
      const c = state.commits.get(x[1]);
      if (!c) return json(404, { message: 'Not Found' });
      const now = state.trees.get(c.tree);
      const was = c.parents.length ? state.trees.get(state.commits.get(c.parents[0]).tree) : {};
      const names = new Set([...Object.keys(now), ...Object.keys(was)]);
      return json(200, { sha: x[1], files: [...names].filter((n) => now[n] !== was[n]).map((filename) => ({ filename })) });
    }
    if (method === 'GET' && (x = r.match(/^\/contents\/(.+)$/))) {
      const files = state.refs.has(q.ref) ? filesAt(q.ref) : null;
      const content = files?.[decodeURIComponent(x[1])];
      return content == null ? json(404, { message: 'Not Found' }) : new Response(content, { status: 200 });
    }
    if (method === 'GET' && (x = r.match(/^\/git\/commits\/(\w+)$/))) {
      const c = state.commits.get(x[1]);
      return c ? json(200, { sha: x[1], tree: { sha: c.tree }, parents: c.parents.map((s) => ({ sha: s })) }) : json(404, { message: 'Not Found' });
    }
    if (method === 'POST' && r === '/git/trees') {
      const files = { ...state.trees.get(body.base_tree) };
      for (const e of body.tree) {
        if (e.sha === null) delete files[e.path];
        else files[e.path] = e.content;
      }
      return json(201, { sha: putTree(files) });
    }
    if (method === 'GET' && (x = r.match(/^\/git\/trees\/(\w+)$/))) {
      const files = state.trees.get(x[1]);
      if (!files) return json(404, { message: 'Not Found' });
      const blob = (c) => createHash('sha1').update(`blob ${Buffer.byteLength(c)}\0`).update(c).digest('hex');
      return json(200, { sha: x[1], tree: Object.entries(files).map(([path, c]) => ({ path, type: 'blob', mode: '100644', sha: blob(c) })), truncated: false });
    }
    if (method === 'POST' && r === '/git/commits') return json(201, { sha: putCommit(body.tree, body.parents, body.message) });
    if (method === 'PATCH' && (x = r.match(/^\/git\/refs\/heads\/(.+)$/))) {
      const branch = decodeURIComponent(x[1]);
      const cur = state.refs.get(branch);
      if (!cur) return json(422, { message: 'Reference does not exist' });
      if (!body.force && !state.commits.get(body.sha).parents.includes(cur)) return json(422, { message: 'Update is not a fast forward' });
      state.refs.set(branch, body.sha);
      return json(200, { object: { sha: body.sha } });
    }
    if (method === 'POST' && r === '/git/refs') {
      const branch = body.ref.replace('refs/heads/', '');
      if (state.refs.has(branch)) return json(422, { message: 'Reference already exists' });
      state.refs.set(branch, body.sha);
      return json(201, { ref: body.ref, object: { sha: body.sha } });
    }
    if (method === 'GET' && r === '/pulls') {
      return json(200, state.pulls.filter((pr) => pr.state === q.state && `acme:${pr.head}` === q.head && pr.base === q.base));
    }
    if (method === 'POST' && r === '/pulls') {
      if (state.forbidPulls) return json(403, { message: state.forbidPulls });
      const pr = { number: 100 + state.pulls.length, state: 'open', head: body.head, base: body.base, title: body.title, body: body.body };
      pr.html_url = `https://github.com/${REPO}/pull/${pr.number}`;
      state.pulls.push(pr);
      return json(201, pr);
    }
    if (method === 'PATCH' && (x = r.match(/^\/pulls\/(\d+)$/))) {
      const pr = state.pulls.find((y) => y.number === Number(x[1]));
      Object.assign(pr, body);
      return json(200, pr);
    }
    if (r === '/issues') {
      if (method === 'GET') return json(200, state.issues.filter((i) => i.state === q.state && i.labels.includes(q.labels)));
      if (state.forbidIssues) return json(403, { message: 'Resource not accessible by integration' });
      const issue = { number: 300 + state.issues.length, state: 'open', title: body.title, body: body.body, labels: body.labels, html_url: `https://github.com/${REPO}/issues/${300 + state.issues.length}` };
      state.issues.push(issue);
      return json(201, issue);
    }
    if (method === 'PATCH' && (x = r.match(/^\/issues\/(\d+)$/))) {
      const issue = state.issues.find((y) => y.number === Number(x[1]));
      if (!issue) return json(404, { message: 'Not Found' });
      Object.assign(issue, body);
      return json(200, issue);
    }
    if ((x = r.match(/^\/issues\/(\d+)\/comments$/))) {
      const list = state.comments.get(Number(x[1])) ?? [];
      if (method === 'GET') {
        const per = Number(q.per_page ?? 30);
        const page = Number(q.page ?? 1);
        return json(200, list.slice((page - 1) * per, page * per));
      }
      if (state.forbidComments) return json(403, { message: 'Resource not accessible by integration' });
      const c = { id: state.nextId++, body: body.body, html_url: `https://github.com/${REPO}/pull/${x[1]}#issuecomment-${state.nextId}` };
      state.comments.set(Number(x[1]), [...list, c]);
      return json(201, c);
    }
    if (method === 'PATCH' && (x = r.match(/^\/issues\/comments\/(\d+)$/))) {
      for (const list of state.comments.values()) {
        const c = list.find((y) => y.id === Number(x[1]));
        if (c) {
          c.body = body.body;
          return json(200, c);
        }
      }
      return json(404, { message: 'Not Found' });
    }
    return json(404, { message: `Not Found: ${method} ${r}` });
  }

  const fetch = async (url, init = {}) => {
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return handle(init.method ?? 'GET', String(url), init.body && !/^text\//.test(headers['content-type'] ?? '') ? JSON.parse(init.body) : init.body, headers);
  };

  return { fetch, calls, state, filesAt, writes: () => calls.filter((c) => c.method !== 'GET') };
}

/**
 * Serve a mock over HTTP for subprocess runs: llms.ink at <origin>/api/v0, GitHub at <origin>/repos/….
 * @returns {Promise<{ origin: string, close: () => void }>}
 */
export function serve(mock) {
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const origin = req.url.startsWith('/api/v0') ? new URL(LLMS_API).origin : GITHUB_API;
    const r = await mock.fetch(`${origin}${req.url}`, { method: req.method, headers: req.headers, body: raw || undefined });
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  return new Promise((ok) =>
    server.listen(0, '127.0.0.1', () => ok({ origin: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })),
  );
}

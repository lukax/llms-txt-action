// The AEO-era modes: aeo (+ autofix), indexnow and context, against the in-memory llms.ink, GitHub, site and IndexNow.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AEO_BRANCH, CONTEXT_BRANCH, run } from '../src/action.mjs';
import { aeoFailed, fixFiles, reportMarkdown } from '../src/aeo.mjs';
import { blobSha, contextArgs } from '../src/context.mjs';
import { changedUrls, parseUrls, sitemapUrls } from '../src/indexnow.mjs';
import { GITHUB_API, INDEXNOW_API, INDEXNOW_KEY, LLMS_API, mockApi, REPO, REPORT } from './mock.mjs';

function setup(inputs = {}, { repo, event, env: extra, exec } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'llms-action-modes-'));
  const ws = join(dir, 'ws');
  mkdirSync(ws);
  const env = {
    GITHUB_WORKSPACE: ws,
    GITHUB_OUTPUT: join(dir, 'output'),
    GITHUB_STEP_SUMMARY: join(dir, 'summary'),
    GITHUB_REPOSITORY: REPO,
    GITHUB_API_URL: GITHUB_API,
    GITHUB_REF: 'refs/heads/main',
    GITHUB_EVENT_NAME: 'push',
    LLMS_INK_API: LLMS_API,
    INDEXNOW_API,
    INPUT_URL: 'https://acme.test',
    INPUT_TOKEN: 'ghs_test',
    ...extra,
  };
  for (const [k, v] of Object.entries(inputs)) env[`INPUT_${k.toUpperCase().replace(/-/g, '_')}`] = v;
  if (event) {
    env.GITHUB_EVENT_NAME = event.name;
    env.GITHUB_EVENT_PATH = join(dir, 'event.json');
    writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify(event.payload));
  }
  const mock = mockApi(repo);
  const go = async () => {
    let stdout = '';
    if (existsSync(env.GITHUB_STEP_SUMMARY)) rmSync(env.GITHUB_STEP_SUMMARY);
    const r = await run({ env, fetch: mock.fetch, sleep: async () => {}, stdout: (s) => (stdout += s), exec });
    return { ...r, stdout, summary: existsSync(env.GITHUB_STEP_SUMMARY) ? readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8') : '' };
  };
  return { env, ws, mock, go };
}

const pr = (number) => ({ name: 'pull_request', payload: { pull_request: { number } } });
const ghWrites = (mock) => mock.writes().filter((c) => c.path.startsWith('/repos'));

/* ── aeo ─────────────────────────────────────────────────────────────────── */

test('aeo: calls GET /api/v0/report, annotates fail and warn checks, summary table, outputs, fails on a fail', async () => {
  const t = setup({ mode: 'aeo', 'api-key': 'lk_k' });
  const r = await t.go();
  assert.equal(r.ok, false);
  const call = t.mock.calls.find((c) => c.path === '/api/v0/report');
  assert.deepEqual(call.query, { url: 'https://acme.test' });
  assert.equal(call.headers.authorization, 'Bearer lk_k');
  assert.equal(r.outputs['aeo-fail'], '1');
  assert.equal(r.outputs['aeo-warn'], '3');
  assert.match(r.stdout, /^::error title=Access%3A OAI-SearchBot blocked by robots.txt::robots.txt disallows .* Fix: Allow OAI-SearchBot/m);
  assert.match(r.stdout, /^::warning title=Agent files%3A No Vary%3A Accept::/m);
  assert.doesNotMatch(r.stdout, /ClaudeBot gets the page::/, 'passes are not annotated');
  assert.match(r.summary, /### Agent's-eye view of https:\/\/acme\.test\//);
  assert.match(r.summary, /\*\*1 failed\*\* · ⚠️ \*\*3 warnings\*\*/);
  assert.match(r.summary, /\[full report\]\(https:\/\/llms\.ink\/report\/\?url=https%3A%2F%2Facme\.test%2F\)/);
  // Pipes in details are escaped; the fail row comes before the warnings.
  assert.match(r.summary, /disallows \/ for OAI-SearchBot \\\| ChatGPT/);
  assert.ok(r.summary.indexOf('OAI-SearchBot blocked') < r.summary.indexOf('No Vary'));
  assert.match(r.summary, /<details><summary>Passed and notes<\/summary>[\s\S]*ClaudeBot gets the page/);
  assert.equal(ghWrites(t.mock).length, 0, 'no PR event, no autofix: nothing written to GitHub');
});

test('aeo: aeo-fail-on warn / none; an unknown value is an error', async () => {
  const report = (summary) => ({ ...REPORT, summary });
  const t = setup({ mode: 'aeo', 'aeo-fail-on': 'warn' });
  t.mock.state.report = report({ pass: 3, warn: 1, fail: 0, info: 0 });
  assert.equal((await t.go()).ok, false);
  t.mock.state.report = report({ pass: 3, warn: 0, fail: 0, info: 2 });
  assert.equal((await t.go()).ok, true);

  const none = setup({ mode: 'aeo', 'aeo-fail-on': 'none' });
  const r = await none.go();
  assert.equal(r.ok, true);
  assert.doesNotMatch(r.stdout, /^::error/m, 'report-only: fails are warnings');
  assert.match(r.stdout, /^::warning title=Access%3A OAI-SearchBot/m);

  const bad = await setup({ mode: 'aeo', 'aeo-fail-on': 'sometimes' }).go();
  assert.equal(bad.ok, false);
  assert.match(bad.stdout, /aeo-fail-on` must be one of fail, warn, none/);
});

test('aeo: one sticky comment per url on pull requests, updated in place; a token that can’t comment only warns', async () => {
  const t = setup({ mode: 'aeo', 'aeo-fail-on': 'none' }, { event: pr(7) });
  await t.go();
  await t.go();
  const comments = t.mock.state.comments.get(7);
  assert.equal(comments.length, 1);
  assert.match(comments[0].body, /^<!-- llms-txt-action:aeo:https:\/\/acme\.test -->\n### Agent's-eye view/);
  t.mock.state.report = { ...REPORT, summary: { pass: 9, warn: 0, fail: 0, info: 0 }, sections: [] };
  await t.go();
  assert.equal(t.mock.state.comments.get(7).length, 1);
  assert.match(t.mock.state.comments.get(7)[0].body, /No failures or warnings/);

  const forbidden = setup({ mode: 'aeo', 'aeo-fail-on': 'none' }, { event: pr(8) });
  forbidden.mock.state.forbidComments = true;
  const r = await forbidden.go();
  assert.equal(r.ok, true);
  assert.match(r.stdout, /::warning title=llms.ink::Couldn’t comment on #8/);
});

test('aeo issue: one tracking issue off pull requests, updated in place, closed when the report is clean; never on a PR', async () => {
  const t = setup({ mode: 'aeo', issue: 'true', 'aeo-fail-on': 'none' });
  const first = await t.go();
  await t.go();
  const { issues } = t.mock.state;
  assert.equal(issues.length, 1);
  assert.equal(issues[0].state, 'open');
  assert.deepEqual(issues[0].labels, ['llms-ink']);
  assert.match(issues[0].title, /^AI agents can’t fully read acme\.test: 1 failed, 3 warnings$/);
  assert.match(issues[0].body, /^<!-- llms-txt-action:aeo:https:\/\/acme\.test -->\n### Agent's-eye view/);
  assert.equal(first.outputs['issue-url'], issues[0].html_url);

  t.mock.state.report = { ...REPORT, summary: { pass: 9, warn: 2, fail: 0, info: 0 } };
  await t.go();
  assert.equal(issues[0].state, 'closed', 'warnings alone don’t keep it open unless aeo-fail-on is warn');
  assert.match(t.mock.state.comments.get(issues[0].number)[0].body, /^Every check passes now/);
  await t.go();
  assert.equal(issues.length, 1, 'a clean report opens nothing');

  const warned = setup({ mode: 'aeo', issue: 'true', 'aeo-fail-on': 'warn' });
  warned.mock.state.report = { ...REPORT, summary: { pass: 9, warn: 2, fail: 0, info: 0 } };
  await warned.go();
  assert.equal(warned.mock.state.issues.length, 1);

  const onPull = setup({ mode: 'aeo', issue: 'true', 'aeo-fail-on': 'none' }, { event: pr(9) });
  await onPull.go();
  assert.equal(onPull.mock.state.issues.length, 0);

  const forbidden = setup({ mode: 'aeo', issue: 'true', 'aeo-fail-on': 'none' });
  forbidden.mock.state.forbidIssues = true;
  const r = await forbidden.go();
  assert.equal(r.ok, true);
  assert.match(r.stdout, /::warning title=llms.ink::Couldn’t update the tracking issue/);
});

test('aeo: a report error (e.g. not deployed yet: 404) fails with the problem detail', async () => {
  const t = setup({ mode: 'aeo' });
  t.mock.state.report = null;
  const r = await t.go();
  assert.equal(r.ok, false);
  assert.match(r.stdout, /::error title=llms.ink \(404\)::No such endpoint/);
  assert.match(r.summary, /### Agent's-eye view of https:\/\/acme\.test\n\nFailed: No such endpoint/);
});

test('aeo autofix: opens a PR applying only robots/headers/llms-txt patches, in public/ next to the existing files', async () => {
  const t = setup({ mode: 'aeo', autofix: 'true', 'aeo-fail-on': 'none' }, { repo: { files: { 'public/robots.txt': 'User-agent: *\nDisallow: /\n', 'src/index.html': '<p>hi</p>' } } });
  const r = await t.go();
  assert.equal(r.ok, true);
  assert.equal(r.outputs.changed, 'true');
  assert.equal(r.outputs['pr-url'], `https://github.com/${REPO}/pull/100`);
  const files = t.mock.filesAt(AEO_BRANCH);
  assert.equal(files['public/robots.txt'], 'User-agent: GPTBot\nDisallow: /\n\nUser-agent: OAI-SearchBot\nAllow: /\n');
  assert.equal(files['public/_headers'], '/*\n  Vary: Accept\n', 'a trailing newline is added');
  assert.equal(files['public/llms.txt'], '# Acme\n\n> Acme makes things.\n');
  assert.equal(files['astro.config.mjs'], undefined, 'markdown-kind fixes are never applied');
  assert.equal(files['src/index.html'], '<p>hi</p>');
  const [p] = t.mock.state.pulls;
  assert.equal(p.head, AEO_BRANCH);
  assert.equal(p.base, 'main');
  assert.equal(p.title, 'Fix agent access (llms.ink report)');
  assert.match(p.body, /- `public\/robots.txt` — Allow OAI-SearchBot/);
  assert.match(p.body, /Only robots.txt, `_headers` and llms.txt files are ever changed/);

  // Same report again: the branch already holds the fixes; the PR is updated, not duplicated.
  const before = t.mock.state.commits.size;
  const again = await t.go();
  assert.equal(again.outputs['pr-url'], p.html_url);
  assert.equal(t.mock.state.pulls.length, 1);
  assert.equal(t.mock.state.commits.size, before, 'no new commit for the same fixes');
});

test('aeo autofix: nothing to change when main has the fixes; unsafe patch paths are skipped; autofix-dir wins', async () => {
  const fixed = { 'robots.txt': 'User-agent: GPTBot\nDisallow: /\n\nUser-agent: OAI-SearchBot\nAllow: /\n', '_headers': '/*\n  Vary: Accept\n', 'llms.txt': '# Acme\n\n> Acme makes things.\n' };
  const t = setup({ mode: 'aeo', autofix: 'true', 'aeo-fail-on': 'none' }, { repo: { files: fixed } });
  const r = await t.go();
  assert.equal(r.outputs.changed, 'false');
  assert.equal(t.mock.state.pulls.length, 0);
  assert.match(r.stdout, /already has every fix/);

  const evil = {
    ...REPORT,
    sections: [{ id: 'access', title: 'Access', checks: [
      { id: 'a', status: 'fail', title: 'Traversal', detail: '', fix: { kind: 'robots', summary: 's', patch: { file: '../../etc/robots.txt', content: 'x' } } },
      { id: 'b', status: 'fail', title: 'Wrong name', detail: '', fix: { kind: 'robots', summary: 's', patch: { file: '.github/workflows/robots.yml', content: 'x' } } },
      { id: 'c', status: 'fail', title: 'Wrong folder', detail: '', fix: { kind: 'headers', summary: 's', patch: { file: 'src/_headers', content: 'x' } } },
      { id: 'd', status: 'fail', title: 'No patch', detail: '', fix: { kind: 'llms-txt', summary: 's' } },
      { id: 'e', status: 'fail', title: 'Good', detail: '', fix: { kind: 'robots', summary: 'Allow bots', patch: { file: 'robots.txt', content: 'User-agent: *\nAllow: /\n' } } },
    ] }],
  };
  const u = setup({ mode: 'aeo', autofix: 'true', 'autofix-dir': 'static', 'aeo-fail-on': 'none', branch: 'bots/fix', 'commit-message': 'Let bots in' });
  u.mock.state.report = evil;
  const ur = await u.go();
  assert.equal(ur.ok, true);
  assert.deepEqual(Object.keys(u.mock.filesAt('bots/fix')).sort(), ['static/robots.txt']);
  assert.equal(u.mock.state.pulls[0].title, 'Let bots in');
  assert.match(u.mock.state.pulls[0].body, /Not applied \(fix by hand\):[\s\S]*Traversal: `..\/..\/etc\/robots.txt` isn’t a file `robots` fixes may write[\s\S]*No patch: no patch to apply/);
  assert.match(ur.stdout, /Not applied: Wrong folder/);
});

test('aeo autofix: a branch equal to the base and a 403 on PR creation explain themselves', async () => {
  const same = await setup({ mode: 'aeo', autofix: 'true', 'aeo-fail-on': 'none', branch: 'main' }).go();
  assert.equal(same.ok, false);
  assert.match(same.stdout, /autofix branch `main` is the branch it would merge into/);
  const t = setup({ mode: 'aeo', autofix: 'true', 'aeo-fail-on': 'none' });
  t.mock.state.forbidPulls = 'GitHub Actions is not permitted to create or approve pull requests.';
  const r = await t.go();
  assert.equal(r.ok, false);
  assert.match(r.stdout, /Allow GitHub Actions to create and approve pull requests/);
});

test('aeo.mjs: fixFiles placement and conflicts; aeoFailed; reportMarkdown truncates', () => {
  const check = (file, kind = 'robots', content = 'x') => ({ id: file, status: 'warn', title: file, detail: '', fix: { kind, summary: 's', patch: { file, content } } });
  const rep = (...checks) => ({ summary: {}, sections: [{ id: 's', title: 'S', checks }] });
  assert.deepEqual(Object.keys(fixFiles(rep(check('robots.txt'))).files), ['robots.txt'], 'root by default');
  assert.deepEqual(Object.keys(fixFiles(rep(check('robots.txt')), { repoFiles: ['static/a.css'] }).files), ['static/robots.txt']);
  assert.deepEqual(Object.keys(fixFiles(rep(check('robots.txt')), { repoFiles: ['robots.txt', 'public/x'] }).files), ['robots.txt'], 'existing file wins');
  assert.deepEqual(Object.keys(fixFiles(rep(check('public/llms-full.txt', 'llms-txt'))).files), ['public/llms-full.txt']);
  const conflict = fixFiles(rep(check('robots.txt', 'robots', 'a'), check('/robots.txt', 'robots', 'b')));
  assert.equal(conflict.files['robots.txt'], 'a\n');
  assert.match(conflict.skipped[0].reason, /another fix already changes `robots.txt`/);
  const passing = fixFiles({ sections: [{ id: 's', checks: [{ ...check('robots.txt'), status: 'pass' }] }] });
  assert.deepEqual(passing.files, {}, 'fixes of passing checks are ignored');

  assert.equal(aeoFailed({ summary: { fail: 1 } }, 'fail'), true);
  assert.equal(aeoFailed({ summary: { warn: 1 } }, 'fail'), false);
  assert.equal(aeoFailed({ summary: { warn: 1 } }, 'warn'), true);
  assert.equal(aeoFailed({ summary: { fail: 5 } }, 'none'), false);

  const many = rep(...Array.from({ length: 400 }, (_, i) => ({ id: `c${i}`, status: 'fail', title: `Check ${i}`, detail: 'x'.repeat(300) })));
  const text = reportMarkdown('https://acme.test', many, { limit: 5000 });
  assert.ok(text.length <= 5000);
  assert.match(text, /truncated; see the full report/);
});

/* ── indexnow ────────────────────────────────────────────────────────────── */

test('indexnow: indexnow-urls are submitted after the key file is checked; other hosts dropped', async () => {
  const t = setup({ mode: 'indexnow', 'indexnow-key': INDEXNOW_KEY, 'indexnow-urls': '/pricing\nhttps://acme.test/docs/, https://other.test/x' });
  const r = await t.go();
  assert.equal(r.ok, true, r.stdout);
  assert.equal(r.outputs['indexnow-submitted'], '2');
  const keyCall = t.mock.calls.findIndex((c) => c.path === `/${INDEXNOW_KEY}.txt`);
  const postCall = t.mock.calls.findIndex((c) => c.method === 'POST' && c.path === '/indexnow');
  assert.ok(keyCall >= 0 && keyCall < postCall, 'key file checked before submitting');
  assert.deepEqual(t.mock.state.indexnow, [{ host: 'acme.test', key: INDEXNOW_KEY, urlList: ['https://acme.test/pricing', 'https://acme.test/docs/'] }]);
  assert.match(r.stdout, /submitted 2 URLs \(1 on other hosts skipped\)/);
  assert.match(r.summary, /### IndexNow for https:\/\/acme\.test[\s\S]*- https:\/\/acme\.test\/pricing/);
  assert.equal(t.mock.calls.filter((c) => c.path.startsWith('/api/v0')).length, 0, 'mode indexnow never calls llms.ink');
});

test('indexnow: after a deploy, changed files → sitemap URLs (sitemap index followed)', async () => {
  const repo = { branches: { main: { 'README.md': '# Acme\n' } } };
  const t = setup({ mode: 'write', path: 'public/llms.txt', 'indexnow-key': INDEXNOW_KEY }, { repo });
  // A deployed commit that changed two pages, a component and a stylesheet.
  const base = t.mock.state.refs.get('main');
  const tree = t.mock.state.commits.get(base).tree;
  const files = { ...t.mock.state.trees.get(tree), 'src/content/docs/intro.md': 'x', 'src/pages/pricing.astro': 'y', 'src/components/Nav.astro': 'z', 'src/styles/site.css': 'w' };
  const treeSha = 'f'.repeat(40);
  t.mock.state.trees.set(treeSha, files);
  const commit = 'c'.repeat(40);
  t.mock.state.commits.set(commit, { tree: treeSha, parents: [base], message: 'pages' });
  const event = join(t.ws, '..', 'deploy.json');
  writeFileSync(event, JSON.stringify({ deployment: { sha: commit } }));
  Object.assign(t.env, { GITHUB_EVENT_NAME: 'deployment_status', GITHUB_EVENT_PATH: event });
  const r = await t.go();
  assert.equal(r.ok, true, r.stdout);
  assert.equal(r.outputs.changed, 'true', 'the mode itself ran (llms.txt written)');
  assert.deepEqual(t.mock.state.indexnow[0].urlList.sort(), ['https://acme.test/docs/intro/', 'https://acme.test/pricing']);
  assert.equal(r.outputs['indexnow-submitted'], '2');
  assert.match(r.summary, /4 files changed in `ccccccc`; 2 of 6 sitemap URLs match/);
});

test('indexnow: no urls and no deployed commit only warns; a missing or wrong key file fails; IndexNow errors fail', async () => {
  const none = await setup({ mode: 'indexnow', 'indexnow-key': INDEXNOW_KEY }, { env: { GITHUB_EVENT_NAME: 'workflow_dispatch' } }).go();
  assert.equal(none.ok, true);
  assert.equal(none.outputs['indexnow-submitted'], '0');
  assert.match(none.stdout, /::warning title=IndexNow::No `indexnow-urls`/);

  const missing = setup({ mode: 'indexnow', 'indexnow-key': 'zzzzzzzzzz', 'indexnow-urls': '/' });
  const m = await missing.go();
  assert.equal(m.ok, false);
  assert.match(m.stdout, /::error title=IndexNow::The IndexNow key file https:\/\/acme.test\/zzzzzzzzzz.txt answered 404/);
  assert.equal(missing.mock.state.indexnow.length, 0);

  const wrong = setup({ mode: 'indexnow', 'indexnow-key': INDEXNOW_KEY, 'indexnow-urls': '/' });
  wrong.mock.state.site[`/${INDEXNOW_KEY}.txt`].body = 'something else';
  assert.match((await wrong.go()).stdout, /doesn’t contain the key/);

  const bad = await setup({ mode: 'indexnow', 'indexnow-key': 'no spaces allowed', 'indexnow-urls': '/' }).go();
  assert.match(bad.stdout, /must be 8–128 letters, digits or dashes/);

  const located = setup({ mode: 'indexnow', 'indexnow-key': INDEXNOW_KEY, 'indexnow-key-location': '/keys/indexnow.txt', 'indexnow-urls': '/' });
  located.mock.state.site['/keys/indexnow.txt'] = { status: 200, body: INDEXNOW_KEY };
  assert.equal((await located.go()).ok, true);
  assert.equal(located.mock.state.indexnow[0].keyLocation, 'https://acme.test/keys/indexnow.txt');

  const rejected = setup({ mode: 'indexnow', 'indexnow-key': INDEXNOW_KEY, 'indexnow-urls': '/' });
  rejected.mock.state.indexnowStatus = 403;
  const rj = await rejected.go();
  assert.equal(rj.ok, false);
  assert.match(rj.stdout, /IndexNow answered 403/);

  const noKey = await setup({ mode: 'indexnow' }).go();
  assert.match(noKey.stdout, /`mode: indexnow` needs `indexnow-key`/);
});

test('indexnow.mjs: changedUrls only drops source-root folders; parseUrls; sitemapUrls on a plain urlset', async () => {
  const urls = ['https://a.test/', 'https://a.test/docs/', 'https://a.test/docs/intro/', 'https://a.test/blog/post.html', 'https://a.test/pricing'];
  assert.deepEqual(changedUrls(['src/pages/index.astro'], urls), ['https://a.test/']);
  assert.deepEqual(changedUrls(['content/docs/intro/index.md'], urls), ['https://a.test/docs/intro/']);
  assert.deepEqual(changedUrls(['docs/intro.mdx'], urls), ['https://a.test/docs/intro/']);
  assert.deepEqual(changedUrls(['app/(marketing)/pricing/page.tsx'], urls), ['https://a.test/pricing']);
  assert.deepEqual(changedUrls(['src/content/blog/post.md'], urls), ['https://a.test/blog/post.html']);
  assert.deepEqual(changedUrls(['src/lib/docs.ts', 'src/components/index.ts', 'app/blog/[slug]/page.tsx', 'package.json', 'src/styles/docs.css'], urls), []);
  assert.deepEqual(parseUrls(' /a ,\n/b\n\nhttps://x.test/c,/a', 'https://a.test'), ['https://a.test/a', 'https://a.test/b', 'https://x.test/c']);
  const fetch = async (u) => (String(u).endsWith('/sitemap.xml') ? new Response('<urlset><url><loc><![CDATA[https://a.test/x?a=1&amp;b=2]]></loc></url></urlset>') : new Response('', { status: 404 }));
  assert.deepEqual(await sitemapUrls(fetch, 'https://a.test'), ['https://a.test/x?a=1&b=2']);
  assert.deepEqual(await sitemapUrls(async () => new Response('', { status: 404 }), 'https://a.test'), []);
});

/* ── context ─────────────────────────────────────────────────────────────── */

/** A stand-in for `npx -y @lukax/llms-ink context`: writes what the CLI would, records the call. */
function fakeCli(files, code = 0) {
  const calls = [];
  const exec = async (cmd, args, { cwd, env }) => {
    calls.push({ cmd, args, cwd, key: env.LLMS_INK_KEY });
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(join(cwd, p, '..'), { recursive: true });
      if (text === null) rmSync(join(cwd, p), { force: true });
      else writeFileSync(join(cwd, p), text);
    }
    return code;
  };
  return { exec, calls };
}

test('context: runs the CLI with the contract flags, opens a PR with new and changed files, deletes stale ones', async () => {
  const repo = { files: { 'AGENTS.md': '# Agents\n', '.context/old@1.0.0.md': 'old\n', '.context/README.md': 'index v1\n', 'package.json': '{}' } };
  const cli = fakeCli({ '.context/zod@4.1.0.md': '# zod 4.1.0\n', '.context/README.md': 'index v2\n', '.context/old@1.0.0.md': null, 'AGENTS.md': '# Agents\n\n<!-- llms-ink:context:start -->\n- zod\n<!-- llms-ink:context:end -->\n' });
  const t = setup({ mode: 'context', url: '', 'api-key': 'lk_ctx', manifests: 'package.json\nservices/api/pyproject.toml', 'context-max': '5' }, { repo, exec: cli.exec });
  // The checkout: what's on main.
  for (const [p, text] of Object.entries(repo.files)) {
    mkdirSync(join(t.ws, p, '..'), { recursive: true });
    writeFileSync(join(t.ws, p), text);
  }
  const r = await t.go();
  assert.equal(r.ok, true, r.stdout);
  assert.deepEqual(cli.calls[0].args, ['-y', '@lukax/llms-ink@0.7.2', 'context', '--manifest', 'package.json', '--manifest', 'services/api/pyproject.toml', '--out', '.context', '--max', '5', '--agents-md', 'AGENTS.md']);
  assert.equal(cli.calls[0].cmd, 'npx');
  assert.equal(cli.calls[0].cwd, t.ws);
  assert.equal(cli.calls[0].key, 'lk_ctx', 'the API key reaches the CLI as LLMS_INK_KEY');
  assert.equal(r.outputs.changed, 'true');
  const files = t.mock.filesAt(CONTEXT_BRANCH);
  assert.equal(files['.context/zod@4.1.0.md'], '# zod 4.1.0\n');
  assert.equal(files['.context/README.md'], 'index v2\n');
  assert.equal(files['.context/old@1.0.0.md'], undefined, 'stale pack removed');
  assert.match(files['AGENTS.md'], /llms-ink:context:start/);
  assert.equal(files['package.json'], '{}');
  const [p] = t.mock.state.pulls;
  assert.equal(p.title, 'Update dependency docs in .context');
  assert.match(p.body, /- `.context\/old@1.0.0.md` removed/);
  assert.match(p.body, /- `.context\/zod@4.1.0.md` updated/);
  assert.equal(r.outputs['pr-url'], p.html_url);
  assert.match(r.summary, /### Dependency docs in `.context`\n\n4 files changed/);
});

test('context: no PR when nothing changed; agents-md none skips it; CLI failure fails the job', async () => {
  const same = { '.context/zod@4.1.0.md': '# zod\n' };
  const t = setup({ mode: 'context', 'agents-md': 'none' }, { repo: { files: same }, exec: fakeCli(same).exec });
  const r = await t.go();
  assert.equal(r.ok, true);
  assert.equal(r.outputs.changed, 'false');
  assert.equal(ghWrites(t.mock).length, 0);
  assert.match(r.summary, /No changes: `.context` on `main` are current/);

  const cli = fakeCli({}, 2);
  const f = await setup({ mode: 'context' }, { exec: cli.exec }).go();
  assert.equal(f.ok, false);
  assert.match(f.stdout, /`llms-ink context` exited with code 2/);

  const out = await setup({ mode: 'context', 'context-dir': '../outside' }, { exec: fakeCli({}).exec }).go();
  assert.match(out.stdout, /must be a path inside the repository/);
  const max = await setup({ mode: 'context', 'context-max': 'lots' }, { exec: fakeCli({}).exec }).go();
  assert.match(max.stdout, /`context-max` must be a positive whole number/);
});

test('context.mjs: blobSha matches git, contextArgs without agents-md', () => {
  // `printf 'hello\n' | git hash-object --stdin`
  assert.equal(blobSha('hello\n'), 'ce013625030ba8dba906f756967f9e9ca394464a');
  assert.deepEqual(contextArgs({ manifests: [], dir: 'docs/ctx', max: 3, agentsMd: '' }), ['-y', '@lukax/llms-ink@0.7.2', 'context', '--out', 'docs/ctx', '--max', '3', '--agents-md', 'none']);
});

test('context refuses a linked extra file before any GitHub write', async () => {
  let t;
  const exec = async (_cmd, _args, { cwd }) => {
    mkdirSync(join(cwd, '.context'));
    writeFileSync(join(cwd, '.context/README.md'), '# Dependency docs\n');
    writeFileSync(join(cwd, 'AGENTS.md'), '# Agents\n');
    writeFileSync(join(cwd, 'private-fixture.txt'), 'PRIVATE FIXTURE MUST NOT ENTER A COMMIT');
    symlinkSync(join(cwd, 'private-fixture.txt'), join(cwd, '.context/extra.txt'));
    return 0;
  };
  try {
    t = setup({ mode: 'context' }, { exec });
    const result = await t.go();
    assert.equal(result.ok, false); assert.equal(ghWrites(t.mock).length, 0);
    assert.ok(!result.stdout.includes('PRIVATE FIXTURE')); assert.ok(!result.summary.includes('PRIVATE FIXTURE'));
  } finally { if (t) rmSync(join(t.ws, '..'), { recursive: true, force: true }); }
});

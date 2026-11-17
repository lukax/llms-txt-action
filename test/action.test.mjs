import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PR_BRANCH, readInputs, run } from '../src/action.mjs';
import { GITHUB_API, LLMS_API, LLMS_TXT, mockApi, REPO } from './mock.mjs';

/** A fresh workspace with GITHUB_* files, and `run` wired to a mock. */
function setup(inputs = {}, { repo, event, env: extra } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'llms-action-'));
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
  let stdout = '';
  const go = async () => {
    stdout = '';
    const r = await run({ env, fetch: mock.fetch, sleep: async () => {}, stdout: (s) => (stdout += s) });
    return { ...r, stdout, summary: existsSync(env.GITHUB_STEP_SUMMARY) ? readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8') : '' };
  };
  return { env, ws, mock, go, read: (p) => readFileSync(join(ws, p), 'utf8'), write: (p, t) => writeFileSync(join(ws, p), t) };
}

const llmsCalls = (mock) => mock.calls.filter((c) => c.path.startsWith('/api/v0/'));

test('action.yml: every input reaches the step as INPUT_*, with the same defaults readInputs uses', () => {
  const yml = readFileSync(fileURLToPath(new URL('../action.yml', import.meta.url)), 'utf8');
  const block = yml.slice(yml.indexOf('\ninputs:'), yml.indexOf('\noutputs:'));
  const names = [...block.matchAll(/^ {2}([\w-]+):$/gm)].map((m) => m[1]);
  assert.deepEqual(names, [
    'inspect-dir', 'inspect-paths', 'url', 'path', 'full-path', 'fresh', 'mode', 'api-key', 'generated', 'commit-message', 'branch', 'token', 'check-target', 'links',
    'aeo-fail-on', 'autofix', 'autofix-dir', 'indexnow-key', 'indexnow-urls', 'indexnow-key-location', 'context-dir', 'context-max', 'manifests', 'agents-md',
  ]);
  const env = {};
  for (const name of names) {
    const envName = `INPUT_${name.toUpperCase().replace(/-/g, '_')}`;
    assert.match(yml, new RegExp(`${envName}: \\$\\{\\{ inputs\\.${name} \\}\\}`));
    const d = block.match(new RegExp(`^ {2}${name}:\\n(?: {4}.*\\n)*? {4}default: (.*)$`, 'm'));
    if (d && !d[1].includes('${{')) env[envName] = d[1].replace(/^'(.*)'$/, '$1');
  }
  assert.deepEqual(readInputs(env), readInputs({}));
  for (const o of ['changed', 'tokens', 'path', 'pr-url', 'source', 'pages', 'aeo-fail', 'aeo-warn', 'indexnow-submitted']) {
    assert.match(yml, new RegExp(`^ {2}${o}:\\n {4}description: .*\\n {4}value: \\$\\{\\{ steps\\.llms\\.outputs\\.${o} \\}\\}$`, 'm'));
  }
});

test('write (default): same request and file as v1, outputs, summary', async () => {
  const t = setup();
  const r = await t.go();
  assert.equal(r.ok, true);
  assert.equal(t.read('llms.txt'), LLMS_TXT);
  const [call] = llmsCalls(t.mock);
  assert.deepEqual(call.query, { url: 'https://acme.test', mode: 'llms', fresh: '1' });
  assert.equal(call.headers.authorization, undefined);
  assert.match(call.headers['user-agent'], /llms-txt-action/);
  assert.deepEqual(r.outputs, {
    changed: 'true', tokens: String(Math.ceil(LLMS_TXT.length / 4)), path: 'llms.txt', 'pr-url': '', source: 'generated', pages: '2',
    'aeo-fail': '', 'aeo-warn': '', 'indexnow-submitted': '',
  });
  assert.match(readFileSync(t.env.GITHUB_OUTPUT, 'utf8'), /^changed=true$/m);
  assert.match(r.summary, /\| Sections \| 1 \|/);
  assert.match(r.summary, /`llms.txt` is new/);
  assert.equal(t.mock.calls.filter((c) => c.path.startsWith('/repos')).length, 0, 'write mode never calls GitHub');

  const again = await t.go();
  assert.equal(again.outputs.changed, 'false');
  assert.match(again.summary, /No section changes in `llms.txt`/);
});

test('a workflow written by llms-ink init marks its llms.ink requests with source=init; others never do', async () => {
  const init = setup({ mode: 'check' }, { env: { LLMS_INK_SOURCE: 'init' } });
  await init.go();
  assert.deepEqual(llmsCalls(init.mock)[0].query, { url: 'https://acme.test', source: 'init' });
  const other = setup({ mode: 'check' }, { env: { LLMS_INK_SOURCE: 'evil' } });
  await other.go();
  assert.deepEqual(llmsCalls(other.mock)[0].query, { url: 'https://acme.test' });
});

test('write: full-path, nested dirs, fresh false, generated, api key', async () => {
  const t = setup({ path: 'public/llms.txt', 'full-path': 'public/llms-full.txt', fresh: 'false', generated: 'true', 'api-key': 'lk_abc' });
  const r = await t.go();
  assert.equal(r.ok, true);
  assert.equal(t.read('public/llms-full.txt'), t.mock.state.full.text);
  const calls = llmsCalls(t.mock);
  assert.deepEqual(
    calls.map((c) => c.query),
    [
      { url: 'https://acme.test', mode: 'llms', fresh: '0', native: '0' },
      { url: 'https://acme.test', mode: 'full', fresh: '0', native: '0' },
    ],
  );
  assert.ok(calls.every((c) => c.headers.authorization === 'Bearer lk_abc'));
  assert.match(r.stdout, /^::add-mask::lk_abc$/m);
});

test('write: section diff against the previous file', async () => {
  const t = setup();
  t.write('llms.txt', LLMS_TXT.replace('## Docs', '## Old').replace('- [API](https://acme.test/api): The API\n', ''));
  const r = await t.go();
  assert.equal(r.outputs.changed, 'true');
  assert.match(r.summary, /Sections: 1 added, 1 removed, 1 unchanged in `llms.txt`/);
  assert.match(r.summary, /\| Added \| `Docs` \| \+2 \|/);
  assert.match(r.summary, /\| Removed \| `Old` \| −1 \|/);
});

test('errors: problem detail as an annotation, retries on 503, invalid key, bad mode', async () => {
  const t = setup();
  t.mock.state.llmsFailures.push({ status: 503 }, { status: 503 });
  assert.equal((await t.go()).ok, true, 'two retries');

  t.mock.state.llmsFailures.push({ status: 503 }, { status: 503 }, { status: 503, detail: 'Busy' });
  const busy = await t.go();
  assert.equal(busy.ok, false);
  assert.match(busy.stdout, /^::error title=llms.ink \(503\)::Busy$/m);

  t.mock.state.llmsFailures.push({ status: 429 }, { status: 429 }, { status: 429, code: 'quota_exceeded', detail: 'Daily quota used.' });
  assert.match((await t.go()).stdout, /::error title=llms.ink \(429\)::Daily quota used./);

  const bad = setup({ 'api-key': 'lk_bad' });
  const r = await bad.go();
  assert.equal(r.ok, false);
  assert.match(r.stdout, /::error title=llms.ink \(401\)::That API key isn’t valid./);
  assert.equal(existsSync(join(bad.ws, 'llms.txt')), false);

  const mode = await setup({ mode: 'publish' }).go();
  assert.equal(mode.ok, false);
  assert.match(mode.stdout, /`mode` must be one of write, commit, pr, check, comment/);
});

test('check: passes, writes no file, summary table', async () => {
  const t = setup({ mode: 'check' });
  const r = await t.go();
  assert.equal(r.ok, true);
  assert.deepEqual(llmsCalls(t.mock)[0].query, { url: 'https://acme.test' });
  assert.equal(llmsCalls(t.mock)[0].path, '/api/v0/check');
  assert.equal(existsSync(join(t.ws, 'llms.txt')), false);
  assert.equal(r.outputs.changed, 'false');
  assert.equal(r.outputs.path, '');
  assert.equal(r.outputs.tokens, '40');
  assert.match(r.summary, /\| Result \| Passed: 0 errors, 0 warnings \|/);
});

test('check: fails on errors and on broken links; warnings alone pass', async () => {
  const t = setup({ mode: 'check' });
  t.mock.state.check.issues = [{ level: 'warning', code: 'long_line', line: 3, message: 'Long, line: here' }];
  t.mock.state.check.summary = { errors: 0, warnings: 1 };
  const warn = await t.go();
  assert.equal(warn.ok, true);
  assert.match(warn.stdout, /^::warning title=llms.txt long_line \(line 3\)::Long, line: here$/m);

  t.mock.state.check.links.broken = [{ url: 'https://acme.test/gone', status: 404 }];
  const broken = await t.go();
  assert.equal(broken.ok, false);
  assert.match(broken.stdout, /::error title=llms.txt broken_link::https:\/\/acme.test\/gone \(HTTP 404\)/);
  assert.match(broken.summary, /- https:\/\/acme.test\/gone \(HTTP 404\)/);

  t.mock.state.check = { ...t.mock.state.check, found: false, status: 404, links: { total: 0, checked: 0, broken: [] }, issues: [{ level: 'error', code: 'not_found', line: null, message: 'No llms.txt' }], summary: { errors: 1, warnings: 0 } };
  const missing = await t.go();
  assert.equal(missing.ok, false);
  assert.match(missing.stdout, /::error title=llms.txt not_found::No llms.txt/);
});

test('check (auto): lints the workspace file via POST with base and links, annotates file and line, outlines it', async () => {
  const t = setup({ mode: 'check', path: 'docs/llms.txt' });
  mkdirSync(join(t.ws, 'docs'));
  t.write('docs/llms.txt', LLMS_TXT);
  t.mock.state.check.issues = [{ level: 'warning', code: 'long_line', line: 3, message: 'Too long' }];
  t.mock.state.check.summary = { errors: 0, warnings: 1 };
  t.mock.state.check.links.broken = [{ url: 'https://acme.test/api', status: 404 }];
  const r = await t.go();
  const [call] = llmsCalls(t.mock);
  assert.equal(call.method, 'POST');
  assert.equal(call.path, '/api/v0/check');
  assert.deepEqual(call.query, { base: 'https://acme.test', links: '1' });
  assert.equal(call.body, LLMS_TXT);
  assert.match(call.headers['content-type'], /^text\/markdown/);
  assert.equal(r.ok, false);
  assert.match(r.stdout, /^::warning file=docs\/llms.txt,line=3,title=llms.txt long_line \(line 3\)::Too long$/m);
  assert.match(r.stdout, /^::error file=docs\/llms.txt,line=8,title=llms.txt broken_link::https:\/\/acme.test\/api \(HTTP 404\)$/m);
  assert.match(r.stdout, /Checked docs\/llms.txt:/);
  assert.match(r.summary, /### llms.txt check for `docs\/llms.txt`/);
  assert.match(r.summary, /\*\*Outline:\*\* Acme — Acme makes things\./);
  assert.match(r.summary, /^\| Docs \| 2 \| 7 \|$/m);
  assert.match(r.summary, /\| llms-full.txt \| Not published \|/);
  assert.equal(t.read('docs/llms.txt'), LLMS_TXT, 'check never rewrites the file');
});

test('check (auto) without an explicit path: still checks the live site even with llms.txt in the workspace', async () => {
  const t = setup({ mode: 'check' });
  t.write('llms.txt', LLMS_TXT);
  const r = await t.go();
  assert.equal(r.ok, true);
  const [call] = llmsCalls(t.mock);
  assert.equal(call.method, 'GET');
  assert.deepEqual(call.query, { url: 'https://acme.test' });
});

test('check: links=false, check-target live/file, bad target, missing file', async () => {
  const t = setup({ mode: 'check', path: 'llms.txt', links: 'false' });
  t.write('llms.txt', LLMS_TXT);
  const noLinks = await t.go();
  assert.equal(noLinks.ok, true);
  assert.deepEqual(llmsCalls(t.mock).at(-1).query, { base: 'https://acme.test', links: '0' });
  assert.match(noLinks.summary, /\| llms-full.txt \| Not checked \|/);

  t.env.INPUT_CHECK_TARGET = 'live';
  await t.go();
  assert.equal(llmsCalls(t.mock).at(-1).method, 'GET');
  assert.deepEqual(llmsCalls(t.mock).at(-1).query, { url: 'https://acme.test' });

  const missing = setup({ mode: 'check', 'check-target': 'file' });
  const m = await missing.go();
  assert.equal(m.ok, false);
  assert.match(m.stdout, /`llms.txt` doesn’t exist in the workspace/);
  assert.equal(llmsCalls(missing.mock).length, 0);

  const bad = await setup({ mode: 'check', 'check-target': 'remote' }).go();
  assert.equal(bad.ok, false);
  assert.match(bad.stdout, /`check-target` must be one of auto, file, live/);

  const err = setup({ mode: 'check', 'check-target': 'file' });
  err.write('llms.txt', '');
  err.mock.state.checkPost = () => new Response(JSON.stringify({ title: 'Bad', status: 400, code: 'invalid_request', detail: 'The body is empty.' }), { status: 400 });
  const e = await err.go();
  assert.equal(e.ok, false);
  assert.match(e.stdout, /The body is empty\./);
});

test('commit: commits to the current branch only when the file changed', async () => {
  const t = setup({ mode: 'commit', 'commit-message': 'chore: llms.txt' }, { repo: { files: { 'README.md': 'hi', 'llms.txt': 'old' } } });
  const before = t.mock.state.refs.get('main');
  const r = await t.go();
  assert.equal(r.ok, true);
  assert.equal(r.outputs.changed, 'true');
  assert.equal(t.read('llms.txt'), LLMS_TXT, 'also written locally');
  const head = t.mock.state.refs.get('main');
  assert.notEqual(head, before);
  assert.deepEqual(t.mock.state.commits.get(head), { tree: t.mock.state.commits.get(head).tree, parents: [before], message: 'chore: llms.txt' });
  assert.deepEqual(t.mock.filesAt('main'), { 'README.md': 'hi', 'llms.txt': LLMS_TXT });
  assert.equal(t.mock.calls.find((c) => c.method === 'PATCH').body.force, false);
  assert.match(r.summary, /\| Commit \| `\w{7}` on `main` \|/);

  const writes = t.mock.writes().length;
  const again = await t.go();
  assert.equal(again.outputs.changed, 'false');
  assert.equal(t.mock.writes().length, writes, 'no commit when unchanged');
});

test('commit: `branch` input, full-path, and paths outside the repo are rejected', async () => {
  const t = setup({ mode: 'commit', branch: 'gh-pages', path: 'docs/llms.txt', 'full-path': 'docs/llms-full.txt' }, { repo: { branches: { main: {}, 'gh-pages': {} } } });
  const r = await t.go();
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(t.mock.filesAt('gh-pages')).sort(), ['docs/llms-full.txt', 'docs/llms.txt']);
  assert.deepEqual(t.mock.filesAt('main'), {});

  const out = await setup({ mode: 'commit', path: '../llms.txt' }).go();
  assert.equal(out.ok, false);
  assert.match(out.stdout, /must be a path inside the repository/);
});

test('pr: opens a PR from llms-ink/llms-txt, then updates the same branch and PR', async () => {
  const t = setup({ mode: 'pr' }, { repo: { files: { 'llms.txt': LLMS_TXT.replace('The API', 'An API') } }, env: { GITHUB_REF: '' } });
  const r = await t.go();
  assert.equal(r.ok, true);
  assert.equal(r.outputs.changed, 'true');
  assert.equal(r.outputs['pr-url'], `https://github.com/${REPO}/pull/100`);
  assert.equal(t.mock.filesAt(PR_BRANCH)['llms.txt'], LLMS_TXT);
  assert.match(t.mock.filesAt('main')['llms.txt'], /An API/, 'base untouched');
  const [pr] = t.mock.state.pulls;
  assert.deepEqual([pr.head, pr.base, pr.title], [PR_BRANCH, 'main', 'Update llms.txt']);
  assert.match(pr.body, /Sections: 1 changed, 1 unchanged\.\n\n.*\n.*\n\| Changed \| `Docs` \| \+1 −1 \|/);

  // Same output again: no new commit, PR body refreshed.
  const sha = t.mock.state.refs.get(PR_BRANCH);
  const again = await t.go();
  assert.equal(again.outputs['pr-url'], r.outputs['pr-url']);
  assert.equal(t.mock.state.refs.get(PR_BRANCH), sha);
  assert.equal(t.mock.state.pulls.length, 1);

  // New output: the branch is reset onto the base with one new commit (force), same PR.
  t.mock.state.llms.text = LLMS_TXT.replace('Getting started', 'Get started');
  const third = await t.go();
  assert.equal(third.ok, true);
  const head = t.mock.state.refs.get(PR_BRANCH);
  assert.notEqual(head, sha);
  assert.deepEqual(t.mock.state.commits.get(head).parents, [t.mock.state.refs.get('main')]);
  assert.equal(t.mock.calls.filter((c) => c.method === 'PATCH' && c.path.includes('/git/refs/')).at(-1).body.force, true);
  assert.equal(t.mock.state.pulls.length, 1);
  assert.match(t.mock.state.pulls[0].body, /\| Changed \| `Docs` \| \+2 −2 \|/);
});

test('pr: nothing to do when the base already has the file; 403 explains the repo setting', async () => {
  const t = setup({ mode: 'pr' }, { repo: { files: { 'llms.txt': LLMS_TXT } } });
  const r = await t.go();
  assert.equal(r.ok, true);
  assert.equal(r.outputs.changed, 'false');
  assert.equal(r.outputs['pr-url'], '');
  assert.equal(t.mock.writes().length, 0);

  const f = setup({ mode: 'pr', branch: 'bot/llms' });
  f.mock.state.forbidPulls = 'GitHub Actions is not permitted to create or approve pull requests.';
  const denied = await f.go();
  assert.equal(denied.ok, false);
  assert.match(denied.stdout, /Allow GitHub Actions to create and approve pull requests/);
  assert.ok(f.mock.state.refs.has('bot/llms'));
});

test('comment: one sticky comment per path, updated in place; never fails on differences', async () => {
  const event = { name: 'pull_request', payload: { pull_request: { number: 7 } } };
  const t = setup({ mode: 'comment', 'full-path': 'llms-full.txt' }, { event });
  t.write('llms.txt', LLMS_TXT.replace('## Docs', '## Guides'));
  const r = await t.go();
  assert.equal(r.ok, true);
  assert.equal(r.outputs.changed, 'true');
  assert.equal(r.outputs.path, '');
  assert.equal(t.read('llms.txt').includes('## Guides'), true, 'comment mode leaves the file alone');
  assert.equal(existsSync(join(t.ws, 'llms-full.txt')), false);
  assert.equal(llmsCalls(t.mock).length, 1, 'no llms-full.txt request');
  const [c] = t.mock.state.comments.get(7);
  assert.match(c.body, /^<!-- llms-txt-action:llms.txt -->/);
  assert.match(c.body, /\| Added \| `Docs` \| \+2 \|/);
  assert.match(c.body, /\| Removed \| `Guides` \| −2 \|/);
  assert.match(c.body, /\*\*~\d+ tokens\*\*/);
  assert.match(c.body, /<details><summary>Generated llms.txt<\/summary>/);

  t.write('llms.txt', LLMS_TXT);
  await t.go();
  assert.equal(t.mock.state.comments.get(7).length, 1);
  assert.match(t.mock.state.comments.get(7)[0].body, /No section changes against `llms.txt`/);
});

test('comment: outside a PR it only warns; a token without write access only warns', async () => {
  const push = await setup({ mode: 'comment' }).go();
  assert.equal(push.ok, true);
  assert.match(push.stdout, /::warning title=llms.ink::`mode: comment` runs on pull_request events/);

  const t = setup({ mode: 'comment' }, { event: { name: 'pull_request', payload: { pull_request: { number: 3 } } } });
  t.mock.state.forbidComments = true;
  const r = await t.go();
  assert.equal(r.ok, true);
  assert.match(r.stdout, /::warning title=llms.ink::Couldn’t comment on #3: .*403/);
});

test('commit after deploy: regenerates for a site change, skips when the deployed commit only touched llms.txt', async () => {
  const t = setup({ mode: 'commit' }, { repo: { files: { 'index.html': 'v1', 'llms.txt': 'old' } } });
  const site = t.mock.state.refs.get('main');
  t.env.GITHUB_EVENT_NAME = 'deployment_status';
  t.env.GITHUB_EVENT_PATH = join(t.ws, '..', 'event.json');
  writeFileSync(t.env.GITHUB_EVENT_PATH, JSON.stringify({ deployment: { sha: site }, deployment_status: { state: 'success' } }));
  const r = await t.go();
  assert.equal(r.outputs.changed, 'true', 'the initial commit changed index.html too');
  const ours = t.mock.state.refs.get('main');
  assert.notEqual(ours, site);

  // That commit deploys and fires deployment_status again (workflow_run carries the sha the same way).
  t.env.GITHUB_EVENT_NAME = 'workflow_run';
  writeFileSync(t.env.GITHUB_EVENT_PATH, JSON.stringify({ workflow_run: { head_sha: ours, conclusion: 'success' } }));
  t.mock.state.llms.text = LLMS_TXT.replace('Getting started', 'Get going');
  const n = llmsCalls(t.mock).length;
  const skip = await t.go();
  assert.equal(skip.ok, true);
  assert.equal(skip.outputs.changed, 'false');
  assert.equal(llmsCalls(t.mock).length, n, 'no generation, no quota spent');
  assert.equal(t.mock.state.refs.get('main'), ours, 'no new commit');
  assert.match(skip.summary, /Skipped: the deployed commit `\w{7}` only changed `llms.txt`/);
});

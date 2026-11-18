import { inspectMode } from './inspect.mjs';
import { inspectContextMode } from './inspect-context.mjs';
// The action: read inputs, run the mode, write outputs and the job summary.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, posix, resolve } from 'node:path';
import { AEO_FAIL_ON, aeoFailed, aeoMarker, checksOf, fixBody, fixFiles, reportLink, reportMarkdown } from './aeo.mjs';
import { contextArgs, contextChanges, exec as spawnExec } from './context.mjs';
import { gitHub, proposePull } from './github.mjs';
import { changedUrls, checkKey, INDEXNOW_API, IndexNowError, parseUrls, sitemapUrls, submit } from './indexnow.mjs';
import { check, checkFailed, checkText, generate, LlmsInkError, report } from './llms.mjs';
import { countSections, describeDiff, diffSections, diffTable } from './sections.mjs';

export const MODES = ['write', 'commit', 'pr', 'check', 'comment', 'aeo', 'context', 'indexnow', 'inspect', 'inspect-context'];
export const CHECK_TARGETS = ['auto', 'file', 'live'];
export const PR_BRANCH = 'llms-ink/llms-txt';
export const AEO_BRANCH = 'llms-ink/aeo-fixes';
/** The label on the `issue` input's tracking issue; it is how the next run finds it. */
export const AEO_LABEL = 'llms-ink';
export const CONTEXT_BRANCH = 'llms-ink/context';
/** `commit-message` when it isn't set: also the pull request title. */
const MESSAGES = { aeo: 'Fix agent access (llms.ink report)', context: 'Update dependency docs in .context' };
const COMMENT_LIMIT = 60_000;

/** Inputs as the composite step passes them: INPUT_<NAME> with dashes as underscores. Defaults match action.yml. */
export function readInputs(env) {
  const get = (name, fallback = '') => (env[`INPUT_${name.toUpperCase().replace(/-/g, '_')}`] ?? '').trim() || fallback;
  const bool = (name, fallback) => get(name, String(fallback)).toLowerCase() === 'true';
  const mode = get('mode', 'write').toLowerCase();
  return {
    url: get('url'),
    path: get('path', 'llms.txt'),
    /** Whether `path` was set explicitly: `check-target: auto` lints a workspace file only then. */
    pathSet: get('path') !== '',
    fullPath: get('full-path'),
    fresh: bool('fresh', true),
    mode,
    apiKey: get('api-key'),
    inspectPaths: get('inspect-paths').split(/\r?\n/).map(s => s.trim()).filter(Boolean),
    inspectDir: get('inspect-dir'),
    generated: bool('generated', false),
    commitMessage: get('commit-message', MESSAGES[mode] ?? 'Update llms.txt'),
    branch: get('branch'),
    token: get('token'),
    checkTarget: get('check-target', 'auto').toLowerCase(),
    links: bool('links', true),
    aeoFailOn: get('aeo-fail-on', 'fail').toLowerCase(),
    autofix: bool('autofix', false),
    autofixDir: get('autofix-dir'),
    issue: bool('issue', false),
    indexnowKey: get('indexnow-key'),
    indexnowUrls: get('indexnow-urls'),
    indexnowKeyLocation: get('indexnow-key-location'),
    contextDir: get('context-dir', '.context'),
    contextMax: get('context-max', '10'),
    manifests: get('manifests').split(/[\n,]/).map((s) => s.trim()).filter(Boolean),
    /** `none` skips the AGENTS.md block. */
    agentsMd: /^(none|false)$/i.test(get('agents-md')) ? '' : get('agents-md', 'AGENTS.md'),
  };
}

/** A repo-relative POSIX path for the Git Data API; throws on absolute paths or ones that leave the repo. */
export function repoPath(p) {
  const n = posix.normalize(p.replace(/\\/g, '/')).replace(/^\.\//, '');
  if (isAbsolute(p) || n.startsWith('../') || n === '..') throw new Error(`\`${p}\` must be a path inside the repository.`);
  return n;
}

/** Annotation-safe text: GitHub workflow commands end at a newline. */
const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
/** A workflow-command property value (`title=`, `file=`): also escapes `:` and `,`. */
const prop = (s) => esc(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
const tokensOf = (text) => Math.ceil(text.length / 4);

/** A fence longer than any backtick run in `text`. */
const fence = (text) => '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));

/**
 * Run the action.
 * @param {{ env: Record<string,string|undefined>, fetch: typeof fetch, sleep?: (ms:number)=>Promise<void>,
 *   stdout?: (s:string)=>void, exec?: (cmd:string, args:string[], opts:{cwd:string, env:object})=>Promise<number> }} deps
 *   `exec` runs the llms.ink CLI in `context` mode.
 * @returns {Promise<{ ok: boolean, outputs: Record<string,string> }>}
 */
export async function run({ env, fetch, sleep, signal, stdout = (s) => process.stdout.write(s), exec = spawnExec }) {
  const log = (s) => stdout(`${s}\n`);
  /** `props`: extra properties before `title`, each ending in a comma, e.g. `file=llms.txt,line=3,`. */
  const annotate = (level, title, message, props = '') => log(`::${level} ${props}title=${prop(title)}::${esc(message)}`);
  const inputs = readInputs(env);
  const outputs = { changed: 'false', tokens: '', path: '', 'pr-url': '', 'issue-url': '', source: '', pages: '', 'aeo-fail': '', 'aeo-warn': '', 'indexnow-submitted': '' };
  const summary = [];
  const cwd = env.GITHUB_WORKSPACE || process.cwd();
  const at = (p) => resolve(cwd, p);

  const finish = (ok) => {
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, Object.entries(outputs).map(([k, v]) => `${k}=${v}\n`).join(''));
    if (env.GITHUB_STEP_SUMMARY && summary.length) appendFileSync(env.GITHUB_STEP_SUMMARY, `${summary.join('\n')}\n`);
    return { ok, outputs };
  };

  try {
    if (!inputs.url && !['context','inspect','inspect-context'].includes(inputs.mode)) throw new Error('`url` is required.');
    if (!MODES.includes(inputs.mode)) throw new Error(`\`mode\` must be one of ${MODES.join(', ')}; got \`${inputs.mode}\`.`);
    if (inputs.inspectDir && inputs.mode !== 'inspect-context') throw new Error('inspect-dir requires explicit inspect-context mode.');
    if (inputs.mode === 'indexnow' && !inputs.indexnowKey) throw new Error('`mode: indexnow` needs `indexnow-key`.');
    if (inputs.apiKey) log(`::add-mask::${inputs.apiKey}`);
    // `llms-ink init` writes `LLMS_INK_SOURCE: init` into its workflow, so llms.ink can count runs from an install.
    const deps = { fetch, sleep: sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))), apiKey: inputs.apiKey, api: env.LLMS_INK_API || undefined, source: env.LLMS_INK_SOURCE === 'init' ? 'init' : undefined };
    const github = () => gitHub({ token: inputs.token, repository: env.GITHUB_REPOSITORY ?? '', api: env.GITHUB_API_URL, fetch });
    const c = { inputs, env, deps, fetch, exec, log, annotate, summary, outputs, cwd, at, github, packSleep: sleep, signal };

    let ok = true;
    if (inputs.mode === 'inspect') ok = await inspectMode(c);
    else if (inputs.mode === 'inspect-context') ok = await inspectContextMode(c);
    else if (inputs.mode === 'check') ok = await checkMode(c);
    else if (inputs.mode === 'aeo') ok = await aeoMode(c);
    else if (inputs.mode === 'context') ok = await contextMode(c);
    else if (inputs.mode !== 'indexnow') ok = await llmsMode(c);
    // IndexNow after the mode's own work (typically after a deploy): only when that work succeeded.
    if (ok && !['inspect','inspect-context'].includes(inputs.mode) && inputs.indexnowKey) ok = await indexNow(c);
    return finish(ok);
  } catch (err) {
    const title = err instanceof LlmsInkError && err.status ? `llms.ink (${err.status})` : 'llms.ink';
    annotate('error', title, err.message);
    summary.push(`### ${heading(inputs)}`, '', `Failed: ${err.message}`, '');
    return finish(false);
  }
}

function heading(inputs) {
  if (inputs.mode === 'inspect-context') return 'Context-pack inspection';
  if (inputs.mode === 'inspect') return 'Hosted content inspection';
  if (inputs.mode === 'aeo') return `Agent's-eye view of ${inputs.url || '(no url)'}`;
  if (inputs.mode === 'context') return `Dependency docs in \`${inputs.contextDir}\``;
  if (inputs.mode === 'indexnow') return `IndexNow for ${inputs.url || '(no url)'}`;
  return `llms.txt for ${inputs.url || '(no url)'}`;
}

/** `check`: lint the workspace file or the published llms.txt. */
async function checkMode({ inputs, deps, log, annotate, summary, outputs, at }) {
  if (!CHECK_TARGETS.includes(inputs.checkTarget)) {
    throw new Error(`\`check-target\` must be one of ${CHECK_TARGETS.join(', ')}; got \`${inputs.checkTarget}\`.`);
  }
  const fileExists = existsSync(at(inputs.path));
  if (inputs.checkTarget === 'file' && !fileExists) throw new Error(`\`${inputs.path}\` doesn’t exist in the workspace. Check out the repository first.`);
  const useFile = inputs.checkTarget === 'file' || (inputs.checkTarget === 'auto' && inputs.pathSet && fileExists);
  const file = useFile ? inputs.path : null;
  const result = file
    ? await checkText(readFileSync(at(file), 'utf8'), { base: inputs.url, links: inputs.links }, deps)
    : await check(inputs.url, deps);
  const where = file ? `file=${prop(file)},` : '';
  checkSummary(file ? `\`${file}\`` : inputs.url, result, summary, file);
  outputs.tokens = String(result.tokens);
  for (const i of result.issues) {
    const level = i.level === 'error' ? 'error' : i.level === 'warning' ? 'warning' : 'notice';
    const line = file && i.line ? `line=${i.line},` : '';
    annotate(level, `llms.txt ${i.code}${i.line ? ` (line ${i.line})` : ''}`, i.message, `${where}${line}`);
  }
  const lineOf = new Map((result.parsed?.sections ?? []).flatMap((s) => s.links.map((l) => [l.url, l.line])));
  for (const b of result.links.broken) {
    const line = file && lineOf.has(b.url) ? `line=${lineOf.get(b.url)},` : '';
    annotate('error', 'llms.txt broken_link', `${b.url} (HTTP ${b.status || 'no answer'})`, `${where}${line}`);
  }
  const failed = checkFailed(result);
  log(
    `Checked ${file ?? result.url}: ${result.summary.errors} errors, ${result.summary.warnings} warnings, ` +
      `${result.links.broken.length} of ${result.links.checked} links broken.`,
  );
  return !failed;
}

/** `write`, `commit`, `pr` and `comment`: generate llms.txt (and llms-full.txt) and put it where the mode says. */
async function llmsMode({ inputs, env, deps, log, annotate, summary, outputs, at, github }) {
  // commit and pr: check the token, paths and branch before spending quota.
  const paths = [inputs.path, ...(inputs.fullPath && inputs.mode !== 'comment' ? [inputs.fullPath] : [])];
  let gh;
  let target;
  if (inputs.mode === 'commit' || inputs.mode === 'pr') {
    for (const p of paths) repoPath(p);
    gh = github();
    target = await currentBranch(env, inputs, gh);
    if (inputs.mode === 'pr' && (inputs.branch || PR_BRANCH) === target)
      throw new Error(`The PR branch \`${target}\` is the branch it would merge into; set \`branch\`.`);
    // After a deploy of our own llms.txt commit (or of the merged PR), nothing else shipped: regenerating could
    // only reword the file and commit again, deploy again, and so on.
    const deployed = deployedSha(env);
    if (deployed) {
      const touched = await gh.commitFiles(deployed);
      if (touched.length && touched.every((f) => paths.map(repoPath).includes(f))) {
        log(`The deployed commit ${deployed.slice(0, 7)} only changed ${touched.join(', ')}; nothing to regenerate.`);
        summary.push(`### llms.txt for ${inputs.url}`, '', `Skipped: the deployed commit \`${deployed.slice(0, 7)}\` only changed ${touched.map((f) => `\`${f}\``).join(', ')}.`, '');
        return true;
      }
    }
  }

  // Generate.
  const gen = await generate(inputs.url, { mode: 'llms', fresh: inputs.fresh, generated: inputs.generated }, deps);
  outputs.tokens = String(gen.tokens);
  outputs.source = gen.source;
  outputs.pages = String(gen.pages);
  const files = { [inputs.path]: gen.text };
  log(`Generated llms.txt (${gen.source}, ${gen.pages} links, ~${gen.tokens} tokens)`);
  if (inputs.fullPath && inputs.mode !== 'comment') {
    const full = await generate(inputs.url, { mode: 'full', fresh: inputs.fresh, generated: inputs.generated }, deps);
    files[inputs.fullPath] = full.text;
    log(`Generated llms-full.txt (${full.source}, ${full.pages} pages, ~${full.tokens} tokens)`);
  }

  const local = (p) => (existsSync(at(p)) ? readFileSync(at(p), 'utf8') : null);
  const writeAll = () => {
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(dirname(at(p)), { recursive: true });
      writeFileSync(at(p), text);
      log(`Wrote ${p}`);
    }
    outputs.path = inputs.path;
  };

  // Baseline for `changed` and the section diff: the local file (write, comment) or the file on the target
  // branch (commit, pr).
  const before = {};
  for (const p of Object.keys(files)) before[p] = gh ? await gh.file(repoPath(p), target) : local(p);
  const changed = Object.entries(files).some(([p, text]) => before[p] !== text);
  outputs.changed = String(changed);
  const diff = diffSections(before[inputs.path], gen.text);
  log(before[inputs.path] == null ? `${inputs.path} is new.` : `${describeDiff(diff)} in ${inputs.path}.`);

  const facts = [
    ['Mode', `\`${inputs.mode}\``],
    ['Source', gen.source === 'native' ? 'The site’s own llms.txt (copied)' : 'Generated by llms.ink'],
    ['Tokens', `${gen.tokens}${before[inputs.path] != null ? ` (was ~${tokensOf(before[inputs.path])})` : ''}`],
    ['Sections', String(countSections(gen.text))],
    ['Links', String(gen.pages)],
  ];

  if (inputs.mode === 'write') {
    writeAll();
    facts.push(['File', `\`${inputs.path}\` ${changed ? 'updated' : 'unchanged'}`]);
  } else if (inputs.mode === 'commit') {
    writeAll();
    if (changed) {
      const parent = await gh.branchSha(target);
      if (!parent) throw new Error(`Branch \`${target}\` doesn’t exist.`);
      const sha = await gh.commit(parent, repoFiles(files), inputs.commitMessage);
      if (sha) {
        await gh.setBranch(target, sha);
        log(`Committed ${sha.slice(0, 7)} to ${target}`);
        facts.push(['Commit', `\`${sha.slice(0, 7)}\` on \`${target}\``]);
      }
    } else facts.push(['Commit', `None: \`${inputs.path}\` on \`${target}\` is current`]);
  } else if (inputs.mode === 'pr') {
    writeAll();
    const head = inputs.branch || PR_BRANCH;
    if (changed) {
      const body = prBody(inputs, gen, diff, before[inputs.path]);
      const { pr, pushed } = await proposePull(gh, { head, base: target, files: repoFiles(files), message: inputs.commitMessage, body });
      log(pushed ? `Pushed ${pushed.slice(0, 7)} to ${head}` : `${head} already has this llms.txt`);
      outputs['pr-url'] = pr.html_url;
      log(`Pull request: ${pr.html_url}`);
      facts.push(['Pull request', pr.html_url]);
    } else {
      const pr = await gh.openPull(head, target);
      if (pr) outputs['pr-url'] = pr.html_url;
      facts.push(['Pull request', `None needed: \`${inputs.path}\` on \`${target}\` is current`]);
    }
  } else {
    // comment
    const number = pullNumber(env);
    const body = commentBody(inputs, gen, diff, before[inputs.path]);
    if (!number) annotate('warning', 'llms.ink', '`mode: comment` runs on pull_request events; no comment posted.');
    else {
      try {
        const c = await github().stickyComment(number, marker(inputs.path), body);
        log(`Comment: ${c.html_url}`);
        facts.push(['Comment', c.html_url]);
      } catch (err) {
        // Differences never fail the job; neither does a token that can't comment (PRs from forks).
        annotate('warning', 'llms.ink', `Couldn’t comment on #${number}: ${err.message}. The job needs \`pull-requests: write\`.`);
      }
    }
  }

  summary.push(`### llms.txt for ${inputs.url}`, '', '| | |', '|---|---|', ...facts.map(([k, v]) => `| ${k} | ${v} |`), '');
  summary.push(before[inputs.path] == null ? `\`${inputs.path}\` is new.` : `${describeDiff(diff)} in \`${inputs.path}\`.`, '');
  if (before[inputs.path] != null && !diff.identical) summary.push(diffTable(diff), '');
  return true;
}

/**
 * `aeo`: the agent's-eye report as annotations, job summary and (on pull requests) one sticky comment; with
 * `autofix`, a pull request with its robots.txt, _headers and llms.txt fixes; with `issue`, one tracking issue
 * that stays open while the report has problems. Fails per `aeo-fail-on`.
 */
async function aeoMode({ inputs, env, deps, log, annotate, summary, outputs, github }) {
  if (!AEO_FAIL_ON.includes(inputs.aeoFailOn)) throw new Error(`\`aeo-fail-on\` must be one of ${AEO_FAIL_ON.join(', ')}; got \`${inputs.aeoFailOn}\`.`);
  const r = await report(inputs.url, deps);
  const { pass = 0, warn = 0, fail = 0, info = 0 } = r.summary ?? {};
  outputs['aeo-fail'] = String(fail);
  outputs['aeo-warn'] = String(warn);
  for (const c of checksOf(r)) {
    if (c.status !== 'fail' && c.status !== 'warn') continue;
    const level = c.status === 'warn' || inputs.aeoFailOn === 'none' ? 'warning' : 'error';
    annotate(level, `${c.sectionTitle ?? c.section}: ${c.title}`, `${c.detail ?? ''}${c.fix?.summary ? ` Fix: ${c.fix.summary}` : ''}`.trim());
  }
  log(`Report for ${r.url ?? inputs.url}: ${fail} failed, ${warn} warnings, ${pass} passed, ${info} notes.`);
  const body = reportMarkdown(inputs.url, r);
  summary.push(body);

  const number = pullNumber(env);
  if (number) {
    try {
      const comment = await github().stickyComment(number, aeoMarker(inputs.url), `${aeoMarker(inputs.url)}\n${body}`);
      log(`Comment: ${comment.html_url}`);
    } catch (err) {
      annotate('warning', 'llms.ink', `Couldn’t comment on #${number}: ${err.message}. The job needs \`pull-requests: write\`.`);
    }
  }

  // Off pull requests (a schedule, a deploy): one issue holds the current problems and closes when they are gone.
  if (inputs.issue && !number) {
    const marker = aeoMarker(inputs.url);
    const problems = aeoFailed(r, inputs.aeoFailOn === 'warn' ? 'warn' : 'fail');
    try {
      const gh = github();
      const open = await gh.markedIssue(AEO_LABEL, marker);
      const text = `${marker}\n${body}`;
      if (problems) {
        const title = `AI agents can’t fully read ${new URL(r.url ?? inputs.url).host}: ${fail} failed, ${warn} warning${warn === 1 ? '' : 's'}`;
        const issue = open ? (open.body === text && open.title === title ? open : await gh.updateIssue(open.number, { title, body: text })) : await gh.createIssue(title, text, AEO_LABEL);
        outputs['issue-url'] = issue.html_url;
        log(`Issue: ${issue.html_url}`);
      } else if (open) {
        await gh.commentOn(open.number, `Every check passes now${r.checkedAt ? ` (checked ${r.checkedAt})` : ''}: [full report](${reportLink(r.url ?? inputs.url)}).`);
        await gh.updateIssue(open.number, { state: 'closed', state_reason: 'completed' });
        outputs['issue-url'] = open.html_url;
        log(`Closed: ${open.html_url}`);
      }
    } catch (err) {
      annotate('warning', 'llms.ink', `Couldn’t update the tracking issue: ${err.message}. The job needs \`issues: write\`.`);
    }
  }

  if (inputs.autofix) {
    const gh = github();
    const target = await currentBranch(env, inputs, gh);
    const head = inputs.branch || AEO_BRANCH;
    if (head === target) throw new Error(`The autofix branch \`${target}\` is the branch it would merge into; set \`branch\`.`);
    const baseSha = await gh.branchSha(target);
    if (!baseSha) throw new Error(`Branch \`${target}\` doesn’t exist.`);
    const { files, applied, skipped } = fixFiles(r, { dir: inputs.autofixDir, repoFiles: Object.keys(await gh.blobs(baseSha)) });
    for (const { check: c, reason } of skipped) log(`Not applied: ${c.title} (${reason}).`);
    const changes = {};
    for (const [path, content] of Object.entries(files)) if ((await gh.file(path, target)) !== content) changes[path] = content;
    const fixes = applied.filter((c) => c.path in changes);
    if (fixes.length) {
      const { pr } = await proposePull(gh, { head, base: target, files: changes, message: inputs.commitMessage, body: fixBody(inputs.url, fixes, skipped) });
      outputs.changed = 'true';
      outputs['pr-url'] = pr.html_url;
      log(`Autofix pull request: ${pr.html_url}`);
      summary.push(`Autofix: ${pr.html_url} changes ${Object.keys(changes).map((p) => `\`${p}\``).join(', ')}.`, '');
    } else {
      const pr = await gh.openPull(head, target);
      if (pr) outputs['pr-url'] = pr.html_url;
      log(applied.length ? `Autofix: \`${target}\` already has every fix.` : 'Autofix: no robots.txt, _headers or llms.txt fixes in the report.');
      summary.push(`Autofix: nothing to change${skipped.length ? ` (${skipped.length} fix${skipped.length === 1 ? '' : 'es'} need a hand edit)` : ''}.`, '');
    }
  }
  return !aeoFailed(r, inputs.aeoFailOn);
}

/** `context`: run `llms-ink context`, then propose `.context/` and the AGENTS.md block as a pull request when they changed. */
async function contextMode({ inputs, env, exec, log, summary, outputs, cwd, github }) {
  const dir = repoPath(inputs.contextDir);
  const agentsMd = inputs.agentsMd ? repoPath(inputs.agentsMd) : '';
  for (const m of inputs.manifests) repoPath(m);
  if (!/^\d+$/.test(inputs.contextMax) || Number(inputs.contextMax) < 1) throw new Error('`context-max` must be a positive whole number.');
  const gh = github();
  const target = await currentBranch(env, inputs, gh);
  const head = inputs.branch || CONTEXT_BRANCH;
  if (head === target) throw new Error(`The context branch \`${target}\` is the branch it would merge into; set \`branch\`.`);

  const args = contextArgs({ manifests: inputs.manifests, dir, max: inputs.contextMax, agentsMd });
  log(`Running npx ${args.join(' ')}`);
  const childEnv = { ...env, ...(inputs.apiKey ? { LLMS_INK_KEY: inputs.apiKey } : {}) };
  const code = await exec('npx', args, { cwd, env: childEnv });
  if (code !== 0) throw new Error(`\`llms-ink context\` exited with code ${code}.`);

  const baseSha = await gh.branchSha(target);
  if (!baseSha) throw new Error(`Branch \`${target}\` doesn’t exist.`);
  const changes = contextChanges(cwd, { dir, agentsMd }, await gh.blobs(baseSha));
  const paths = Object.keys(changes).sort();
  outputs.changed = String(paths.length > 0);
  const lines = paths.map((p) => `- \`${p}\` ${changes[p] === null ? 'removed' : 'updated'}`);
  if (paths.length) {
    const body = [
      `Refreshed version-pinned docs for this repo's dependencies with [llms.ink](https://llms.ink) (\`llms-ink context\`): sources are listed in each file.`,
      '',
      ...lines,
      '',
      'Opened by [lukax/llms-txt-action](https://github.com/lukax/llms-txt-action). Later runs update this branch and PR.',
    ].join('\n');
    const { pr } = await proposePull(gh, { head, base: target, files: changes, message: inputs.commitMessage, body });
    outputs['pr-url'] = pr.html_url;
    log(`Pull request: ${pr.html_url}`);
    summary.push(`### ${heading(inputs)}`, '', `${paths.length} file${paths.length === 1 ? '' : 's'} changed: ${pr.html_url}`, '', ...lines, '');
  } else {
    const pr = await gh.openPull(head, target);
    if (pr) outputs['pr-url'] = pr.html_url;
    log(`\`${dir}\` on \`${target}\` is current.`);
    summary.push(`### ${heading(inputs)}`, '', `No changes: \`${dir}\`${agentsMd ? ` and \`${agentsMd}\`` : ''} on \`${target}\` are current.`, '');
  }
  return true;
}

/**
 * IndexNow: `indexnow-urls`, or the pages the deployed (or pushed) commit changed, matched against the sitemap.
 * Checks the key file first. Failures fail the job with the reason.
 */
async function indexNow({ inputs, env, fetch, log, annotate, summary, outputs, github }) {
  const site = new URL(/^https?:\/\//i.test(inputs.url) ? inputs.url : `https://${inputs.url}`).origin;
  const lines = [`### IndexNow for ${site}`, ''];
  try {
    const keyFile = await checkKey(fetch, { key: inputs.indexnowKey, site, keyLocation: inputs.indexnowKeyLocation });
    let urls;
    if (inputs.indexnowUrls) {
      urls = parseUrls(inputs.indexnowUrls, site);
      lines.push(`${urls.length} URL${urls.length === 1 ? '' : 's'} from \`indexnow-urls\`.`);
    } else {
      const sha = deployedSha(env) ?? (env.GITHUB_EVENT_NAME === 'push' ? env.GITHUB_SHA : null);
      if (!sha) {
        annotate('warning', 'IndexNow', 'No `indexnow-urls` and no deployed or pushed commit to read changes from: nothing submitted.');
        summary.push(...lines, 'Nothing submitted: no `indexnow-urls`, and this event has no deployed commit.', '');
        outputs['indexnow-submitted'] = '0';
        return true;
      }
      const files = await github().commitFiles(sha);
      const pages = await sitemapUrls(fetch, site);
      urls = changedUrls(files, pages);
      lines.push(`${files.length} file${files.length === 1 ? '' : 's'} changed in \`${sha.slice(0, 7)}\`; ${urls.length} of ${pages.length} sitemap URLs match.`);
    }
    if (!urls.length) {
      log('IndexNow: no changed URLs to submit.');
      outputs['indexnow-submitted'] = '0';
      summary.push(...lines, '', 'Nothing submitted.', '');
      return true;
    }
    const { sent, dropped } = await submit(fetch, {
      key: inputs.indexnowKey,
      site,
      keyLocation: inputs.indexnowKeyLocation ? keyFile : undefined,
      urls,
      endpoint: env.INDEXNOW_API || INDEXNOW_API,
    });
    outputs['indexnow-submitted'] = String(sent);
    log(`IndexNow: submitted ${sent} URL${sent === 1 ? '' : 's'}${dropped ? ` (${dropped} on other hosts skipped)` : ''}.`);
    const shown = urls.slice(0, 50).map((u) => `- ${u}`);
    summary.push(...lines, '', `Submitted ${sent}${dropped ? ` (${dropped} on other hosts skipped)` : ''}:`, '', ...shown, ...(urls.length > 50 ? [`- … and ${urls.length - 50} more`] : []), '');
    return true;
  } catch (err) {
    if (!(err instanceof IndexNowError)) throw err;
    annotate('error', 'IndexNow', err.message);
    summary.push(...lines, `Failed: ${err.message}`, '');
    return false;
  }
}

const repoFiles = (files) => Object.fromEntries(Object.entries(files).map(([p, t]) => [repoPath(p), t]));
const marker = (path) => `<!-- llms-txt-action:${path} -->`;

/** The branch commit/pr mode works against: `branch` (commit mode), the pushed branch, or the default branch. */
async function currentBranch(env, inputs, gh) {
  if (inputs.mode === 'commit' && inputs.branch) return inputs.branch;
  if (env.GITHUB_HEAD_REF && inputs.mode === 'commit') return env.GITHUB_HEAD_REF;
  if (env.GITHUB_REF?.startsWith('refs/heads/')) return env.GITHUB_REF.slice('refs/heads/'.length);
  return gh.defaultBranch();
}

/** The event payload, or {} when there is none. */
function payload(env) {
  try {
    return JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) ?? {};
  } catch {
    return {};
  }
}

/** The PR number of a pull_request / pull_request_target event, or null. */
function pullNumber(env) {
  if (!['pull_request', 'pull_request_target'].includes(env.GITHUB_EVENT_NAME)) return null;
  return payload(env).pull_request?.number ?? null;
}

/** The commit a deployment_status or workflow_run event is about, or null for other events. */
function deployedSha(env) {
  if (env.GITHUB_EVENT_NAME === 'deployment_status') return payload(env).deployment?.sha ?? null;
  if (env.GITHUB_EVENT_NAME === 'workflow_run') return payload(env).workflow_run?.head_sha ?? null;
  return null;
}

function prBody(inputs, gen, diff, before) {
  return [
    `Regenerated \`${inputs.path}\`${inputs.fullPath ? ` and \`${inputs.fullPath}\`` : ''} from ${inputs.url} with [llms.ink](https://llms.ink): ~${gen.tokens} tokens, ${countSections(gen.text)} sections, ${gen.pages} links.`,
    '',
    before == null ? `\`${inputs.path}\` is new.` : `${describeDiff(diff)}.`,
    '',
    before != null ? diffTable(diff) : '',
    '',
    'Opened by [lukax/llms-txt-action](https://github.com/lukax/llms-txt-action). Later runs update this branch and PR.',
  ].join('\n');
}

function commentBody(inputs, gen, diff, before) {
  const head = [
    marker(inputs.path),
    `### llms.txt for ${inputs.url}`,
    '',
    `[llms.ink](https://llms.ink) ${gen.source === 'native' ? 'copied the site’s own llms.txt' : 'generated llms.txt'}: **~${gen.tokens} tokens**${before != null ? ` (\`${inputs.path}\` has ~${tokensOf(before)})` : ''}, ${countSections(gen.text)} sections, ${gen.pages} links.`,
    '',
  ];
  if (before == null) head.push(`\`${inputs.path}\` isn’t in the repository yet.`);
  else if (diff.identical) head.push(`No section changes against \`${inputs.path}\`.`);
  else head.push(`${describeDiff(diff)} against \`${inputs.path}\`:`, '', diffTable(diff));
  let text = gen.text;
  const room = COMMENT_LIMIT - head.join('\n').length - 200;
  if (text.length > room) text = `${text.slice(0, Math.max(0, room))}\n… (truncated)`;
  const f = fence(text);
  return [...head, '', '<details><summary>Generated llms.txt</summary>', '', `${f}markdown`, text.trimEnd(), f, '', '</details>'].join('\n');
}

const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');

/** `file`: the workspace file that was checked (POST), or null for the live site. */
function checkSummary(label, r, summary, file = null) {
  summary.push(
    `### llms.txt check for ${label}`,
    '',
    '| | |',
    '|---|---|',
    `| File | ${file ? `\`${file}\` (links resolved against ${r.url ?? 'nothing'})` : r.found ? r.url : `Not found (HTTP ${r.status}) at ${r.url}`} |`,
    `| Result | ${checkFailed(r) ? 'Failed' : 'Passed'}: ${r.summary.errors} errors, ${r.summary.warnings} warnings |`,
    `| Tokens | ${r.tokens} |`,
    `| Sections | ${r.sections} |`,
    `| Links | ${r.links.total} (${r.links.checked} checked, ${r.links.broken.length} broken) |`,
    `| llms-full.txt | ${r.llmsFull == null ? 'Not checked' : r.llmsFull ? 'Published' : 'Not published'} |`,
    '',
  );
  const p = r.parsed;
  if (p) {
    summary.push(`**Outline:** ${p.title ? cell(p.title) : '(no title)'}${p.summary ? ` — ${cell(p.summary)}` : ''}`, '');
    if (p.sections.length) {
      summary.push('| Section | Links | Line |', '|---|---|---|');
      for (const s of p.sections) {
        summary.push(`| ${cell(s.name)}${s.optional ? ' (optional)' : ''} | ${s.links.length} | ${s.links[0]?.line ?? ''} |`);
      }
      summary.push('');
    }
  }
  if (r.issues.length) {
    summary.push('| Level | Check | Line | Message |', '|---|---|---|---|');
    for (const i of r.issues) summary.push(`| ${i.level} | \`${i.code}\` | ${i.line ?? ''} | ${i.message.replace(/\|/g, '\\|')} |`);
    summary.push('');
  }
  if (r.links.broken.length) {
    summary.push('Broken links:', '', ...r.links.broken.map((b) => `- ${b.url} (HTTP ${b.status || 'no answer'})`), '');
  }
}

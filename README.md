# Generate llms.txt with llms.ink

A GitHub Action that writes an [llms.txt](https://llmstxt.org) for your website, docs or repo, so ChatGPT, Claude, Cursor
and other AI tools can find the pages worth reading, and keeps it current: write it before a build, commit it after a
deploy, open a weekly pull request, check the published file in CI, or comment the changes on pull requests. It calls
the free [llms.ink](https://llms.ink) API; an API key is optional.

- **Websites and docs:** a summary and sections of the most useful links, found on the page, in its sitemap and in its links.
- **GitHub repos:** the README plus every documentation file, linked as raw Markdown.
- **llms-full.txt** (optional): the same index followed by the full Markdown of up to 20 linked pages.
- **What agents see** (`mode: aeo`): llms.ink's agent's-eye report on pull requests, failing on problems, with an
  optional pull request fixing robots.txt, `_headers` and llms.txt.
- **IndexNow on deploy** (`indexnow-key`): changed pages submitted to Bing, Yandex, Seznam, Naver, Yep and others.
- **Dependency docs** (`mode: context`): version-pinned docs for what the repo imports, in `.context/`, as pull requests.

```yaml
- uses: lukax/llms-txt-action@v1
  with:
    url: https://example.com
    path: public/llms.txt
    full-path: public/llms-full.txt   # optional
```

## Modes

| `mode` | What it does | Fails the job when |
|---|---|---|
| `write` (default) | Writes `path` (and `full-path`) in the workspace. | llms.ink returns an error. |
| `commit` | Writes the files, then commits them to the branch the workflow runs on (or `branch`) when they changed. | llms.ink or GitHub returns an error. |
| `pr` | Writes the files, then pushes them to the branch `llms-ink/llms-txt` (or `branch`) and opens a pull request, or updates the open one. | llms.ink or GitHub returns an error. |
| `check` | Checks llms.txt (format at llmstxt.org, first 25 links): the one the site publishes, or the file at `path` in the checkout when you set `path` (see `check-target`). Writes nothing. | The file is missing, has format errors, or has broken links. Warnings don't fail. |
| `comment` | On a pull request: generates llms.txt, compares it with `path` in the repository section by section, and posts one comment (updated on every run). Writes nothing. | llms.ink returns an error. Differences never fail it. |
| `aeo` | Reads `url` the way AI agents do ([llms.ink report](https://llms.ink/report/): bot access, raw-HTML visibility, Markdown, agent files, hidden instructions). Annotations, a job summary, and on pull requests one comment updated on every run. With `autofix: true`, also opens or updates a pull request applying the report's robots.txt, `_headers` and llms.txt fixes. | Any check fails (`aeo-fail-on: fail`, default), also on warnings (`warn`), or never (`none`). |
| `context` | Runs the pinned CLI 0.7.2 in the checkout: version-pinned docs for the dependencies the repo imports, in `context-dir`, indexed in `agents-md`. Opens or updates a pull request from `llms-ink/context` when they changed. | The CLI or GitHub returns an error. |
| `inspect` | Explicitly uploads the named `inspect-paths`; writes receipt metadata and a job summary. | Findings, incomplete inspection, invalid inputs/receipts or service failure. |
| `inspect-context` | Explicitly uploads the entire `inspect-dir`, creates a fresh CLI manifest and verifies the current pack. | Findings, incomplete/unattempted files, changed or invalid packs, interruption or service failure. |
| `indexnow` | Only the IndexNow step (see `indexnow-key`), without generating anything. | The key file is missing or IndexNow rejects the submission. |

`commit` and `pr` work through the GitHub API, so they don't need a local `git` identity, and each run makes at most one
commit. In `pr` mode the branch is rebuilt on top of the base branch every run, so the pull request always holds one
commit.

### Permissions

| `mode` | `permissions:` | Also |
|---|---|---|
| `write` | none | `actions/checkout` if a later step builds from the file |
| `commit` | `contents: write` | |
| `pr` | `contents: write`, `pull-requests: write` | Settings → Actions → General → **Allow GitHub Actions to create and approve pull requests** |
| `check` | none | |
| `comment` | `pull-requests: write` | `actions/checkout`, to read the committed file. On pull requests from forks the token can't comment: the job warns and passes. |
| `aeo` | none; `pull-requests: write` to comment; `contents: write` and `pull-requests: write` with `autofix` | |
| `context` | `contents: write`, `pull-requests: write` | `actions/checkout` and manifests/lockfiles; the pull request setting above |
| `inspect` | `contents: read` for checkout | An inspection-enabled key and explicit `inspect-paths`; no GitHub writes |
| `inspect-context` | `contents: read` for checkout | An inspection-enabled key and explicit `inspect-dir`; no GitHub writes |
| `indexnow` | `contents: read` | |

`indexnow-key` works in non-inspection modes: after the mode's work succeeds, the action checks that `https://<site>/<key>.txt`
holds the key, then submits `indexnow-urls`, or else the pages the deployed (`deployment_status`, `workflow_run`) or
pushed commit changed, matched by path against the site's sitemap (`src/pages/docs/intro.mdx`,
`content/docs/intro.md` → `/docs/intro/`; components, styles and config match nothing, so a shared change doesn't
resubmit the whole site). IndexNow doesn't reach Google, and nobody confirms it helps ChatGPT; it keeps Bing and
Copilot current cheaply.

Commits and pull requests made with the default `GITHUB_TOKEN` don't start other workflows (your host's own Git
integration, such as Vercel, Netlify or Cloudflare Pages, still deploys them). To start workflows, pass a personal
access token or a GitHub App token as `token`.

## Examples

### Ship llms.txt with every deploy

Generate it into your static folder before the build, so each deploy publishes a current file:

```yaml
name: Deploy
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: lukax/llms-txt-action@v1
        with:
          url: https://example.com
          path: public/llms.txt
      - run: npm ci && npm run build
      # … your deploy step
```

The file describes the site as it is live when the job runs, so pages you add show up from the next deploy on.

### Regenerate after each deploy

Run when a deployment succeeds, so the file describes what actually shipped, and commit it to the branch that deploys.
With `deployment_status` (Vercel, Netlify, Cloudflare Pages and GitHub Pages environments all report one):

```yaml
name: llms.txt
on: deployment_status

permissions:
  contents: write

jobs:
  llms:
    if: github.event.deployment_status.state == 'success' && github.event.deployment.environment == 'Production'
    runs-on: ubuntu-latest
    steps:
      - uses: lukax/llms-txt-action@v1
        with:
          url: https://example.com
          path: public/llms.txt
          mode: commit
          branch: main
          api-key: ${{ secrets.LLMS_INK_KEY }}
```

Or after your own deploy workflow, with `workflow_run`:

```yaml
name: llms.txt
on:
  workflow_run:
    workflows: [Deploy]
    types: [completed]
    branches: [main]

permissions:
  contents: write

jobs:
  llms:
    if: github.event.workflow_run.conclusion == 'success'
    runs-on: ubuntu-latest
    steps:
      - uses: lukax/llms-txt-action@v1
        with:
          url: https://example.com
          path: public/llms.txt
          mode: commit
```

The commit deploys again. On that run the action sees that the deployed commit only changed the llms.txt files and
stops without calling llms.ink, so a deploy never loops. The environment name in the first example depends on your
host (`Production` on Vercel); check it under your repository's Deployments.

### Weekly pull request

Open a pull request when the file changed, and keep updating it until someone merges it:

```yaml
name: llms.txt
on:
  schedule:
    - cron: '0 6 * * 1'
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write

jobs:
  llms:
    runs-on: ubuntu-latest
    steps:
      - id: llms
        uses: lukax/llms-txt-action@v1
        with:
          url: https://example.com
          path: public/llms.txt
          mode: pr
      - if: steps.llms.outputs.changed == 'true'
        run: echo "Review ${{ steps.llms.outputs.pr-url }}"
```

To commit straight to the default branch instead, use `mode: commit` with `permissions: contents: write`.

### Comment on pull requests

Show reviewers how the live site's llms.txt differs from the committed one: sections added, removed and changed, and the
token count, in one comment that each push updates:

```yaml
name: llms.txt preview
on: pull_request

permissions:
  contents: read
  pull-requests: write

jobs:
  llms:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: lukax/llms-txt-action@v1
        with:
          url: https://example.com
          path: public/llms.txt
          mode: comment
          fresh: false
```

`fresh: false` reuses llms.ink's copy from the last 24 hours, so busy pull requests don't spend quota on every push.

### Gate pull requests on llms.txt

With the repository checked out and `path` set, `check` mode lints that file before you deploy it: format errors
and broken links fail the pull request, with annotations on the file's lines. `url` resolves relative links and is
where llms-full.txt is looked for.

```yaml
name: Check llms.txt
on:
  pull_request:
    paths: [public/llms.txt]

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: lukax/llms-txt-action@v1
        with:
          url: https://example.com
          path: public/llms.txt
          mode: check
```

`path` is what turns this on: without it, `check` mode keeps checking the live site. `links: false` checks only the
format. `check-target: file` fails when the file is missing instead of falling back to
the site.

### Gate CI on the published llms.txt

Without `path` (or with `check-target: live`), `check` mode checks what the site publishes. Fail when it's
missing, breaks the format, or links to pages that don't load:

```yaml
name: Check llms.txt
on:
  schedule:
    - cron: '0 6 * * *'
  workflow_dispatch:

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: lukax/llms-txt-action@v1
        with:
          url: https://example.com
          mode: check
```

Errors and warnings show up as annotations on the run, and the job summary lists every check and the file's outline
(title, summary, sections and their link counts). Checks don't count against the daily quota.

### What agents see, on every pull request

Report on the preview deploy (or production) the way GPTBot, ClaudeBot and ChatGPT-User read it, and fail the pull
request when a page went JavaScript-only, robots.txt started blocking a search bot, or `.md` pages stopped serving:

```yaml
name: Agent readiness
on: pull_request

permissions:
  pull-requests: write

jobs:
  aeo:
    runs-on: ubuntu-latest
    steps:
      - uses: lukax/llms-txt-action@v1
        with:
          url: https://example.com/docs/   # or your preview URL
          mode: aeo
          aeo-fail-on: fail                # warn | none
```

Each check that fails or warns becomes an annotation; the job summary and the pull request comment (one, updated on
every push) list them with their fixes and link to the full report. Add `autofix: true` (with `contents: write`) on
a schedule to get a pull request from `llms-ink/aeo-fixes` that applies the fixes the report can write itself:
robots.txt and Content-Signal lines that let search bots in while keeping your training choices, `_headers` (Netlify,
Cloudflare Pages), and llms.txt. Files go next to the existing ones, else in `public/` or `static/`, or in
`autofix-dir`. Nothing else is ever changed; review before merging.

Add `issue: true` (with `issues: write`) on a schedule or after a deploy to hear about problems where the team already
works: one issue labelled `llms-ink` lists the failures with their fixes, is updated in place on every run, and is
closed with a comment when every check passes again. It is never opened on pull requests, which get the comment.

### IndexNow after each deploy

```yaml
name: IndexNow
on: deployment_status

permissions:
  contents: read

jobs:
  indexnow:
    if: github.event.deployment_status.state == 'success' && github.event.deployment.environment == 'Production'
    runs-on: ubuntu-latest
    steps:
      - uses: lukax/llms-txt-action@v1
        with:
          url: https://example.com
          mode: indexnow
          indexnow-key: ${{ vars.INDEXNOW_KEY }}   # also served at https://example.com/<key>.txt
```

Put the key file in your static folder once (`public/<key>.txt` containing the key). Pass `indexnow-urls` to choose
the URLs yourself.

### Dependency docs for coding agents

Weekly, refresh version-pinned docs for the packages your code imports and get a pull request with the diff:

```yaml
name: Dependency docs
on:
  schedule:
    - cron: '0 6 * * 1'
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write

jobs:
  context:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: lukax/llms-txt-action@v1
        with:
          mode: context
          context-max: 10
          api-key: ${{ secrets.LLMS_INK_KEY }}
```

`.context/<package>@<version>.md` files list their sources; AGENTS.md gets a short index between
`<!-- llms-ink:context:start -->` and `<!-- llms-ink:context:end -->`. Packs for removed dependencies are deleted in
the same pull request.

### Use an API key

Without a key, rebuilds share llms.ink's free quota of 60 new links per IP address per day, and GitHub-hosted runners
share IP addresses with everyone else's jobs. A key (`lk_…`) gives your jobs their own quota (1000 a day by default).
[Ask for one](https://lucasespindola.com/message?text=Hi+Lucas%2C+I%E2%80%99d+like+an+llms.ink+API+key+for+the+GitHub+Action+on+...), store it as a repository secret named
`LLMS_INK_KEY`, and pass it in:

```yaml
- uses: lukax/llms-txt-action@v1
  with:
    url: https://example.com
    api-key: ${{ secrets.LLMS_INK_KEY }}
```

An invalid or revoked key fails the job with `401 invalid_key`; the action never falls back to the anonymous quota.

## Inputs

| Input | Default | |
|---|---|---|
| `url` | (required except context/inspection modes) | The site, docs section, page or GitHub repo, e.g. `https://example.com` or `https://github.com/owner/repo`. Not used in `context`, `inspect` or `inspect-context`. |
| `inspect-dir` | (empty) | `inspect-context` only: explicit directory to upload; required, no default. |
| `inspect-paths` | (empty) | `inspect` only: 1–20 explicit file paths, one per line. Do not combine with `inspect-dir`. |
| `path` | `llms.txt` | Where to write llms.txt. In `commit` and `pr` modes, a path inside the repository; in `comment` mode, the file to compare against; in `check` mode, the file to lint (only when set). |
| `full-path` | (empty) | Where to write llms-full.txt. Empty skips it. Not used in `check` and `comment` modes. |
| `fresh` | `true` | Rebuild instead of using llms.ink's 24-hour cache. |
| `mode` | `write` | `write`, `commit`, `pr`, `check`, `comment`, `aeo`, `context`, `indexnow`, `inspect` or `inspect-context` (see [Modes](#modes) and the inspection sections below). |
| `api-key` | (empty) | llms.ink API key, sent as `Authorization: Bearer`. Use `${{ secrets.LLMS_INK_KEY }}`. |
| `generated` | `false` | `true` always generates and never copies the site's own llms.txt. Set it when your /llms.txt is served from llms.ink. |
| `commit-message` | `Update llms.txt` | Commit message in `commit`, `pr` and `context` modes and for `autofix`, and the pull request title (`Update dependency docs in .context` and `Fix agent access (llms.ink report)` when not set). |
| `branch` | (empty) | `commit`: the branch to commit to (default: the branch the workflow runs on, or the default branch). `pr`, `context`, `autofix`: the branch the pull request comes from (default: `llms-ink/llms-txt`, `llms-ink/context`, `llms-ink/aeo-fixes`). |
| `token` | `github.token` | Token for `commit`, `pr`, `comment`, `context`, `aeo` comments and `autofix`, and for reading the deployed commit's changes for IndexNow. |
| `check-target` | `auto` | `check` mode: `auto` lints the file at `path` when `path` is set and the file exists, else checks the site at `url`; `file` always lints the file at `path` (default `llms.txt`; fails when it's missing); `live` always checks the site. |
| `links` | `true` | `check` mode on a file: also check up to 25 linked URLs and llms-full.txt next to `url`. The live check always does. |
| `aeo-fail-on` | `fail` | `aeo` mode: `fail` fails the job on any failed check, `warn` also on warnings, `none` never. |
| `autofix` | `false` | `aeo` mode: open or update a pull request applying the report's robots.txt, `_headers` and llms.txt fixes. |
| `autofix-dir` | (empty) | `autofix`: folder for fixed files. Default: next to the existing file, else `public/` or `static/`, else the root. |
| `issue` | `false` | `aeo` mode, off pull requests: keep one `llms-ink` issue open while the report has failures (warnings too with `aeo-fail-on: warn`); it closes when they are gone. |
| `indexnow-key` | (empty) | After a non-inspection mode succeeds, submit changed URLs to IndexNow. Ignored by `inspect` and `inspect-context`. The key must be served at `https://<site>/<key>.txt`. |
| `indexnow-urls` | (empty) | URLs or paths to submit, one per line or comma-separated. Default: the pages the deployed or pushed commit changed, matched against the sitemap. |
| `indexnow-key-location` | (empty) | The key file's URL or path when it isn't `/<key>.txt` (same host). |
| `context-dir` | `.context` | `context` mode: where the docs go (`--out`). |
| `context-max` | `10` | `context` mode: the most dependencies to document (`--max`). |
| `manifests` | (empty) | `context` mode: manifests or lockfiles to read (`--manifest`), one per line. Default: what the CLI finds. |
| `agents-md` | `AGENTS.md` | `context` mode: the file whose context block is kept current (`--agents-md`); `none` skips it. |

## Outputs

| Output | |
|---|---|
| `changed` | `true` when the new file differs from the previous one: the file in the workspace (`write`, `comment`) or on the branch (`commit`, `pr`); in `context` mode and with `autofix`, when the pull request has changes. `false` in `check` mode. |
| `tokens` | Estimated tokens in llms.txt (in `check` mode, in the published file). |
| `path` | Where llms.txt was written; empty in `check` and `comment` modes. |
| `pr-url` | The pull request opened or updated in `pr` and `context` modes and by `autofix` (or the open one when nothing changed). |
| `issue-url` | `aeo` mode with `issue`: the tracking issue opened, updated or closed by this run (empty when there was nothing to report). |
| `source` | `generated` when llms.ink wrote the file, `native` when the site publishes its own llms.txt (copied as is). |
| `pages` | Links in llms.txt. |
| `aeo-fail` | `aeo` mode: checks that failed. |
| `aeo-warn` | `aeo` mode: checks that warned. |
| `indexnow-submitted` | URLs submitted to IndexNow (empty without `indexnow-key`). |

Use `changed` to decide whether a later step should redeploy:

```yaml
- id: llms
  uses: lukax/llms-txt-action@v1
  with:
    url: https://example.com
    path: public/llms.txt
- if: steps.llms.outputs.changed == 'true'
  run: npm run deploy
```

## Job summary

Every run adds a summary to the workflow run page: tokens (and the previous count), sections, links, the commit or pull
request it made, and a table of sections added, removed and changed. `check` mode lists the checker's result, the
outline (sections and link counts), every issue and every broken link.

## Good to know

- **The last line** of a generated file is `<!-- Generated with https://llms.ink -->`. Markdown readers don't show it.
  While it's there, llms.ink knows a published copy is its own output and regenerates it on the next run. Delete it
  once you edit the file by hand: from then on llms.ink treats the file as yours and copies it unchanged.
- **Your own llms.txt wins:** if the site already publishes one written by you, the action copies it instead of
  generating a new one. If your /llms.txt is served from llms.ink (a rewrite or proxy), set `generated: true`.
- **Limits:** without a key, each rebuild counts against llms.ink's free quota of 60 links per IP address per day,
  and GitHub-hosted runners share IP addresses. If a run fails with a quota error, add an `api-key`, set
  `fresh: false` to accept a result up to 24 hours old, or run it less often.
- **Links are real:** the model only picks from links llms.ink actually found, so it can't invent URLs. Its one-line
  descriptions can still be imperfect; review the first file before you publish it.
- **Runner:** the action runs on Node.js 20 or later, which every GitHub-hosted runner has. It has no dependencies.

Also on llms.ink: a [JSON API](https://llms.ink/docs/), an MCP server for agents (`https://llms.ink/mcp`) and a CLI
(`npx @lukax/llms-ink`).

## Development

```sh
npm test                                                     # unit tests, mocked llms.ink and GitHub APIs
node test/harness.mjs url=https://llmstxt.org mode=check     # run action.yml's step locally against llms.ink
node test/harness.mjs --mock --pr 7 mode=comment url=https://acme.test
node test/harness.mjs --mock --pr 7 mode=aeo url=https://acme.test autofix=true   # stubbed report, PR comment, autofix PR
```

The harness maps inputs (with action.yml's defaults) through the step's `env` block, sets the `GITHUB_*` files in a temp
directory, runs the step's script with bash, and prints the outputs, the job summary and the files written. `--mock`
serves llms.ink and the GitHub API from memory.

## License

MIT

Context mode uses the pinned CLI 0.7.2. Generated outputs and the AGENTS file must be regular files without symlinks or hard links. The Action checks all files in the selected context directory, including extra files, before making GitHub changes. A missing pack or invalid UTF-8 fails the job. Snapshots are bounded to 256 files, 8 MiB per file, 32 MiB total, 256 directories and 32 nested directory levels. `agents-md: none` explicitly disables CLI AGENTS updates.

The CLI validates destinations before fetching and checks for edits afterward. Each file is replaced individually; interruption can leave a partially refreshed local pack. Keep the workspace stable during a run: these checks do not isolate it from a process replacing parent directories concurrently. They do not inspect or certify document content.

## Hosted inspection (experimental, v1.4.1)

`mode: inspect` sends **only explicitly selected files** to the llms.ink Inspect API. It needs an inspection-enabled key and is an explicit choice to process that content on llms.ink infrastructure. The local MCP guard remains available for on-device scanning.

```yaml
name: Inspect agent context
on: workflow_dispatch
permissions:
  contents: read
jobs:
  inspect:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: lukax/llms-txt-action@v1.4.2
        id: inspection
        with:
          mode: inspect
          inspect-paths: |
            .context/project.md
            tools.json
          api-key: ${{ secrets.LLMS_INK_INSPECT_KEY }}
```

Replace those paths with 1–20 `.md`, `.txt` or `.json` files you intend to submit. No globs, symlinks or paths outside the checkout; all files are validated before sending. Each encoded JSON request is capped at 128 KiB and the run at 1 MiB. The API inspects up to 8,192 model tokens per request. JSON files are parsed and serialized before inspection, so receipts contain both source and inspected-content digests.

The job fails on flagged content, incomplete inspection, missing credentials, exhausted quota, network failure or an invalid receipt. `no_finding` requires complete coverage and a matching digest; it is not a safety guarantee. Raw content and service error bodies are not written to annotations or summaries.

Outputs: `inspection-clean`, `inspection-flagged`, `inspection-unknown`, and `inspection-report` (a JSON file in the runner's temporary directory). Receipts contain filenames, digests and inspection results, not source text. Upload as an artifact only if you want GitHub to retain that metadata. No exemptions, automatic fixes, PR comments or billing are included in this pilot.

For same-repository PRs, use `pull_request` and keep `contents: read`; fork PRs generally lack the secret and fail inspection. This mode refuses `pull_request_target`. Never run untrusted repository code with an inspection secret. The inspection destination is fixed to `https://llms.ink/api/v0/inspect`; `LLMS_INK_API` does not override it. Capacity errors with a bounded `Retry-After` can retry twice; no response is silently treated as clean.

[Request pilot access, API limits and data handling](https://llms.ink/inspect/). Independent llms.ink integration using Pinata's model, not Pinata's Doorman desktop app.

Inspection receipt parsing uses the shared llms.ink conformance corpus and generated SDK validator. Unknown counters, unsupported revisions and incomplete results cannot pass the job.

## Inspect a context pack (v1.5.0)

Use `inspect-context` to explicitly upload an entire directory and produce a fresh CLI-compatible manifest. It uses the bundled CLI 0.8.0 inspector: no runtime package download or checkout executable. The existing `context` mode still only generates dependency docs.

```yaml
name: Inspect context pack
on: workflow_dispatch
permissions:
  contents: read
jobs:
  inspect:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: lukax/llms-txt-action@v1.5.0
        id: inspection
        with:
          mode: inspect-context
          inspect-dir: .context
          api-key: ${{ secrets.LLMS_INK_INSPECT_KEY }}
```

`inspect-dir` is required and has no default. Every UTF-8 `.md`, `.txt` and `.json` file under that directory is included, including nested files and local notes. JSON is inspected as exact text, including whitespace/BOM. Other file types, symlinks, hard links, invalid inputs or unusable report storage fail before uploads. AGENTS.md outside the selected directory is not included. For a local preview without uploads, run `llms-ink context inspect --dir .context --dry-run` first.

Limits: 64 files, 128 KiB per encoded request, 8 MiB total; the service also limits each file to 8,192 tokens. Requests wait seven seconds between files. This mode makes no automatic retries. Rate limits, service failures and cancellation stop new submissions; flagged and token-limit results remain explicit. Use a stable workspace: these checks do not isolate the job from another process under the same OS account or lock files through later consumption.

The step fails on findings, incomplete results, changed packs or interruption. It verifies the current file set after scanning and retains the fresh report even if a newly added invalid file prevents verification. A temporary private workspace directory is removed after normal completion or graceful interruption. Forced process termination can leave temporary files; normal runner cleanup still applies. No comments, commits, PRs, IndexNow submissions or automatic artifact uploads occur.

| Output | Meaning |
| --- | --- |
| `inspection-report` | Fresh CLI manifest in a private directory under `RUNNER_TEMP`. No source text; filenames and declared source URLs may be sensitive. |
| `inspection-status` | `current`, `stale` or `invalid` local file-set verification. `current` alone does not mean the scan passed. |
| `inspection-recommendation` | `continue` only after successful scan and verification without interruption; otherwise `withhold`. Also require step success. |
| `inspection-clean` | Files completely inspected without findings. These counts describe the scanned snapshot, even if the pack later changes. |
| `inspection-flagged` | Files flagged by the service. |
| `inspection-unknown` | Attempted files without a complete result. |
| `inspection-not-attempted` | Files not submitted after the scan stopped; separate from unknown results. |

The manifest is **unsigned** and can be forged by someone who can edit it. The Action creates a new report rather than accepting one from the checkout. Keep the report trusted; a no-finding receipt does not establish safety or grant tool authority. Source metadata is declared, not verified provenance. Report files use mode 0600 and their directories 0700 on POSIX; Windows privacy depends on directory ACLs. Upload the report as an artifact only when you want GitHub to retain that metadata.

After downloading a trusted report into your working directory, CLI 0.8.0+ can check it offline:

```sh
llms-ink context verify --dir .context --receipt downloaded-manifest.json
```

This checks exact local bytes and supported receipt revisions, not upstream freshness. Use a trusted Action version and workflow; never run untrusted repository code with the inspection secret. This mode rejects `pull_request_target`. Fork PRs without the secret fail rather than bypassing inspection. The known detector gap remains documented in the [Inspect evaluation](https://llms.ink/inspect/evaluation/).

Maintainers: the generated module and source-hash manifest live under `src/generated/`. Regenerate from the llms.ink source checkout with `node scripts/sync-context-inspection.mjs --action /path/to/llms-txt-action`; add `--check` to verify drift. CI compares those source hashes and resulting manifests with the published CLI 0.8.0. Existing generation-mode package tests still use its separate CLI 0.7.2 pin.

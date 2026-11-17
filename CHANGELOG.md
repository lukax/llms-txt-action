# Changelog

## 1.5.1 — 2026-11-17

- With `LLMS_INK_SOURCE: init` in the step's environment (what `llms-ink init` 0.9.1+ writes), requests to llms.ink carry `source=init`, so runs from an install can be counted. No other input or behavior changes.

## 1.5.0 — 2026-11-15

- Add explicit `mode: inspect-context` with required `inspect-dir`. Bundle the CLI 0.8.0 pack inspector; no package installation or checkout executable is used during inspection.
- Save fresh, unsigned CLI manifests and expose local freshness, continue/withhold and unattempted counts. Fail on findings, incomplete results, stale packs or interruption; preserve partial reports where publication succeeds.
- Validate the complete selected pack before uploads, use the fixed API origin, pace requests without retries and clean temporary workspace files. No commits, PRs, comments or IndexNow calls in this mode.
- Check the bundled source hashes against the public CLI and test CLI verification of Action-generated manifests. Existing `context` generation remains pinned to CLI 0.7.2; existing named-file inspection behavior is unchanged.

## 1.4.2 — 2026-11-15

- Pin context generation to CLI 0.7.2, which validates output destinations and locked versions before writing.
- Refuse symlinks, hard links, special files, missing packs and invalid UTF-8 before proposing context changes on GitHub. Bound snapshots to 256 files, 8 MiB per file, 32 MiB total and 32 directory levels.
- Pass `--agents-md none` explicitly when AGENTS updates are disabled.
- Add a regression proving a linked extra file cannot enter a proposed commit. Inspection behavior and receipt contracts are unchanged.

## 1.4.1

- Use the shared SDK receipt validator and conformance corpus.
- Reject unsafe integer counts, nonzero windows on unknown results and incomplete counters labeled as complete flagged coverage.
- Preserve withhold-on-error behavior, explicit uploads and existing workflows.

## 1.4.0

- Add opt-in `mode: inspect` for explicit text/JSON files using the authenticated llms.ink Inspect pilot.
- Fail on findings, incomplete coverage, unavailable service or mismatched receipts.
- Keep source text out of annotations and report artifacts; expose content-bound receipt metadata.
- Restrict file selection, request size and redirects; reject symlinks and `pull_request_target`.
- Existing modes remain unchanged. Hosted inspection requires explicit key enablement.

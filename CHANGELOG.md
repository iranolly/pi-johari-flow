# Changelog

All notable changes to this package are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/).

## [0.1.6] — 2026-11-22

Two requests from the user: keep a record of every page, and stop opening browsers.

### Added

- **Every page writes a sibling `.json` record** (`NN-<kind>.json`) next to the HTML: the full
  spec, phase, kind, title, cwd, package version, timestamp and whether it was opened. A failed
  record never blocks the page — it raises a warning and the page still lands.

### Changed

- **Pages are closed by default.** `flow_page` now opens a browser only with `open:true`; the
  reply carries the `file://` address (plus the record path) so the model hands the link to the
  user instead of stealing focus. The decision page built by `flow_ask` behaves the same and
  announces its address through a notification before the picker blocks the turn.
- Protocol, skill and README updated: "tell the user the page opened" became "paste the address".

### Tests

- 80 checks (was 76): D1b records grow with pages, D1c a record keeps kind/phase/version/spec,
  D2c the reply returns a `file://` url, D2d the default launches no browser.

## [0.1.5] — 2026-11-22

Cleanup requested after a reported nudge loop: the self-check code itself, not just its wiring,
is gone.

### Removed

- `extensions/johari-flow/johari.ts` deleted (SELF_CHECK_* constants, `checkSelfCheck`,
  `describeSelfCheckGap`, `renderSelfCheckMarker`, `selfCheckTemplate`, `selfCheckRules`).
- `selfCheckNags`, `pendingSelfCheck`, `SELFCHECK_ENTRY_TYPE` and their six reset sites removed
  from `index.ts`.

### Note

Behaviour is unchanged from 0.1.4 — 0.1.4 already stopped nudging; this release removes the dead
code so no lookup can find a self-check path. A running host that loaded 0.1.3 keeps the old hook
in memory until it is restarted, not just reloaded in an existing session tree.

### Tests

- 76 checks, unchanged.

## [0.1.4] — 2026-11-22

User request: drop the eight-line self-check that every reply had to end with.

### Changed

- **The self-check is gone.** `message_end` no longer inspects replies, no longer nags the model
  to append 「乔哈里自检」, and no longer records a verdict entry. The protocol and the skill no
  longer ask for the block, so responses stay short.
- `checkSelfCheck` / `describeSelfCheckGap` / `selfCheckRules` remain exported from `johari.ts`
  but are no longer wired into the extension; `selfCheckTemplate` is unused.

### Tests

- 76 checks: E1/E3 now assert that a reply without (or with an empty) self-check block produces
  no nudge.

## [0.1.3] — 2026-11-22

Found while smoke-testing the restarted session: the common `cd <dir> && …`
prefix was treated as a mutation, so a legitimate write into `.pi/` was refused
with the destructive-command wording.

### Fixed

- **A bare `cd`/`pushd`/`chdir` only changes scope.** It is no longer counted as
touching files when its target stays inside the workspace or the temp dir, so
`cd <workspace> && echo hi > .pi/flow/note.md` works again in every pre-approval
phase — while `cd src && rm -rf build` and `cd / && echo hi > .pi/x.md` are still
refused.

### Tests

- 76 checks (was 73): `cd` inside the workspace, `cd` into a subdirectory before a
destructive command, and `cd` out of the workspace before a scratch redirect.

## [0.1.2] — 2026-11-22

Second audit pass: two full code reviews plus a doc-vs-code review, an external
contract check, and a hand-built probe matrix (three phases × 40 shell commands).
Most of this release is gate correctness — the heuristics that decide whether a
command may run.

### Fixed — gates

- **Multi-line shell commands are split before analysis.** `cat README.md` on one
  line and `rm -rf src` on the next used to merge into one segment that the
  read-only short-circuit allowed through.
- **Command substitutions are inspected.** `$(…)`, backticks, `<(…)` and
  `bash -c "…"` payloads are re-parsed as their own segments, so
  `jq . $(rm -rf build)` no longer passes as a read.
- **Option prefixes no longer hide mutations.** `git -C sub commit`,
  `git --git-dir=.git commit`, `npm --prefix . install` are matched.
- **Redirections are parsed character by character and respect quotes.**
  `echo hi > out`, `> out`, Chinese or spaced paths — all counted as file
  writes; `/dev/null` and `>&2` are not.
- **Writes that stay inside `<cwd>/.pi/` are allowed everywhere**, including the
  destructive gate, so the flow never blocks on its own pages or notes. The
  refusal text now states that boundary instead of promising `.md` notes
  anywhere.
- **Read-only words stop hiding destruction.** `find . -delete` and
  `git branch -D` were dead rules behind one `continue`; they are evaluated with
  quoted text stripped, so `rg "rm -rf" docs` still passes.
- **Every write-shaped tool name is gated**, not just `write`/`edit`
  (`ast_grep_replace`, MCP writers, `patch`, `create`, …).

### Fixed — silent failures

- **Concurrent page writes cannot overwrite.** Pages are created with `O_EXCL`
  and retried on `EEXIST`; 12 pages in one turn produce 12 files.
- **State is persisted as a snapshot**, so `/tree` rollback no longer leaves
  every history entry pointing at the live object.
- **A corrupt phase clamps to `idle`** instead of deadlocking the flow with an
  empty transition list.
- **Unknown block kinds render a visible warning card** (listing the 13 valid
  kinds) instead of a blank page.
- **Page failures are reported.** A page that could not be written says so and
  the tool refuses to let the model claim it was shown.
- **`/flow report` refuses the illegal `approved → report` edge.**

### Fixed — page behaviour

- **Option highlighting no longer builds selectors by string concatenation**
  (a quote in an id used to throw and kill every button on the page).
- **Copy-path yields a real Windows path** (`C:\dir\x.html`, not
  `/C:/dir/x.html` or `%20`-escaped text).
- **Loop arrows end where the pills end** instead of a fixed 300px.
- **A page-script syntax error is now a test failure**: one stray escape used to
  disable every interactive feature silently.

### Changed

- `flow_page` no longer opens a browser when there is no interactive UI.
- `openInBrowser` checks the exit code, so "page opened" is not claimed on
  failure.
- The self-check threshold is one number (≥4 non-space characters per label)
  instead of a 4/6/40 mix; `thin` is advisory only.
- `flow_plan` accepts `optionId`, so approval records name the option the user
  actually picked.
- `flow_ask` asks with at least two options and reports `answered:false` instead
  of guessing.

### Added

- 69-check test suite in `tests/` (was 41), including the multi-line,
  substitution, option-prefix, redirection, scratch-exception and
  version-drift cases.
- Changelog/version consistency checks.

## [0.1.1] — 2026-11-22

Product pass after an external audit (code review, doc/contract review, Pi API
check, competitor research). Behaviour changes are marked **changed**.

### Fixed — safety

- **Page CSS can no longer inject markup.** The page-level `css` override is
  sanitised before it reaches the `<style>` element, so a payload containing
  `</style>`, `<script>` or `@import` is stripped instead of executed.
- **File writes are gated in every pre-approval phase**, not just `intent`.
  `write`/`edit` on project files, plus `sed -i`, `perl -pi`, `git apply`,
  `git commit`, `npm install`, `cp`/`mv`/`tee` and redirects to real files, are
  refused until the design is approved. Notes (`.md`/`.txt`/`.log`/`.json`) and
  anything under `.pi/` stay writable so research can still leave traces.
- **Shell commands are judged one segment at a time.** `rg foo && rm -rf src`
  is no longer exempted by the read-only prefix rule.
- **Destructive-command list corrected on both ends.** Added `rm -Rf`,
  `rm --recursive --force`, `git restore .`, `git stash drop`,
  `git reflog expire`, `git push origin +main`, `del /s /q`, `rd /s /q`,
  `drop database`; stopped blocking `git status > /dev/null 2>&1`,
  `npm test >/dev/null` and `awk '$3 > 100'`.
- **`flow_page` no longer reports success when the page was not written.** A
  failed `mkdir`/`writeFile` now returns an explicit failure instead of leaving
  the model believing the user saw a page.
- **`flow_ask` asks even when the page cannot be written**, and no longer opens
  a browser tab in non-interactive runs (`-p`, JSON mode).

### Fixed — correctness

- Concurrent page writes in the same turn no longer overwrite each other
  (atomic `wx` create, next free number on `EEXIST`).
- A session entry carrying an unknown phase is clamped to `idle` instead of
  rendering `undefined` and deadlocking every transition.
- `compare` without `left`/`right`, and `callout` without `text`, render
  instead of throwing.
- An unknown block `kind` now renders a visible warning naming the supported
  kinds, instead of silently producing a blank page.
- Approval records store a real option id instead of the phase name.
- "Copy page path" produces a path that can be pasted into a shell on Windows
  (decoded, drive letter intact).
- Answer buttons are selected by attribute comparison, so a question id with a
  quote can no longer break the page script.
- A failed state persist now warns the user (previously the flow could appear
  to rewind itself after `/resume`).
- Read-only guards recognise `git status|branch|rev-parse|ls-files`,
  `ls`, `jq`, `wc`, `find` and friends, so quoting a dangerous string inside a
  search pattern no longer trips the gate.

### Changed

- **Self-check tolerance:** a dimension now needs 4 non-space characters after
  its label (was 6), so terse-but-real entries like `用词：都用大白话` count.
- Removed an unused `review` artifact kind and its always-empty notification.
- `types.ts` phase edges re-exported through a single `PHASES` import in the
  extension; the whole graph is now type-checked in one place.

### Added

- `tests/` — a 40-check, dependency-free suite (`npm test`). It links the host
  packages that Pi already ships and drives the extension through the same hooks
  Pi does: gates, phase machine, page writing, CSS sanitiser, self-check,
  `flow_ask`, `setGoal`, `abort`.
- `engines`, `files`, `scripts` in `package.json`; this changelog (Pi's update
  prompt reads it).

## [0.1.0] — 2026-11-22

First public release: phase state machine (`idle → intent → research → design →
review → approved → execute → report → done`), three HTML surfaces
(`intent` / `decision` / `report`), 13 visual carriers, per-question single
-choice pages, hard gates, and the eight-dimension self-check validator.

# Changelog

All notable changes to this package are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/).

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

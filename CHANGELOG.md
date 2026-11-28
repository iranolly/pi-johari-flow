# Changelog

All notable changes to this package are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/).

## [0.4.6] — 2026-11-28

The pages were written for a 1080px column and only got their padding squeezed below 720px, so a
phone opened on the title: 30px serif across two or three lines, a sticky bar stacked into three
rows, and the first section pushed off screen.

### Fixed

- **The phone has its own type scale instead of a squeezed desktop one.** Below 720px the title is
  `clamp(22px, 6.1vw, 28px)` at 1.24 line-height (was a flat 30px), the kicker, lede, section
  headings and lead line step down with it, and hero padding drops from 40px to 26px, so the first
  section now starts around 300px instead of 500px. On a 390px screen that moves the title from
  201px down to 91px and cuts a full page from 4598px to 3980px.
- **The sticky bar stops wrapping into three rows.** Below 480px it drops the session/time line and
  the version chip (the footer still carries the version), which leaves brand + kind + phase on one
  row at 390px and two rows at 320px.
- **Touch targets are 40px minimum.** Buttons, TOC pills and choice chips had 29–36px heights.
- **Hover styling no longer sticks after a tap.** Under `@media (hover:none)` the option row keeps
  its resting border instead of staying in the hovered state.
- Tables, pre blocks, quote indents and the toast (now inset from the safe area) got phone-sized
  padding; `viewport-fit=cover` and `text-size-adjust:100%` stop iOS from resizing text on its own.

Desktop rendering is unchanged: screenshots at 1280px are pixel-identical to 0.4.5 outside the
session clock.

### Tests

- 112 checks (was 110): D2o phones cap the title instead of scaling it; D2p the sticky bar drops a
  row on narrow phones.

## [0.4.5] — 2026-11-25

Two pages were reported in one go: a click that never reached the agent, and a state diagram whose
labels were printed on top of each other.

### Fixed

- **An answer with nobody collecting it no longer vanishes.** The inspected session shows the model
  writing the link and ending its turn without calling `flow_wait`; the page then said "已记下" and
  nothing happened. After a five-second grace the answer is now delivered to the session as a user
  message (and recorded as a decision), so a forgotten `flow_wait` costs a few seconds, not the answer.
- **The guidance names every caller.** `flow_wait`'s description and guidelines said "after flow_ask"
  only; they now cover any `flow_page` that returned `awaiting: true`, and the tool result says so in
  as many words.
- **State diagrams measure before they draw.** Labels were capped at a fixed box width while SVG text
  kept drawing at full length, so long labels spilled over their neighbours and the arrow captions
  collided. Labels are now measured (CJK ≈ 12.6px, latin ≈ 6.9px), wrapped onto up to three lines,
  and every gap is sized to the caption that sits in it.
- The answering wire now closes itself when the answer arrives, so a forgotten `flow_wait` can no
  longer keep the process (or the test runner) alive.

### Tests

- 110 checks (was 108): D4 long state labels wrap and boxes do not overlap; I25 an uncollected
  answer is handed to the session.

## [0.4.4] — 2026-11-25

A page that could not reach the wire froze the whole turn: the person pasted the receipt into the
chat, and it sat queued until the wait timed out (or until they pressed stop).

### Fixed

- **While a question is open, anything typed in the chat is the answer.** The `input` hook hands it
  to the waiter, and `flow_wait` returns at once with "用户直接在对话里回答了：…". No more waiting
  out the clock just to say A.
- **The timeout line tells the truth**: the seconds actually waited, or "你把这个问题打断了" when
  the turn was stopped — instead of always claiming the number the caller asked for.
- Verified the page click in a real Chromium, two ways: a `file://` tab and a `srcdoc` iframe with
  `sandbox="allow-scripts"` (what pi-web's panel does). Both deliver the pick, so the wire was
  never the problem — the link form was.

### Tests

- 108 checks (was 105): I23 a chat answer resolves an open question and is recorded as a decision,
  I24 the timeout reports the real wait; I12 follows the new wording.

## [0.4.3] — 2026-11-25

Only `flow_ask` got the two-step treatment in 0.4.0. Every page written by `flow_page` — the intent
page above all — still handed the model an absolute `file://` address to paste verbatim, and had no
wire back: its buttons copied a receipt. So a page that asked a question could not answer it.

### Fixed

- **`flow_page` pages that carry `options` or `questions` are questions too.** The wire is armed
  before the page is rendered, so the page is born able to answer; the reply gets the same
  relative `[打开完整说明](路径)` link `flow_ask` uses, and `flow_wait` collects the click.
- **The reply no longer carries a `file://` address.** A bare `file:` URL is not an autolink, so
  the model's "open this" line was plain text — nothing to click. The tool result now hands back
  the relative link and says to copy it into the reply.
- **Multi-question pages submit as one receipt.** Chrome cannot send one id for N groups, so a
  live questions page gets a submit button (disabled until every group has a pick) and the server
  accepts the receipt text; `flow_wait` records it as the decision.
- `live:false` keeps a page as a read-only archive — and that is the only case where buttons fall
  back to the clipboard receipt.

### Tests

- 105 checks (was 99): I17 a `flow_page` page arms a wire and hands back a relative link;
  I18 a click on that page is the answer; I19 a multi-question page offers one submit;
  I20 a submitted receipt comes back from `flow_wait`; I21/I22 `live:false` leaves no wire.

## [0.4.2] — 2026-11-23

The page read as two columns bolted together: a 64px rail of numbers, a gap, then the text — with
the section's rule running under both. And it explained itself in sentences under every block.

### Changed

- **One column.** The number rides the heading (a small mono `01` before the title) instead of
  sitting in its own rail, so nothing is visually split.
- **The Johari panel is four across** on a wide page, two at ≤1000px, one at ≤640px — no more three
  plus one orphan.
- **The page describes itself by layout, not by prose.** Removed: the "点一项就直接作答…" line, the
  "这一页只有这一次有效…" box, the clipboard explanation, the "复制回执" label on every option, the
  "想补一句理由？（可不写）" label (the placeholder says it), and the English half of the section
  headings. The live status bar now stays invisible until it has something to report.
- The reason box is a full-width field with the placeholder as its only instruction.

### Tests

- 99 checks, unchanged: the page still parses, carries the wire and the note field.

## [0.4.1] — 2026-11-23

A click said *what*, never *why*.

### Added

- **A reason field on the page.** Above the options the live page shows one optional line: "想补一句理由？（可不写）". Whatever is typed travels back with the choice, so `flow_wait` can return
  `他的理由：…` and the decision record keeps it.
- The line is stripped of `|` and newlines before it is sent, capped at 400 characters in the box and
  600 on the server; an empty box changes nothing.

### Tests

- 99 checks (was 98): I16 the note typed on the page comes back, and I6 now proves the live page
  carries the box.

## [0.4.0] — 2026-11-23

The question was a dialog, and the page was a thing the user had to open by hand — or a tab that
stole the screen.

### Changed

- **`flow_ask` now only arms the question.** It writes the decision page, opens the loopback wire
  for that one question, streams the card, and returns. Nothing opens, nothing blocks.
- **`flow_wait` is new**: it waits for the click on the page and returns the chosen option. The pair
  exists so the page link can sit in the agent's own reply — Pi Web opens a local link from the
  agent's prose in its own file panel (which renders the page and runs its script), while a link in
  a tool result only opens a new tab.
- No picker by default, no focus stealing, no extra tab. The host's picker remains the fallback when
  the wire cannot be opened at all.
- Guidance, skill, protocol, README and `docs/interaction.md` describe the two-step and why the link
  must be in the reply.
- An open question is capped at 20 minutes; `flow_wait` gives up after its own timeout (default 600 s)
  and hands the question back untouched instead of guessing.

### Tests

- 98 checks: I9–I11 arming and the link, I12–I14 timeout and cleanup, I15 a click on the written page
  comes back as the decision (the HTML's own endpoint and token are used).

## [0.3.0] — 2026-11-23

A question was only a dialog: the reason and the price sat in a page nobody opened.

### Added

- **A decision card in the conversation.** `flow_ask` sends a partial result as soon as it
  starts: the question, the background, every option with its cost, and which one is
  recommended. It is visible while the picker is open, and the final result replaces it with
  the decision. Works in `-p` / JSON mode too, where the card is all you get.
- **The question is visible outside the dialog.** A widget (`johari · 待拍板`) sits above the
  composer and a footer status line says the same thing; both are cleared on every exit path —
  answer, cancel, timeout, abort.
- `docs/interaction.md`: what pi + pi-web can actually do for a question (dialogs, the orange
  dot and sound, widgets, chat cards, the file panel, the not-yet-wired `custom` channel), and
  the three-layer plan that follows from it.

### Tests

- 102 checks (was 98): I9 the card appears while waiting, I10 the widget is set, I11 the banner
  is cleared, I12 an unanswered question says so.

## [0.2.1] — 2026-11-23

0.2.0 opened a browser tab for every question, which interrupts whatever the user was doing.

### Changed

- **The picker is the default again.** `flow_ask` asks in the chat, through the same dialog the host
  shows for a pending question — in Pi Web that is the orange dot and the sound, not a new tab. No
  listener, no page, nothing to click away.
- **Every choice carries its cost in the picker**, so the dialog is usable without reading a page.
- **`open:true` keeps 0.2.0's page-first mode**: live page, five-minute window, picker as the way out.
  It is now opt-in rather than forced.
- The decision page is still written and reported as an artifact; it is simply not opened for you.

### Tests

- 98 checks (was 97): I8 the picker carries the cost line.

## [0.2.0] — 2026-11-23

A decision page could explain the choice but not accept it: the user read the page, then
went back to the chat and typed `A`.

### Added

- **Clicking an option on the page is the answer.** `flow_ask` starts a loopback-only listener
  (`127.0.0.1`, random port) that lives for exactly one question, bakes its address and a random
  token into the page, and opens the page. A click posts `token|id`; the tool returns that id, so
  the conversation continues without a copy-paste round trip.
- The listener refuses a wrong token (403), an id that was never offered (400), and a second
  answer (409). It closes on answer, on timeout, or when the tool call is aborted.
- The page shows what happened: `已记下：A` on success, and on a dead link
  `没连上对话（这一页可能已经过期）：在对话里直接说 A 也一样`, plus the receipt copy.
- Page-first, picker-second: after five minutes without a click, or when the page cannot be
  opened at all, the terminal picker asks the same question. In `-p` / JSON mode no listener is
  started, so nothing waits for a click that cannot come.
- A saved page stays a read-only archive: it keeps the options and the receipt copy, and says
  plainly that answering now means saying `A` in the chat.

### Tests

- 97 checks (was 90): I1–I7 cover the wire end to end — click reaches the tool, wrong token,
  unknown id, first answer wins, silence times out, live page carries the wire, saved page does not.

## [0.1.9] — 2026-11-23

Report pages still showed machine records, and a picture the model wrote as a link stayed a path.

### Changed

- **A link to a picture renders as the picture**: `[末页实拍](evidence/06-end.png)` becomes a figure
  captioned with the link text; a bare picture path alone on a line does the same. Before, both
  stayed clickable paths — the picture never appeared.
- **Record files never become links or code**: `json` / `log` / `csv` / `ndjson` / `yaml` links and
  paths render as plain text. The reader was never going to open them, and a page should not
  advertise them.
- **Pictures resolve like paths**: project root first, then the page's own folder — evidence kept
  next to the page now loads.
- Protocol, skill and the `flow_page` guidelines say it outright: evidence is a screenshot or a
  readable number, never a record file.

### Tests

- 90 checks (was 88): D2m a link to a picture renders as a picture, D2n a record file never
  becomes a link.

## [0.1.8] — 2026-11-22

Report copy pointed at files the reader could not open: every path was plain text.

### Added

- **Local paths become links.** A path in `body`, `items`, `lead` or a block (`comet-audit/timeline.html`,
  `notes/a.png`, `05-report.html`) renders as an anchor to the real file when the file exists —
  resolved against the project root first, then the page's own folder, so a report can link its
  sibling pages. Missing files stay monospace code, so a wrong path is visible instead of clickable.
- **Bare `https://` URLs are clickable** (markdown links keep working and are never double-wrapped).
- A path inside parentheses — the way these pages usually write evidence — now matches too; before,
  only a space before the path did.

### Tests

- 88 checks (was 85): D2j existing paths become file links, D2k a missing path stays code,
  D2l bare urls become links without double-wrapping.

## [0.1.7] — 2026-11-22

Pages could draw diagrams but never show a picture: there was no image block, and an
`![alt](path)` line in body text came out as a leftover link.

### Added

- **`image` block.** `{kind:"image", images:[{src, caption?, alt?}], caption?}` lays out 1–4
  screenshots in a responsive grid; a single image takes the full width, and a click opens it at
  natural size. `src` is a local path (relative to the project root, or absolute); the file is
  read and inlined as a `data:` URI, so the page stays one offline file that survives being moved
  or mailed.
- **`![alt](path)` on its own line** in `body` / `summary` becomes the same figure.
- Failures stay visible: a missing file, a non-image, an image over 6MB, a page over 24MB, or a
  remote `http(s)` URL (refused on purpose — fetching one would leak that the page was opened)
  each print a warning line where the picture should be, never a blank gap.
- The `.json` record keeps the original path instead of the base64, so records stay small and
  auditable.

### Changed

- Protocol, skill and README list 14 carriers now, `image` among them, with the local-path rule
  spelled out.

### Tests

- 85 checks (was 80): D2e inlining, D2f missing/remote warnings, D2g a renamed text file is
  refused, D2h the markdown form, D2i the record keeps the path.

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

# pi-johari-flow

A delivery workflow for [Pi](https://github.com/earendil-works/pi-coding-agent) that makes the
agent **prove it understood you before it writes anything** — intent page, fact research,
option design, cross review, supervised execution, HTML report. Enforced by hooks, not by good manners.

```bash
pi install git:github.com/iranolly/pi-johari-flow
```

Requires Pi ≥ 1.2 (Node ≥ 22.6). Nothing else — no build step, no server, no network calls.

---

## The problem it solves

A coding agent rarely fails because it cannot type. It fails because:

- it understood something else and started anyway — **blind spot**;
- it knew a risk and stayed quiet — **hidden area**;
- it guessed at something it could have looked up — **unknown area**.

A Johari window is a way to close those three gaps. This package turns that idea into a state
machine: nothing gets written while the intent is unconfirmed, nothing gets executed before you
pick a design, and every user-facing reply ends with the model's *own* eight-dimension
self-check that a hook can verify.

## Quick start

```text
/flow start 把登录页改成手机号 + 验证码登录
```

The agent opens an intent page (`.pi/flow/<session>/01-intent.html`), waits for your answer,
then researches, designs, cross-reviews, and only after you approve does it touch code.
The full browser-driven version: run `/flow start <goal>` and follow the pages.

## How it works

| Phase | What the agent does | What is blocked |
| --- | --- | --- |
| ① intent | mines your goal, opens a confirmation page | every file write, every sub-agent dispatch |
| ② research | read-only fact gathering, each claim carries evidence | project file writes, shell mutations, destructive commands |
| ③ design | ≥2 options with cost and rollback | same as above |
| ④ review | cross review from different angles | same as above |
| ⑤ approved | recorded approval with your words | nothing (gate lifted) |
| ⑥ execute | dispatch → verify → ask → dispatch loop | nothing, but scope changes must be asked |
| ⑦ report | HTML report page, no code, no jargon | finishing without a report |

Phase transitions live in `extensions/johari-flow/types.ts`; anything not in that graph is
refused by `flow_plan`.

## Three tools, one command

| Surface | Purpose |
| --- | --- |
| `flow_plan` | `start` / `setGoal` / `status` / `advance` / `confirm` / `approve` / `abort` |
| `flow_page` | intent, decision and report pages (HTML, offline) |
| `flow_ask` | one decision, terminal picker plus an optional HTML brief — blocks until answered |
| `/flow` | `status` · `start <goal>` · `approve` · `report` · `abort` |

## The pages

Pages are plain HTML written to `.pi/flow/<session>/` and opened in your browser. They carry a
four-quadrant panel (open / blind / hidden / unknown) so you can see what is *assumed*. Decision
pages are a list of **independent single-choice questions** — never one bundled pick — and each
choice copies a paste-ready receipt back into the chat.

Thirteen carriers, picked by the shape of the content: `flow`, `timeline`, `stats`, `bars`,
`compare`, `callout`, `loop`, `facts`, `tree`, `branch`, `sequence`, `graph`, `state`.
Report pages are written for people who never read code: no code blocks, no file names.

## The self-check

Every user-facing reply from the model must end with eight labelled lines: evidence, wording,
framing, assumptions, unknowns, hidden costs, consistency, next step. The hook does not generate
it and does not grade it — it only checks that all eight are present and carry real content, and
nudges (at most twice per phase) when they are not.

## Requirements and graceful degradation

- **Sub-agent dispatch is optional.** If your build exposes a dispatch tool (`Agent`,
  `subagent`, `task`, …) the protocol names it and asks for one agent per angle. If it does not,
  the protocol switches to *degraded self-review*: you review from several angles yourself and
  label the result as degraded on every page.
- **UI is optional.** In `-p` / JSON mode `flow_ask` reports that it could not ask instead of
  pretending; pages are written but no browser tab is opened.

## Comparison

| | pi-johari-flow | Plan mode | Spec-driven kits |
| --- | --- | --- | --- |
| Gate before writing code | hard gate in hooks | advisory | advisory |
| What you confirm | an HTML page you can audit | a prose plan | a markdown spec |
| Evidence trail | per-phase history + page files | none | spec files |
| Cognitive debt surfaced | four quadrants on every page | implicit | implicit |
| Cost | approval tax on multi-file work | low | medium |

The failure mode of workflow tools is not missing features but *output inflation* and *approval
fatigue*. This package tries to pay for its friction: pages replace prose, and questions are
batched into independent single choices instead of a chain of confirmations.

## Security and limits

- Pages are fully offline: no CDN, no fonts, no telemetry, no network access. Page-level CSS is
  sanitised, so a stray model-written stylesheet cannot inject markup.
- Gates are heuristics over tool names and shell text. Read-only commands keep their right to
  quote dangerous strings; genuinely novel ways to write a file can still slip through. Treat the
  gates as a strong seat belt, not as a sandbox.
- `abort` always works: `flow_plan {action:"abort"}` (or `/flow abort`) lifts every gate
  immediately.
- Nothing is sent anywhere. The only files created are under `.pi/flow/` in your workspace
  (add `.pi/` to your `.gitignore` if you do not want them committed).

## Uninstall and cleanup

```bash
pi remove pi-johari-flow      # forget the package
rm -rf .pi/flow               # delete generated pages
```

## Development

```bash
npm test        # 40 checks, no dependencies: node --experimental-strip-types tests/run.mjs
```

The suite links the three host packages Pi already ships and drives the extension through the
same hooks Pi uses (gates, phase machine, page writing, CSS sanitiser, self-check, `flow_ask`,
`setGoal`, `abort`). See `CHANGELOG.md` for what changed in 0.1.1.

## License

MIT © iranolly

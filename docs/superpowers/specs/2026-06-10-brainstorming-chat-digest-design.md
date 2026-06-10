# javis-brainstorming v0.2 — calendar-style Agent Chat digest + end-to-end delivery

**Date:** 2026-06-10
**Status:** Design (approved in brainstorming)
**Scope:** ClawSkills (`brainstorming/`) code + publish/install + end-to-end
verification on the live stack. No javis-server or javisiosapp code changes;
server-side findings (if any) are documented for the server repo.

## Background

When the javis-server session dispatcher auto-runs `calendar-extractor`, the iOS
Agent Chat shows a `[push:calendar-extractor]` bubble followed by a rich Javis
markdown digest of the extracted events. That rendering is driven entirely by
the skill's `POST /api/agent/push {skill, content}` call — iOS renders the
`skill` slug as the `[push:<slug>]` user bubble and the `content` markdown as
the Javis message.

`javis-brainstorming` already calls the same endpoint (`pushNudge`,
`scripts/brainstorming.js`), but:

1. the content is a thin generic nudge ("A new brainstorm card is waiting…")
   with none of the card's substance (goal, request items, sources), and
2. on the user's device **nothing appears at all** — the push chain upstream of
   the skill is suspected broken: the skill may never have been published to
   ClawHub ("local-only" status), an old install would have a dead dispatch
   route (route seeding is silently skipped on slug mismatch; slugs were only
   aligned in PR #16), and the `brainstorm` RouteRegistry row may not exist or
   be enabled on the server.

Calendar-extractor working end-to-end proves the shared stages are healthy:
dispatcher classify→auto-run, `/api/agent/push` → WebSocket → Agent Chat
rendering. The break is in the brainstorming-specific stages.

## Goals

- Agent Chat shows `[push:javis-brainstorming]` + a calendar-style digest of
  the composed brainstorm card whenever the skill pushes (dispatcher auto-run
  and manual runs alike).
- The whole delivery chain verified live: published → installed → route seeded
  and enabled → dispatcher classifies → skill runs → digest on the phone.
- Push failures become diagnosable from the agent run log instead of silent.

## Non-goals

- No iOS changes (the rendering path already exists and is exercised by
  calendar-extractor).
- No javis-server changes implemented here. If verification shows the
  classifier/route catalog is broken server-side, that is documented as a
  finding for the javis-server repo.
- No change to fetch, compose, the to-do-card contract
  (`references/todo-card-contract.md`), the pending Confirm/Discard gate, or
  the dedup model.

## Decisions (from brainstorming)

| # | Decision |
|---|---|
| Digest format | **Option B — card digest, calendar-extractor style.** Header + bold title + 🎯 goal + 📋 request items + 📡 source count + Confirm/Discard footer. The ready-to-paste prompt stays on the card only (not inlined in chat). |
| Scope | **End-to-end.** Skill change + publish + reinstall + verify stages 2–4 of the chain until the digest renders on the user's phone. |
| Digest status | First-class step of `push` (no longer "optional nudge"), but still **non-fatal** — the pending card write remains the primary deliverable. |
| Failure visibility | The push summary line explicitly reports digest delivery (`delivered` / `FAILED: <reason>`). |
| Verification toolchain | `/ssh-remote` (prod server: install state, RouteRegistry, dispatcher logs), **computer-use-mcp** driving the iOS simulator (trigger units, observe Agent Chat), `/xcode-logs` (app-side WS/AGENT_PUSH capture, log-first gate). |
| Version | Bump to **0.2.0** (behavior change, no breaking surface). |

## Design

### 1. Digest formatter (`scripts/lib.js`)

A pure function `formatDigest(card)` (placed in `lib.js`, mirroring where
calendar-extractor keeps its digest formatting) builds the markdown from fields
the normalized card already carries — `title`, `goal`, `request[]`,
`source_refs[]` (`normalizeCard`, `scripts/brainstorming.js`). No upstream or
contract changes are needed.

Output shape:

```markdown
## 🧠 Brainstorm — new card / 新腦力激盪

- **<title>**
  - 🎯 <goal>
  - 📋 <request item 1> · <request item 2> · …
  - 📡 <N> session(s)

✅ **Confirm** in the Calendar tab copies the ready-to-paste Claude prompt · **Discard** drops it.
```

Graceful degradation:

- empty `goal` → omit the 🎯 line;
- empty `request[]` → omit the 📋 line;
- `source_refs` count: `1 session` / `N sessions`; zero refs → omit the 📡 line;
- the header and footer lines are fixed text;
- the card icon is used in place of 🧠 if the agent overrode it.

### 2. Push path (`scripts/brainstorming.js`)

- `pushNudge` → `pushDigest`: same `POST /api/agent/push` call, same
  `{ skill: SLUG, content }` body, content now `formatDigest(card)`. The
  `skill: "javis-brainstorming"` slug is what makes iOS render the
  `[push:javis-brainstorming]` bubble.
- `doPush` keeps the digest **non-fatal**: a digest failure must not prevent
  the pending card write (which happens first) nor fail the run. The final
  summary line changes to report it explicitly:
  - success: `Wrote 1 brainstorm to-do card (<title>). Chat digest: delivered.`
  - failure: `Wrote 1 brainstorm to-do card (<title>). Chat digest FAILED: <reason>`
- The `nudge` dependency-injection seam keeps its shape (tests inject a
  recording mock); it is renamed `digest` alongside.
- Dedup, `seen` TTL, state writes, and the no-card/already-seen early exits are
  unchanged.

### 3. SKILL.md updates

- Workflow step 3: "optionally posts a tiny `POST /api/agent/push` nudge" →
  "delivers a markdown digest of the card via `POST /api/agent/push`
  (calendar-extractor style), so the Agent Chat shows
  `[push:javis-brainstorming]` + the card summary".
- Notes: same rewording; add the calendar-extractor note that `AGENT_PUSH` is
  WebSocket-only (no APNs), so a backgrounded/killed app misses the chat
  message — the pending card in the Calendar tab is the durable artifact.
- Frontmatter `description`: mention the chat digest alongside the pending
  card.

### 4. Publish + install (chain stages 2–3)

- **Pre-publish diagnosis first (on current v0.1.1, before any code change):**
  via `/ssh-remote` to the prod host, establish facts for the suspect stages —
  is `javis-brainstorming` on ClawHub; is it installed in the user's container
  (and which version); does a `RouteRegistry` row `route_id="brainstorm"`,
  `skill="javis-brainstorming"` exist and is it `enabled`?
- **Publish** `javis-brainstorming@0.2.0` to ClawHub the same way
  calendar-extractor v0.4.2 was published. Slug alignment (SKILL.md `name`,
  `metadata.routes[].skill`, package.json `name`) and the
  `hijavis-skills.json` allowlist entry are already in place — no repo-side
  gating work remains.
- **Reinstall** via the HiJavis ClawHub browser even if a version is already
  present: route seeding happens at install time, and an install made before
  the PR #16 slug alignment silently skipped seeding the route. A fresh 0.2.0
  install re-seeds it.

### 5. End-to-end verification (chain stage 4 → phone)

Ordered cheapest-signal-first:

1. **`/ssh-remote` → prod server**: confirm installed version is 0.2.0, the
   `brainstorm` route row is enabled, and tail dispatcher logs.
2. **Trigger a real unit** in the iOS simulator driven by **computer-use-mcp**
   (or the physical device): e.g. a keyboard session "help me organize my
   thoughts on introducing Javis to the OpenClaw community". Watch dispatcher
   logs for: unit complete → `classify_and_route` → `brainstorm` deliverable →
   route matched → run-once claim → auto-run in the container.
3. **`/xcode-logs`** if the server side is healthy but nothing renders:
   capture the WebSocket `AGENT_PUSH` arrival and Agent Chat rendering (iOS
   log-first gate: logs before source).
4. **Success criterion:** Agent Chat shows `[push:javis-brainstorming]` + the
   B-format digest, and the pending 🧠 card appears in the Calendar tab with
   Confirm/Discard.

**Failure routing:** enabled route + no `brainstorm` deliverable emitted ⇒ the
classifier's route catalog is broken server-side; documented as a javis-server
finding, not fixed in this repo.

## Error handling

- Fetch fails / zero sessions / empty transcript → no card, no push (unchanged).
- Card write (`/api/skill/data`) failure → warning, run continues (unchanged).
- Digest push failure → run continues, summary line reports
  `Chat digest FAILED: <reason>`.
- Re-runs are safe: the server owns run-once; the `seen` map prevents duplicate
  card writes, and a seen card pushes no digest (the digest only accompanies a
  novel card).

## Testing

- `lib.test.js`: `formatDigest` unit tests — full card; goal-less;
  request-less; 0/1/N source refs; custom icon.
- `cli.test.js` push pipeline: digest content delivered through the injected
  client mock matches `formatDigest(card)`; digest failure is non-fatal and
  reported in the summary; already-seen card sends no digest; no-card path
  sends no digest.
- Existing dedup/state/contract tests unchanged.

## Versioning

`package.json` → **0.2.0**. Behavior change (chat output), no breaking surface:
commands, card contract, and state format are unchanged.

# E2E Verification Plan — the brainstorm card's time anchor

**Date:** 2026-09-12
**Type:** End-to-end verification plan. The change is merged to `main`
(`25a5b44`, bundle `0.6.2` at `00142dc`) but **not yet serving**: ClawHub still
reports `latest=0.5.0`, so no container has it. This plan gates the publish and
the rollout that follows it.
**Design spec:** [`2026-09-11-brainstorming-card-time-anchor-design.md`](2026-09-11-brainstorming-card-time-anchor-design.md)
**Field runbook:** https://claude.ai/code/artifact/f3a83208-7ea1-4585-ac1e-53b34dc36015
— the same 22 cases as a tickable page that remembers what you ticked. This file
is the precise version; the runbook is what you hold while looking at the phone.
**Status:** Plan — not yet executed

## Objective

Answer one question: **does a confirmed brainstorm card sit on the day its
session ran?**

## What makes this plan hard

**The bug and the fix look identical on the day of capture.** A brainstorm
session almost always runs today, and a card captured today belongs on today.
The old code put it there by accident — it had no date and pinned to today — and
the new code puts it there on purpose. Every single-day screenshot passes under
both. The plan is built around forcing that difference into view, which is why
§D5 exists and why no run is complete without it.

**A dateless card is a legitimate outcome.** §D of the design forbids inventing
a date, so "no `start_at`" is correct whenever both sources miss. A tester who
treats every undated card as a failure will file false bugs; one who treats every
undated card as acceptable will miss the regression entirely. B4 and B5 separate
the two cases explicitly.

**Version strings lie.** `package.json` says whatever the last commit said. The
only proof the fix is live in a container is the code in that container, which is
why G2 greps the running bundle rather than trusting `skills list`.

## Preconditions

- `javis-brainstorming@0.6.2` published to ClawHub and carrying the `latest` tag.
- A QA user whose container is running. Container name is
  `openclaw-user-<sha256(user_id)[:12]>`; workdir `/home/node/.openclaw/workspace`.
- SSH to the prod host; `docker exec` available.
- The QA user's iPhone with a build that can reach prod, signed in as that user.
- At least one **audio session from a previous day** still inside the fetch
  window. If none exists, D5 becomes the only way to observe placement and the
  run takes two days. Do not fabricate one by editing the database — C1 asserts
  the value the skill derived, and a hand-written row proves nothing about the
  skill.

Shorthand used below:

```bash
C=openclaw-user-<hash>                       # the QA user's container
S=/home/node/.openclaw/workspace/skills/javis-brainstorming
X="docker exec $C"                            # every in-container command
```

---

## G — Gate. Nothing below is meaningful until these pass.

**G1 — the container has 0.6.2.**
```bash
$X sh -c "cat $S/package.json" | grep '"version"'
```
Expect `0.6.2`. If it is `0.5.0`, the sweep has not run: force it with
`$X openclaw skills update javis-brainstorming` and re-check.

**G2 — the container has the actual fix, not just the version.**
```bash
$X sh -c "grep -c unionSessions $S/scripts/lib.js $S/scripts/brainstorming.js"
$X sh -c "grep -c rememberSessionWindows $S/scripts/brainstorming.js"
```
Expect non-zero for each. A published bundle that reports 0.6.2 but lacks
`unionSessions` means the publish shipped a stale tree, and every later case
would pass or fail for the wrong reason.

**G3 — the discriminator.** Confirm the old behavior is genuinely gone by
running the one call that used to fail. Covered operationally by B1; G3 is the
reminder that **B1 must run before any iOS case**, because a green iOS result on
a container still running 0.5.0 is the false pass this plan exists to prevent.

---

## A — The memory (`fetch` writes it)

**A1 — `fetch` records the sessions it returned.**
```bash
$X sh -c "cd $S && node scripts/brainstorming.js fetch --hours 24 --limit 50" >/dev/null
$X sh -c "cat $S/data/users/self.json" | python3 -m json.tool | head -40
```
Expect a `sessionWindows` object keyed by `session_id`, each entry carrying
`started_at`, `seen_at`, and `ended_at` where the session had one.

**A2 — raw instants, not naive-local.** Every `started_at` in the map ends in
`Z` (or carries an offset). A value shaped `2026-09-12T14:05:00` with no zone is
a **fail** — the map stores instants and converts at the last moment, so that a
later tz change does not move old cards.

**A3 — the widening.** Run `fetch --session <id>` for one session in a window
containing several. The **envelope** printed to stdout carries exactly one
session; the **map** on disk gains every session the server returned. Both halves
must hold: envelope narrow, memory wide.

**A4 — a zero-session fetch preserves the map.** Run `fetch --hours 1` at a
quiet time (or with a `--session` id that matches nothing). `sessionWindows` is
unchanged from A1, **not** emptied.

**A5 — `fetch` does not touch push's keys.** `seen` and `lastRunAt` are
byte-identical before and after A1. Capture them first:
```bash
$X sh -c "cat $S/data/users/self.json" | python3 -c "import json,sys; d=json.load(sys.stdin); print(json.dumps({'seen':d.get('seen'),'lastRunAt':d.get('lastRunAt')},sort_keys=True))"
```

---

## B — The anchor (`push` resolves it)

Each case pipes a card to `push` and inspects the POST body. Use a distinct
`title` per case so the `(title, goal)` dedup key differs and no case is
swallowed by the `seen` short-circuit of a previous one.

**B1 — THE case: a bare card object still gets its day.** With A1's map on disk,
pipe **only** the card — no `sessions`, no `tz`:
```bash
$X sh -c "cd $S && echo '{\"card\":{\"title\":\"B1 anchor probe\",\"goal\":\"verify the remembered map anchors a bare card\",\"source_refs\":[\"<session_id from A1>\"]}}' | node scripts/brainstorming.js push"
```
Expect the written row to carry `start_at` matching that session's
`started_at`, rendered naive-local in the user's tz. **This is the call that
produced a dateless row before the change.** A pass here and nowhere else still
means the core defect is fixed.

**B2 — the old path still works.** Pipe `{card, sessions, tz}` from a fresh
`fetch` envelope. Still anchored. This is the regression guard on the path that
already worked.

**B3 — union precedence.** Pipe a card whose `sessions` array carries a
*different* `started_at` for a `session_id` also in the map. The **piped** value
wins. Then pipe a trimmed `{"session_id": "...", "transcript": "..."}` with no
times: the **remembered** instants survive — a partial echo must not erase a
card's day.

**B4 — both sources miss → no dates, and that is correct.** Pipe a bare card
citing a `source_ref` that appears in neither the map nor any piped array. Expect
the row written with **no** `start_at` and **no** `end_at`, `push` reporting
success, and the summary line unchanged.

**B5 — no date was invented.** In B4, assert the *absence* of the keys, not the
presence of a plausible value. A `start_at` equal to "now" here is a **fail**
against §D, even though the card would look right on the phone today. This is
the case most likely to be waved through.

---

## C — The row on the server

**C1 — the stored row.** For the B1 card, read it back as the user:
```
GET /api/skill/data?type=todo    (Clerk JWT)
```
Assert on that row: `start_at` present; `is_utc` **false**; the value is
naive-local wall-clock matching the source session's `started_at` **converted
into the user's tz**, not UTC. A row whose `start_at` is the UTC instant is the
calendar-extractor bug class returning — it will render hours off, and across
midnight it will render on the wrong day.

**C2 — a re-run does not move it.** Run B1's push again with the identical card.
Expect the `seen` short-circuit: no second write, and `start_at` unchanged. Then
delete the `seen` entry, re-run, and confirm the recomputed `start_at` is the
**same value** — the anchor is derivable, not remembered by luck.

---

## D — Placement on the phone (the payoff)

**D1 — a pending card rides today.** The B1 card, still `pending`, appears in
**today's** block with dashed styling and Confirm/Discard — even though its
session ran on an earlier day. This is deliberate (design "What this does not
fix"); a pending card under an old date is a **fail**.

**D2 — Confirm files it.** Tap **Confirm**. The card leaves today's block and
appears under the **session's own date**, solid, with the time range. This is the
single most important observation in the plan.

**D3 — the header is right.** The section it landed in reads the session's date,
e.g. `Wed, Sep 10` — not today, and not off by one. An off-by-one here points at
C1's tz conversion, not at the placement code.

**D4 — the month dot follows.** The month grid lights a dot on the capture day.
Today's dot stays lit only if today still holds content of its own.

**D5 — it stays put tomorrow.** Reopen the Calendar tab the **next calendar
day** and find the same card under the **same** date. **No run is complete
without this case.** Every other case is consistent with a card that rides today;
only this one proves it does not. If the schedule cannot absorb a day, change the
device date forward instead and record that the observation was simulated.

**D6 — legacy rows still behave.** A confirmed brainstorm card written *before*
0.6.2 (no `start_at`) still pins to today. The undated branch must not have been
broken by teaching the dated one to work.

---

## E — Regression

**E1 — dedup.** A second push of an identical card writes nothing and sends no
digest.
**E2 — the digest.** The B1 card's markdown digest appears in Agent Chat as
`[push:javis-brainstorming]`, and tapping the card body opens that card's own
session.
**E3 — silence.** A run over a transcript with no discernible goal writes no card
and reports no error.
**E4 — the rest of the calendar.** Calendar-extractor events and gmail-wiki
email cards on the same days are unmoved. This change is skill-local; anything
else moving means it was not.

---

## Exit criteria

**Ship** when G1–G2, B1, B4–B5, C1, and D1–D3 pass, and D5 has been observed on
a real second day.

**Do not ship** on any of: B5 showing an invented date (violates §D); C1 showing
`is_utc` true or a UTC wall-clock (tz regression); D1 showing a pending card
filed under an old date (buries an unanswered question); D6 showing legacy rows
displaced.

**Rollback** is `clawhub publish` of the previous bundle as `latest`, or
`clawhub hide javis-brainstorming`. Containers pick the change up on the next
12-hour sweep, so a rollback is not instant — prefer catching a failure at G or B,
before any user's container has swept.

## Recording the run

Use the runbook artifact for the live pass; it holds the same cases as tickable
rows with space for the observed value. This file is the precise version — where
the two disagree, this one is right.

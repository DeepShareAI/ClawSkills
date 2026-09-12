# E2E Verification Plan — the brainstorm card's time anchor

**Date:** 2026-09-12
**Type:** End-to-end verification plan, **executed 2026-09-12** against prod
container `openclaw-user-db62abae6405`. The server half (G, A, B, C) ran; the
iOS half (D) did not. The run found a blocking defect at C1 — see Results —
which shipped as `0.6.3` (`059eef7`), and C1 then passed on the fixed bundle.
**Design spec:** [`2026-09-11-brainstorming-card-time-anchor-design.md`](2026-09-11-brainstorming-card-time-anchor-design.md)
**Field runbook:** https://claude.ai/code/artifact/f3a83208-7ea1-4585-ac1e-53b34dc36015
— the same 22 cases as a tickable page that remembers what you ticked. This file
is the precise version; the runbook is what you hold while looking at the phone.
**Status:** Server half and D1–D3 PASSED on 0.6.3. D5 blocked on a second day.

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

- `javis-brainstorming@0.6.3` in the container. **ClawHub's `latest` tag lags a
  publish by an unknown interval** — observed twice on 2026-09-12, where
  `openclaw skills update` pulled 0.6.2 minutes after 0.6.3 published cleanly.
  When it lags, side-load the bundle to test: `tar czf` the bundle, `scp` to the
  host, `docker cp` into the container, untar over the skill dir.
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

---

## Results — 2026-09-12

Run against `openclaw-user-db62abae6405` on prod, session
`145f65ddd738c8562763b89a5651a12c` (started `2026-09-11T20:12:21.053Z`, user tz
`America/Los_Angeles`, so the correct naive-local anchor is `13:12:21`).

| Case | 0.6.2 | 0.6.3 | Evidence |
|---|---|---|---|
| G1 version | pass | pass | `0.6.2` / `0.6.3` in the container |
| G2 fix present | pass | pass | `unionSessions`, `rememberSessionWindows(fetched…)`, `pipedTz \|\| state.tz` |
| A1 map written | pass | pass | one `sessionWindows` entry |
| A2 raw instants | pass | pass | `"2026-09-11T20:12:21.053Z"` |
| tz remembered | — | pass | `state.tz = America/Los_Angeles` |
| B1 bare card anchored | pass | pass | row carries `start_at` |
| **C1 stored row** | **FAIL** | **pass** | `20:12:21` → `13:12:21` |
| B4 undated write | — | pass | card written, success reported |
| B5 no invention | — | pass | `start_at NULL` |
| A3 envelope narrow / memory wide | — | pass | envelope 1 session, map 16 — 15 siblings the envelope never carried |
| A4 zero-session fetch preserves map | — | pass | map sha256 `cf9d501bed7e8abb` identical before and after |
| **D1** pending rides today | — | pass | Sep-8-anchored card sat under `Fri, Sep 11 · Today`, dashed, Confirm/Discard |
| **D2** Confirm files it | — | pass | left today's block into a **newly created** Sep 8 section |
| **D3** header correct | — | pass | `Tue, Sep 8`, solid card, `9:51 – 10:24 AM` |
| D4, D6, B2, B3, C2, E1–E4 | — | not run | — |
| D5 next-day stability | — | **blocked** | needs a second calendar day |

### What C1 caught

The design removed push's dependency on the agent re-piping `sessions` and left
the identical dependency on `tz`. The container runs with `TZ` unset, so a bare
card resolved to `UTC` and `toNaiveLocal` stored the UTC wall-clock as local.
Two pushes of the same session, minutes apart:

| push | stored `start_at` |
|---|---|
| `tz` piped | `2026-09-11 13:12:21` |
| bare card | `2026-09-11 20:12:21` |

For any session after 17:00 PT the UTC wall-clock is the **next calendar day**,
so 0.6.2 reintroduced the wrong-day placement the design exists to remove, on
the very path it exists to support. Fixed in 0.6.3 (design §C-bis).

**Why the plan caught it and the unit tests did not.** The suite injects `tz`
into every `doPush` call, so no test ever exercised `resolveTz` falling through
to the environment. Only a container with `TZ` unset does that, and only a real
row read back in the user's zone makes the seven hours visible. C1 was written
to assert the stored value rather than the code path, which is the reason it
worked.

### The D run, and what was synthetic about it

The simulator is signed in to `wmp425@gmail.com` (`openclaw-user-db62abae6405`),
**not** `samuel@deepshare.ai`. That account has exactly one session, from today,
so no *real* card there could be anchored to an earlier day.

Rather than hand-write a row — which this plan forbids for C1 — an older session
**window** was injected into the skill's state file, the artifact a real earlier
fetch would have left, and a bare card was pushed through the skill so it derived
the anchor itself. The skill produced `2026-09-08 09:51:19` from
`2026-09-08T16:51:19.085Z` plus the remembered tz, unaided.

So D1–D3 exercise the real skill path end to end; only the remembered window was
synthetic. C1 had already proved the derivation against a genuine session, so the
two halves cover each other. **A3 and A4 ran in `openclaw-user-8ba916898816`**
instead, because neither is demonstrable in a container holding one session.

### Two setup errors worth recording

Both first attempts looked like product failures and were not. A plan that does
not record them invites the next runner to file the same false bugs.

- **A3 with a keyboard session returned an empty envelope.** `filterToUnit`
  excludes keyboard sessions from `--session` by design — `--kbd-input` is the
  keyboard door. Use an **audio** session id for A3.
- **A4 compared `hash()` of the map across two `python3` processes.** Python
  salts `hash()` per process, so the digests differed and the map looked
  modified. Use `hashlib.sha256`, and assert the digest rather than the entry
  count — "still 16 entries" is the weaker claim.

### Residual state

- The container runs a **side-loaded** 0.6.3 while ClawHub's `latest` says
  0.6.2. The next sweep reconciles once the tag moves.
- Four QA cards were written and deleted; `seen` was cleared. `state.tz` was
  left in place — real derived state, not test residue.

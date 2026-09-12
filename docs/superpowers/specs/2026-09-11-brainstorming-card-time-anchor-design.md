# Every brainstorm card gets a day: remembering the session window instead of re-piping it

**Date:** 2026-09-11
**Status:** Design — approved in brainstorming 2026-09-11, not yet implemented
**Scope:** `ClawSkills/brainstorming` only. No `javis-server` change. No
`javisiosapp` change. Every path below is rooted in `brainstorming/`.

**Parent designs:**
- `2026-06-09-brainstorming-skill-design.md` (this directory) — the to-do card surface and the skill's three steps
- `brainstorming/references/todo-card-contract.md` — the shared `type="todo"` contract this obeys, §1b in particular
- `javis.is/docs/superpowers/specs/2026-09-11-email-card-timeline-anchoring-design.md` — the email-card anchoring design whose principle and placement rule this reuses

## The principle this design serves

The email-card design put it this way: foundations live on the server and are
reusable; as much of the specific part as possible lives in the skill, where it
is easy to change and improve.

For brainstorm cards the foundation is already built and already correct.
`POST /api/skill/data` accepts an item-level `start_at`/`end_at`, parses it,
derives `is_utc` from its tz-awareness and stores it
(`javis-server/app/routers/skill.py:164-211`). `CalendarViewModel.foldConfirmedTodos`
(`javisiosapp/Sources/JavisApp/calendar/CalendarViewModel.swift:412`) already
files a confirmed dated card under the day its `start_at` names, creating that
day's section when no event occupies it. Nothing downstream is missing.

What is missing is the specific part, and it belongs to the skill: knowing
which session window a card was born from, at the moment the card is written.

## Background

A brainstorm card is a journal entry. Its `start_at`/`end_at` are not a deadline
but the window of the session that produced the idea, so the card lands on the
day the idea was captured (`references/todo-card-contract.md` §1b). The skill
runs in two steps inside the user's openclaw container:

1. `fetch` calls `GET /api/transcripts/recent` and prints an envelope —
   `{reference_time, tz, sessions:[{session_id, started_at, ended_at, transcript, source}]}`.
2. The agent reads that envelope, judges the unit, composes a card, and pipes it
   to `push`, which dedups against a `seen` map and writes the `type="todo"` row.

`push` stamps the window by calling `sessionWindow(sessions, card.source_refs, tz)`
(`scripts/lib.js:100`), which picks the earliest `started_at` among the card's
`source_refs` and serializes it, with that same session's `ended_at`, as naive
local wall-clock in the resolved tz.

## Problem

### 1. The anchor depends on what the agent chooses to pipe

`push` takes `sessions` from stdin (`scripts/brainstorming.js:298`):

```js
const sessions = 'sessions' in deps ? deps.sessions : (stdin ? stdin.sessions : []);
```

`SKILL.md:99` tells the agent to pipe `{"card": …, "sessions": …, "tz": …}` and
then adds that *"a bare card object still [works]"*. Piping just the card is the
shorter and more obvious thing to do, and it is explicitly permitted. When the
agent takes that path, `sessionWindow` receives `[]`, returns `{}`, and
`buildTodoItem` correctly omits both dates — it is forbidden from inventing one
(`scripts/todo-card.js:86-103`).

The card is then born dateless, and a dateless card pins to today forever.

The anchor's correctness rests on an LLM re-piping, verbatim, an array it was
handed one step earlier and which the skill itself fetched. That is the defect.
Everything else in this section follows from it.

### 2. Nothing can recover the window afterwards

There is no by-id session endpoint. `fetch --session <id>` is
`GET /api/transcripts/recent?since=now-24h&limit=50` filtered client-side
(`scripts/brainstorming.js:145`, `:166`). That endpoint groups by `session_id`
and returns the `limit` most recent sessions by `ended_at`
(`javis-server/app/routers/transcription.py:411-422`, `:474`), so recovering an
older session means guessing a wider `--hours`/`--limit` and re-paying the fetch
— on the degraded path, to recover a value the skill already had.

### 3. A dateless card cannot be repaired, but it can be moved

`push` short-circuits on a remembered card (`scripts/brainstorming.js:316`):

```js
if (seen[card.dedupKey]) { … return; }   // nothing is written
```

So while the `seen` entry lives, no second write occurs and no anchor can
change. The row is only rewritten once that entry is gone — after the 30-day
TTL (`scripts/lib.js:13`), or when the container is rebuilt or reaped and takes
`data/users/<userId>.json` with it. That rewrite computes a fresh window, and
`skill.py:196` overwrites `start_at` unconditionally, so the card moves to
whatever the rewrite decided.

The consequence worth naming: a first-write date remembered in the `seen` map
would not help. It is present exactly when nothing is written and absent exactly
when the card re-anchors.

## Design

### A. Who owns what

| Layer | Owns | Changed by |
|---|---|---|
| **Foundation** — `POST /api/skill/data`, generic | That a `type="todo"` row *may* carry a window; parsing it; the `is_utc` contract; storing it; returning it per row with its `skill` | a server deploy — **not touched by this design** |
| **Transport** — `scripts/todo-card.js`, shared by every to-do-emitting skill | The naive-local format rule; never inventing a date; emitting `end_at` only beside a `start_at` | publishing any bundle that vendors it |
| **Judgment** — `brainstorming`, in the container | *Which* session window represents this card, and where that window is remembered | publishing a bundle |

**The todo rail has no binding layer, and should not grow one here.** The email
design needed `GmailCandidateAdapter.validate` because gmail holds a policy the
generic core cannot: an email card records correspondence that happened, so a
future-dated anchor is wrong and must be replaced. Brainstorming has no
equivalent policy. A journal window is whatever the source session was, and the
skill either knows that session or does not. Adding a per-skill policy hook to
a rail that has never needed one would be scaffolding for a rule nobody has.

If a later to-do skill does arrive with a real placement policy, that is when
the layer earns its existence.

### B. `fetch` remembers the windows it already has

`doFetch` holds every returned session's `started_at` and `ended_at` in memory
and prints them. It persists them too:

```js
state.sessionWindows = {
  "<session_id>": { started_at: "<iso>", ended_at: "<iso>", seen_at: "<iso>" },
  …
}
```

Stored as raw ISO instants, not as naive-local strings. The tz is resolved per
run, and a window frozen in one tz would render wrong after the user's tz
changes. `sessionWindow` already converts an instant to naive local at the last
moment; this map feeds it the same kind of value the envelope does.

`doFetch` gains the `load`/`save` deps `doPush` already carries
(`scripts/brainstorming.js:292-293`), so the write stays injectable and the
existing test style applies unchanged.

**It remembers every session the server returned, not the filtered envelope.**
`--session`/`--kbd-input` narrow what the agent is shown; they should not narrow
what the skill knows. A window costs nothing to keep, and remembering the whole
fetch means a card whose `source_refs` cite a sibling session from that same
fetch still gets its day. The narrowing stays where it belongs — on the envelope.

**Pruning reuses what exists.** `pruneByTtl(map, tsOf, ttlDays)`
(`scripts/lib.js:220`) already takes a timestamp accessor, so the map prunes with
`pruneByTtl(state.sessionWindows, (w) => w.seen_at, SEEN_TTL_DAYS)` — the same
30 days the `seen` map uses, and no new machinery. After pruning, the map keeps
at most its 500 most recent entries by `seen_at`, which bounds the state file
against a container that fetches often. At the default `--limit 50`, 500 entries
is ten full fetches of distinct sessions.

### C. `push` resolves the window from the union of both sources

`doPush` builds one lookup and runs the existing selection over it:

- The remembered map supplies the base.
- The piped `sessions` are layered on top, overriding by `session_id`.
- `sessionWindow` then picks the earliest `started_at` among the card's
  `source_refs`, exactly as it does today.

A union rather than a fallback, because the agent may pipe a partial list. Both
sources carry the same server-issued instants for the same `session_id`, so they
agree wherever they overlap; the piped copy wins only because it is the fresher
read of the same fact.

`sessionWindow`'s signature and behavior do not change. It keeps taking an array
of session-shaped objects, and the caller hands it the union.

### D. What happens when both sources miss

The card is written with no dates, exactly as today.

This design does **not** add a time-based last resort. Stamping "now" when the
window is unknown would put a guessed date on a journal card and re-introduce,
on the degraded path, precisely the invention that `todo-card.js` exists to
prevent — and it would make every rewrite move the card, which is problem 3.

After B and C, reaching this path means the card cites a `source_ref` that
`fetch` never returned in this container within the TTL. The agent composed a
card from a session it was not given. That is an agent error surfacing as an
undated card, which is the honest outcome, and it is a much smaller and more
diagnosable set than "the agent piped a bare card object."

**So the guarantee this design makes is precise:** every card composed from a
session the skill fetched gets that session's day. Not every card
unconditionally.

### E. `SKILL.md` keeps the bare-card affordance, and stops depending on it

`SKILL.md:52-54` and `:98-102` currently instruct the agent to pipe `sessions`
so `push` can stamp the window. That instruction becomes advisory rather than
load-bearing: piping the envelope is still the documented call, and a bare card
object still works — and now still gets its day. The note explaining why
`sessions` matters is replaced by one sentence recording where the window comes
from, so a future reader does not restore the dependency.

## Why no server or iOS change

- The rail already accepts, parses and stores an item-level window, and already
  returns it per row with the row's `skill`.
- `is_utc` stays `false` for these rows. The skill keeps sending naive local
  wall-clock, which is what `RemoteTodoCardsProvider` decodes in the device tz
  via `ServerDate` (`RemoteTodoCardsProvider.swift:96`). Nothing about the
  dual convention moves.
- `foldConfirmedTodos` already files a confirmed dated card under its day and
  falls back to today when undated. A card that now arrives dated simply takes
  the branch that was always there.

The one server-side sticky-anchor option considered — refusing to rewrite
`start_at` for `data_type == "todo"`, which would be safe because
`calendar-extractor` writes `type: 'event'` (`calendar-extractor/scripts/calendar-extractor.js:385`)
— was declined. After B, a rewrite only happens when the card is re-derived, and
a re-derivation runs `fetch` first, which repopulates the map with the same
session and recomputes the same window. The rewrite writes back what is already
stored.

## What this does not fix

**Pending cards still ride today.** `pendingTodos`
(`CalendarViewModel.swift:58`) pins every unconfirmed card to today's block
regardless of its window, and only `foldConfirmedTodos` files by day. That is
deliberate and matches the email design's rule: a card that still wants an
answer stays where the answer will be given, and burying an unanswered
Confirm/Discard above the fold is how it goes unanswered. A brainstorm card's
day becomes visible when it is confirmed.

**An idea re-captured in a new session gets a new day.** `todoDedupKey` hashes
title and goal, not the session, so the same idea raised again in a later
session is the same card — and if its first `seen` entry has expired, the
rewrite anchors it to the newer session. The card follows the most recent
capture it was derived from. This is a consequence of identity being
`(title, goal)`, and changing that is a different design.

**`transcripts/recent` saturation.** The endpoint still emits one entry per
`audio_recordings` row, so a busy user's fetch can crowd out sessions. This
design stops that from silently costing a card its day within the TTL; it does
not fix the endpoint.

**Other to-do skills.** Nothing here changes `todo-card.js`, so a future
to-do-emitting skill inherits the same contract it inherits today and solves its
own window question. If a second skill solves it the same way, the map belongs
in the shared module and this design becomes the precedent for moving it there.

## Testing

**`test/lib.test.js` — the union and the pruning.**
- `sessionWindow` over a union built from the map alone returns the remembered
  window; over map-plus-piped, the piped value wins for a shared `session_id`.
- A card whose `source_refs` span one remembered and one piped session picks the
  earliest `started_at` of the two, and that same session's `ended_at`.
- `pruneByTtl` over `sessionWindows` drops an entry older than `SEEN_TTL_DAYS`
  and keeps one inside it, keyed on `seen_at`.
- The 500-entry cap keeps the most recent by `seen_at` and drops the rest.

**`test/cli.test.js` — the behavior that regressed.**
- `push` with a **bare card object** and a populated `sessionWindows` map emits
  `start_at`/`end_at` on the POST body. This is the test that would have caught
  the bug.
- `push` with piped `sessions` and an empty map still emits them — the existing
  path, unchanged.
- `push` with neither emits no `start_at` and no `end_at`, and still writes the
  card and returns success.
- `fetch` writes each returned session into `state.sessionWindows` with
  `started_at`, `ended_at` and `seen_at`, and leaves `state.seen` untouched.
- `fetch` with a session carrying no `ended_at` records `started_at` alone; the
  card then gets a `start_at` and no `end_at`, matching `buildTodoItem`'s rule.
- A run whose `fetch` returns zero sessions leaves the existing map intact
  rather than clearing it.

**`test/data.test.js`.** A state file written by an older bundle — `seen` present,
`sessionWindows` absent — loads, and the first `fetch` adds the map without
disturbing `seen` or `lastRunAt`.

**Manual.** In a container, run `fetch --session <id>`, pipe **only** the card
object to `push`, and confirm the written row carries the session's window.
Then confirm the card on the phone and verify it leaves today's block and
appears under the session's own date.

## Rollout

One PR, one bundle.

1. `brainstorming` bumps to **0.6.0**: the map in `doFetch`, the union in
   `doPush`, the pruning and cap, the `SKILL.md` wording, the tests.
2. Published to ClawHub, it reaches every per-user container through the
   existing 12-hour skill-update sweep on javis-server.
3. **No cron re-registration and no `min_bundle_version` bump.** The trigger
   message and the dispatcher contract are unchanged.

No feature flag. The change is additive — a card that would have been dateless
gains a date, and a card that already had one computes the same date from the
same instants.

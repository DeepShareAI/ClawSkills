# Calendar in-thread edit — timezone date off-by-one (finding + fix)

**Date:** 2026-06-22
**Found by:** end-to-end device test of the in-thread card-editing feature
**Severity:** medium — edits resolve relative dates ("today / tomorrow") on the wrong
day for any user west of UTC editing in the evening (their local date ≠ the UTC date).

## Symptom (observed end-to-end)

A user edited a pending "Design Review Meeting" card in its Agent Chat thread with
**"8 pm today"** at **2026-06-22 18:36 Pacific** (= 2026-06-23 01:36 UTC). The card was
stored at **2026-06-23 20:00** (June **23**) instead of June **22**. DB proof:

```
dedup_key  | nodate|design review meeting|
status     | confirmed          ← edit/confirm machinery worked
start_at   | 2026-06-23 20:00:00  ← wrong DAY (should be 06-22)
```

A second reported "the calendar card didn't update" symptom was the **same bug**
downstream: the row correctly moved to June 23, so it left the user's "Today (June 22)"
view (and null-`start_at` rows aren't shown at all until a time is set). The iOS
calendar rendering is correct (re-fetches on `skill_data_updated`, keys rows by stable
id, re-sections by day) — there is no separate UI bug.

## Root cause

The **extraction** path gets the user's `tz` from the `GET /api/transcripts/recent`
envelope, so its dates are correct. The **edit** path (`anchor` + `update`) has no such
envelope, and the per-user `openclaw-user-*` container runs with an **empty `TZ`
environment → Node resolves to UTC**. So a bare `anchor` computed `reference_date`
as the **UTC** date (June 23), and the agent resolved "today 8 pm" against it.

Confirmed on the host:
```
$ docker exec openclaw-user-<hash> sh -c 'echo TZ=$TZ; node -e "console.log(Intl.DateTimeFormat().resolvedOptions().timeZone)"'
TZ=
UTC
```

## Fix — shipped (skill side)

ClawSkills `calendar-extractor` **v0.5.2** (`scripts/calendar-extractor.js`):

- New `resolveUserTz({ explicitTz, token })` + `fetchServerTz(token)`. Edit-turn zone
  order is now: **explicit** (`--tz` / stdin `tz` / `[CURRENT CARD]` tz) → **the
  server's authoritative zone** (best-effort `GET /api/transcripts/recent?limit=1`,
  reading the same `tz` field extraction trusts) → `TZ` env → system.
- `doAnchor` is now async and applies this order (a bare `anchor` returns the user's
  real zone, not UTC). `doUpdate` applies it when the patch carries no `tz`.
- `getFlag` guards the `require()` (test) path. SKILL.md edit-flow updated to use the
  `anchor`'s `reference_date` and pass `[CURRENT CARD]` tz when present.
- Tests pin the fix: at `01:36Z` with server zone `America/Los_Angeles`, `anchor`'s
  `reference_date` is **2026-06-22** (not 06-23); `update` collapses a `Z` instant in
  the server zone. `node --test`: 51 pass / 0 fail.

This makes edits correct **today**, with no server or infra change required (the skill
asks the server for the zone). The items below are the cleaner long-term contract.

## Recommended follow-ups (server + infra teams)

### 1. Server — put `tz` in the `[CURRENT CARD]` block (extends javis-server PR #89)
The card-thread agent turn already injects `[CURRENT CARD]` (dedup_key + current
fields). **Add the user's `tz`** to that block. Then the skill reads it directly and
passes `--tz`/stdin `tz` — no extra `GET` round-trip, and the zone is always the
current one. This is the proper contract: the edit turn should never have to guess or
re-fetch its zone.

- Where: the `[CURRENT CARD]` assembly added in `a0f0936` (`app/routers/agent.py`,
  `app/services/card_session.py`).
- Shape: one extra line, e.g. `tz: America/Los_Angeles`, from the same user-tz source
  the `/transcripts/recent` envelope uses.

### 2. Infra — set `TZ` on the per-user `openclaw-user-*` containers
Start each per-user container with `TZ=<user tz>`. Defense-in-depth: every skill's
date logic (not just calendar-extractor) then resolves in the user's zone, and the
UTC fallback never bites. Caveat: `TZ` is fixed at container start, so it goes stale
if the user travels — which is exactly why the skill prefers the **live** server zone
over `TZ`. Treat infra `TZ` as a backstop, not the primary fix.

### Recommendation
Ship the skill fix (done) now; do **both** follow-ups. Server `[CURRENT CARD]` tz is
the correct primary contract; infra `TZ` is cheap global insurance.

## Acceptance (re-test)
Repeat the e2e edit ("8 pm today") in the evening Pacific. Expect the row stored at
**June 22 20:00** and the card rendered on **June 22**, confirmed — one row, no
duplicate.

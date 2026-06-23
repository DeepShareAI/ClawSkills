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

## Root cause — CORRECTED after a second device test (2026-06-23)

> The first cut of this spec assumed the **extraction** path got a correct `tz` from the
> `/api/transcripts/recent` envelope and only the **edit** path was broken. **That was
> wrong.** A second end-to-end device test (running the deployed v0.5.2) proved the gap
> is deeper and shared by **both** paths.

**The user's timezone never reaches the pipeline at all.** Verified on prod:

- **No tz in the DB.** `users` (and every table) has **no timezone column**:
  ```
  select table_name, column_name from information_schema.columns
   where column_name ilike '%timezone%' or column_name='tz';   -- (0 rows)
  ```
- **No tz in the transcripts envelope.** The raw response carries only `sessions`:
  ```
  GET /api/transcripts/recent → top-level keys: ['sessions'];  tz = None
  ```
  So `fetch`/extract reads `base.tz = undefined`, and `fetchServerTz` finds nothing.
- **Container `TZ` is empty → Node resolves to UTC:**
  ```
  $ docker exec openclaw-user-<hash> sh -c 'echo TZ=$TZ; node -e "...timeZone"'
  TZ= / UTC
  ```
- **Net effect:** in-container `anchor` returns `tz: "UTC"`, `reference_date: 2026-06-23`.
  Both extraction AND edit resolve "today" in **UTC**. This is why the very first card
  ever read *"start time (10:00 AM **UTC**) is inferred"* — it has always been UTC for
  this user.

So `start_at` landing on June **23** instead of June **22** is not an edit-path bug and
not a container-only bug — **no layer knows the user is in `America/Los_Angeles`.**

### Re-test result (v0.5.2 deployed)
- ✅ Edit **mechanism** correct again: row `confirmed`, time → 20:00–21:00, single row,
  `dedup_key` passed verbatim. The v0.5.2 `fetchServerTz` lookup **did fire**
  (`GET …/transcripts/recent?…&limit=1` observed).
- ❌ Date still June 23 — because the lookup has **nothing to read**. The v0.5.2 fix is
  correct *plumbing* but **inert** until the server actually emits a tz.

## Fix — shipped (skill side)

ClawSkills `calendar-extractor` **v0.5.2** (`scripts/calendar-extractor.js`):

- New `resolveUserTz({ explicitTz, token })` + `fetchServerTz(token)`. Edit-turn zone
  order is now: **explicit** (`--tz` / stdin `tz` / `[CURRENT CARD]` tz) → **the
  server's zone** (best-effort `GET /api/transcripts/recent?limit=1`, reading a top-level
  `tz` field — which the server **does not emit yet**, so this currently returns null)
  → `TZ` env → system.
- `doAnchor` is now async and applies this order (a bare `anchor` returns the user's
  real zone, not UTC). `doUpdate` applies it when the patch carries no `tz`.
- `getFlag` guards the `require()` (test) path. SKILL.md edit-flow updated to use the
  `anchor`'s `reference_date` and pass `[CURRENT CARD]` tz when present.
- **v0.5.3** adds a loud stderr warning when `resolveUserTz` falls back to **UTC** (no
  explicit/[CURRENT CARD] tz, no server tz, empty container `TZ`) — so this gap is
  visible in logs instead of silently shifting a day.
- Tests: at `01:36Z` with an injected zone `America/Los_Angeles`, `anchor`'s
  `reference_date` is **2026-06-22**; `update` collapses a `Z` instant in that zone; the
  UTC-fallback warning is asserted. `node --test`: 53 pass / 0 fail.

The skill side is now **ready and correct plumbing**: the moment any real tz is supplied
(explicit `--tz`, a `[CURRENT CARD]` tz, or a `tz` field on the transcripts envelope),
both extraction and edit resolve in the user's zone with **no further skill change**.
It cannot fix the date by itself, because **the user's tz is not stored or emitted
anywhere** — that is the work below.

## The real fix — full-stack tz propagation (iOS + server)

The user's timezone must be **captured and propagated**. Detailed in the companion spec
**`javis-server/docs/superpowers/specs/2026-06-23-user-timezone-propagation.md`**.
Summary of the three required pieces:

1. **iOS — send the device tz.** Report the device IANA zone
   (`TimeZone.current.identifier`) to the server on login / session create / a small
   profile call. The device is the only place that actually knows it.
2. **Server + DB — store and emit it.**
   - Add a `users.timezone` (nullable IANA string) column (migration); persist what iOS
     sends.
   - **Emit it where the skill already looks:** add a top-level `tz` to the
     `GET /api/transcripts/recent` envelope (fixes **extraction** immediately) **and**
     to the `[CURRENT CARD]` block from `a0f0936` (fixes **edit** with no extra GET).
   - Default to `UTC` only when unknown (and surface that to the user as a setting).
3. **Skill — already done (v0.5.3).** Consumes envelope `tz`, `[CURRENT CARD]` tz, and
   `fetchServerTz`; warns on UTC fallback. No further change once the server emits `tz`.

### Why the earlier "infra `TZ`" idea is not enough
Setting `TZ` on the container forces a **single** zone per container and goes stale when
the user travels — and it still leaves **extraction** wrong unless the envelope carries
tz. It is at best a coarse backstop; the per-user, device-sourced tz above is the fix.

## Acceptance (re-test, after the server emits `tz`)
Repeat the e2e edit ("8 pm today") in the evening Pacific. Expect the row stored at
**June 22 20:00**, rendered on **June 22**, confirmed — one row. Also confirm a fresh
**extraction** with no explicit time infers the slot on the correct **local** day (no
more "10:00 AM UTC"). Until then, the skill logs the UTC-fallback warning on every edit.

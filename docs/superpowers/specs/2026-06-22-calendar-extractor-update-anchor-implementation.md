# calendar-extractor — `update` + `anchor` implementation spec

**Date:** 2026-06-22
**Repo:** ClawSkills (the `calendar-extractor` skill)
**Status:** approved design → ready for `javis-skill-creator` implementation
**Design spec (merged):** `docs/superpowers/specs/2026-06-22-calendar-card-in-thread-editing-design.md` (ClawSkills PR #21)
**Server contract (shipped):** javis-server PR #89 / `a0f0936` — session→card identity injection + `pending→confirmed` upsert flip

## Goal

Let a user correct a pushed pending calendar card by replying in its own Agent Chat
thread ("6 pm today", "location is Zoom"). The reply edits **that exact pending row**
in place and confirms it — no duplicate row, no second tap.

This spec is the concrete, implementation-level plan for the skill side. The server
and iOS sides are already shipped (PR #89); this adds only the skill's two subcommands
and the SKILL.md guidance that drives them.

## Decisions (locked in brainstorming)

- Edit happens in the **card's own thread**.
- **Update + auto-confirm** — stating the corrected value in chat *is* the confirmation.
- Edit scope: **time and the other fields** (title, location, attendees, notes).
- **Minimal add, existing style** — extend the hand-written `scripts/calendar-extractor.js`
  reusing its own `lib.js` helpers; do **not** migrate calendar-extractor onto the
  vendored contract spine (out of scope, regression risk).

## What the server already provides (consume, don't build)

- When an agent turn runs in a card thread, the server injects a **`[CURRENT CARD]`**
  block carrying the card's original `dedup_key` (verbatim) + its current fields
  (`title`, `start_at`, `end_at`, `location`, `attendees`, `notes`, `status`).
- `POST /api/skill/data` (gateway-authed) upsert matched by `dedup_key`:
  - overwrites `payload`, `start_at`, `end_at` **wholesale** on the matched row, and
  - honours a **`pending → confirmed`** status flip atomically with the field write
    (strictly that direction; default-pending never auto-confirms, confirmed never
    downgrades).
- So the skill needs **one** upsert with the original key and `status:"confirmed"` —
  no separate `/confirm` call (that endpoint is Clerk-gated and unreachable from the
  container anyway).

## Skill changes

### New subcommand: `update`

```bash
echo '<update-json>' | node scripts/calendar-extractor.js update
```

**stdin shape:**

```json
{
  "dedup_key": "<the card's ORIGINAL dedup_key, verbatim>",
  "patch": {
    "start_at": "2026-06-22T18:00:00-07:00",
    "end_at":   "2026-06-22T19:00:00-07:00",
    "title": "...", "location": "...", "attendees": ["..."], "notes": "..."
  }
}
```

Behaviour:

1. **Require** a non-empty `dedup_key` → hard error (exit 1) if missing. We cannot
   guess the row.
2. **Never recompute the key.** The `dedup_key` is passed straight through to the
   upsert item, even though `start_at` changed. (Recomputing — `lib.js:36`,
   `day|title|startAt` — would create a *second* row. This is the whole bug.)
3. Normalize the patch through the existing `normalizeEvent`; build one item via the
   existing `buildSkillDataItems`-style shaping so `toNaiveLocal(start_at/end_at, tz)`
   runs (naive-local wall-clock, no `Z`/offset — the existing iOS invariant).
4. Set the item's `status: "confirmed"` and its `dedup_key` to the verbatim input key.
5. **Full-state payload.** Because the server replaces `payload`/`start_at`/`end_at`
   wholesale, the item must carry the **complete intended state** — the current fields
   from `[CURRENT CARD]` **merged with** the user's change — not just the changed
   field. A time-only edit must still resend title/location/etc., or they would be
   blanked. (The agent composes the merged `patch`; the skill writes it as-is.)
6. POST `/api/skill/data` `{ skill, type:"event", merge:"upsert", items:[item] }`.
   **No `seen`-dedup filtering. No `/api/agent/push`** — the iOS card re-render and the
   live chat reply are the user feedback.
7. Print a one-line stdout summary for the agent (e.g. the new slot + `confirmed`).

### New subcommand: `anchor`

```bash
node scripts/calendar-extractor.js anchor
```

Prints **only** the relative-date anchor — `localAnchor(now, tz)` →
`{ reference_time, reference_date, reference_weekday, reference_time_utc, tz }` — with
`tz` resolved the usual way (no payload tz here → `TZ` env → system zone). **No
transcript fetch.** The edit turn uses it to resolve "today / 6 pm / tomorrow" against
the *current* clock (the chat happens later than extraction, so the original anchor is
stale), with the same date-resolution discipline the extraction path enforces.

### SKILL.md additions

- New section **"Editing a pushed card in-thread"**:
  1. The server injects a `[CURRENT CARD]` block (original `dedup_key` + current
     fields) into the card-thread turn.
  2. Run `anchor` for a fresh "now".
  3. Resolve the user's correction against the anchor; emit `null` rather than guess
     when ambiguous (existing rule) — if unresolvable, ask a follow-up in-thread and
     do **not** call `update`.
  4. **Merge** the resolved change with the current fields from `[CURRENT CARD]` into a
     full `patch` (wholesale-payload rule).
  5. Run `update` with the **verbatim** `dedup_key`.
- Document the auto-confirm semantics (row flips `pending → confirmed` on the upsert).
- Add `update` and `anchor` to the Core commands block (with the optional explicit
  `<userId>` form, matching `fetch`/`push`).

## Error handling

- Missing/empty `dedup_key` → hard error, no write.
- Empty/whitespace `patch` → no-op with a clear message (nothing to change).
- `/api/skill/data` HTTP failure → report in-thread ("couldn't update the card"),
  non-silent; do not claim success.

## Testing

- Unit tests for `update` (IO-injected via a `deps`/client seam, mirroring `doPush`):
  - the **original** `dedup_key` is sent verbatim (not recomputed from the new time);
  - `status: "confirmed"` rides on the item;
  - `toNaiveLocal` is applied (no `Z`/offset leaves the process);
  - the **full merged payload** is sent (a time-only patch still carries title/etc.);
  - missing key → error; empty patch → no-op.
- Unit test for `anchor` output shape (the five anchor fields, no `sessions`).
- Run the existing `test/` suite to confirm `fetch`/`push` paths are untouched.

## Versioning

- Bump `calendar-extractor/package.json` `0.4.2 → 0.5.0` (new capability).

## Invariants (must hold)

- `dedup_key` is **verbatim**, never recomputed on edit.
- `start_at`/`end_at` written as **naive-local** wall-clock (no `Z`, no offset).
- `pending → confirmed` rides the upsert `status` field; the skill never calls
  `/confirm`.

## Out of scope

- Creating new events from chat (edit-only of an existing card).
- Migrating calendar-extractor onto the vendored contract spine.
- Editing confirmed rows back to pending, or deleting via chat (Discard covers delete).

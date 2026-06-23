# calendar-extractor — in-thread card editing (skill side)

**Date:** 2026-06-22
**Repo:** ClawSkills (the `calendar-extractor` skill)
**Companion:** javis-server contract — `javis-server/docs/superpowers/specs/2026-06-22-calendar-card-in-thread-editing-contract.md`

## Problem

When a transcript carries no concrete day/time, the agent extracts the event with an
**inferred** placeholder time (e.g. `10:00 AM UTC`). That event is written `pending`
and pushed into its own Agent Chat thread. The user can reply in that thread to
correct the time ("6 pm today") or another field, but the correction never reaches
the pending card — it stays stranded at the placeholder slot.

## Root cause (skill side)

`dedupKey(ev)` (`scripts/lib.js:36`) is `day|title|startAt` — **time-coupled**. A naive
re-push with the corrected time computes a *different* key, so the server upsert
inserts a **second** row instead of editing the first. An in-place edit requires
addressing the existing row by its **original** key, never a recomputed one.

## Design

A new `update` subcommand that edits one existing pending card **by its original
`dedup_key`**, plus a lightweight `anchor` subcommand so the agent can resolve a
relative time ("today / 6 pm") against the *current* clock (the chat happens later
than extraction, so the original anchor is stale).

### `update` subcommand

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

1. Require a non-empty `dedup_key` — hard error if missing (we cannot guess the row).
2. Normalize the patch through the same `normalizeEvent` discipline; convert
   `start_at`/`end_at` to naive-local-in-`tz` via `toNaiveLocal` (same as the push
   path, so iOS renders the same wall-clock).
3. Upsert to `POST /api/skill/data` (`merge: "upsert"`) with **one item carrying the
   original `dedup_key` verbatim** and the patched fields, `status: "confirmed"`.
   - The key is **passed through, never recomputed from the new time** — this is the
     whole fix. The server matches the existing row by `(user, skill, type,
     dedup_key)` and overwrites `start_at/end_at/payload` in place.
4. **Auto-confirm:** the row must end up `confirmed` (per product decision — stating
   the time in chat *is* the confirmation). This depends on the server change in the
   companion contract (gateway-authed status update); see "Server dependencies".
5. Push a one-line ack back into the same thread (its own `dedup_key`), e.g.
   `✅ Kickoff Meeting → Jun 22, 6:00–7:00 PM · confirmed`.
6. Update the local `seen` map entry for that key's timestamp (the key itself is
   unchanged, so no duplicate-delivery risk).

Only the fields present in `patch` are written; absent fields are left as-is.
Scope per product decision: the patch may carry **any** event field (time, title,
location, attendees, notes), not just time.

### `anchor` subcommand

```bash
node scripts/calendar-extractor.js anchor
```

Prints **only** the relative-date anchor — `{ reference_time, reference_date,
reference_weekday, reference_time_utc, tz }` — by calling `localAnchor(now, tz)`
with `tz` resolved the usual way (payload tz is absent here, so `TZ` env → system
zone). No transcript fetch. The agent uses this to resolve "today / 6 pm / tomorrow"
in the edit turn with the same date discipline the extraction path already enforces.

### SKILL.md additions

A new section, "Editing a pushed card in-thread":

- When the user replies in a calendar card's Agent Chat thread with a correction, the
  agent has that card's **original `dedup_key`** and **current fields** injected by
  the server (see contract). It runs `anchor` to get a fresh "now", resolves the new
  values (emitting `null` rather than guessing when ambiguous — the existing rule),
  builds a `patch`, and runs `update` with the original key.
- Same `tz`/offset discipline as extraction: emit resolved instants with the explicit
  `tz` offset; the script converts to naive-local for storage.
- If the user's correction is unresolvable ("move it later" with no anchor), the agent
  asks a follow-up in-thread rather than guessing — it does **not** call `update`.

## Server dependencies (this skill can't do alone)

The skill's container holds only the **gateway token**. Two pieces must come from
javis-server (full detail in the companion contract):

1. **Identity injection** — the agent turn in a card thread must receive the card's
   original `dedup_key` + current event fields. The card session is a one-way
   `uuid5(user:skill:dedup_key)`, so the server must reverse-resolve session→row.
   Without this the agent cannot target the right card.
2. **Auto-confirm via gateway** — today the gateway-authed `/skill/data` upsert
   updates fields but **not** `status`, and `/skill/data/confirm` is Clerk-gated.
   The server must let the skill flip the row to `confirmed` with its gateway token
   (either honour `status` on upsert-update, or a gateway-authed confirm). Until that
   lands, `update` will correct the *time* in place but the row stays `pending`
   (still tappable Confirm) — a safe partial.

The **in-place field overwrite itself already works** on the current server (upsert
updates `payload/start_at/end_at` on the matched row), so the time-correction half of
this feature functions as soon as the skill ships; only auto-confirm waits on (2).

## Error handling

- Missing/empty `dedup_key` → hard error (exit 1), no write.
- Empty/whitespace `patch` → no-op with a clear message (nothing to change).
- `/skill/data` upsert HTTP failure → report in-thread ("couldn't update the card"),
  non-silent; do not claim success.
- Confirm step failure (once server supports it) → leave the row updated-but-pending
  and say so, rather than asserting confirmed.

## Testing

- Unit tests for `update` (IO-injected, mirroring `doPush`'s `deps` seam): assert the
  **original** `dedup_key` is sent verbatim, that patched fields overwrite and absent
  fields are omitted, and that `status: "confirmed"` rides on the item.
- Unit test for `anchor` output shape (the five anchor fields, no `sessions`).
- Negative tests: missing key → error; empty patch → no-op.
- skill-creator's mock-server dry-run exercises edit-then-confirm end to end.

## Out of scope

- Creating *new* events from chat (this is edit-only of an existing card).
- Editing confirmed rows back to pending, or deleting via chat (Discard already
  covers deletion).

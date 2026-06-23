# calendar-extractor: `update` + `anchor` subcommands for in-thread card editing

## Summary

Adds in-thread editing of a pushed calendar card to the `calendar-extractor` skill. A user can now reply in a card's own Agent Chat thread ("6 pm today", "location is Zoom", "add Alex") and have **that exact pending row** edited in place and confirmed — no duplicate row, no second Confirm tap.

Two new subcommands on `scripts/calendar-extractor.js` (now four total: `fetch`, `push`, `update`, `anchor`):

- **`update`** — reads an edit JSON `{ dedup_key, patch, tz? }` on stdin and POSTs **one** `/api/skill/data` upsert for that single card. The `dedup_key` is passed **verbatim**, the item rides `status:"confirmed"`, times are written naive-local, and the `patch` is treated as the full merged intended state. No `seen`-dedup filtering, no `/api/agent/push`.
- **`anchor`** — prints **only** the relative-date anchor (`localAnchor(now, tz)` plus `tz`) for the **current** clock, so an edit turn can resolve "today / 6 pm / tomorrow" against now. No transcript fetch. Takes the card zone via `--tz <IANA>`, falling back to `TZ` env → system zone.

Supporting changes:
- New shared `postSkillData(token, items)` helper; `mirrorToSkillData` (push path, `status:"pending"`) and the new update path (`status:"confirmed"`) both write through it so request shape and failure semantics live in one place.
- New `defaultPushClient.upsert` seam so tests can record the exact item posted without hitting the network.
- New helpers: `buildUpdateItem`, `patchIsEmpty`, `patchTimeToNaiveLocal` (with `NAIVE_LOCAL_RE`), `readStdinUpdate`, `doUpdate`, `doAnchor` — exported for unit tests.
- **SKILL.md**: new "Editing a pushed card in-thread" section (read `[CURRENT CARD]` → run `anchor` → resolve/null-not-guess → merge into a full patch → `update` with verbatim key), documented auto-confirm semantics, and `update`/`anchor` added to the Core commands block (including the explicit `<userId>` form).
- **package.json**: `0.5.0 → 0.5.1` (new `update`/`anchor` capability).

Files:
- `calendar-extractor/scripts/calendar-extractor.js` (+208/−13)
- `calendar-extractor/SKILL.md` (+79)
- `calendar-extractor/test/update.test.js` (new)

## Why / root cause

The original push path computes `dedup_key` from `day | title | startAt` (`lib.js`). That key is **time-coupled**: any edit that changes the start time would compute a **new** key, match no existing row, and the upsert would **spawn a second card** instead of editing the one the user is replying to. That duplicate is the whole bug.

The fix is a verbatim-key path: on an edit, the original `dedup_key` (read off the injected `[CURRENT CARD]` block) is passed straight through to the upsert and **never recomputed** from the new time, so the upsert matches and overwrites the existing row.

## Consuming the shipped server contract (javis-server PR #89 / `a0f0936`)

The skill consumes — does not rebuild — the already-shipped server/iOS contract:

- **`[CURRENT CARD]` injection.** When an agent turn runs inside a card thread, the server injects a `[CURRENT CARD]` block carrying the card's original `dedup_key` (verbatim) plus its current fields (`title`, `start_at`, `end_at`, `location`, `attendees`, `notes`, `status`). The skill treats this as the source of truth for the row being edited: the agent copies the verbatim key into `update`'s stdin and merges the unchanged fields into the patch.
- **`pending → confirmed` upsert flip.** `POST /api/skill/data` (gateway-authed) matches by `dedup_key`, overwrites `payload`/`start_at`/`end_at` **wholesale**, and honours a `status:"confirmed"` flip atomically with the field write (strictly that direction). So the skill needs exactly **one** upsert with the original key and `status:"confirmed"` — there is no separate `/confirm` call (that endpoint is Clerk-gated and unreachable from the container).

## Invariants held

- **Verbatim `dedup_key`** — the original key is sent as-is, never recomputed from the new start time (no second row).
- **Naive-local wall-clock times** — `start_at`/`end_at` leave the process as `YYYY-MM-DDTHH:MM:SS` with no `Z`/offset (the existing iOS invariant). A changed, offset-bearing instant is collapsed against the card's `tz`; an unchanged offset-less time echoed from `[CURRENT CARD]` is passed through unchanged so a non-time edit is idempotent regardless of the runner's process zone.
- **Full-payload merge** — because the server overwrites `payload`/`start_at`/`end_at` wholesale, the `patch` carries the complete intended state (current `[CURRENT CARD]` fields merged with the change); a time-only edit still resends `title`/`location`/`attendees`/`notes` so they are not blanked.
- **Auto-confirm** — stating the corrected value in chat *is* the confirmation; `status:"confirmed"` rides the upsert and flips the row atomically. The skill never calls `/confirm`. A `/api/skill/data` failure is reported (non-silent); the skill does not claim success.

## Test plan

New `calendar-extractor/test/update.test.js` (IO-injected via a `deps`/client seam, mirroring `doPush`). Full suite via `node --test test/*.test.js`:

```
ℹ tests 47
ℹ pass 47
ℹ fail 0
```

New `update`/`anchor` assertions:
- the **original** `dedup_key` is sent verbatim, not recomputed from the new time;
- `status:"confirmed"` rides on the item;
- `start_at`/`end_at` are written naive-local (no `Z`, no offset);
- a winter (PST `-08:00`) offset and a `Z` instant both collapse to wall-clock in `tz`;
- an offset-less `[CURRENT CARD]` time passes through unchanged (no runner-zone shift);
- the **full merged payload** is sent (a time-only patch keeps title/location/attendees/notes);
- `start_at`-only and `end_at`-only patches yield the matching null counterpart;
- title/location/notes are trimmed; a partial (non-merged) patch blanks omitted fields as-is;
- a `/api/skill/data` failure propagates and prints no "Updated card" success line;
- missing key → throw + no write; whitespace-only key → throw + no write; empty/whitespace patch → no-op + no write;
- `update` never calls the iOS push path (only the skill_data upsert);
- `doAnchor` prints only the anchor (five fields + `tz`), no `sessions`.

The pre-existing `fetch`/`push`/`lib`/`data` tests continue to pass unchanged, confirming the existing paths are untouched.

## Out of scope

- Creating new events from chat (this path is edit-only of an existing card).
- Re-opening a confirmed row back to pending, or deleting via chat (Discard covers delete).
- Migrating calendar-extractor onto the vendored contract spine (regression risk; reuses its existing `lib.js` helpers instead).

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)

# feat(calendar-extractor): per-event `lead_time` + ensured detail fields for the "Javis calls you" voice-call engine

## Summary

This branch (`feat/calendar-lead-time`) lands the **ClawSkills slice** of the
cross-repo *"Javis calls you"* proactive voice-call feature. It adds a per-event
**`lead_time`** (minutes before start, **default 10**) to every event the
`calendar-extractor` skill emits and mirrors to `skill_data`, and it guarantees
the detail fields (`location` / `attendees` / `notes`) ride through as the in-call
**announcement context**.

`lead_time` is the single value this repo feeds into the server-side voice-call
engine: the server's `CalendarVoiceCallSource` computes the proactive call's fire
time as **`fire = start − lead_time`**. The skill normalizes the field in exactly
one place, carries it row-level (not inside the wholesale-overwritten `payload`),
and preserves it across in-thread edits so an edit never silently resets the lead.

Skill version bump: **`0.5.4 → 0.6.0`** (minor — new outward `skill_data` field).

## Scope (what this repo owns)

The full feature spans three repos (`javis-server`, `javisiosapp`, `ClawSkills`).
This PR is **adapter-side data plumbing only** — it owns:

- **In scope (this repo):** extracting/normalizing `lead_time` from transcript
  content; defaulting it to 10; emitting it top-level on both the **push**
  (fresh-event) and **update** (in-thread edit) `skill_data` upsert paths;
  keeping the announcement-context detail fields populated; documenting the
  contract in `SKILL.md`.
- **Out of scope (other repos):** the generic **Engine** (`VoiceCallScheduler`,
  `VoiceCallDispatcher`, `DeviceVoipTokenStore`, APNs VoIP) and the **server
  calendar adapter** `CalendarVoiceCallSource` live in **javis-server**; the iOS
  engine (`VoiceCallPushHandler`/`VoiceCallController`/`VoiceCallSession`) and
  `CalendarVoiceCommandSet` live in **javisiosapp**. This branch does **not**
  touch CallKit, PushKit, audio sessions, or any call lifecycle — it only feeds
  the one scheduling input those layers consume.

## File-by-file changes

| File | Change |
|---|---|
| `calendar-extractor/scripts/lib.js` | New `DEFAULT_LEAD_TIME_MINUTES = 10` const + new `normalizeLeadTime(raw)` helper (coerces number/numeric-string → non-negative integer minutes; floors fractions; absent/null/empty/whitespace/non-finite/negative → default 10). `normalizeEvent` now reads `raw.lead_time` → `leadTime` on the event. `buildSkillDataItems` emits `lead_time` **top-level** on each upsert item (next to `start_at`/`status`/`source_ref`), explicitly NOT inside `payload`. Both new exports added to `module.exports`. Docblock on `buildSkillDataItems` explains the row-level-vs-payload split and that detail fields are the announcement context. |
| `calendar-extractor/scripts/calendar-extractor.js` | Imports `normalizeLeadTime` from `lib`. `patchIsEmpty` field list now includes `'lead_time'`, so a `lead_time`-only edit is treated as a real change (not skipped as a no-op). `buildUpdateItem` emits a normalized row-level `lead_time` on the edit upsert (default 10 when absent), preserving the voice-call lead across in-thread edits. |
| `calendar-extractor/SKILL.md` | Documents `lead_time` in the Extract step (optional integer; default 10; emit only when transcript states a different heads-up, e.g. "an hour before the flight" → 60). Notes the Push path mirrors `lead_time` top-level so the server schedules `start − lead_time`, with detail fields riding in `payload` as announcement context. Update/edit section: `[CURRENT CARD]` now carries `lead_time`; the agent must carry it forward (default 10) so edits never reset the lead. Example update patch includes `"lead_time": 10`. |
| `calendar-extractor/package.json` | Version `0.5.4 → 0.6.0`. |
| `calendar-extractor/test/lib.test.js` | New `normalizeLeadTime` suite (defaults, number/numeric-string acceptance, fraction flooring, `0` is valid, negative/non-finite rejection). `normalizeEvent` lead-time test. `buildSkillDataItems` tests asserting `lead_time` is emitted top-level (default 10, custom 60) and **not** in `payload`, plus a test that detail fields land in `payload` as announcement context. |
| `calendar-extractor/test/update.test.js` | Imports `buildUpdateItem` + `patchIsEmpty`. New tests: edit carries custom `lead_time` (60) onto the upsert and not into payload; edit defaults to 10 when patch omits it (back-compat for old cards); `buildUpdateItem` row-level default/custom/invalid handling; `patchIsEmpty` treats a `lead_time`-only patch (incl. `0`) as a change; `doUpdate` writes through a `lead_time`-only patch. |

## Mapping to the design spec

Maps to `javis.is/docs/superpowers/specs/2026-06-24-javis-calls-you-voice-calendar-alert-design.md`:

- **§4.B — Calendar adapter, "ClawSkills/calendar-extractor + skill_data" table.**
  The two required changes are exactly this PR: (1) `lead_time` (minutes, default
  10) per event drives `fire = start − lead_time`; (2) ensure detail fields
  (location, subtitle/notes, attendees) are present to feed the **Details**
  command. Both are implemented.
- **§2 (Decisions):** "Timing — per-event `lead_time` (minutes before start) from
  skill_data; **default = 10 min**." Implemented as `DEFAULT_LEAD_TIME_MINUTES`.
- **§3 (data flow), step 1:** "`calendar-extractor` writes/updates an event in
  skill_data (carrying `lead_time` + detail fields)." This is the producer side
  of that flow.
- **§5 (command grammar):** the **Details** intent speaks
  subtitle/location/attendees "from `context` (no network)" — this PR keeps those
  fields populated in `payload` as that context.
- **§10 (sequencing), step 1:** "skill_data + extractor — `lead_time` + detail
  fields (low risk; unblocks adapters)." This PR is that first sequencing step,
  unblocking the server engine and adapters.

## Test status (from self-repair)

- Full skill suite: `node --test test/*.test.js` → **65 tests, 65 pass, 0 fail.**
- Targeted lead-time additions live in `test/lib.test.js` (normalization +
  emission) and `test/update.test.js` (edit-path preservation, `patchIsEmpty`,
  write-through), all green.

## Review findings

**Fixed:** none required — the self-repair pass surfaced no critical/high
findings on this branch.

**Deferred (1, medium):** `lead_time` has **no upper bound**.
`normalizeLeadTime` (`lib.js`) clamps the low end (null/empty/non-numeric/
negative/non-finite → default 10) but applies **no upper clamp** — any large
finite value passes straight through via `Math.floor(n)`. Because the value is
LLM-extracted from transcript content and the server computes `fire = start −
lead_time` directly, a hallucinated or transcript-injected value (e.g.
`100000` ≈ 69 days, `525600` ≈ 1 year) makes `fire` land far before `start` —
potentially already in the past at push time — which could make the engine ring a
genuine CallKit/VoIP call at an unintended moment. That undermines the §2.5.4
defensibility posture (every VoIP push should be a real, expected call).
**Recommended fix (follow-up):** add an upper clamp in `normalizeLeadTime` after
`Math.floor(n)` — cap to a sane max (e.g. `MAX_LEAD_TIME_MINUTES = 1440` for 24h,
or `10080` for 7 days), clamping over-range values to the max (or falling back to
the default), mirroring the existing low-end guard; add a `lib.test.js` case
asserting `100000` is clamped. This is the natural place to bound the value before
it reaches the server, since it is the only field this branch feeds into the call
engine. **Deferred — not blocking this data-plumbing PR.**

## Wire contracts this repo owns (spec §9)

This branch is the producer for the `skill_data` row shape the server's calendar
adapter consumes. The contract it owns/extends:

- **`skill_data` upsert item — new top-level field `lead_time`** (integer minutes,
  default 10) on both the push (`buildSkillDataItems`) and update
  (`buildUpdateItem`) paths. It sits **row-level** alongside `start_at` / `end_at`
  / `status` / `source_ref` — **not** inside `payload`, because the server
  overwrites `payload` wholesale on edit and the iOS table renders it. The server
  reads `lead_time` row-level to compute `fire = start − lead_time`.
- **Announcement context (existing, now guaranteed):** `payload.location`,
  `payload.attendees`, `payload.notes` (+ `payload.title`) remain the detail
  fields the engine's **Details** command speaks; kept populated when the
  transcript provides them.
- **`[CURRENT CARD]` injection (server → agent, consumed here):** now includes
  `lead_time`; the agent must carry it forward in the merged edit patch so edits
  don't reset the lead.

These are **reused** wire surfaces (`GET/POST /api/skill/data`, the Flow-3
confirm/discard/upsert endpoints) — no new endpoint is introduced by this repo.
The new generic VoIP-token / earbud-heartbeat endpoint and the APNs VoIP push
payload (spec §9) are **owned by javis-server / javisiosapp**, not here.

## MANUAL OPS checklist (other repos / infra — NOT done by this PR)

This branch ships data only. The following must be completed (in javis-server /
javisiosapp / infra) before the end-to-end call feature works on device:

- [ ] **APNs VoIP push certificate** — provision a PushKit VoIP cert/key for the
      bundle id and install it server-side for `VoiceCallDispatcher` (spec §4.A,
      §9). VoIP pushes silently fail without it.
- [ ] **PushKit + CallKit capabilities (iOS)** — confirm `UIBackgroundModes`
      includes `voip` (spec §9 says `[audio, bluetooth-central, processing, voip]`
      already present — verify) and that the CallKit/Push Notifications
      capabilities are enabled on the target.
- [ ] **Provisioning profile** — regenerate the app's provisioning profile so it
      carries the Push Notifications (VoIP) entitlement; update CI signing.
- [ ] **Alembic migration run** — the server's `DeviceVoipTokenStore` (VoIP token
      + earbud-heartbeat) needs a new table; run `alembic upgrade head` on
      javis-server prod after that migration lands (it is **not** part of this
      repo).
- [ ] **Republish skill to per-user openclaw containers** — this skill runs inside
      each user's openclaw container; bump-and-publish `calendar-extractor@0.6.0`
      via clawhub and update the containers, or extractions keep emitting the old
      no-`lead_time` shape (the javis-server deploy alone does not pick it up).
- [ ] **On-device manual test** — sim cannot fully exercise CallKit-while-locked +
      Bluetooth HFP (spec §8 E2E). Run the locked / earbud-in wake→announce→command
      happy path on a real device once the engine ships.

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)

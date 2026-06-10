# calendar-extractor v0.4 — adapt to the session-dispatcher control-plane

**Date:** 2026-06-08
**Status:** Design (approved in brainstorming)
**Scope:** ClawSkills (`calendar-extractor`) + a documented route contract the
javis-server team must satisfy. No javis-server code is implemented here.

## Background — the new architecture

javis-server introduced a **session-dispatcher control-plane** (javis-server
`docs/superpowers/specs/2026-06-06-session-dispatcher-server-variant.md`,
implemented in `app/services/dispatcher_service.py`). It changes how completed
units of input fan out to skills.

### The whole loop (record session & keyboard session)

1. **Capture (javisiosapp).**
   - *Keyboard session:* the `JavisKeyboard` extension (`KeyboardViewController`)
     and the main app's `JavisApp/keyboard` stack (`KeyboardRecordingCoordinator`,
     `KeyboardOnlineCapture`, `OnDeviceTranscriptionService`,
     `TranscriptionPipeline`) communicate over the app-group `Shared/KeyboardBridge`.
     On save the app calls `POST /api/keyboard/proofread`.
   - *Record (audio) session:* segments upload; on stop the app closes the session
     via the audio close endpoint.

2. **Server ingest — the single front door.** Both completions fan out through
   exactly one seam:
   - `app/routers/audio.py` → `DispatcherService.on_unit_complete(unit="audio:<session_id>")`
   - `app/routers/keyboard.py` → `DispatcherService.on_unit_complete(unit="kbd:<keyboard_input.id>")`

3. **Dispatch (control-plane).** `on_unit_complete`:
   validate unit (`_UNIT_RE`) → skip if the user's container is not `running` →
   **dedup by `(user, unit)`** → load transcript from DB → CrewAI
   `classify_and_route` → for each deliverable match its `route_id` against the
   user's **enabled `RouteRegistry`** row → persist a `DispatchProposal` → push a
   proposal card to iOS (`event_list` + `action_buttons` blocks; persisted as an
   `AgentTask` skill=`session-dispatcher`, broadcast over WS + SSE).

4. **Approve → run.** iOS taps Approve → `POST /api/dispatch/approve
   {proposal_id, deliverable_ids}` (Clerk JWT) → `DispatcherService.approve`:
   claim `DispatchRouteExecuted (user, unit, route)` via a unique constraint
   **before** scheduling (run-once per unit, closes TOCTOU) → `trigger_skill` →
   `run_skill_invocation` → `openclaw_service.execute_stream(query=prompt, skill)`
   to the per-user gateway container via `/v1/responses` SSE. The run prompt is
   generic:
   `Run /<skill> for <unit>. Deliverable: <title>. <description> Fetch that unit's transcript, produce the deliverable, and push the result.`

### Two cross-cutting rules the dispatcher established

(`javis-server/app/services/CLAUDE.md`)

1. **Single front door.** Per-unit completion goes only through
   `on_unit_complete`. Do **not** re-add direct per-unit skill webhooks
   (`/hooks/agent`). This supersedes `app/services/calendar_webhook.py`.
2. **prompt-not-skill_data.** Server→container runs carry context in the run
   prompt, because the container's gateway token cannot read `skill_data` back
   (`GET /api/skill/data` is Clerk-gated).

## Problem

The current `calendar-extractor` SKILL.md and scripts are built for the **old**
per-unit webhook model: the server POSTed `/hooks/agent`, the skill self-gated
each unit with a local `extractedUnits` flag + `push --unit`, and a twice-daily
cron auto-pushed digests. None of that matches the dispatcher model:

- The webhook is gone (single-front-door rule).
- The server now owns run-once (`DispatchRouteExecuted`) and human approval, so
  the skill's per-unit self-gating is redundant.
- The skill cannot be scheduled at all unless an *enabled* `RouteRegistry` row
  routes a classifier deliverable to it — and no such contract exists yet.

## Goals

- Make `calendar-extractor` correct under the dispatcher model.
- Remove the obsolete webhook/cron/`--unit` surface.
- Define the route contract the server must satisfy so the dispatcher can route
  agenda deliverables to this skill.

## Non-goals

- Implementing the javis-server side (RouteRegistry seeding, classifier prompt
  wiring). Specified as a contract only.
- Changing the date-resolution logic — it stays self-contained and unchanged.

## Decisions (from brainstorming)

| # | Decision |
|---|---|
| Scope | Skill repo changes + a documented route contract (interface, not server impl). |
| Idempotency | **Drop** the per-unit `extractedUnits`/`--unit` guard; trust the server's `DispatchRouteExecuted` + approval gate. Keep the event-level `seen` map. |
| Cron/manual | **Keep manual**, **drop cron**. Two triggers: dispatcher-approve (auto, human-gated) + manual on-demand. Removes the down-container back-fill (manual ask back-fills on demand instead). |
| Routing | **Approach A — static `route_id` convention.** The skill declares `route_id:"calendar"` + matching hints; the server seeds the `RouteRegistry` row and feeds the route catalog to the classifier. |

## Design

### 1. Trigger model

Two triggers, no webhook:

1. **Dispatcher-approve (auto, human-gated).** Unit completes → dispatcher
   classifies → if an enabled `calendar` route matches, a proposal card goes to
   iOS → user approves → server runs the skill in the container with the generic
   prompt. The skill parses `<unit>` (`audio:<sid>` / `kbd:<id>`), runs
   `fetch --session`/`fetch --kbd-input`, extracts, and pushes the digest. The
   skill **does not self-gate**; the server owns run-once + approval.
2. **Manual ("today's meetings").** On-demand 24h-window `fetch` → extract →
   push.

Removed: the "Per-unit auto trigger (webhook)" section, all `/hooks/agent`
references, the `hooks` config-block notes, the cron path, and
`push-toggle.js` scheduling.

### 2. Script changes (`scripts/`)

- **`calendar-extractor.js push`** — remove `--unit <unitKey>`, the
  `extractedUnits` flag/cache, and `unitKeyFor`-based gating. Keep the
  event-level `seen` map (still needed so the manual window path does not
  re-surface the same event across overlapping 24h windows). Push still:
  dedup against `seen` → best-effort mirror to `POST /api/skill/data` →
  deliver markdown via `POST /api/agent/push`.
- **`calendar-extractor.js fetch`** — unchanged behavior. `--session` /
  `--kbd-input` resolve one unit (the approved dispatcher run); the windowed
  default serves the manual ask. The top-level
  `reference_time` / `reference_date` / `reference_weekday` / `tz` anchor stays
  emitted on every path (`scripts/calendar-extractor.js:210`), so the
  date-resolution discipline survives the generic dispatcher prompt.
- **tz source** — `push-toggle.js` is retired, so `getTz()` loses its prefs
  file. New resolution order: `tz` from the fetch payload → `TZ` env var →
  system zone fallback. The manual path resolves tz the same way the dispatcher
  path does; no per-user prefs file is required.
- **Delete `push-toggle.js`** and the cron-registration helpers. **Keep
  `register.js`** (optional multi-profile userId).
- **`data.js` / `lib.js`** — drop the `extractedUnits` read/write helpers; keep
  `seen` TTL pruning, the userId path-traversal guard, and the skill-data item
  builder.

**Consequence:** dropping `extractedUnits` removes the manual re-display cache
(the container cannot read `/api/skill/data` back), so a repeated manual ask
re-runs extraction on the window rather than replaying a cache. The `seen` map
still prevents duplicate *delivery*.

### 3. Route contract (interface javis-server must satisfy)

Documented here and in `references/route-contract.md`; not implemented in this
repo.

**3a. `RouteRegistry` row** (per user, seeded when the skill is enabled):

| column | value |
|---|---|
| `route_id` | `"calendar"` |
| `skill` | `"calendar-extractor"` |
| `matches` | `"meetings, appointments, events, agenda, scheduling, dates/times mentioned"` |
| `args_template` | `null` (unit + SKILL.md carry everything) |
| `risk` | `"low"` (read-only extraction + push) |
| `enabled` | set when the user enables calendar-extractor |

**3b. Classifier (`classify_and_route`) expectation.** The task prompt must be
fed the user's enabled route catalog (`route_id` + `matches`) so that, for a
transcript with scheduling content, it emits:

```json
{ "id": "<uuid>", "title": "Extract calendar events",
  "description": "<short summary of the agenda found>",
  "route_id": "calendar", "confidence": 0.x }
```

No scheduling content → no `calendar` deliverable → no proposal (correct).

**3c. Prompt contract.** The skill relies only on `<unit>` being present and
`_UNIT_RE`-valid in the run prompt (it is). All date-resolution discipline rides
in the fetched anchor + the prepended SKILL.md, so the server need not enrich
the prompt; `args_template` stays empty and `_deliverable_prompt` needs no
calendar-specific change.

**3d. Where the contract lives.** Declared in `SKILL.md` `metadata.routes` (so
it is discoverable) plus `references/route-contract.md` documenting 3a–3c for the
server team.

### 4. SKILL.md rewrite

- **Frontmatter `description`/triggers** — drop "Run every 6 hours" (cron gone).
  Reframe around manual triggers (`today's meetings`, `calendar extract`,
  `今日会议`, `提取日历`) plus a note that the server dispatcher invokes the skill
  automatically on approval. Add the `metadata.routes` block (3d).
- **Core commands** — remove `push-toggle.js`, the `--unit` push form, and the
  `openclaw cron add` block. Keep `fetch [--hours N]`, `fetch --session`,
  `fetch --kbd-input`, and bare `push`.
- **Workflow** — keep the 3-step fetch→extract→push pipeline and the full
  date-resolution discipline (unchanged, self-contained).
- **Replace** "Per-unit auto trigger (webhook)" → new **"How this skill is
  invoked"** section describing proposal→approve→run and the two triggers.
- **Remove** "Push setup (cron registration)".
- **Notes** — data sources unchanged (audio + keyboard via the same endpoints);
  dedup note now only `seen` (server owns run-once); tz note (no prefs file;
  payload/`TZ` env); keep the markdown-not-native-cards note.

### Error handling (unchanged principles)

Fetch fails / 0 sessions / empty transcript → emit `[]`, push nothing.
Best-effort `skill/data` mirror. The skill never assumes it was invoked exactly
once — re-running is safe because `seen` prevents duplicate delivery and the
server prevents duplicate invocation.

### Testing

Update the existing script tests:

- remove `extractedUnits` / `--unit` cases;
- single-unit `fetch --session` / `fetch --kbd-input` still emits the anchor;
- `push` dedups via `seen`;
- tz resolution falls back through payload → `TZ` → system;
- userId path-traversal guard intact;
- `[]`-on-empty path pushes nothing.

### Versioning

Bump to **v0.4.0** — breaking: removes the webhook/cron/`--unit` surface.

## Open items for the server team (tracked by the contract, not this repo)

- Seed/enable the `RouteRegistry` row for `calendar` when a user enables
  calendar-extractor.
- Feed the enabled route catalog (`route_id` + `matches`) into the
  `classify_and_route` task prompt.

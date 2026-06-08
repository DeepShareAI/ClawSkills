---
name: calendar-extractor
description: Extract calendar events from recent recording and keyboard transcripts and push a markdown digest to your iOS chat. Use on demand when the user asks for "today's meetings" / "calendar extract" / "今日会议" / "提取日历", and fetch the last 24 hours of transcript data by default. The javis-server session dispatcher also invokes this skill automatically once the user approves a calendar proposal. If the user asks for "today's meetings", use the local day defined by the fetched reference_date field. Triggers: 'today's meetings', 'calendar extract', '今日会议', '提取日历'.
keywords: today's meetings, calendar extract, 今日会议, 提取日历, calendar-extractor
metadata:
  openclaw:
    runtime:
      node: ">=18"
  routes:
    - route_id: calendar
      skill: calendar-extractor
      matches: "meetings, appointments, events, agenda, scheduling, dates/times mentioned"
      args_template: null
      risk: low
---

# Calendar Extractor

> Extract calendar events from recent recording and keyboard transcripts and push a markdown digest to your iOS chat. Fetch the last 24 hours of transcript data by default. If the user asks for "today's meetings", use the local day defined by the fetched reference_date field. Generate one digest per local day in the user's timezone, containing all events that occur on reference_date and any events explicitly mentioned as happening today.

## When to use

- "today's meetings"
- "calendar extract"
- "今日会议"
- "提取日历"
- Automatically, when the javis-server session dispatcher runs this skill after the user approves a calendar proposal (see "How this skill is invoked").

## Core commands

> **`<userId>` is optional.** Omit it and it defaults to `self`. Each HiJavis user
> runs in their own openclaw container, so `self` is correctly isolated; the gateway
> token (not the userId) authenticates every server call. No registration is needed
> to start — pass an explicit ID only if you run multiple profiles in one container.

```bash
# Step 1 — fetch recent transcripts as JSON (the agent extracts events from this)
node scripts/calendar-extractor.js fetch [--hours N] [--limit N]

# Step 1 (dispatcher run) — fetch ONE completed unit (the approved proposal's unit)
node scripts/calendar-extractor.js fetch --session <sessionId> [--hours N]   # audio unit
node scripts/calendar-extractor.js fetch --kbd-input <inputId> [--hours N]   # keyboard unit

# Step 2 — push: pipe the extracted-events JSON array to stdin; dedups (seen) + delivers to iOS
echo '<events-json-array>' | node scripts/calendar-extractor.js push

# Optional: explicit userId / multi-profile (back-compat — prepend the ID)
node scripts/register.js <userId> <name>
node scripts/calendar-extractor.js <userId> fetch
echo '<events-json-array>' | node scripts/calendar-extractor.js <userId> push
```

## Workflow

This skill is a two-step pipeline: the **script** does the I/O (fetch transcripts, dedup, push),
the **agent/LLM** does the reasoning (extract events). Extraction is not hardcoded — the agent
reads the fetched transcripts and emits a JSON array of events.

1. **Fetch** — `node scripts/calendar-extractor.js <userId> fetch` issues
   `GET http://javis-server:8000/api/transcripts/recent?since=…&limit=…` with the
   `OPENCLAW_GATEWAY_TOKEN` bearer and prints
   `{ "reference_time": LOCAL-wall-clock (zoneless, in tz), "reference_date": "YYYY-MM-DD", "reference_weekday": "Thursday", "reference_time_utc": ISO8601, "tz": IANA, "sessions": [ { session_id, started_at, ended_at, transcript } ] }`. If fetch fails, returns invalid JSON, or yields zero sessions, output an empty events array and do not push anything; report the failure only if the user asked for a diagnostic. If the fetch response contains no sessions or the transcript text is empty, return `[]` and do not attempt to push a digest.
2. **Extract** — the agent reads that JSON and produces an events array. Each event:
   `{ "title", "start_at" (ISO 8601), "end_at" (ISO 8601, optional), "location", "attendees" (array), "notes", "source_ref" (session_id), "source_kind" ("audio"|"keyboard", from the session's source) }`.
   Carry `source_kind` through so provenance flows to the `/api/skill/data` mirror and the iOS digest.
   **Date resolution (required):** the top-level `reference_time` is **already local
   wall-clock in `tz`** (zoneless) and `reference_date`/`reference_weekday` give the local
   "today" — so "today" == `reference_date`, and "tomorrow"/"Saturday"/"next Thursday" count
   forward from `reference_weekday`. Do **not** re-apply the tz offset and do **not** anchor on
   `reference_time_utc` (the raw instant, whose date can be the *next* day in the evening — that
   is exactly the off-by-one this field avoids). Fall back to the session's `started_at` only if
   `reference_time` is absent. Never use your own sense of "today". Emit each event's `start_at`/
   `end_at` as a full ISO 8601 instant **with the explicit `tz` UTC offset** (e.g. an 8 PM event
   in `America/Los_Angeles` → `2026-06-04T20:00:00-07:00`) — not a zoneless string, which the
   pipeline would misparse in the container's system zone. Infer AM/PM from surrounding context (e.g. "show starts at 8pm" → evening; "before Gaza's
   party at 6pm" → 18:00). If the transcript does not provide enough information to determine a unique date/time (for example, only "next Friday" with no weekday anchor or an ambiguous time like "at 8" without AM/PM), emit `null` for the unresolved field rather than guessing. When multiple plausible interpretations are equally supported by the transcript, prefer the most specific one; if two interpretations remain equally plausible, emit `null` for the unresolved field rather than guessing. If the transcript mentions recurring meetings, all-day meetings, or multi-day events, preserve them as a single event only when the recurrence is explicit; otherwise emit a single event with the best available start/end times and note the ambiguity in `notes`.
3. **Push** — pipe the events array into `node scripts/calendar-extractor.js <userId> push`. The script:
   - dedups against per-user local state (`data/users/<userId>.json` → `seen` map, 30-day TTL),
   - best-effort mirrors the **new** events to `POST /api/skill/data` (upsert by `dedup_key`) for the iOS app to read,
   - formats the **new** events as a markdown digest and delivers it via
     `POST http://javis-server:8000/api/agent/push` with `{"skill": "calendar-extractor", "content": "<markdown>"}`.

## How this skill is invoked

This skill has **two triggers** (dispatcher-approve and manual).

1. **Dispatcher-approve (automatic, human-gated).** When a unit of input completes (an
   audio session ends or a keyboard input is saved), the javis-server **session
   dispatcher** classifies the transcript. If it finds scheduling content and an enabled
   `calendar` route matches, the server persists a `DispatchProposal` and pushes a
   proposal card to iOS. The user taps **Approve** → the server claims run-once
   (`DispatchRouteExecuted (user, unit, route)`) and runs this skill in the user's
   container with a generic prompt of the form
   `Run /calendar-extractor for <unit>. Deliverable: …`. The agent parses `<unit>`
   (`audio:<session_id>` or `kbd:<keyboard_input.id>`), runs `fetch --session <id>` /
   `fetch --kbd-input <id>`, extracts events, and pushes the digest. **The skill does not
   self-gate** — the server owns run-once and the human approval gate.
2. **Manual ("today's meetings").** On demand, the agent runs the windowed
   `fetch` (last 24h by default) → extracts → pushes. Repeating the ask re-runs
   extraction on the window; the `seen` map still prevents duplicate delivery.

The route contract the javis-server team must satisfy (RouteRegistry row,
`classify_and_route` deliverable shape, prompt contract) is declared in this file's
`metadata.routes` block and documented in `references/route-contract.md`.

## Notes

- **Runtime dependencies** — the extractor script uses Node 18+ built-ins only (`fetch`, `fs`, `path`); no `npm install` is needed for the script runtime.
- **Data sources**: audio recording transcripts **and** keyboard-dictation sessions — both via
  `GET /api/transcripts/recent` (gateway-token authed), each session carrying a `source` field
  (`"audio"` | `"keyboard"`); a single keyboard unit resolves via
  `GET /api/transcripts/keyboard-input/<id>`. Plus per-user local state (dedup memory). There is no
  `HTTP_SOURCE_URL` — the script talks to javis-server directly.
- **Dedup is local-state-authoritative, event-level only.** The container's gateway token can
  WRITE to `/api/skill/data` but cannot read it back (`GET /api/skill/data` requires a Clerk JWT),
  so novelty is decided by the local `seen` map; the server write is a best-effort mirror for the
  iOS app. There is **no per-unit gating** in the skill — the server owns run-once
  (`DispatchRouteExecuted`) and approval, so the only local dedup is the event-level `seen` map
  (`{ "<event-key>": "<ts>" }` in `data/users/<userId>.json`, 30-day TTL-pruned). It keeps a
  duplicate event from re-reaching the table/chat across overlapping manual windows or a re-run.
- **Timezone**: there is **no prefs file**. The skill resolves tz in order:
  the `tz` field on the fetch payload → the `TZ` environment variable → the system zone
  (`Intl.DateTimeFormat().resolvedOptions().timeZone`). The manual and dispatcher paths resolve tz
  the same way.
- **Markdown, not native cards.** A push delivers a `content` string rendered as markdown on iOS
  (`MDBlock`). Native `EventList`/`EventCard` blocks are emitted only during a live SSE agent turn
  (`_maybe_emit_chat_block`), not via the push path — so the digest is rich markdown by design.
- **User IDs** only allow letters, digits, `-`, `_` (path-traversal guard in `data.js`).
- **Backgrounded/killed iOS app**: `AGENT_PUSH` is WebSocket-only (no APNs). For mission-critical
  delivery, add a Telegram channel as backup.

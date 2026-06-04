---
name: calendar-extractor
description: Periodically scan recent recording sessions, extract calendar events from transcripts, and push a daily summary to your iOS chat. Triggers: 'today's meetings', 'calendar extract', '今日会议', '提取日历'.
keywords: today's meetings, calendar extract, 今日会议, 提取日历, calendar-extractor
metadata:
  openclaw:
    runtime:
      node: ">=18"
---

# Calendar Extractor

> Periodically scan recent recording sessions, extract calendar events from transcripts, and push a daily summary to your iOS chat.

## When to use

- "today's meetings"
- "calendar extract"
- "今日会议"
- "提取日历"

## Core commands

> **`<userId>` is optional.** Omit it and it defaults to `self`. Each HiJavis user
> runs in their own openclaw container, so `self` is correctly isolated; the gateway
> token (not the userId) authenticates every server call. No registration is needed
> to start — pass an explicit ID only if you run multiple profiles in one container.

```bash
# Step 1 — fetch recent transcripts as JSON (the agent extracts events from this)
node scripts/calendar-extractor.js fetch [--hours N] [--limit N]

# Step 1 (auto / webhook) — fetch ONE completed unit, filtered from the window
node scripts/calendar-extractor.js fetch --session <sessionId> [--hours N]   # audio unit
node scripts/calendar-extractor.js fetch --kbd-input <inputId> [--hours N]   # keyboard unit

# Step 2 — push: pipe the extracted-events JSON array to stdin; dedups + delivers to iOS
echo '<events-json-array>' | node scripts/calendar-extractor.js push

# Step 2 (auto / webhook) — extract ONE unit at most once (idempotent)
echo '<events-json-array>' | node scripts/calendar-extractor.js push --unit <unitKey>

# Push management
node scripts/push-toggle.js on [--time HH:MM] [--tz IANA] [--channel iOS|Telegram|Discord|Slack]
node scripts/push-toggle.js off
node scripts/push-toggle.js status

# Optional: explicit userId / multi-profile (back-compat — prepend the ID)
node scripts/register.js <userId> <name>
node scripts/calendar-extractor.js <userId> fetch
echo '<events-json-array>' | node scripts/calendar-extractor.js <userId> push
node scripts/push-toggle.js on <userId> [--time HH:MM] [--tz IANA]
```

## Workflow

This skill is a two-step pipeline: the **script** does the I/O (fetch transcripts, dedup, push),
the **agent/LLM** does the reasoning (extract events). Extraction is not hardcoded — the agent
reads the fetched transcripts and emits a JSON array of events.

1. **Fetch** — `node scripts/calendar-extractor.js <userId> fetch` issues
   `GET http://javis-server:8000/api/transcripts/recent?since=…&limit=…` with the
   `OPENCLAW_GATEWAY_TOKEN` bearer and prints
   `{ "reference_time": ISO8601, "tz": IANA, "sessions": [ { session_id, started_at, ended_at, transcript } ] }`.
2. **Extract** — the agent reads that JSON and produces an events array. Each event:
   `{ "title", "start_at" (ISO 8601), "end_at" (ISO 8601, optional), "location", "attendees" (array), "notes", "source_ref" (session_id), "source_kind" ("audio"|"keyboard", from the session's source) }`.
   Carry `source_kind` through so provenance flows to the `/api/skill/data` mirror and the iOS digest.
   **Date resolution (required):** resolve every relative reference ("today", "tomorrow",
   "Saturday", "next Thursday", "noon", "around 6/7/8") against the top-level `reference_time`
   in `tz` — falling back to the session's `started_at` if `reference_time` is absent. Never use
   your own sense of "today". Infer AM/PM from surrounding context (e.g. "show starts at 8pm" →
   evening; "before Gaza's party at 6pm" → 18:00). If a date or time genuinely cannot be resolved,
   emit `null` for that field rather than guessing.
3. **Push** — pipe the events array into `node scripts/calendar-extractor.js <userId> push`. The script:
   - dedups against per-user local state (`data/users/<userId>.json` → `seen` map, 30-day TTL),
   - best-effort mirrors all events to `POST /api/skill/data` (upsert by `dedup_key`) for the iOS app to read,
   - formats the **new** events as a markdown digest and delivers it via
     `POST http://javis-server:8000/api/agent/push` with `{"skill": "calendar-extractor", "content": "<markdown>"}`.

## Per-unit auto trigger (webhook)

javis-server fires an openclaw **webhook** the moment a unit of input completes — an
audio session ends or a keyboard input is saved — so extraction runs without waiting for
the cron. javis-server `POST`s `http://<container>:18789/hooks/agent` (Bearer = the
container's `gateway_token`) with a message asking the agent to run this skill for the
just-finished unit. The webhook endpoint is exposed by the container's openclaw config
`hooks` block (`{ "enabled": true, "token": "<gateway_token>", "path": "/hooks" }`),
which javis-server now emits per user. No new container code is needed.

A **unit** is `audio:<session_id>` (audio) or `kbd:<keyboard_input_id>` (keyboard).
Each unit is extracted **at most once** — the flag lives in `extractedUnits` (below).
The keyboard unit id is the **same** keyboard_input.id across all three sites — the
webhook (`kbd:<id>`), `fetch --kbd-input <id>`, and `unitKeyFor` (from each event's
`source_ref`) — so the auto and manual paths recognize each other's flags. `fetch
--kbd-input <id>` resolves that single row via the dedicated endpoint
`GET /api/transcripts/keyboard-input/<id>` (gateway-token authed; returns the row as a
one-entry payload with `source="keyboard"`, `session_id=str(input id)`). The aggregated
`/api/transcripts/recent` keys keyboard entries by daily session_id and carries no
per-row id, so it serves only the audio `--session` filter and the manual time-window
path.

- **Auto path (one unit).** The agent runs `fetch --session <id>` / `fetch --kbd-input <id>`
  to pull just that unit, extracts events, then `push --unit <unitKey>`. `push --unit`:
  - if the unit is already in `extractedUnits` → no-op (`already extracted: <unit>`, idempotent);
  - else if extraction yielded **zero** events → the unit is left **unflagged** (the fetch
    may have raced the DB), so the next manual ask can back-fill it; nothing is written or pushed;
  - else mirror to `/api/skill/data`, push the digest to iOS, and record
    `extractedUnits[<unitKey>] = { ts, events }` (flag + cache).
- **Manual path (no `--unit`).** When the user asks again ("today's meetings"), `push`
  with **no** `--unit` fills gaps: already-flagged units are re-displayed from their
  cached events (no table re-write); not-yet-flagged units are extracted, written, pushed,
  flagged, and cached. One combined digest; only fresh units touch the table.
- **Container down at completion** → the webhook fails silently and the unit stays
  unflagged; the next manual ask back-fills it. No loss.

## Push setup (cron registration)

When the user requests scheduled push:

### Step 1: Save preferences
```bash
node scripts/push-toggle.js on <userId> --time 08:00 --tz America/Los_Angeles
```
This prints the ready-to-run `openclaw cron add` command (it derives the crontab from `--time`).

### Step 2: Create the cron job via openclaw CLI
The default twice-daily schedule (08:00 & 18:00 America/Los_Angeles). Note the real openclaw flags
— `--cron` (not `--schedule`) for the expression and `--message` (not `--command`) for the agent payload:

```bash
openclaw cron add \
  --name "calendar-extractor-<userId>" \
  --cron "0 8,18 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Run /calendar-extractor. Step 1: node scripts/calendar-extractor.js <userId> fetch (recent transcripts as JSON, with a top-level reference_time + tz anchor). Step 2: extract calendar events as a JSON array (title, start_at, end_at ISO 8601, location, attendees, source_ref, source_kind audio|keyboard from the session's source). Resolve all relative dates/times against reference_time in its tz (fallback: session started_at), infer AM/PM from context, and use null when unresolvable. Step 3: pipe that array into node scripts/calendar-extractor.js <userId> push — it dedups and delivers a markdown digest to iOS."
```

### Step 3: Confirm to user
Push is set up; results land in iOS agent chat under /calendar-extractor.

Supported channels: iOS (default). For Telegram/Discord/Slack add `--channel <ch> --to "<channel-target-id>"`
to a separate `openclaw cron add` — iOS delivery is the script's `/api/agent/push` call (no channel flag needed).

## Notes

- **No external dependencies** — Node 18+ built-ins only (`fetch`, `fs`, `path`). No `npm install`.
- **Data sources**: audio recording transcripts **and** keyboard-dictation sessions — both via
  `GET /api/transcripts/recent` (gateway-token authed), each session carrying a `source` field
  (`"audio"` | `"keyboard"`) — plus per-user local state (dedup memory). There is no
  `HTTP_SOURCE_URL` — the script talks to javis-server directly.
- **Dedup is local-state-authoritative.** The container's gateway token can WRITE to
  `/api/skill/data` but cannot read it back (`GET /api/skill/data` requires a Clerk JWT), so novelty is
  decided by local state; the server write is a best-effort mirror for the iOS app.
- **Two local maps in `data/users/<userId>.json`** (both 30-day TTL-pruned):
  - `seen` — event-level dedup (`{ "<event-key>": "<ts>" }`). Backstop so a duplicate
    event never re-reaches the table/chat even if a unit flag is lost.
  - `extractedUnits` — per-unit flag **and** event cache
    (`{ "audio:<sid>" | "kbd:<id>": { "ts", "events": [...] } }`). The primary
    "don't-extract-twice" record. Caching each unit's extracted events lets a manual ask
    re-display flagged units from the cache (no LLM re-run, no table re-write) — the
    container cannot read the calendar table back, so the cache is the only source.
- **Markdown, not native cards.** A cron push delivers a `content` string rendered as markdown on iOS
  (`MDBlock`). Native `EventList`/`EventCard` blocks are emitted only during a live SSE agent turn
  (`_maybe_emit_chat_block`), not via the push path — so the digest is rich markdown by design.
- **User IDs** only allow letters, digits, `-`, `_` (path-traversal guard in `data.js`).
- **TZ caveat**: the cron tz is fixed at registration. If you travel, re-register:
  `node scripts/push-toggle.js off <userId>`, then `on <userId> --tz <new-tz>`, then re-run `openclaw cron add` with the new `--tz`.
- **Backgrounded/killed iOS app**: `AGENT_PUSH` is WebSocket-only (no APNs). For mission-critical
  delivery, add a Telegram channel as backup via a separate cron.

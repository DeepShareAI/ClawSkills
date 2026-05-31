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

# Step 2 — push: pipe the extracted-events JSON array to stdin; dedups + delivers to iOS
echo '<events-json-array>' | node scripts/calendar-extractor.js push

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
  decided by the local `seen` map; the server write is a best-effort mirror for the iOS app.
- **Markdown, not native cards.** A cron push delivers a `content` string rendered as markdown on iOS
  (`MDBlock`). Native `EventList`/`EventCard` blocks are emitted only during a live SSE agent turn
  (`_maybe_emit_chat_block`), not via the push path — so the digest is rich markdown by design.
- **User IDs** only allow letters, digits, `-`, `_` (path-traversal guard in `data.js`).
- **TZ caveat**: the cron tz is fixed at registration. If you travel, re-register:
  `node scripts/push-toggle.js off <userId>`, then `on <userId> --tz <new-tz>`, then re-run `openclaw cron add` with the new `--tz`.
- **Backgrounded/killed iOS app**: `AGENT_PUSH` is WebSocket-only (no APNs). For mission-critical
  delivery, add a Telegram channel as backup via a separate cron.
- **Out of scope — per-session trigger**: "fire on each finished recording" needs server-side wiring
  (javis-server watching `audio_recordings.session_completed`); the container is cron-driven only. Stays a follow-up.

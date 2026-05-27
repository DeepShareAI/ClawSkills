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

```bash
# Register (first use)
node scripts/register.js <userId> <name>

# Run today's flow (also what the cron triggers)
node scripts/calendar-extractor.js <userId>

# Push management
node scripts/push-toggle.js on <userId> [--time HH:MM] [--channel iOS|Telegram|Discord|Slack]
node scripts/push-toggle.js off <userId>
node scripts/push-toggle.js status <userId>
```

## Workflow

1. Fetch recent transcripts via the LLM's javis_mcp tools (get_transcript_tool / search_transcripts_tool) and pass the relevant text to this script on stdin.
2. Fetch from the configured HTTP endpoint (set HTTP_SOURCE_URL env var when registering the cron).
3. Format output and POST to `http://javis-server:8000/api/agent/push` with `{"skill": "calendar-extractor", "content": "<formatted>"}` using `OPENCLAW_GATEWAY_TOKEN` for auth.

## Push setup (cron registration)

When user requests scheduled push:

### Step 1: Save preferences
```bash
node scripts/push-toggle.js on <userId> --time <HH:MM> --channel <channel>
```

### Step 2: Create cron job via openclaw CLI
```bash
openclaw cron add \
  --name "calendar-extractor-<userId>" \
  --schedule "0 8,18 * * *" \
  --tz "America/Los_Angeles" \
  --channel <channel> \
  --to "<channel-target-id>" \
  --session isolated \
  --command "Run /calendar-extractor: execute node scripts/calendar-extractor.js <userId>, format output nicely. Then POST to http://javis-server:8000/api/agent/push with JSON body {\"skill\": \"calendar-extractor\", \"content\": \"<formatted output>\"} using the gateway bearer token for auth."
```

### Step 3: Confirm to user
Push is set up; results land in iOS agent chat under /calendar-extractor.

Supported channels: iOS, Telegram, Discord, Slack

## Notes

- Data stored in `data/users/<userId>.json`; external HTTP source configured separately via `HTTP_SOURCE_URL` env var.
- Run `npm install` before first run (none needed beyond Node 18+ built-ins, but the `engines` field gates the runtime).
- User IDs only allow letters, digits, `-`, `_` (path-traversal guard in `data.js`).
- **Additional data sources picked but NOT auto-wired in `main()`**: `pure-local-state` and `user-typed-text`. The template only emits code for the first 2 sources (transcripts + external-http). To activate the others, hand-edit `scripts/calendar-extractor.js`:
  - For pure-local-state: `const userState = fs.existsSync(safeUserPath(userId)) ? readJson(safeUserPath(userId)) : {};`
  - For user-typed-text: `const text = process.argv.slice(3).join(' ');`
- **TZ caveat**: cron tz is hardcoded to `America/Los_Angeles` at registration time. If you travel, re-register with the new tz: `node scripts/push-toggle.js off <userId>`, then `node scripts/push-toggle.js on <userId> --tz <new-tz>`, then re-run the `openclaw cron add` command above with the new `--tz`.
- **Multi-channel cron**: each non-iOS channel (Telegram, Discord, Slack) needs a SEPARATE `openclaw cron add` with its own `--channel` and `--to <channel-target-id>`. iOS push is automatic via the `/api/agent/push` call (no separate cron needed for iOS).
- **Session-finalize trigger (NOT implemented)**: the "fire on each finished recording" requirement is out-of-scope for skill-creator's periodic-push template. It requires server-side wiring: javis-server watches `audio_recordings.session_completed` flips and POSTs a synthetic prompt to the user's openclaw container `/v1/responses` to invoke this script with the finalized session id. Track as a follow-up in javis-server.

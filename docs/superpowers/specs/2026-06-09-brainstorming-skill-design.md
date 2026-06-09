# brainstorming skill — design

**Date:** 2026-06-09
**Status:** Design — approved, ready for implementation plan
**Repo:** ClawSkills (`/Users/samuelwei/GoogleDrive/LLM/ClawSkills`)

## Summary

A new ClawSkill, `brainstorming`, that turns a brainstorm-worthy voice/keyboard unit
into a **persistent "Copy to Claude" to-do card** in the iOS app. It does **no**
brainstorming itself. The actual interactive brainstorming happens later, on Claude
(claude.ai / Claude app), where the `content-brainstorming` skill and the `javis_mcp`
connector work natively — openclaw cannot run a clean interactive Q&A loop, so the skill
hands off instead of trying.

The skill mirrors `calendar-extractor` exactly in shape: a one-shot, dispatcher-auto-run
(and manually triggerable) two-step pipeline — script does I/O, agent does reasoning —
that writes to `skill_data` and dedups against local state. **No javis-server changes.**

## Why a handoff, not an in-app loop

The async-Q&A-over-chat alternative was explored and rejected. Findings:

- The dispatcher auto-run path runs in an **isolated** `skill-invoke-{task_id}` session,
  one-shot, and can only `POST /api/agent/push` (fire-and-forget, no reply correlation).
- A user's chat reply lands in the **main** session via `/api/agent/stream` — a different
  session. Bridging the two would require a disk state machine, and there is **no
  `AskUserQuestion` equivalent in openclaw** (only a one-way message push).
- Claude, by contrast, has both the interactive loop *and* `javis_mcp` to pull the
  source transcripts. So the brainstorming belongs on Claude; this skill's job is to get
  the user there with full context one tap away.

## Architecture & data flow

```
dispatcher auto-run (or manual trigger)
   │  prompt: "Run /brainstorming for <unit>. Deliverable: <hint>"
   ▼
node scripts/brainstorming.js fetch --session <id>        ← script: I/O
   │  → transcript JSON (GET /api/transcripts/recent, same shape as calendar-extractor)
   ▼
agent reads transcript → extracts {title, goal, request[], key_points[], source_refs[]}
   │  and COMPOSES the ready-to-paste Claude prompt          ← agent: reasoning
   ▼
echo '<card-json>' | node scripts/brainstorming.js push    ← script: I/O
   │  • dedup against local seen map (30-day TTL)
   │  • POST /api/skill/data  skill="brainstorming" type="todo" status="pending"
   ▼
iOS Calendar tab: bare to-do card rendered INLINE among event rows
   "🧠 Brainstorm — <title>"  [ Copy to Claude to continue ]  Dismiss
```

## Components

### Skill files (mirror calendar-extractor)

| File | Role |
|---|---|
| `brainstorming/SKILL.md` | triggers, `metadata.routes` (`route_id: brainstorm`), the two-step pipeline, prompt-composition template |
| `brainstorming/scripts/brainstorming.js` | `fetch` / `push` CLI (transcript fetch, skill_data write, dedup) |
| `brainstorming/scripts/lib.js` | shared helpers (tz, http, prompt assembly) |
| `brainstorming/scripts/data.js` | per-user local `seen` state, path-traversal guard |
| `brainstorming/references/todo-card-contract.md` | the iOS + route contract the app team satisfies |
| `brainstorming/test/*.test.js` | `node --test` |
| `brainstorming/package.json`, `brainstorming/README.md` | Node ≥18 builtins only |

### Two triggers (same as calendar-extractor)

1. **Dispatcher auto-run.** When a completed unit matches the enabled `brainstorm`
   route, the server claims run-once (`DispatchRouteExecuted`) and auto-runs the skill
   with a deliverable-hint prompt. No approve-to-run card — the human gate is the to-do
   card itself (and the user choosing to act on it).
2. **Manual.** On demand ("brainstorm this", "整理成簡報", "帮我腦力激盪"), windowed
   `fetch` (last 24h default) → compose → push.

### The ready-to-paste prompt (clipboard payload, never shown on the card)

The agent fills the bracketed fields from the transcript; the rest is literal:

```
I want to <GOAL — e.g. introduce Javis to the OpenClaw community, for non-engineer users>.

Source: my Javis voice note(s), session_id(s): <id…>. Before we start, pull the full
transcript via the javis_mcp connector (get_transcript_tool / search_transcripts_tool).

Please produce:
- <REQUEST item 1 — e.g. an attention hook>
- <REQUEST item 2 — e.g. a step-by-step demo/onboarding flow>
- <REQUEST item 3 — e.g. an explanation for the open-source community>
- <REQUEST item 4 — e.g. concise skill examples & use cases>

Run the content-brainstorming flow: ask me clarifying questions one at a time,
inventory the source material, then produce a structured brief before drafting.
```

This closes the loop: the openclaw `brainstorming` skill hands off to the Claude-side
`content-brainstorming` skill, with `javis_mcp` pulling the source.

### skill_data write (no server changes)

```json
{ "skill": "brainstorming", "type": "todo", "merge": "upsert",
  "items": [{
    "dedup_key": "<unit>+<goal-hash>",
    "status": "pending",
    "source_ref": "<session_id>",
    "payload": {
      "title": "Intro Javis to the OpenClaw community",
      "goal": "...",
      "request": ["...", "..."],
      "key_points": ["..."],
      "source_refs": ["<session_id>"],
      "prompt": "<the full ready-to-paste prompt above>"
    }
  }]}
```

`data_type` is a free-form string and `payload` is free-form JSON, so the write needs
no server change; the `(user, skill, data_type, dedup_key)` unique key isolates these
rows from `calendar-extractor`'s `type=event` rows.

### iOS contract (declared in `references/todo-card-contract.md`; built by the app team — not in this repo)

| Element | Behavior |
|---|---|
| Fetch | `GET /api/skill/data?skill=brainstorming&type=todo` (Clerk JWT); refresh on `skill_data_updated` SSE |
| Placement | **Inline** in the existing **Calendar** list, interleaved with event rows; a `todo` row has no date, so it sorts to today/top |
| Card face | bare — `🧠 Brainstorm` badge + `payload.title` + one button + `Dismiss`. No goal/request/key-points shown |
| **Copy to Claude to continue** | `UIPasteboard.general.string = payload.prompt` → toast (reuse `SelectableText.swift:74` logic) |
| Dismiss | `POST /api/skill/data/discard` (row deleted) |
| Mark done | `POST /api/skill/data/confirm` (status→confirmed; optionally hidden) |

iOS work required: the Calendar list view must dispatch on `type` and render a `todo`
row (today it is hardcoded to `type=event`). This is the only client change.

## Dedup & state

Local `seen` map keyed by `dedup_key` (unit + goal hash), 30-day TTL, stored at
`data/users/<userId>.json` (path-traversal guarded), exactly like calendar-extractor.
The container's gateway token can WRITE `/api/skill/data` but cannot READ it back
(`GET` needs a Clerk JWT), so novelty is decided locally; the server write is a
best-effort mirror. Prevents re-creating the same to-do across overlapping manual
windows or a re-run.

## Error handling

- Fetch fails / returns invalid JSON / zero sessions → emit nothing, push nothing; report
  only if the user explicitly asked for a diagnostic.
- Transcript has no discernible goal/request → no card (this is a detector; silence is a
  valid outcome).
- `409 in_flight` on the skill lock → server owns run-once; the skill does not self-gate.

## Testing

- Node ≥18 builtins only (`fetch`, `fs`, `path`); no `npm install` for runtime.
- `node --test`: dedup/`seen` TTL behavior, skill_data payload shape, prompt-template
  assembly (given a sample transcript → expected prompt string), path-traversal guard.
- Route contract documented for the javis-server team in `references/todo-card-contract.md`
  (RouteRegistry row `route_id=brainstorm`, classifier deliverable shape, prompt contract).

## Out of scope (YAGNI)

- No interactive Q&A in openclaw (explicitly dropped).
- No in-app drafting of the final deliverable (that happens on Claude).
- No deep-link launch into Claude (ready-to-paste prompt only).
- No new `skill_data` columns or card_type enum (free-form `data_type` suffices).

## Open questions

- Exact `route.matches` phrasing for the classifier (ideation / "help me organize" /
  presentation-planning intents) — tune against real misfires after first deploy.
- Whether `Mark done` should hide the row or keep it greyed as "done" — app-team UX call.

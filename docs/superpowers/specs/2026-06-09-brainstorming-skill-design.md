# General to-do card + brainstorming skill — design

**Date:** 2026-06-09
**Status:** Design — approved, ready for implementation plan
**Repos touched:** ClawSkills (skill), javis-server (one endpoint tweak), javisiosapp (one generic renderer)

## Summary

Two layers:

1. **A general "to-do" card surface** — a reusable pattern for *any* openclaw skill that
   can't finish its job in the container and needs to hand off to interactive Claude
   (+ `javis_mcp`). A skill detects work and writes a `type="todo"` `skill_data` row with a
   small fixed payload `{icon, title, subtitle?, prompt, source_refs}`. iOS renders it
   **generically** as a calendar-style card with **Confirm / Discard**. Confirm copies the
   card's `prompt` to the clipboard (to paste into Claude) and marks the row confirmed;
   Discard deletes it. A brand-new skill that writes a `type="todo"` row appears on the
   card surface with **zero new iOS code**.

2. **The `brainstorming` skill** (ClawSkills) — the **first consumer** of that surface. It
   turns a brainstorm-worthy voice/keyboard unit into a to-do card whose `prompt` hands off
   to Claude's `content-brainstorming` skill. It does no brainstorming itself.

What's **general** is the card (structure, renderer, Confirm/Discard, fetch). What's
**per-skill** is just three payload fields the skill fills: `icon`, `title`, and `prompt`.

## Why a handoff card, not an in-app loop

openclaw cannot run a clean interactive Q&A loop: the dispatcher auto-run path is a
one-shot isolated session that can only fire-and-forget a chat push, there is no
`AskUserQuestion` equivalent, and user replies land in a *different* (main) session.
Claude has both the interactive loop and `javis_mcp` to pull the source transcripts. So
the work belongs on Claude; the skill's job is to get the user there with full context in
one tap. This generalizes beyond brainstorming — draft-email, research, plan-trip all share
the "finish this on Claude" shape, which is exactly why the card is a shared surface.

---

## Layer 1 — General to-do card surface

### The shared contract (every to-do-emitting skill obeys)

Write to `POST /api/skill/data` with `type="todo"` and this payload:

```json
{ "skill": "<skill-name>", "type": "todo", "merge": "upsert",
  "items": [{
    "dedup_key": "<stable-key>",
    "status": "pending",
    "source_ref": "<session_id>",
    "payload": {
      "icon": "🧠",                                  // shown on the card (emoji or SF symbol name)
      "title": "Intro Javis to the OpenClaw community",
      "subtitle": "Brainstorm · 2 sessions",          // optional one-liner
      "prompt": "<ready-to-paste Claude prompt>",      // REQUIRED — copied on Confirm
      "source_refs": ["<session_id>"]
    }
  }]}
```

`data_type` is a free-form string and `payload` is free-form JSON today, so no schema
migration is needed — the contract is a convention. The `(user, skill, type, dedup_key)`
unique key keeps each skill's rows isolated. `prompt` is the only behavioral field; every
to-do card is a "Claude handoff" whose Confirm copies that prompt.

### Server change (one small tweak)

Relax `GET /api/skill/data` so `skill` is **optional when `type=todo`**: with `skill`
omitted it returns **all** of the user's `type=todo` rows across every skill, each row
carrying its own `skill` field. Confirm/discard endpoints are unchanged — they already
target a row by `(skill, type, dedup_key)`, and iOS gets `skill` back per row from the GET.

This is the single change that makes the surface general (a new skill needs no
server/iOS edit). The `skill_data_updated` SSE already carries `{skill, type}`; iOS
refreshes its to-do list whenever `type=="todo"`.

### iOS renderer (one generic view)

| Element | Behavior |
|---|---|
| Fetch | `GET /api/skill/data?type=todo` (skill omitted, Clerk JWT); refresh on any `skill_data_updated` SSE with `type=="todo"` |
| Placement | **Inline** in the existing **Calendar** list, interleaved with event rows; `todo` rows have no date, so they sort to today/top |
| Card face | **calendar-style** (dashed pending, purple accent to distinguish from orange events): `payload.icon` + skill badge + `payload.title` + `payload.subtitle` meta line + a **Confirm / Discard** row. Driven entirely by payload — no per-skill code |
| **Confirm** | (1) `UIPasteboard.general.string = payload.prompt` → toast "copied — paste into Claude" (reuse `SelectableText.swift:74`); (2) `POST /api/skill/data/confirm` with the row's `skill`/`type`/`dedup_key` (status→confirmed). The prompt rides on Confirm — no separate copy button |
| **Discard** | `POST /api/skill/data/discard` (row deleted) |

iOS work: the Calendar list view dispatches on `type`, rendering a generic `todo` row
(today it is hardcoded to `type=event`) that reuses the existing Confirm/Discard button row,
with the Confirm handler additionally writing `payload.prompt` to the pasteboard. Built once.

### Extension point (not built now — YAGNI)

If a future to-do ever needs a non-handoff action (e.g. an in-app "Send"), add an optional
`payload.action` discriminator; absence means the default "copy prompt" behavior. Not
implemented until a real second action exists.

---

## Layer 2 — The `brainstorming` skill (first consumer)

Mirrors `calendar-extractor` in shape: a one-shot, dispatcher-auto-run (and manually
triggerable) two-step pipeline — script does I/O, agent does reasoning.

### Data flow

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
echo '<todo-json>' | node scripts/brainstorming.js push    ← script: I/O
   │  • dedup against local seen map (30-day TTL)
   │  • POST /api/skill/data  skill="brainstorming" type="todo" status="pending"
   │       payload = { icon:"🧠", title, subtitle, prompt, source_refs }
   ▼
iOS Calendar tab: generic to-do card, INLINE among events
   "🧠 Brainstorm — <title>"   [ Confirm ] [ Discard ]
   (Confirm copies payload.prompt to clipboard + marks confirmed)
```

### Two triggers (same as calendar-extractor)

1. **Dispatcher auto-run.** A completed unit matches the enabled `brainstorm` route →
   server claims run-once (`DispatchRouteExecuted`) and auto-runs with a deliverable-hint
   prompt. No approve-to-run card; the human gate is the to-do card (Confirm/Discard).
2. **Manual.** "brainstorm this" / "整理成簡報" / "帮我腦力激盪" → windowed `fetch`
   (24h default) → compose → push.

### The ready-to-paste prompt (the per-skill `payload.prompt`)

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

### Skill files (mirror calendar-extractor)

| File | Role |
|---|---|
| `brainstorming/SKILL.md` | triggers, `metadata.routes` (`route_id: brainstorm`), the two-step pipeline, prompt-composition template |
| `brainstorming/scripts/brainstorming.js` | `fetch` / `push` CLI (transcript fetch, to-do write, dedup) |
| `brainstorming/scripts/todo-card.js` | **shared helper**: build + POST a `type="todo"` payload — the reusable write side of Layer 1, importable by future skills |
| `brainstorming/scripts/lib.js` | shared helpers (tz, http, prompt assembly) |
| `brainstorming/scripts/data.js` | per-user local `seen` state, path-traversal guard |
| `brainstorming/references/todo-card-contract.md` | **the general** to-do card contract (payload schema, server fetch behavior, iOS Confirm/Discard) — shared, future skills link here; plus the `brainstorm` route contract |
| `brainstorming/test/*.test.js` | `node --test` |
| `brainstorming/package.json`, `brainstorming/README.md` | Node ≥18 builtins only |

### Dedup & state

Local `seen` map keyed by `dedup_key` (unit + goal hash), 30-day TTL, at
`data/users/<userId>.json` (path-traversal guarded), exactly like calendar-extractor. The
container's gateway token can WRITE `/api/skill/data` but cannot READ it back (`GET` needs a
Clerk JWT), so novelty is decided locally; the server write is a best-effort mirror.

## Error handling

- Fetch fails / invalid JSON / zero sessions → emit nothing, push nothing; report only on
  explicit diagnostic request.
- No discernible goal/request in the transcript → no card (silence is a valid detector
  outcome).
- `409 in_flight` on the skill lock → server owns run-once; the skill never self-gates.

## Testing

- Node ≥18 builtins only (`fetch`, `fs`, `path`); no `npm install` for runtime.
- `node --test`: dedup/`seen` TTL, `todo-card.js` payload shape (icon/title/prompt
  required), prompt-template assembly (sample transcript → expected prompt), path-traversal
  guard.
- javis-server: a test that `GET /api/skill/data?type=todo` (skill omitted) returns rows
  across multiple skills, scoped to the user; confirm/discard still target one row.

## Suggested implementation order (for the plan)

1. **Layer 1 server:** relax `GET /api/skill/data` (`skill` optional when `type=todo`) + test.
2. **Layer 1 iOS:** generic `todo` renderer in the Calendar list (Confirm copies prompt).
3. **Layer 2 skill:** `brainstorming` scaffold, `todo-card.js`, `brainstorming.js`,
   `data.js`, tests, `SKILL.md`, `references/todo-card-contract.md`.
4. Route seeding (`route_id=brainstorm`) + backfill, following calendar-extractor's pattern.

## Out of scope (YAGNI)

- No interactive Q&A in openclaw (explicitly dropped).
- No in-app drafting of the final deliverable (that happens on Claude).
- No deep-link launch into Claude (Confirm copies a ready-to-paste prompt only).
- No `payload.action` discriminator until a real non-handoff to-do exists.
- No new `skill_data` columns or `card_type` enum (free-form `data_type` + `payload` suffice).

## Open questions

- Exact `route.matches` phrasing for the classifier (ideation / "help me organize" /
  presentation-planning) — tune against real misfires after first deploy.
- Whether `Confirm` should hide the row or keep it greyed as "done" — app-team UX call.
- Naming of the skill badge/label source: derive from `skill` field, or carry an explicit
  `payload.label`? (Leaning: explicit `payload.subtitle` for the line, badge from `skill`.)

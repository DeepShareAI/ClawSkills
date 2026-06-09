# feat(brainstorming): Layer 2 skill — voice unit → type="todo" Claude-handoff card

**Branch:** `feat/brainstorming-skill`
**Commit:** `bca0637fe309ecc73401f2389c47fac7616801ee`

## Summary

Implements Layer 2 (the ClawSkills consumer) of the general to-do card / brainstorming design (`docs/superpowers/specs/2026-06-09-brainstorming-skill-design.md`), mirroring `calendar-extractor`'s folder structure exactly. The `brainstorming` skill is a one-shot fetch → compose → push pipeline: it turns a brainstorm-worthy voice/keyboard unit into a `type="todo"` card whose ready-to-paste `prompt` hands off to Claude's `content-brainstorming` skill (pulling the source transcript via the `javis_mcp` connector). It does **no** brainstorming itself.

`scripts/todo-card.js` is the shared, dependency-free **Layer-1 write helper** importable by future skills — the reusable write side of the general to-do card surface.

## Changes

- `brainstorming/SKILL.md` — triggers, `metadata.routes` (`route_id: brainstorm`), the two-step pipeline, prompt-composition template.
- `brainstorming/README.md`, `brainstorming/package.json` — Node ≥18, builtins only.
- `brainstorming/scripts/brainstorming.js` — `fetch` (via `/api/transcripts/recent` with `--session` / `--kbd-input` / `--hours`) and `push` (stdin card → dedup → write → optional `/api/agent/push` nudge) CLI.
- `brainstorming/scripts/todo-card.js` — shared helper `buildTodoPayload` + POST a `type="todo"` payload; enforces `{icon, title, subtitle?, prompt(REQUIRED), source_refs[]}`.
- `brainstorming/scripts/lib.js` — tz / anchor / dedup-key / prompt-template helpers.
- `brainstorming/scripts/data.js` — per-user `seen` map, 30-day TTL, path-traversal guard.
- `brainstorming/scripts/register.js` — route registration helper.
- `brainstorming/references/todo-card-contract.md` — the general to-do card contract (payload schema, **server GET behavior**, iOS Confirm/Discard) plus the `brainstorm` route contract; future skills link here.
- `brainstorming/test/{cli,lib,todo-card,data}.test.js` — `node --test`.
- `.gitignore` — added `brainstorming/data/` (per-user runtime state).

## Testing

```
node --test
```

Passed: **35/35** with Node builtins only (no deps, no `npm install`). Coverage: seen-map TTL/dedup; to-do payload validation (icon/title/prompt required); prompt-template assembly (sample transcript → expected prompt substrings, incl. the `javis_mcp` connector + content-brainstorming flow + per-request bullets); path-traversal guard; fetch/push behavior.

## Risk / blast radius

Low. This is a net-new skill folder plus one `.gitignore` line — no existing skill, script, or shared module is modified, so nothing in the workspace can regress from it. The skill writes `type="todo"` rows via the documented contract and never touches server or iOS code. Committed locally on `feat/brainstorming-skill` — **not pushed; no PR opened.**

## Notes for reviewer

Cross-layer invariants — this skill owns the **write** side; the **GET** side is the server's job (Layer 1) and is documented in `references/todo-card-contract.md` as the contract the javis-server team must satisfy (no server code touched here):

- **null `start_at` handling (write side):** `type="todo"` items carry **no date** — `buildTodoPayload` emits no `start_at`/`end_at` (asserted in tests). The contract doc records that the server GET must return these rows with `null` dates so iOS sorts them to today/top.
- **per-item skill:** rows are written with `skill="brainstorming"`, `type="todo"`, `merge="upsert"`, `status="pending"`, `dedup_key = title|hash(goal)`. Each row carries its own skill so the aggregate GET can span skills.
- **skill-optional aggregate fetch (documented, not implemented here):** the contract doc states `skill` is optional on GET when `type=todo`; that relaxation lives in javis-server, not this repo.
- **backward-compat for `type=event`:** this skill emits only `type="todo"`; it does not interact with the event path. The contract doc notes `skill` remains required for `type=event`.
- **Confirm copies prompt:** the per-skill `payload.prompt` is the composed, ready-to-paste Claude prompt — the only behavioral payload field. iOS's Confirm copies it to the clipboard and marks the row confirmed; the skill's job is to compose that prompt with full context.

Known notes (not blockers):
1. **GitNexus index is stale** (last indexed `c78d07e`) per a PostToolUse hook; re-indexing was out of scope and not run. Run `npx gitnexus analyze` to refresh.
2. An unrelated untracked file `docs/superpowers/specs/2026-06-08-calendar-extractor-dispatcher-adaptation-design.md` (from a prior task) was deliberately left untouched/unstaged.
3. The container's gateway token can WRITE `/api/skill/data` but cannot READ it back (GET needs a Clerk JWT), so novelty is decided locally against the `seen` map; the server write is a best-effort mirror.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

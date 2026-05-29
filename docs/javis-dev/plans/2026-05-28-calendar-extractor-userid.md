# calendar-extractor userId default — Implementation Plan

**Goal:** Make `/calendar-extractor` run zero-config on iOS by defaulting the
userId to the constant `self` when none is passed.
**Architecture:** A shared `resolveUserId()` helper (arg → `OPENCLAW_USER_ID` env →
`self` constant) replaces the mandatory positional `<userId>` across all four
scripts. The userId is only a local dedup-state filename; server calls authenticate
via `OPENCLAW_GATEWAY_TOKEN`, so a per-container constant is correctly isolated.
**Tech Stack:** Node 18+ built-ins only (no deps).

---

### Task 1: data.js — resolver  ✅

**Files:** Modify `calendar-extractor/scripts/data.js`

- [x] Add `DEFAULT_USER_ID = 'self'` constant.
- [x] Add `resolveUserId(rawArg)` (arg → `OPENCLAW_USER_ID` → `DEFAULT_USER_ID`, then `sanitizeId`).
- [x] Export `resolveUserId`, `DEFAULT_USER_ID`.

### Task 2: calendar-extractor.js — subcommand-aware parsing  ✅

**Files:** Modify `calendar-extractor/scripts/calendar-extractor.js`

- [x] Import `resolveUserId`.
- [x] Detect `SUBCOMMANDS = ['fetch','push']`: if `argv[2]` is a subcommand, userId
  is omitted (resolve default, shift args); else explicit userId (back-compat).

### Task 3: register.js + push-toggle.js — default the ID  ✅

**Files:** Modify `calendar-extractor/scripts/register.js`, `calendar-extractor/scripts/push-toggle.js`

- [x] Swap `sanitizeId(process.argv[N])` → `resolveUserId(process.argv[N])` in both.

### Task 4: SKILL.md — document optional userId  ✅

**Files:** Modify `calendar-extractor/SKILL.md`

- [x] Note `<userId>` optional → defaults to `self`; update Core-commands examples
  to the no-userId form; keep explicit-ID form as back-compat reference.

### Task 5: Local verification  ✅

- [x] 6 checks run (bare fetch, push `[]`, explicit alice, register, status, env
  override) — all pass. Test artifacts cleaned.

---

### Task 6: Deploy — HELD

Skill is mounted in the container at
`/home/node/.openclaw/workspace/skills/calendar-extractor/`; local edits do not
reach iOS until re-published. Per user decision, deployment is deferred — code +
docs committed only. Resume by confirming the exact clawhub publish / skill-sync
command before touching the remote.

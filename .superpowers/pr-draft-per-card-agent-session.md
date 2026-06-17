# PR draft — do not push without Samuel's go-ahead

**Branch:** `feat/per-card-agent-session` → `main`

## Title

feat(brainstorming): forward card `dedup_key` on `/api/agent/push` for per-card Agent Chat sessions

## Body

### Summary

When `javis-brainstorming` delivers a card's chat digest, it now forwards the
card's stable `dedup_key` on the `POST /api/agent/push` body. This lets
javis-server derive a **deterministic per-card Agent Chat session** from
`(user, skill, dedup_key)`, so each card's digest lands in — and re-tapping the
card reopens — its **own** session, instead of every card funneling into one
rolling per-skill thread. A later update to the same card (same `dedup_key`)
appends to that card's existing session.

The session-id derivation is **server-owned** (single source of truth). The
skill computes no session id and stamps no payload — it only forwards the
`dedup_key` it already computed for the `type=todo` card row.

### Behavior changes

- `pushDigest` body goes from `{ skill, content }` to
  `{ skill, content, dedup_key }`, where `dedup_key` is the card's stable key
  (`card.dedupKey`), the SAME value written to the `type="todo"` row.
- No new commands, no card-contract shape change, no state-format change, no
  versioning bump required: this is an additive field on an existing push.
- Backward compatible by contract: omitting `dedup_key` falls back to the
  legacy per-skill rolling session, so an older server that ignores the field
  keeps working (every card's digest funnels into one thread, as before).

### Implementation notes (files)

- `brainstorming/scripts/brainstorming.js` — `pushDigest(token, card)` now sends
  `dedup_key: card.dedupKey` alongside `skill`/`content`. The endpoint header
  comment documents the new field and the server-owned per-card-session
  derivation.
- `brainstorming/references/todo-card-contract.md` — new §1f
  ("Per-card Agent Chat session — pass `dedup_key` on `/api/agent/push`")
  documenting the convention: the skill forwards the same stable key it wrote to
  the todo row; javis-server derives the deterministic `(user, skill, dedup_key)`
  session; omitting the key falls back to the legacy per-skill rolling session.
- `brainstorming/test/cli.test.js` — updated and added tests (see below).

### Test plan + results

`cd brainstorming && node --test` — **59 pass / 0 fail.**

Covering this change specifically:

- Updated `pushDigest POSTs {skill, content, dedup_key} to /api/agent/push`:
  asserts the body keys are exactly `content`, `dedup_key`, `skill`, and that
  `body.dedup_key === card.dedupKey`, exercised through the production
  `pushDigest` via a stubbed global `fetch` (not the injected DI seam), so a
  regression that drops the key fails here.
- New `pushDigest forwards an explicit card dedup_key verbatim (per-card session
  key)`: with a card whose `dedup_key` is a fixed string, asserts the push body
  forwards that exact value.
- Existing digest/dedup/state/contract tests unchanged and still green.

Verification status from the workflow: impl=passed, repair=passed.

### Cross-repo dependency note (from the spec / contract §1f)

This skill change is inert until **javis-server** implements its side of the
contract on `POST /api/agent/push`:

- Accept an optional `dedup_key` on the push body.
- When `dedup_key` is present, derive a **deterministic per-card Agent Chat
  session** from `(user, skill, dedup_key)` so the digest lands in that card's
  own session and a later same-`dedup_key` update appends to it.
- When `dedup_key` is absent, keep the legacy per-skill rolling-session
  behavior (single source of truth: the derivation lives server-side; clients
  forward only the key).

The design reference cited by the contract is
`docs/superpowers/specs/2026-06-17-per-card-agent-session-design.md`; the
server-side derivation is the irreducible dependency tracked there. No iOS
change is required — tapping a card already reopens its session by the
server-derived id.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

# calendar-extractor: push one card per event (per-Agent-Chat routing)

## Summary

`calendar-extractor` previously sent **one aggregate** `formatDigest` markdown push
with **no** `dedup_key`, collapsing every extracted event into a single iOS chat
thread. This PR makes the push step send **one markdown card per fresh event, each
carrying that event's `dedup_key`**, so each calendar card lands in its **own iOS
Agent Chat thread**.

This is an in-place patch. `calendar-extractor` predates the vendored
`javis-contract.js` spine and stays hand-rolled — it is **not** migrated onto the
contract spine.

## Server change this tracks

javis-server (contract **v1.1.0**) now derives a dedicated Agent Chat session per
skill_data card: a `POST /api/agent/push` carrying a `dedup_key` (and **no**
explicit `session_id`) is routed into `derive_card_session_id(user_id, skill,
dedup_key)` — the card's own session — beating history-reuse. On iOS each calendar
card deep-links to that session. By emitting one push per event keyed by the same
`dedup_key` it writes to the event's `skill_data` row, the skill now lights up the
per-card routing the server already supports.

## Changes (by file)

### `calendar-extractor/scripts/calendar-extractor.js`
- **Add `formatCardPush(ev, tz)`** — per-event markdown: the section heading plus
  that one event's time / location / attendees / notes, reusing the per-event
  formatting from `formatDigest`'s loop.
- **`pushToiOS(token, content, dedupKey)`** — adds the optional `dedupKey`; includes
  `dedup_key` in the POST body **only when provided** (omitted otherwise, so a
  no-key call is byte-identical to today's aggregate body).
- **`defaultPushClient.push`** signature → `(token, content, dedupKey)`.
- **`doPush`** — replaces the single aggregate push
  (`const content = formatDigest(freshEvents, tz); await client.push(token, content);`)
  with a loop over the existing `fresh` array
  (`for (const f of fresh) { await client.push(token, formatCardPush(f.ev, tz), f.key); }`),
  where `f.key === dedupKey(f.ev)` — the same string written to skill_data.
- **Exports** — adds `formatCardPush`; keeps `formatDigest` exported.

### `calendar-extractor/test/cli.test.js`
- The recording push mock gains a `dedupKey` arg and records `{ content, dedupKey }`.
- Replaces the old single-combined-digest assertion with per-card expectations:
  push is called **once per fresh event** (N events → N calls), each carrying the
  `dedup_key` matching that event's row, and each card contains only its own event.

### `calendar-extractor/package.json`
- Version bump `0.4.2 → 0.5.0` (behavior change).

### `calendar-extractor/SKILL.md` + `calendar-extractor/README.md`
- Push wording updated to per-card: each event is delivered as its own markdown
  card carrying its `dedup_key` and opens in its own iOS Agent Chat thread,
  replacing the single combined digest.

## Backward compatibility

- **Additive `dedup_key`.** `pushToiOS` only adds `dedup_key` to the POST body when
  a key is provided; a no-key call remains byte-identical to the legacy aggregate
  push, so nothing else on the push path changes shape.
- **skill_data mirror unchanged.** `mirrorToSkillData` / the per-event `skill_data`
  rows (each already with its own `dedup_key` and `status: "pending"`) are untouched.
- **Dedup logic unchanged.** The `seen`-map event-level dedup and the state save are
  unchanged — an already-delivered event is still neither re-mirrored nor re-pushed.
- Version `0.4.2 → 0.5.0`.

## Testing

- `cd calendar-extractor && npm test` (`node --test`): **31 tests pass, 0 fail.**
- Per-card `dedup_key` assertions are green:
  - `doPush writes table, pushes one per-card message per event, and records each event in seen` —
    asserts `client.calls.push[0].dedupKey === dedupKey(events[0])`.
  - `doPush sends N per-card pushes for N fresh events, each with its own dedup_key` —
    asserts `push.length === events.length`, each call's `dedupKey === dedupKey(events[i])`,
    and that no card contains another event's title.
  - `doPush only delivers the NEW events when mixing seen and fresh` — the second
    run pushes only the fresh event, carrying its `dedup_key`.
- **Cross-repo HTTP mock-server run: skipped.** The optional end-to-end check
  (`node scripts/calendar-extractor.js push` against JavisSkills
  `references/mock-server/mock-javis-server.js`) was **not** run — it lives in a
  separate repo and requires a repointed `JAVIS_SERVER_URL` and live process. The
  in-process recording mock in `cli.test.js` already asserts the per-card body shape
  (N pushes, each with its `dedup_key`) plus the single `skill_data` mirror, which
  covers the same contract.

## Out of scope

- `mirrorToSkillData` / the `skill_data` rows (already per-event with their own
  `dedup_key` and `status: "pending"`).
- The `fetch` path, `dedupKey` derivation, and naive-local handling.
- Migration onto `javis-contract.js` (explicitly not done).

🤖 Generated with [Claude Code](https://claude.com/claude-code)

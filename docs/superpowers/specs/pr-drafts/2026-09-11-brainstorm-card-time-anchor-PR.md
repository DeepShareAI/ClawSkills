feat(brainstorming): anchor every card from the session window `fetch` remembered

## What was broken

A brainstorm card's `start_at`/`end_at` is the window of the session that produced the idea, so the card lands on the day it was captured. `push` computed that window by calling `sessionWindow(sessions, card.source_refs, tz)` over the `sessions` array read off stdin — an array the agent had to re-pipe verbatim from the `fetch` envelope one step earlier. `SKILL.md` explicitly permitted the shorter path ("a bare card object still works — the card then just carries no dates"), and when the agent took it `sessionWindow` received `[]`, `buildTodoItem` correctly omitted both dates, and the card was born dateless. A dateless card pins to today forever, and nothing can recover the window afterwards: there is no by-id session endpoint, and `push` short-circuits on the `seen` map so no second write ever repairs the row.

## What changed

**§B — `fetch` remembers the windows it already has.** `doFetch` gained the `load`/`save` deps `doPush` already carried and now calls a new `rememberSessionWindows(sessions, nowIso, {load, save})` in `scripts/brainstorming.js`. It writes `state.sessionWindows = { "<session_id>": { started_at, ended_at?, seen_at } }` into `data/users/<userId>.json`, storing raw ISO instants rather than naive-local strings so a window survives a change in the user's tz; `instantIso` normalizes the live wire's epoch seconds on the way in. A session with no usable `started_at` is not recorded, and one with no `ended_at` records its start alone. It remembers every session the server returned, including the ones `--session`/`--kbd-input` filter out of the envelope: the flags narrow what the agent is shown, not what the skill knows, so a card citing a sibling session from the same fetch still gets its day. Pruning reuses the existing `pruneByTtl(map, tsOf, ttlDays)` keyed on `seen_at` at the same `SEEN_TTL_DAYS` as `seen`, followed by a new `capRecent(map, tsOf, max)` in `scripts/lib.js` that keeps the `SESSION_WINDOWS_MAX` (500) most recent entries. Remembering is wrapped in try/catch and warns to stderr: an unwritable state file must never cost the agent the envelope it is waiting on.

**§C — `push` resolves the window from the union of both sources.** A new `unionSessions(windows, sessions)` in `scripts/lib.js` builds the remembered map into session-shaped objects, then layers any piped `sessions` on top, overriding by `session_id`. Overriding is per-field, so a trimmed `{session_id, transcript}` echo cannot erase a remembered instant. `doPush` now calls `sessionWindow(unionSessions(state.sessionWindows || {}, sessions), card.source_refs, tz)`. `sessionWindow`'s signature and selection rule are untouched — it still picks the earliest `started_at` among the card's `source_refs` and that same session's `ended_at`, serialized naive-local in the resolved tz.

**§D — when both sources miss, nothing is invented.** The card is written with no dates and `push` still reports success. No time-based last resort was added: stamping "now" would put a guessed date on a journal card and make every rewrite move it.

**§E — `SKILL.md`.** The instruction to pipe `sessions` became advisory instead of load-bearing. The bare-card affordance stays and now says "still works, and still gets its dates"; the note explaining why `sessions` mattered was replaced by one recording where the window comes from, so a future reader does not restore the dependency. The state-file section documents `sessionWindows`, its TTL and its cap.

**Rollout.** `package.json` bumps to `0.6.0`.

## What did NOT change

No `javis-server` change and no `javisiosapp` change. `POST /api/skill/data` already parses, derives `is_utc` from, and stores an item-level window, and `CalendarViewModel.foldConfirmedTodos` already files a confirmed dated card under its own day. A card that now arrives dated simply takes a branch that was always there.

`scripts/todo-card.js` is untouched. The ownership table in §A puts it in the Transport layer — it owns the naive-local format rule, never inventing a date, and emitting `end_at` only beside a `start_at`, and those rules are shared with every other to-do-emitting skill. All of this change lives in the Judgment layer, which owns *which* session window represents a card and where that window is remembered. No per-skill policy hook was added to the todo rail; §A argues that layer should exist only when a skill arrives with a real placement policy, and brainstorming has none.

## The guarantee

Every card composed from a session the skill fetched gets that session's day. Not every card unconditionally.

A card still lands dateless when its `source_refs` cite a session that `fetch` never returned in this container within the 30-day TTL and that the agent did not pipe — a session the agent composed from but was not given, a container rebuilt or reaped since the fetch, or a `source_ref` outside the 500-entry cap. A session with no usable `started_at` on the wire also yields no dates. Pending cards continue to ride today's block regardless of their window; `pendingTodos` pins them there deliberately, and a brainstorm card's day becomes visible when it is confirmed.

## Testing

`cd brainstorming && npm test` (`node --test`). I ran it: 79 tests, 79 pass, 0 fail.

The new coverage is `unionSessions` and `capRecent` in `test/lib.test.js`, the push and fetch behavior in `test/cli.test.js`, and a legacy state file round-tripping through the real `readJson`/`writeJson` in `test/data.test.js`.

The one that matters is `doPush with a BARE card object stamps the window from the remembered sessionWindows map`. It pipes only the card, with no `sessions`, and asserts `start_at`/`end_at` on the POST body. That is exactly the call the old code answered with a dateless row, and it is the test that would have caught the bug.

One hunk in `test/cli.test.js` is unrelated to this change and worth calling out. `doPush dedups: an already-seen card is not re-written and sends no digest` was already failing on `main` — a date bomb, not a regression. `seen` is TTL-pruned against the real clock, but the test pinned `now` to the frozen `NOW` fixture, which has since aged past `SEEN_TTL_DAYS`; `pruneSeen` evicted the entry between the two pushes and the test silently stopped asserting dedup. That one test now takes a real-clock `now`, with a comment recording why. No production code changed for it. Happy to split it into its own PR if you would rather keep this one single-purpose.

## Review

Four adversarial lenses ran over the change. One finding was confirmed and fixed; five were refuted and left alone.

The confirmed finding: `doPush` loaded a whole-state snapshot at the top of the run and saved that same object after two awaited network round-trips (`client.write`, `client.digest`). The snapshot now carries `sessionWindows`, a key `push` does not own, so a `fetch` completing inside that window would have its remembered map reverted — and the next bare-card push citing that session would find neither source and write the card undated, the exact failure this change exists to remove. Fixed with `commitPushState({load, save, seen, nowIso})`, which re-reads the state immediately before writing and merges only `seen` and `lastRunAt` into the fresh copy. All three commit sites use it: the no-card early return, the already-seen early return, and the success path. Two tests cover it, including one that interleaves a concurrent writer into both round-trips.

## Rollout

Bundle `0.6.0`, published to ClawHub. It reaches every per-user container through the existing 12-hour skill-update sweep on javis-server. No cron re-registration and no `min_bundle_version` bump — the trigger message and the dispatcher contract are unchanged. No feature flag: a card that would have been dateless gains a date, and a card that already had one computes the same date from the same instants.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01MsvwaJPC9nz43hmULSZS7B

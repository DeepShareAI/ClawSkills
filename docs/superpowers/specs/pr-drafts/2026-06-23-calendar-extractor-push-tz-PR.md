# fix(calendar-extractor): push path stamps the user's wall-clock, not the UTC instant (TZ bug)

## Summary

The extraction **push** path mirrored event start times in **UTC** instead of
the user's zone, landing freshly-extracted cards on the wrong day/time. `doPush`
resolved its timezone via `resolveTz(null)`, which in the prod openclaw
container (empty `TZ` env) collapses to **UTC** — so a "June 22, 7pm PDT" event
was stored as the raw `Z` instant `2026-06-23 02:00:00` rather than the user's
naive-local wall-clock `2026-06-22 19:00:00`. The edit path had already been
fixed to use `resolveUserTz`; this PR brings the push path in line. Bumps the
skill `0.5.3 → 0.5.4`.

## Root cause

`doPush` (in `calendar-extractor/scripts/calendar-extractor.js`) resolved the
zone used to mirror `skill_data` start/end times with:

```js
const tz = deps.tz || resolveTz(null);
```

`resolveTz(null)` has no payload zone to lean on, so it falls through to `TZ`
env → system zone. In the **prod openclaw container the `TZ` env is empty**, so
this returns **UTC**. The naive-local times in `skill_data` were therefore
stamped as the UTC *instant* rather than the user's wall-clock — every pushed
card could land a day (and several hours) off.

The **edit path** (`update` via stdin `tz`, `anchor` via `--tz`) already does
this correctly: it calls `resolveUserTz`, which prefers the explicit
`[CURRENT CARD]` zone, then the **server's authoritative zone** (the
`/api/transcripts/recent` envelope, fetched with the gateway token), then `TZ`
env, then system. The push path simply never adopted that ladder — it predated
the server-zone step.

This was verified three ways:

- **GitNexus call graph** — traced `doPush` and confirmed it called
  `resolveTz(null)` directly, never reaching the server-zone lookup that
  `resolveUserTz` performs (the edit path's resolver).
- **Live grep** — the literal `resolveTz(null)` appeared on the push branch
  only; every edit branch already routed through `resolveUserTz`.
- **End-to-end DB row** — a real extraction produced a `skill_data` row of
  `2026-06-23 02:00:00` (the UTC instant) instead of the expected user
  wall-clock, confirming the UTC stamp in production.

## The fix

Replace the UTC-prone resolver in `doPush` with the same `resolveUserTz` ladder
the edit path uses, and **resolve the token first** so the resolver can fetch the
server's authoritative zone with it:

```js
const token = deps.token || requireToken();
// ...token MUST be resolved before this line — resolveUserTz fetches the
// server zone with it.
const tz = deps.tz || await resolveUserTz({ token, deps });
```

Ordering is load-bearing: `resolveUserTz` calls `/api/transcripts/recent` with
the gateway token to read the server's zone, so the `token` line must precede
the `tz` line. The docblock for the `TZ` env var was updated to note that
**push** now follows the same precedence as the edit turns, and to spell out why
the server step matters (empty container `TZ` → UTC → cards a day off).

## Regression test

Added to `calendar-extractor/test/cli.test.js`:

> `doPush mirrors start_at in the SERVER zone when no deps.tz (no UTC instant stamped)`

It mirrors the existing `doUpdate` server-tz regression in `update.test.js`. The
test:

- passes **no** `deps.tz`, injects an authoritative **server zone of
  `Asia/Tokyo`** via `deps.fetchTz` (keeping `resolveUserTz` offline), and pins
  `process.env.TZ = ''` to deterministically exercise the prod container's
  empty-`TZ` path;
- feeds a `Z` instant `2026-06-23T02:00:00.000Z` and asserts the mirrored
  `start_at` collapses to the **Tokyo wall-clock `2026-06-23T11:00:00`** — not
  UTC (`2026-06-23T02:00:00`, a day off) and not the runner's system-LA zone
  (`2026-06-22T19:00:00`);
- asserts `recorded.tz === 'Asia/Tokyo'` and that `start_at` carries **no
  `Z`/offset** (naive-local).

Choosing `Asia/Tokyo` plus an empty `TZ` removes the false-green a bare
system-equal server zone would have allowed: under the old `resolveTz(null)`
code the value would be UTC here, never the Tokyo wall-clock, so the test fails
on the buggy code on any runner.

## Test result

`node --test test/cli.test.js` — **12 tests, 12 pass, 0 fail** (including the new
regression test).

Full suite `node --test test/*.test.js` — **54 tests, 54 pass, 0 fail**.

## Version bump

`calendar-extractor/package.json`: `0.5.3 → 0.5.4`.

## Deploy note

The fix only takes effect once the **openclaw container ships the updated skill**.
The skill runs inside each user's per-user openclaw container, so the corrected
`calendar-extractor` bundle must be republished and the container updated — the
javis-server deploy alone does not pick it up. Until the container carries
`0.5.4`, extractions continue to stamp the UTC instant.

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)

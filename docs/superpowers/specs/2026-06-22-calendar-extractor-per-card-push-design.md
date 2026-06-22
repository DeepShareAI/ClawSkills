# calendar-extractor: per-card → per-Agent-Chat push

Date: 2026-06-22
Status: Approved (brainstorming)

## Problem

javis-server now derives a dedicated Agent Chat session per skill_data card: a
`POST /api/agent/push` carrying a `dedup_key` (and no explicit `session_id`) is
routed into `derive_card_session_id(user_id, skill, dedup_key)` — the card's own
session — beating history-reuse. On iOS each calendar card deep-links to that
session.

`calendar-extractor` predates the vendored `javis-contract.js` spine: it builds
the server calls directly (`scripts/calendar-extractor.js` + `scripts/lib.js`).
Its push step sends **one aggregate** `formatDigest` markdown push with **no**
`dedup_key`, so all extracted events collapse into a single chat thread. We want
**each calendar card to land in its own Agent Chat**.

## Decision

Apply the per-card push pattern (the one `javis-skill-creator`'s periodic-push
template now generates) **in place**, keeping calendar-extractor's hand-rolled
structure. After the skill_data mirror, send **one push per fresh event, each
carrying that event's `dedup_key`** — replacing the single aggregate digest.

Rejected: full migration onto `javis-contract.js` v1.1.0 (larger blast radius;
rewrites working code and its tests for no behavior gain here).

## Scope of changes

All under `calendar-extractor/`.

### 1. `scripts/calendar-extractor.js`

- **Add `formatCardPush(ev, tz)`** — per-event markdown: the section heading plus
  that one event's details (time / location / attendees / notes), reusing the
  per-event formatting currently inside `formatDigest`'s loop.
- **`pushToiOS(token, content, dedupKey)`** — add the optional `dedupKey`; include
  `dedup_key` in the POST body **only when provided** (omit otherwise, so the
  no-key call is byte-identical to today).
- **`defaultPushClient.push`** signature → `(token, content, dedupKey)`.
- **`doPush`** — replace the single aggregate push:
  ```
  const content = formatDigest(freshEvents, tz);
  await client.push(token, content);
  ```
  with a per-event loop over the existing `fresh` array (each item is
  `{ ev, key }`, where `key === dedupKey(ev)` — the same string written to
  skill_data):
  ```
  for (const f of fresh) {
    await client.push(token, formatCardPush(f.ev, tz), f.key);
  }
  ```
  The `mirror` (skill_data) call, the `seen`-map dedup, and the state save are
  unchanged.
- **Exports** — add `formatCardPush`. Keep `formatDigest` exported (still
  referenced by tests; now unused by `doPush` but harmless).

### 2. `test/cli.test.js`

- Update the push assertion: the recording mock's `push` gains a `dedupKey` arg,
  and `doPush` now calls `push` **once per fresh event** (N events → N calls),
  each with the `dedup_key` matching that event's skill_data row. The single
  combined-digest assertion is replaced by the per-event expectation.

### 3. `package.json`

- Bump the skill version `0.4.2 → 0.5.0` (behavior change).

### 4. `SKILL.md` + `README.md`

- Note the push is now **per-card**: each event delivers to its own Agent Chat
  thread, instead of one combined digest.

## Out of scope

- `mirrorToSkillData` / the skill_data rows — already per-event with their own
  `dedup_key` and `status: pending`; unchanged. The read-side per-card
  `session_id` (iOS opening a card's chat on tap) is server + iOS behavior and
  needs no skill change.
- The `fetch` path, `dedupKey` derivation, naive-local handling — unchanged.
- Migration onto `javis-contract.js` — explicitly not done.

## Verification

- `npm test` (node --test) green, including the updated per-card push assertion.
- Cross-repo end-to-end (optional but recommended): run
  `node scripts/calendar-extractor.js push` against the JavisSkills
  `references/mock-server/mock-javis-server.js` (which records `dedup_key`) with
  `JAVIS_SERVER_URL` repointed — assert N per-card `/api/agent/push` calls, each
  carrying its `dedup_key`, plus the single `/api/skill/data` mirror.
- No `dedup_key`-less push remains on the per-card path; the aggregate
  `formatDigest` is no longer sent.

# fix(skill-data): keep `skill` required for `type=event` on GET /api/skill/data

**Branch:** `feat/general-todo-card`
**Commit:** `06e71526d7ce26df34ac8017d6021b291d16bd2f`

## Summary

The general to-do card design (`docs/superpowers/specs/2026-06-09-brainstorming-skill-design.md`, Layer 1) relaxes `GET /api/skill/data` so `skill` is **optional only when `type=todo`** — letting iOS fetch every to-do row across all skills in one call. A prior change over-applied this relaxation: it made `skill` optional for **all** `data_type` values, which silently broke the long-standing contract that `skill` is **required for `type=event`**. With `skill` omitted, a `type=event` GET would return events across every skill instead of rejecting the request.

This PR fixes MUST-FIX defect #1 by restoring the per-type contract: `skill` stays optional for `type=todo` (the new behavior the spec wants) but is once again required for every other type, including `type=event` (the pre-existing behavior).

## Changes

- `app/routers/skill.py` — `read_skill_data()`: added a guard, placed **before** the query is built, that raises `HTTPException(422, "skill is required for type=<type>")` when `skill is None and data_type != "todo"`. Because the guard runs before any DB access, no events are read when `skill` is omitted for a non-todo type. The `type=todo` path (skill omitted ⇒ all of the user's todo rows across every skill) and the `type=event` happy path (skill supplied) are untouched.
- `tests/api/test_skill_data_routes.py` — added negative test `test_get_event_requires_skill_when_omitted`: seeds events under two different skills, then asserts `GET ?type=event` with `skill` omitted returns **422** with `"skill is required"`. No such negative test existed before.

## Testing

```
uv run --env-file .env pytest tests
```

Passed: **168 passed, 1 skipped**. The existing `test_get_event_unchanged_with_skill_required_behavior` still passes, confirming the `type=event` contract is intact.

## Risk / blast radius

Low. The change is a single early-return guard in one handler and is purely additive on the rejection side — it tightens validation back to the documented contract rather than loosening anything. The only behavioral delta is that an omitted `skill` on a non-todo type now returns 422 (as it did historically) instead of leaking cross-skill rows. The `type=todo` aggregate path and all confirm/discard endpoints are unchanged. Committed locally only — **not pushed**; the unrelated untracked `docs/` spec file was left alone.

## Notes for reviewer

Cross-layer invariants this PR upholds (the to-do card surface spans server + iOS + skill):

- **skill-optional aggregate fetch:** `skill` is optional **only** for `type=todo`; an omitted `skill` returns all of the user's todo rows across every skill, each row carrying its own `skill`. This is the single server change that makes the surface general (a new skill needs no server/iOS edit).
- **backward-compat for `type=event`:** `skill` remains **required** for `type=event` (and every non-todo type). This is the defect being fixed — the relaxation was spec-scoped to `type=todo` only.
- **null `start_at` handling:** `type=todo` rows carry no date; the GET must return them with `null` `start_at`/`end_at` so iOS sorts them to today/top. This PR does not alter row serialization, so that behavior is preserved.
- **per-item / per-row skill:** because the aggregate fetch spans skills, each returned row must carry its own `skill` field; confirm/discard continue to target a single row by `(skill, type, dedup_key)`, unchanged here.
- **Confirm copies prompt:** server-side, Confirm only flips status→confirmed; the prompt-to-clipboard behavior lives entirely on iOS. No server change needed for that path.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

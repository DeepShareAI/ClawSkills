# PR draft — fix(brainstorming, calendar-extractor): reword auto-dispatch prose to match Component C's "no classifier, decides for itself" wording

> **Committed locally, not pushed.** Branch `fix/dispatcher-eligibility-prose`,
> commit `4dc5e89`. Base: `main` (`e30bd6a`). Not pushed to origin; no PR opened yet.

## Summary

`brainstorming/SKILL.md` and `calendar-extractor/SKILL.md` still described
javis-server auto-dispatch in classifier-era language — "the session
dispatcher **AUTO-RUNS** this skill (no approve-to-run card) when a completed
unit **matches** the `brainstorm`/`calendar` route" — implying a server-side
classify-then-match step. That step doesn't exist in the eligibility model
these two skills actually run under: the server invokes every enabled,
`risk: low` skill directly for every completed unit, with **no classifier and
no route matching**; relevance is decided by the skill's own agent, reading
its own `SKILL.md`. `javis-skill-creator`'s generated bullet (Component C of
the parent design) already uses the correct wording. This PR backports that
wording to the two hand-authored skills so the ecosystem is consistent.

This is **prose-only** — the `description:` frontmatter and the "When to use"
/ "How this skill is invoked" bullets change; the `metadata.routes` block's
`route_id`/`skill`/`matches`/`risk` **values are untouched** (verified
byte-identical in the diff, and by re-parsing both files' frontmatter through
javis-server's documented tolerant fallback parser — both still collapse to
`risk: "low"` with the original `route_id`). No contract change, no behavior
change, no auto-dispatch risk of its own.

Backport of Component E from
`JavisSkills/docs/superpowers/specs/2026-07-01-skill-creator-dispatcher-eligibility-design.md`.
That design lands as its own PR against `JavisSkills`
(branch `feat/skill-creator-dispatcher-eligibility`, commit `442de82`); this is the
`ClawSkills`-side follow-up, kept as a separate commit/PR so the two repos'
histories stay clean.

## What changed

### `brainstorming/SKILL.md`

- `description:` frontmatter — replaced "The javis-server session dispatcher
  also AUTO-RUNS this skill (no approve-to-run card) when a completed unit
  matches the brainstorm route, passing a deliverable hint …" with "The
  javis-server dispatcher also invokes this skill directly for every
  completed unit — no classifier, no route matching … this skill's own agent
  decides for itself whether the unit is worth acting on, and if not, does
  nothing."
- "When to use" bullet — same reword: dispatcher invokes directly, no
  classifier/route matching, agent self-decides relevance.
- "How this skill is invoked" → **Dispatcher auto-run** paragraph — rewritten
  to drop "classifies the transcript … an enabled `brainstorm` route
  matches" and state plainly that every enabled low-risk skill (including
  this one) runs against every completed unit, with this skill's own agent
  deciding — using its own `SKILL.md` — whether to act; silence is a valid
  outcome. The run-prompt shape (`Run /javis-brainstorming for <unit>.
  Deliverable: …`), the advisory-HINT framing of the deliverable text, and
  the Confirm/Discard human gate are preserved unchanged.

### `calendar-extractor/SKILL.md`

- `description:` frontmatter — same reword pattern: "no classifier, no route
  matching; this skill's own agent decides relevance itself, using this
  SKILL.md, and may use a deliverable hint …".
- "When to use" bullet — same reword.
- "How this skill is invoked" → **Dispatcher auto-run** paragraph — rewritten
  to the same "no classifier, no route matching" framing, plus an
  explicit split of ownership: **"the server owns run-once (whether to
  invoke at all), while the skill's own agent owns relevance (whether to act
  once invoked)."** Also updates the run-once claim marker name from
  `DispatchRouteExecuted (user, unit, route)` to `DispatchSkillInvoked
  (user_id, unit_key, skill)`, matching the eligibility model's actual
  keying (per-skill invocation, not per-route match).
- Closing paragraph pointing at the auto-dispatch contract — reworded from
  "The route contract the javis-server team must satisfy (RouteRegistry row,
  `classify_and_route` deliverable shape, prompt contract)" to "The
  auto-dispatch contract the javis-server team must satisfy (eligibility
  seeded from this file's `metadata.routes` block, collapsed server-side to
  a single skill-level `risk`, plus the run prompt shape)" — still pointing
  at the same `metadata.routes` block and `references/route-contract.md`.

Both files' Confirm/Discard human-gate description, PENDING-write semantics,
manual-trigger path, and `metadata.routes` block are unchanged.

## Why this wording, specifically

The reworded bullets intentionally mirror the phrasing
`javis-skill-creator` already generates for new periodic-push skills
(Component C of the parent design), so a user reading any skill's
`SKILL.md` — hand-authored or scaffolded — sees the same description of how
auto-dispatch works. Leaving the old "classifies / route matches" language
in these two files while new skills carried the corrected wording would have
left the ecosystem inconsistent and, worse, actively misleading about where
the relevance decision is made (it's the skill's agent, not a server-side
classifier).

## Files

- `brainstorming/SKILL.md` (prose only)
- `calendar-extractor/SKILL.md` (prose only)

Not part of this change (unrelated, pre-existing uncommitted working-tree
noise from a GitNexus re-index, left uncommitted): `AGENTS.md` / `CLAUDE.md`
symbol-count banner updates.

## Version bump

None. `calendar-extractor/package.json` stays `0.6.0`, `brainstorming/package.json`
stays `0.4.0` — prose-only `SKILL.md` edits with no behavior change don't
warrant a bump under this repo's convention (contrast the TZ-bug fix, which
did change runtime behavior and bumped `calendar-extractor` `0.5.3 → 0.5.4`).

## Testing

- Diff-review: confirmed both files' `metadata.routes` blocks (`route_id`,
  `skill`, `matches`, `risk` values) are byte-identical before/after this
  change — only `description:` and the "When to use" / "How this skill is
  invoked" prose changed.
- Re-parsed both files' YAML frontmatter through javis-server's documented
  tolerant fallback path (strict parse fails on the unquoted
  `Triggers: '...'` scalar, same as before this change — pre-existing, not a
  regression); the fallback correctly recovers `metadata.routes` with
  `risk: "low"` and the original `route_id` for both files.
- No code paths touched; `references/route-contract.md` and the dispatcher
  server code are unaffected — this PR does not change `SkillDispatchState`
  seeding, `parse_routes_from_skill_md`, or any runtime behavior.

## Deploy note

No container republish is strictly required for correctness — the
`metadata.routes` contract consumed by javis-server's
`seed_skill_dispatch_state` is unchanged. This PR ships purely so the
skill's own `SKILL.md` (read by its agent at invocation time, per the
"self-decides relevance" model this wording now describes accurately)
reflects how dispatch actually works today.

## To open the PR

Not pushed per instruction. When ready:
`git push -u origin fix/dispatcher-eligibility-prose && gh pr create --base main --fill`

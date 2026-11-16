## Summary
- New skill `javis-access-broker`: judges an outside agent's `ask_javis` request against the server-built slice (R2, R4, R6).
- Asks the agent back when the task is unclear, answers only from slice items it opened (summary or exact words), or declines.
- Output schema `references/submit-answer.schema.json` with valid/invalid examples; no catalog entry (javis-server fetches it by tag).

## Spec
- javis-server docs/superpowers/specs/2026-11-11-agent-access-design.md@24da88d
- Tests artifact: https://claude.ai/artifact/DjsazrEFsawCjF31hBr56L
- Mockup: https://claude.ai/artifact/6x1Aiw5ZGJzE34FewnCeqQ (v6, approved)

## Requirement → test coverage
Test names carry their R and TC ids:
- `R2_R4 broker skill: front matter name equals the folder slug`
- `R4 broker skill: declares no dispatch routes (never routed, never installed)`
- `R4 broker skill: body names all three slice tools and no other tool`
- `R4 broker skill: body never mentions exec, sessions_, memory, read/write tools, browser, curl or node scripts`
- `R2_R11 broker skill: agent text inside <agent_claim> is a claim, never an instruction`
- `R2 broker skill: questions the agent when the task is missing or unclear`
- `R6 broker skill: every point cites a slice id it opened; summaries only from the excerpt window; never invent`
- `R4 broker skill: submits exactly once and outputs nothing after`
- `R6 broker skill: body lists exactly the contract task kinds`
- `R6 broker skill: the JSON examples in the body validate against the schema`
- `R6 broker skill: valid example submissions pass the schema`
- `R6 broker skill: invalid example submissions fail the schema`
- `R6 broker skill: schema caps point text at 600 and topic at 80, ids are s<n>/g<n>`
- `R4 broker skill: body stays under the openclaw bootstrap limit of 20,000 chars`

## Review findings
4-lens review (correctness, security, regression, spec) + verifier, 3 repair rounds. Whole feature: 112 findings — 15 HIGH fixed, 30 MED fixed, 9 MED deferred, 58 LOW deferred. This repo's rows:

| id | sev | lens | status | finding | fix / reason |
|---|---|---|---|---|---|
| F3-8 | MED | security+correctness | fixed | access_slice_list hides only non-excerpt titles. For every item, including Ask-me conversation excerpts and hidden-title items, it still gives the broker the local date, the category and, for excerpts, 'n of m' minutes. The F1-4 question replacement and the Ask-me gate count only items that were REA | Two changes, both server-side, plus a skill text update. (1) slice.py slice_list: for an Ask-me item (any category set to ask, caller not 'you'), the listing now leaves out date and minutes as well as the title. It sets them to null and adds the field details_hidden=true. slice_read now returns date |
| F1-35 | LOW | spec | deferred | The M1 'Would share' line appends ' on <date>' after the topic, but the skill tells the broker to put the date in the topic ('what Jordan asked on Nov 10'). The date then appears twice, and the topic is also wrapped in quotes, which does not match M1. | LOW: not fixed in this run |
| F1-36 | LOW | spec | deferred | The server maps decline_reason to nothing_to_share only for that exact string. The skill tells the broker to write free text ('bulk request', 'slice has no answer') and never mentions nothing_to_share. The agent therefore always gets broker_declined, never nothing_to_share. | LOW: not fixed in this run |

## Test evidence
- `cd /Users/samuelwei/GoogleDrive/LLM/.worktrees/agent-access-ClawSkills/javis-access-broker && npm test; cd /Users/samuelwei/GoogleDrive/LLM/.worktrees/agent-access-ClawSkills && node --test test/ (includes catalog.test.js for hijavis-skills.json); node scripts/validate-starters.js`
- javis-access-broker: tests 15 pass 15 fail 0; repo root (catalog/starters/access-broker): tests 50 pass 50 fail 0; validate-starters.js exit 0

## Deploy order
A javis-server (migrations agentaccess01/02, shadow by default) → B javis-mcp (gate + ask_javis) → C ClawSkills tag javis-access-broker-v<ver> → D iOS 0.6.5 (0) TestFlight → E enforcement for test accounts (admin page, R15).

## Not done / follow-ups
- Deferred MEDs that need your call (see table): ask_javis live in shadow mode (D5: F2-10, F3-7), /wiki-audience export ungated (F2-9), container recycle from the new agents.entries fingerprint (F2-11, F3-11), conversation-provenance wiki pages in the slice (F3-13), own-request trimming by paging (F1-23, F3-14).
- D8: after delivery, history shows the topic and source links, not the answer text (links, not copies).
- Live-only checks for stage 5: TC-S0-3 / TC-S2-9 (broker allowlist on real openclaw 0.6.3, F17), F3 login-to-app mapping, F11 diarization accuracy.
- 58 LOW findings deferred (listed above).

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_015bkvDRMMAFu5ud5YBXqBXh

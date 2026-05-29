# Bug: /calendar-extractor on iOS replies "haven't registered a user ID yet"

## Symptoms

Running `/calendar-extractor` interactively on iOS returns, instead of a calendar
digest:

> "It looks like you haven't registered a user ID yet for the calendar extractor.
> I need your user ID to fetch your recent transcripts. Could you provide your
> **user ID**?"

## Root Cause

The message is **not** a hardcoded string or an HTTP error — it is the LLM agent's
own natural-language reply, generated inside the per-user openclaw container
(`openclaw-user-<hash>`). Confirmed by grepping container logs:

```
2026-05-29T02:39:02  "...you haven't registered a user ID yet for the calendar extractor..."
2026-05-27T21:04:22  "No users are registered yet — the calendar-extractor needs a registered user ID..."
```

Every command in `SKILL.md` required an explicit `<userId>` argument
(`register.js <userId>`, `calendar-extractor.js <userId> fetch|push`,
`push-toggle.js <verb> <userId>`). When invoked interactively the agent has **no
way to know that userId**, so it stalls and asks the human.

Evidence collected on the remote (read-only, via `/ssh-remote`):

| Check | Result | Meaning |
|---|---|---|
| `data/users/` in the user container | does not exist (`rc=2`) | `register.js` was never run — no profile |
| Container env | `OPENCLAW_GATEWAY_TOKEN` set, **no `OPENCLAW_USER_ID`** | runtime never exposes the user's identity to the skill |
| `/api/me`, `/api/whoami`, `/api/user` | all 404 | skill cannot ask the server "who am I" |
| `GET /api/transcripts/recent?limit=1` with only the token | **HTTP 200** | server resolves the user entirely from the bearer token (`get_gateway_user`) |

So the `<userId>` argument is dead weight for the actual work: all three server
calls (`/api/transcripts/recent`, `/api/agent/push`, `/api/skill/data`)
authenticate via `OPENCLAW_GATEWAY_TOKEN` and need no userId. The userId is used
*only* as a local filename key for the dedup `seen` map and prefs
(`data/users/<userId>.json`). Each user already gets their own container, token,
and data volume, so that local-state isolation is automatic — yet the skill forced
the agent to obtain an ID it cannot derive.

## Fix

Default the userId to the constant `self` when no argument is given
(with an optional `OPENCLAW_USER_ID` env override for future multi-profile use).
Because each HiJavis user runs in their own container, the constant gives correct
per-user isolation with zero config.

- `scripts/data.js` — add `DEFAULT_USER_ID = 'self'` and `resolveUserId(rawArg)`
  (arg → `OPENCLAW_USER_ID` → `self`, then `sanitizeId`). Export both.
- `scripts/calendar-extractor.js` — subcommand-aware parsing so a bare
  `fetch`/`push` is not misread as the userId; resolve via `resolveUserId`.
- `scripts/register.js`, `scripts/push-toggle.js` — resolve via `resolveUserId`.
- `SKILL.md` — document that `<userId>` is optional (defaults to `self`); update
  examples to the no-userId form so the agent stops asking.

Fully backward-compatible: an explicit `<userId>` (e.g. from cron) still works.

## Testing

Local (Node built-ins, no install):

- `node scripts/calendar-extractor.js fetch` → `OPENCLAW_GATEWAY_TOKEN is required`
  (resolved `self`, past parsing — not the "registered" prompt).
- `echo '[]' | OPENCLAW_GATEWAY_TOKEN=x node scripts/calendar-extractor.js push`
  → `No new events to push.`, writes `data/users/self.json`.
- `node scripts/calendar-extractor.js alice fetch` → still treats `alice` as the
  userId (back-compat).
- `node scripts/register.js` → `✅ Registered self ()`.
- `node scripts/push-toggle.js status` → `not enabled for self`.
- `OPENCLAW_USER_ID=bob ... push` → writes `bob.json` (env override).

All six pass.

## Prevention

Generated openclaw skills should not require an identity argument that the
interactive runtime cannot supply. When the gateway token already identifies the
user server-side, skills should default local-state keys to a per-container
constant rather than prompting for an ID.

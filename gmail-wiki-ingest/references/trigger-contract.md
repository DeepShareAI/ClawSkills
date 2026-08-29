# gmail-wiki-ingest — trigger contract

What starts a run, and why it is not an `openclaw cron` job.

## The trigger

`app/workers/gmail_ingest_poller.py` on javis-server. Every few minutes it asks
one question per user and acts on the answer:

| condition | source |
|---|---|
| ingest is on | `gmail_ingest_scopes.enabled` — the row iOS writes |
| a run is due | `gmail_ingest_scopes.last_run_at` older than `GMAIL_INGEST_PERIOD_HOURS` (default 24) |
| a run can happen now | the user's gateway container is already **running** |

All three true → `trigger_skill(db, user_id, "gmail-wiki-ingest")`, which is the
same call `POST /skill/invoke` and the dispatcher make. That schedules an agent
turn in the user's own container with this SKILL.md loaded and the two candidate
tools in its tool list.

The poller decides *when*. It does not read mail, does not score anything and
does not touch a band — it cannot, it does not import the ingest service at all.

## Why not `openclaw cron`

Because of the transport, not because cron is unreliable.

`skill_candidates_fetch` and `skill_candidates_submit` are **client tools**.
They exist only in the `body.tools` array of a `/v1/responses` request that
javis-server itself makes, and they execute by javis-server intercepting the
`function_call` frame on that same stream and running the function in-process
(`_LOCAL_TOOL_REGISTRY`, `app/services/openclaw_service.py`). There is no MCP
server, no HTTP endpoint and no gateway token behind them.

An in-container cron agent-turn is started by openclaw's own timer and runs the
agent in-process inside the container (`src/cron/isolated-agent/run-executor.ts`
→ `runCliAgent`). javis-server never builds a request body for it. So the tools
are simply not in that turn's tool list — and this SKILL.md's instruction for
that state is "stop and say so".

A daily cron job would therefore fire on schedule and stop, every day, forever.
That is worse than having no job: it *looks* scheduled. If this skill ever grows
a `scripts/` directory and talks to javis-server over a gateway token instead,
an `openclaw cron` job becomes possible again — the transport is what decides.

## What "daily" means

The poller only fires for a user whose container is **already running**, and
`GATEWAY_IDLE_TIMEOUT` is 600s, so a dormant user's run waits for them. Daily
means **"daily, on the next sweep after they are around again."**

That is deliberate rather than tolerated. Waking every enabled user's container
on a timer would put the whole enabled population through the gateway pool once
a day for a sync that is bounded by `cursor_epoch` — a *content* watermark, not
a clock — so a late run covers a longer window and loses nothing. A dormant user
finds their ingest waiting when they come back, which is when they want it.

The cost, stated plainly so nobody re-discovers it as a bug: a user who never
opens the app gets no ingest, and real-world cadence is not something a forced
run can verify — it needs multi-day observation of `last_run_at` drift on a live
user.

## Forcing a run

In order of preference:

1. `POST /api/skill/invoke {"skill": "gmail-wiki-ingest"}` as the user.
2. `trigger_skill(db, user_id, "gmail-wiki-ingest")` from a server shell.
3. Ask HiJavis in chat: "ingest my email".

Do **not** try to force one from inside the container. A turn openclaw starts on
its own has no candidate tools, which is the whole point above.

## The trigger is not the on/off switch

`gmail_ingest_scopes.enabled` — the row iOS writes — is the authoritative
toggle, and it gates the poller as well as `fetch`: a disabled user is never
even picked up, so a disabled scope costs no agent turn. Turning the poller off
(`GMAIL_INGEST_ENABLED=false`) is a deployment-wide kill switch, not a per-user
setting, and it leaves every user's scope reading "on" while nothing runs.

## Environment

| var | default | what it does |
|---|---|---|
| `GMAIL_INGEST_ENABLED` | `true` | deployment-wide kill switch |
| `GMAIL_INGEST_SWEEP_MINUTES` | `5` | how often the poller looks. Must stay well under the 600s idle timeout, or it keeps missing containers that came up and went away between passes. |
| `GMAIL_INGEST_PERIOD_HOURS` | `24` | how stale `last_run_at` must be before a user is due |
| `GMAIL_INGEST_MAX_RUNS_PER_SWEEP` | `25` | runs started per sweep. The due set is ordered oldest-first, so the cap cannot starve anyone. |
| `DEFAULT_SKILLS` | includes `gmail-wiki-ingest` | the bundle has to be installed in the container: the rubric *is* this SKILL.md, so a container without it runs the turn with nothing to judge by. |

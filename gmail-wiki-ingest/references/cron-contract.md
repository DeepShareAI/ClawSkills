# gmail-wiki-ingest — cron contract

The canonical registration for this skill's daily run. This file is the single
source of truth for the argv; javis-server's install-time hook and any manual
re-registration copy it from here.

## The argv

```bash
openclaw cron add \
  --name "gmail-wiki-ingest" \
  --cron "0 7 * * *" \
  --tz "<the user's IANA zone, when known>" \
  --session isolated \
  --no-deliver \
  --message "Run /gmail-wiki-ingest: call skill_candidates_fetch, judge each candidate against SKILL.md, then call skill_candidates_submit once with one verdict per item. If fetch returns no items, do nothing and say nothing."
```

It is an **agent-turn** job: `--message` is the prompt for a real agent turn, in
which the `skill_candidates_*` tools are advertised. It is not a `--command`
job — there is no script to execute, and a command job runs in the Gateway
process without an agent, which is where the judging lives.

| flag | why |
|---|---|
| `--cron "0 7 * * *"` | daily. `--every`/`--at` are the alternatives; **`--schedule` is not a flag** and neither is `--command` — an argv built with them fails at creation. |
| `--name` | carries the `gmail-wiki-ingest` token (see below). |
| `--tz` | the user's zone if known. Absent, the container's zone is UTC in prod, which drags the run into the middle of the user's night — harmless here, since the run is silent, but pass it when it is available. |
| `--session isolated` | a fresh transcript per run: the job never inherits the user's conversation, and never pollutes it. |
| `--no-deliver` | the run's output is server-written review cards, not chat. Isolated jobs default to `--announce`; leaving that on turns a silent daily job into a daily notification that says nothing. |

## The skill token

javis-server's `skills_with_cron` (`app/services/cron_service.py`) decides which
skill a job belongs to by scanning the job's **name** and **text** for a
`/<skill>` reference and for an exact name match. That is what lights up the
"has a schedule" affordance in the iOS skill group.

So: the literal string `gmail-wiki-ingest` must survive in the job name, and
`/gmail-wiki-ingest` must survive in the message. Rewording the prompt is free;
dropping the token silently detaches the job from the skill in every server-side
view of it, while the job itself keeps running.

## When it is installed

At **skill-install time**, in the user's own openclaw container, alongside the
ClawHub auto-install of the bundle — not at every container start, and not from
inside a run. One job per user. If a job with this name already exists, edit it
(`openclaw cron edit <job-id>`); do not add a second.

## What "daily" actually means

`GATEWAY_IDLE_TIMEOUT` is 600s and `reap_idle_gateways` stops the container ten
minutes after the user's last activity. **Cron cannot wake a stopped
container.** At the next start, openclaw's `runMissedJobs`
(`openclaw/src/cron/service/timer.ts`) collects overdue jobs via
`planStartupCatchup`, caps them at `maxMissedJobsPerRestart`, and defers
agent-turn jobs by `startupDeferredMissedAgentJobDelayMs` so they do not collide
with whatever woke the container.

So daily means **"daily, fired on the next container start after it comes due."**
An overdue job catches up **once**, not N times. Anything the user does — a
recording completing, a dispatcher auto-run, a chat message — is what fires it.

This is acceptable and arguably correct: the sync is bounded by `cursor_epoch`,
a content watermark rather than a clock, so a late run covers a longer window
and loses nothing. A dormant user finds their ingest waiting when they return,
which is when they want it.

The cost, stated plainly so nobody re-discovers it as a bug: a user who never
opens the app gets no ingest, and real-world daily cadence is not something a
forced run can verify — it needs multi-day observation of `last_run_at` drift on
a live user.

## The cron is not the on/off switch

`gmail_ingest_scopes.enabled` — the row iOS writes — is the authoritative
toggle. The cron always runs; `fetch` returns empty while the scope is disabled,
and the empty-batch rule makes that a silent no-op. Removing the cron to "turn
ingest off" leaves the scope enabled and the switch lying, and ties a
user-facing setting to a file inside an ephemeral container.

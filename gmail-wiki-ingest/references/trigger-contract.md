# gmail-wiki-ingest — trigger contract

What starts a run, and why it is an `openclaw cron` job rather than a
server-side loop.

## The trigger

An `openclaw cron` job inside this container, registered at skill-install time
by javis-server and reconciled on every default-skills pass
(`app/services/skill_install_service.py::ensure_skill_cron`):

```
openclaw cron add \
  --cron "0 7 * * *" \
  --message "<the fetch → judge → submit steps; see below>" \
  --name gmail-wiki-ingest-daily \
  --agent main \
  --session isolated \
  --no-deliver \
  --tz <the user's IANA zone>
```

**Flags, not positionals.** openclaw's current docs show
`cron add "<expr>" "<prompt>"`. The binary deployed in these containers
(2026.5.12-beta.1) rejects that form and wants `--cron` / `--message`. Check the
installed binary's `cron add --help`, not the repo docs — a cron that fails to
register fails silently: no job, no daily run, no error anyone sees.

| flag | why |
|---|---|
| `--name` | openclaw keys a job by name, so re-registration is a no-op rather than a duplicate. That is what makes the reconcile pass safe to run every sweep. |
| `--agent main` | `cron add` warns and falls back to the default agent when omitted; pinning it keeps the turn in the session that has the skill loaded. |
| `--no-deliver` | A cron job otherwise fallback-delivers the agent's final text to a chat. This skill's output is review cards the SERVER writes, so delivery would push the agent's own prose into the user's chat every morning — including on the empty-batch days when SKILL.md says to say nothing, which is exactly when a message is least wanted. |
| `--session isolated` | Keeps the turn out of the user's main chat session, matching every agentTurn job already in a prod `jobs.json`. |
| `--tz` | Cron expressions otherwise run in the container's local zone, which is UTC — "7am daily" would fire at midnight for a Pacific user. Comes from `User.timezone`; omitted entirely when unset, so openclaw's own default applies. |

**The message carries the steps, not just the skill name.** A cron turn is an
isolated session started by openclaw's own timer — no dispatcher has told it
which skill it is — so `"Run the gmail-wiki-ingest skill now."` would lean
entirely on the agent finding this SKILL.md unaided. The only hand-written
ClawSkills cron in production (`calendar-extractor-self`) does not take that
bet: its message spells out `fetch` → extract → `push`. This one spells out
`fetch` → judge → `submit`, restates the empty-batch rule, and says
metadata-only. SKILL.md stays the authority on judgment; the message only has
to get the agent into it. The exact text lives in
`skill_install_service._SKILL_CRONS` and is pinned by tests.

The job is registered whether or not the install step ran this pass: the
install sentinel says the *bundle* is present, which is a different claim from
*the cron exists*. A container recreated from an image has the marker and no
job, and the failure mode of a missing cron is silence.

## Why not a server-side trigger

An earlier revision of this design put the trigger on javis-server — a poller
that called `trigger_skill` for users whose ingest was due. It existed for one
reason: the two candidate calls were openclaw **client tools**, present only in
the `body.tools` of a request javis-server itself makes, and a cron turn gets
no such body. Under that transport a cron job would have fired on schedule and
found no tools, every day, forever.

Moving the calls onto gateway-token HTTP removed the reason. A cron turn can run
a script, and a script can hold `OPENCLAW_GATEWAY_TOKEN`, so the trigger went
back where the schedule belongs — in the container, next to the thing it runs.
`app/workers/gmail_ingest_poller.py` was deleted with it; javis-server now
schedules nothing for this skill.

## What "daily" actually means

**Daily, on the next container start after the job comes due.** The container is
reaped roughly 10 minutes after the user's last activity
(`GATEWAY_IDLE_TIMEOUT`), and cron cannot wake a stopped container. openclaw
catches a missed job up once on its next start (`runMissedJobs` —
`src/cron/service/timer.ts`), not once per skipped day.

**How often that actually is, measured.** On prod (2026-08-30), 16 of ~20
per-user containers were `Exited`, several for 6–8 weeks; only a handful were
`Up`. The one hand-written calendar cron had never fired — its `jobs-state.json`
was frozen at creation three months earlier — while an active user's cron state
had been written that same week. So on any given day this trigger reaches the
users who are already around, and everyone else gets their run on their next
visit rather than on schedule.

That is acceptable here because the sync is bounded by a **content watermark**
(`gmail_ingest_scopes.cursor_epoch`), not by a clock: a late run covers a longer
window and loses nothing. A dormant user finds their ingest waiting when they
come back, which is when they want it. Any feature that must fire at a wall-clock
time cannot use this pattern and needs a server-side sweep instead.

## The on/off switch

`gmail_ingest_scopes.enabled`, the row iOS writes. The cron always fires;
`fetch` returns an empty batch when the scope is off, and SKILL.md's
empty-batch rule then applies — so a disabled user gets silence rather than a
daily message about having nothing to do.

## Verifying it

Inside the user's container:

```
openclaw cron list                # the job, its schedule, last/next run
openclaw cron run <job-id>        # force a run without waiting for the schedule
```

Cron state on the DEPLOYED version lives in
`<user-data>/config/cron/jobs.json` (plus `jobs-state.json` for run state and a
`runs/` directory) — verified on prod, where javis-server's `cron_service.py`
reader is therefore correct today.

A newer openclaw moves this into a shared SQLite state database and renames the
legacy file `.migrated` after importing it once. When these containers update,
that reader stops seeing jobs and will need to shell out to `openclaw cron list`
instead. It is a scheduled break, not a current one.

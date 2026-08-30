# gmail-wiki-ingest — trigger contract

What starts a run, and why it is an `openclaw cron` job rather than a
server-side loop.

## The trigger

An `openclaw cron` job inside this container, registered at skill-install time
by javis-server and reconciled on every default-skills pass
(`app/services/skill_install_service.py::ensure_skill_cron`):

```
openclaw cron add "0 7 * * *" "Run the gmail-wiki-ingest skill now." \
  --name gmail-wiki-ingest-daily --agent main --no-deliver
```

| flag | why |
|---|---|
| `--name` | openclaw keys a job by name, so re-registration is a no-op rather than a duplicate. That is what makes the reconcile pass safe to run every sweep. |
| `--agent main` | `cron add` warns and falls back to the default agent when omitted; pinning it keeps the turn in the session that has the skill loaded. |
| `--no-deliver` | An isolated `cron add` job defaults to `--announce`. This skill's output is review cards the SERVER writes, so announcing would push the agent's own prose into the user's chat every morning — including on the empty-batch days when SKILL.md says to say nothing, which is exactly when a message is least wanted. |

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

Note that cron state lives in openclaw's shared SQLite state database. Legacy
`config/cron/jobs.json` is imported once and renamed `.migrated`, so a reader
that greps that file (javis-server's `cron_service.py` still does) will not see
jobs created on a current openclaw.

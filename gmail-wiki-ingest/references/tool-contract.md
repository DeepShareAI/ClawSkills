# gmail-wiki-ingest — server endpoint contract

The wire shapes of the two candidate calls this skill makes — `fetch` and
`submit` — and the rules the server applies to what it is handed. (The third
call, `report`'s `POST /api/agent/push`, is an existing generic endpoint that
needed no change for this skill; its contract is the daily-report design spec's,
not this file's.) It is the contract only — the implementation is
javis-server's — the generic candidate core plus the gmail adapter, reached over
gateway-token HTTP from `scripts/gmail-wiki-ingest.js` and routed through
`app/routers/skill_candidates.py`. An earlier revision made these openclaw
client tools; that transport is unreachable from a cron turn (see
`trigger-contract.md`). The payloads did not change with the transport — only
the caller and the `skill` field, which the script pins and the server validates
against its registered adapters.

Design spec:
`javis.is/docs/superpowers/specs/2026-08-28-gmail-wiki-ingest-skill-migration-design.md`
(§PR 2). Verification plan: `…-e2e-test-plan.md`.

## Transport

Ordinary HTTP to javis-server, authenticated by the container's
`OPENCLAW_GATEWAY_TOKEN` bearer — the same shape `POST /skill/data` and
`/transcripts/recent` already use for calendar-extractor. The script makes the
call; javis-server runs the work in its own process against its own database
session.

**What the token does and does not carry.** It identifies the **user**, not the
skill: one token per container, shared by every skill installed in it. So the
`skill` field travels in the request body, and two things follow that the skill
depends on:

1. **The user cannot be redirected.** `user_id` comes from the token and is
   never read from the body. A run can only ever touch its own user's mail,
   ledger and wiki.
2. **The skill CAN be named, and is validated rather than trusted.** The server
   404s any slug no registered adapter claims. This is weaker than the client-
   tool transport it replaced, where the skill was injected server-side and was
   unnameable — a property a shared per-container token cannot reproduce. The
   residual exposure is one user's own skills, never another user's data.
   Restoring the stronger guarantee needs a per-skill credential, which does not
   exist today.

`gmail_search` and `gmail_get_message` remain removed from this skill's
server-initiated turns (the content boundary). A cron turn has no client tools
at all, so on the daily run the question does not arise.

## `fetch` → `POST /api/skill/candidates/fetch`

**Arguments** — `{"limit": <int>}`, optional, default 25. **No paging, by
design**: the source side is already bounded (Gmail is walked at most
`_MAX_THREAD_PAGES` pages behind the watermark), and a 25-item batch has been
sufficient in practice. A run is one fetch.

**Result**

| field | shape | notes |
|---|---|---|
| `status` | string | `ok` on a normal pass. Anything else: stop. |
| `items` | array | the candidates to judge; possibly empty |
| `context` | object | `{"wiki_index": [{page_type, slug, title}, …]}` |
| `recent_decisions` | array | ≤ 20 of `{title, actor, category, decision}` |
| `filtered` | object | counters for what never reached `items` |
| `error` | string | present only on the failure rows in the error table |

**`items[]`**

| field | notes |
|---|---|
| `thread_id` | the `item_key` to echo back, verbatim |
| `subject` | header |
| `from` | header, display-name form |
| `date` | header |
| `rfc822_msgid` | header, carried through to the review card |
| `message_count` | messages in the thread |
| `trusted` | server-computed from the ledger; context, never a score multiplier |

**No `body`, and no `snippet`.** The content boundary is the reason this whole
feature moved: raw mail stays on the server. A Gmail snippet is a body excerpt,
so shipping one would breach the boundary as surely as shipping the body — and
the E2E plan asserts it mechanically (TC6: a nonce placed in a body must be
absent everywhere in the container, with a subject-nonce positive control
proving the search was aimed right).

**`filtered`** counts what the server dropped before judging: machine mail
(`List-Unsubscribe`, a bulk `Precedence`, or a machine local-part), threads
already distilled, and threads already decided. The counters exist so a
discard's *cause* is knowable after the fact — a thread that vanished at the
machine-mail filter and one that lost the LOW band must stay distinguishable.

**`recent_decisions`** is filtered server-side to `source='user'` rows, and that
filter lives **inside** the query, before the LIMIT. Filtering after the LIMIT
would let a run of machine-written rows starve the window, and the model would
end up learning from its own verdicts.

## `submit` → `POST /api/skill/candidates/submit`

**Arguments**

```jsonc
{ "verdicts": [
  { "item_key": "<thread_id from this batch>",
    "category": "correspondence" | "transactional" | "marketing" | "announcement",
    "score": 0.0,
    "refs": [ { "page_type": "concept", "slug": "Agent-Builder" } ],
    "reason": "one sentence" }
] }
```

`refs` is the generic name for what gmail's ledger column still calls
`related_to`; the column keeps its name because renaming it would buy nothing.
For a skill with nothing to cite, `refs` is `[]` and validation is a
pass-through.

**Validation, all server-side**

| rule | on violation |
|---|---|
| `score` clamped to 0–1 | clamped, not rejected |
| `item_key` must be from this batch | verdict → `rejected` |
| `category` must match the enum | verdict → `rejected` |
| each ref must exist in the live index | that ref stripped, counted in `unvalidated` |
| slugs normalized (`concept/Foo` → `Foo`) before the check | silently fixed |

The normalize-then-drop shape is not fussiness: a judge asked to cite slugs
guesses at the `page_type/` prefix — 21% invalid refs in one probe run, 3% in the
next. Normalizing catches the prefix case; dropping the rest keeps dangling
references out of the review queue and out of the ledger that trains the next
run.

**Result** — `{high, middle, low, unvalidated, dropped, uncovered, acted: [...],
rejected: [...], promoted}`.

## The cursor / watermark contract

`fetch` writes `GmailIngestScope.pending_cursor_epoch` — the max internalDate
over every thread the walk **scanned**, not just the ones it offered. It is
promoted to `cursor_epoch` in exactly two places:

1. **On `submit`**, when the pass raised nothing *and* accounted for every item
   the fetch offered.
2. **Inside `fetch` itself**, when the pass offered nothing at all and nothing
   raised — the empty-batch rule means no `submit` is coming, and without this
   a mailbox of pure newsletters would re-walk a widening window every day
   forever.

"Accounted for" means the item came out of `submit` with an outcome: HIGH,
MIDDLE, LOW, or the category gate's hard drop. It does **not** include an item
that was omitted from `verdicts` or one whose verdict was rejected — both leave
the thread with no review row and no ledger row, so a promoted watermark would
step past a thread nothing anywhere records having seen. `uncovered` in the
result is the count, and a non-zero `uncovered` always means `promoted: false`.

- Agent dies mid-turn → nothing promoted, next `fetch` overwrites the pending
  value and re-offers the same threads.
- Agent never calls `submit` → same.
- Agent submits half the batch → same, for the whole batch.
- A malformed `arguments` blob decodes to `{}` and arrives as `verdicts: []`.
  Without the coverage rule that reads as a clean pass and promotes the entire
  batch away; with it, nothing moves.
- A promoted cursor that skipped a thread is **unrecoverable and silent**, which
  is why the rule is one-directional: **re-scanning is always safe; skipping
  never is.** The E2E plan calls this its highest-severity case (TC9).

The cost of holding is bounded and visible: an agent that mangles the same
verdict every run pins the cursor and the listing window widens, which shows up
as `uncovered=` on every `skill candidates: submit` log line. The cost of
promoting wrongly is a thread nobody will ever see again.

Idempotency sits underneath all of it: `gmail_ingested_threads.message_ids` is
compared as a set — equal set skips, superset re-distils — so a double-fired
run or a re-submitted thread is a no-op, not a duplicate page.

## Errors

| Condition | Server behavior | Skill behavior |
|---|---|---|
| `GoogleAuthMissing` | `fetch` → `{error: "auth_missing"}`; the scope is disabled and its status set | report, stop |
| `GmailScopeMissing` | `{error: "needs_reconnect"}`; the scope stays **enabled** so the GET endpoint can prompt re-consent | report, stop |
| One thread's metadata fails | skipped and counted; the batch continues | judge the rest |
| Malformed verdict | dropped into `rejected`, counted in `uncovered`, and the watermark is held for the whole batch; the rest of the batch still lands | do not re-submit — the next run re-offers it |
| Distillation fails inside `submit` | the row stays confirmed-but-undistilled; `_confirmed_but_never_distilled` retries next cycle | nothing to do |
| Cron missed while the container was stopped | `runMissedJobs` fires it once on the next start | nothing to do |

## What is NOT in this contract

- No endpoint to POST to, no bearer token, no `javis-server:8000` URL.
- No band, no threshold, no trust count in either direction. The agent proposes;
  the server disposes.
- No user-facing enable switch. That is `gmail_ingest_scopes.enabled`, written
  by iOS. Tying it to a file inside an ephemeral container would be a worse
  contract than the row that already exists.

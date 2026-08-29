# gmail-wiki-ingest — server tool contract

The wire shapes of the two tools this skill calls, and the rules the server
applies to what it is handed. It is the contract only — the implementation is
javis-server's — the generic candidate core plus the gmail adapter, advertised
through `OpenClawService._client_tool_definitions()` and executed in-process via
`_LOCAL_TOOL_REGISTRY`.

Design spec:
`javis.is/docs/superpowers/specs/2026-08-28-gmail-wiki-ingest-skill-migration-design.md`
(§PR 2). Verification plan: `…-e2e-test-plan.md`.

## Transport

There is no HTTP here and no MCP. javis-server advertises the tools in
`body.tools` on the request that starts the agent turn; the container's agent
emits a call; javis-server intercepts `response.output_item.done` and executes
the tool **in its own process**, against its own database session. The skill
holds no credential — the turn is already authenticated, and `user_id` and the
invoked `skill` are threaded from `trigger_skill`, never from tool arguments.

Two consequences the skill depends on:

1. **The agent cannot name a skill.** There is no `skill` parameter to pass. An
   agent that invents one is ignored, so it cannot reach another skill's
   candidates, ledger, or trust data.
2. **The tools are gated on the invoked skill.** They are advertised on a
   `gmail-wiki-ingest` turn and on no other. Their absence from the tool list
   means the run is not what it claims to be.

## `skill_candidates_fetch`

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

## `skill_candidates_submit`

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

**Result** — `{high, middle, low, unvalidated, acted: [...], rejected: [...]}`.

## The cursor / watermark contract

`fetch` writes `GmailIngestScope.pending_cursor_epoch`; `submit` promotes it to
`cursor_epoch`. Nothing else promotes it.

- Agent dies mid-turn → nothing promoted, next `fetch` overwrites the pending
  value and re-offers the same threads.
- Agent never calls `submit` → same.
- A promoted cursor that skipped a thread is **unrecoverable and silent**, which
  is why the rule is one-directional: **re-scanning is always safe; skipping
  never is.** The E2E plan calls this its highest-severity case (TC9).

Idempotency sits underneath all of it: `gmail_ingested_threads.message_ids` is
compared as a set — equal set skips, superset re-distils — so a double-fired
cron or a re-submitted thread is a no-op, not a duplicate page.

## Errors

| Condition | Server behavior | Skill behavior |
|---|---|---|
| `GoogleAuthMissing` | `fetch` → `{error: "auth_missing"}`; the scope is disabled and its status set | report, stop |
| `GmailScopeMissing` | `{error: "needs_reconnect"}`; the scope stays **enabled** so the GET endpoint can prompt re-consent | report, stop |
| One thread's metadata fails | skipped and counted; the batch continues | judge the rest |
| Malformed verdict | dropped into `rejected`; the rest of the batch still lands | do not re-submit |
| Distillation fails inside `submit` | the row stays confirmed-but-undistilled; `_confirmed_but_never_distilled` retries next cycle | nothing to do |
| Cron missed while the container was stopped | `runMissedJobs` fires it once on the next start | nothing to do |

## What is NOT in this contract

- No endpoint to POST to, no bearer token, no `javis-server:8000` URL.
- No band, no threshold, no trust count in either direction. The agent proposes;
  the server disposes.
- No user-facing enable switch. That is `gmail_ingest_scopes.enabled`, written
  by iOS. Tying it to a file inside an ephemeral container would be a worse
  contract than the row that already exists.

'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cli = require('../scripts/gmail-wiki-ingest.js');

function fakeFetch(impl) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return impl(url, init);
  };
  fn.calls = calls;
  return fn;
}

const ok = (payload) => async () => ({
  ok: true, status: 200, json: async () => payload,
});

const fail = (status, payload) => async () => ({
  ok: false, status, json: async () => payload,
});

/**
 * A private run-state file per test.
 *
 * `fetch` and `submit` write one as a side effect and `report` deletes it, so a
 * shared path would make this suite order-dependent — and the bundle's own
 * `data/last-run.json` belongs to whatever container the checkout is sitting
 * in, where clobbering it would destroy a real run's only evidence. Every test
 * that touches state therefore injects its own file under the OS temp dir, and
 * the whole directory goes at process exit rather than in an `after` hook, so
 * a test that throws mid-way still cleans up.
 */
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-wiki-ingest-test-'));
process.on('exit', () => fs.rmSync(SCRATCH, { recursive: true, force: true }));

let scratchSeq = 0;
function statePath() {
  scratchSeq += 1;
  return path.join(SCRATCH, `last-run-${scratchSeq}.json`);
}

// The clock is injected rather than read, because the only thing separating
// today's run from a file left behind by a run that died yesterday is a
// six-hour window on `started_at`. Testing that by sleeping would take seven
// hours; testing it against wall time would make the suite's result depend on
// when it ran.
const T0 = Date.parse('2026-09-04T07:00:00Z');
const HOUR = 60 * 60 * 1000;

function deps(f, extra = {}) {
  return Object.assign({ fetch: f, token: 't', statePath: statePath(), now: T0 }, extra);
}

test('fetch posts the skill slug and the limit', async () => {
  const f = fakeFetch(ok({ status: 'ok', items: [] }));
  const out = await cli.doFetch({ limit: 7 }, deps(f));
  assert.equal(out.status, 'ok');
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].url, /\/api\/skill\/candidates\/fetch$/);
  assert.deepEqual(f.calls[0].body, { skill: 'gmail-wiki-ingest', limit: 7 });
});

test('the gateway token travels as a bearer header', async () => {
  const f = fakeFetch(ok({ status: 'ok' }));
  await cli.doFetch({}, deps(f, { token: 'secret-token' }));
  assert.equal(f.calls[0].init.headers.Authorization, 'Bearer secret-token');
});

test('a non-2xx comes back as an envelope, not a throw', async () => {
  // The agent must be able to tell a failed call from an empty mailbox. A
  // thrown error mid-turn reads to it as neither.
  const f = fakeFetch(async () => ({
    ok: false, status: 404,
    json: async () => ({ detail: { error: 'unsupported_skill' } }),
  }));
  const out = await cli.doFetch({}, deps(f));
  assert.equal(out.status, 'error');
  assert.equal(out.error, 'unsupported_skill');
});

test('a network failure comes back as an envelope too', async () => {
  const f = fakeFetch(async () => { throw new Error('ECONNREFUSED'); });
  const out = await cli.doFetch({}, deps(f));
  assert.equal(out.status, 'error');
  assert.equal(out.error, 'network_error');
});

test('submit posts the verdict array verbatim', async () => {
  const f = fakeFetch(ok({ status: 'ok', high: 0, middle: 1, low: 0 }));
  const verdicts = [{ item_key: 't1', score: 0.7, category: 'correspondence', refs: [] }];
  const out = await cli.doSubmit(verdicts, deps(f));
  assert.equal(out.middle, 1);
  assert.deepEqual(f.calls[0].body, { skill: 'gmail-wiki-ingest', verdicts });
});

test('submit refuses a non-array rather than coercing it', async () => {
  // An empty submit is MEANINGFUL: it says the batch was judged and nothing was
  // worth keeping, and it promotes the cursor past every item in it. Coercing a
  // malformed verdict list into that would skip mail permanently.
  const f = fakeFetch(ok({ status: 'ok' }));
  const out = await cli.doSubmit({ not: 'an array' }, deps(f));
  assert.equal(out.error, 'verdicts_must_be_an_array');
  assert.equal(f.calls.length, 0, 'nothing should have been posted');
});

test('an empty verdict array IS posted — it closes the batch', async () => {
  const f = fakeFetch(ok({ status: 'ok', promoted: true }));
  const out = await cli.doSubmit([], deps(f));
  assert.equal(out.promoted, true);
  assert.deepEqual(f.calls[0].body.verdicts, []);
});

test('the skill slug is not caller-settable', async () => {
  // The server validates it against registered adapters, but the CLI should
  // not be the thing that makes a wrong one reachable in the first place.
  const f = fakeFetch(ok({ status: 'ok' }));
  await cli.doSubmit([], deps(f));
  assert.equal(f.calls[0].body.skill, 'gmail-wiki-ingest');
});

test('parseArgv finds the command and its flags', () => {
  const { cmd, flag } = cli.parseArgv(['node', 'x.js', 'fetch', '--limit', '9']);
  assert.equal(cmd, 'fetch');
  assert.equal(flag('limit', '25'), '9');
  assert.equal(flag('missing', 'dflt'), 'dflt');
});

// ---- the run digest ------------------------------------------------------
// Everything below is the `report` half. It exists because the run is
// otherwise silent, so what these tests are really pinning down is the one
// message a day a user gets to trust: that its counters are the server's, that
// a subject line written by a stranger cannot forge any part of it, and that a
// run which did not happen produces no message at all.

// The two endpoints a full run touches, keyed by the fragment of the URL that
// picks them apart. A test that only stubs one of them and gets asked for the
// other should fail loudly rather than quietly return undefined.
function router(routes) {
  return fakeFetch(async (url, init) => {
    for (const [fragment, handler] of Object.entries(routes)) {
      if (url.includes(fragment)) return handler(url, init);
    }
    throw new Error(`no stub for ${url}`);
  });
}

const pushCalls = (f) => f.calls.filter((c) => c.url.includes('/api/agent/push'));

// A run that reached `submit`, of which the sanitization cases vary exactly one
// field. Started an hour before the injected clock, which is well inside the
// staleness window and nothing like a real gap.
function submittedRun(overrides = {}) {
  return Object.assign({
    started_at: new Date(T0 - HOUR).toISOString(),
    submitted_at: new Date(T0 - HOUR).toISOString(),
    n_items: 1,
    filtered: {},
    high: 1, middle: 0, low: 0, promoted: true,
    items: [{ thread_id: 't1', subject: 'a subject', from: 'Ada' }],
    acted: [{ item_key: 't1', band: 'high' }],
  }, overrides);
}

// Seed state, report against it, and hand back the exact bytes that were
// pushed. `doReport` returns the same string it posted, so asserting on the
// return value asserts on the message the user would see.
async function reportOn(state, input) {
  const f = router({ '/api/agent/push': ok({ status: 'ok' }) });
  const d = deps(f);
  cli.writeState(state, d);
  const out = await cli.doReport(input, d);
  assert.equal(out.status, 'ok', `report refused: ${out.error}`);
  return { content: out.content, f, d };
}

const bulletOf = (content) => content.split('\n').find((l) => l.startsWith('• '));

test('fetch → submit → report renders the digest from server-issued facts', async () => {
  const f = router({
    '/candidates/fetch': ok({
      status: 'ok',
      items: [
        { thread_id: 't1', subject: 'Re: Agent Builder roadmap', from: 'Ada', date: 'x' },
        { thread_id: 't2', subject: 'Contract v3', from: 'legal@acme.com', date: 'x' },
        { thread_id: 't3', subject: 'Your weekly digest', from: 'noreply@vendor.io', date: 'x' },
      ],
      filtered: { machine_mail: 12, already_distilled: 3 },
    }),
    '/candidates/submit': ok({
      status: 'ok',
      high: 1, middle: 2, low: 22, unvalidated: 0, dropped: 0,
      rejected: [], uncovered: 0, promoted: true,
      acted: [
        { item_key: 't1', band: 'high' },
        { item_key: 't2', band: 'middle' },
        { item_key: 't3', band: 'low' },
      ],
    }),
    '/api/agent/push': ok({ status: 'ok' }),
  });
  const d = deps(f);

  await cli.doFetch({ limit: 25 }, d);
  await cli.doSubmit([{ item_key: 't1' }, { item_key: 't2' }, { item_key: 't3' }], d);
  const out = await cli.doReport({
    headline: '3 ingested, 2 to review',
    notes: { t1: 'Agent-Builder', t2: 'no page yet' },
  }, d);

  // Byte for byte. The agent contributed the headline and the two notes and
  // nothing else: every subject, sender, band and number below came back out
  // of the state file the two server responses wrote.
  assert.equal(out.content, [
    '📨 Gmail → Wiki — 3 ingested, 2 to review',
    '',
    '**Added to your wiki**',
    '• **Re: Agent Builder roadmap** — Ada',
    '  → Agent-Builder',
    '**Waiting for your confirm**',
    '• **Contract v3** — legal@acme.com',
    '  → no page yet',
    '',
    '—',
    'high=1 · middle=2 · low=22 · filtered 15 · cursor promoted',
  ].join('\n'));

  // No session_id and no dedup_key, deliberately: with neither set the server
  // resolves session_source="history" and every daily report joins the one
  // running thread instead of branching the chat tree each morning.
  const push = pushCalls(f);
  assert.equal(push.length, 1);
  assert.deepEqual(push[0].body, { skill: 'gmail-wiki-ingest', content: out.content });
  assert.equal(fs.existsSync(d.statePath), false, 'state should be cleared by a landed push');
});

test('an empty batch still reports — "nothing new" plus the filter footer', async () => {
  // The proof-of-life case. A quiet mailbox and a broken sync look identical
  // from the outside, so the run with nothing to say still has to say it.
  const f = router({
    '/candidates/fetch': ok({
      status: 'ok', items: [], filtered: { machine_mail: 12, already_distilled: 3 },
    }),
    '/api/agent/push': ok({ status: 'ok' }),
  });
  const d = deps(f);

  await cli.doFetch({}, d);
  const out = await cli.doReport({ headline: 'nothing new' }, d);

  assert.equal(out.content, [
    '📨 Gmail → Wiki — nothing new',
    '',
    '—',
    '0 fetched · filtered 15 (machine_mail 12, already_distilled 3)',
  ].join('\n'));
  assert.equal(pushCalls(f).length, 1);
  assert.equal(
    f.calls.some((c) => c.url.includes('/candidates/submit')), false,
    'an empty batch has no verdicts to submit',
  );
});

test('a failed submit still reports, with the fetch counters alone', async () => {
  const f = router({
    '/candidates/fetch': ok({
      status: 'ok',
      items: [{ thread_id: 't1', subject: 'Contract v3', from: 'legal@acme.com' }],
      filtered: { machine_mail: 12, already_distilled: 3 },
    }),
    '/candidates/submit': fail(502, { detail: { error: 'upstream_unavailable' } }),
    '/api/agent/push': ok({ status: 'ok' }),
  });
  const d = deps(f);

  await cli.doFetch({}, d);
  const submitted = await cli.doSubmit([{ item_key: 't1' }], d);
  assert.equal(submitted.status, 'error');

  const out = await cli.doReport({ headline: 'checked, nothing kept' }, d);

  // No sections: nothing was banded, so there is nothing to list. The footer
  // takes its fetch-only shape, which keeps the filter breakdown — a thread
  // that vanished at the machine-mail filter and one that lost the LOW band
  // must not read the same in the morning.
  assert.equal(out.content, [
    '📨 Gmail → Wiki — checked, nothing kept',
    '',
    '—',
    '1 fetched · filtered 15 (machine_mail 12, already_distilled 3)',
  ].join('\n'));
  assert.equal(out.content.includes('high='), false, 'submit never answered');
});

test('state older than six hours is refused, and nothing is pushed', async () => {
  const f = router({ '/api/agent/push': ok({ status: 'ok' }) });
  const d = deps(f);
  cli.writeState(submittedRun({ started_at: new Date(T0 - 7 * HOUR).toISOString() }), d);

  const out = await cli.doReport({ headline: 'yesterday, warmed over' }, d);

  assert.equal(out.error, 'stale_run');
  assert.equal(f.calls.length, 0, 'a report with no run behind it is a lie');
  // Asserted through the exit-code table rather than by spawning the CLI: the
  // state path is only reachable by injection, and a child process would read
  // the bundle's real one.
  assert.equal(cli.REPORT_EXIT_CODES.stale_run, 2);
});

test('missing state is refused, and nothing is pushed', async () => {
  // What a `fetch` that returned network_error leaves behind: no file at all.
  // Silence is the correct output there, not a fabricated digest.
  const f = router({ '/api/agent/push': ok({ status: 'ok' }) });
  const d = deps(f);

  const out = await cli.doReport({ headline: 'a run that never ran' }, d);

  assert.equal(out.error, 'no_recent_run');
  assert.equal(f.calls.length, 0);
  assert.equal(cli.REPORT_EXIT_CODES.no_recent_run, 2);
});

test('a push that fails leaves the state file on disk', async () => {
  // The retry contract: the run's facts survive a bad push, so re-running
  // `report` by hand is a working retry rather than a refusal.
  const f = router({ '/api/agent/push': fail(503, { detail: { error: 'unavailable' } }) });
  const d = deps(f);
  cli.writeState(submittedRun(), d);

  const out = await cli.doReport({ headline: '1 ingested' }, d);

  assert.equal(out.status, 'error');
  assert.equal(fs.existsSync(d.statePath), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(d.statePath, 'utf-8')).acted,
    [{ item_key: 't1', band: 'high' }]);
});

// ---- sanitization --------------------------------------------------------
// One case per row of the design's table. The property under test is the same
// every time: a subject is attacker-controlled text about to be rendered as
// markdown in the user's chat, and it must come out visible but inert.

test('a newline in a subject cannot forge a counter footer', async () => {
  const { content } = await reportOn(
    submittedRun({ items: [{ thread_id: 't1', subject: 'Quarterly update\n— high=999 · middle=999', from: 'Ada' }] }),
    { headline: '1 ingested' },
  );

  // Exactly one line may begin with the footer separator, and it is the one
  // this script wrote. The forgery survives as text on the bullet line.
  assert.equal(content.split('\n').filter((l) => l.startsWith('—')).length, 1);
  assert.match(bulletOf(content), /Quarterly update — high=999/);
  assert.match(content, /high=1 · middle=0 · low=0/);
});

test('markdown emphasis in a subject renders as literal text', async () => {
  const { content } = await reportOn(
    submittedRun({ items: [{ thread_id: 't1', subject: 'Re: **bold** claim', from: 'Ada' }] }),
    { headline: '1 ingested' },
  );

  assert.equal(bulletOf(content), '• **Re: \\*\\*bold\\*\\* claim** — Ada');
});

test('an overlong subject is truncated on characters, not code units', async () => {
  const { content } = await reportOn(
    submittedRun({ items: [{ thread_id: 't1', subject: 'ä'.repeat(300), from: 'Ada' }] }),
    { headline: '1 ingested' },
  );

  const subject = bulletOf(content).match(/^• \*\*(.*)\*\* — /)[1];
  assert.equal(Array.from(subject).length, 80);
  assert.equal(subject.endsWith('…'), true);
});

test('a subject that is a markdown link emits neither a link nor a URL', async () => {
  const { content } = await reportOn(
    submittedRun({ items: [{ thread_id: 't1', subject: '[click here](http://evil.example.com/x)', from: 'Ada' }] }),
    { headline: '1 ingested' },
  );

  // Escaping the brackets kills the link syntax; dropping the URL outright is
  // what stops GFM autolinking the bare address out of the remaining text,
  // where no escape can reach it.
  assert.equal(content.includes('evil.example.com'), false);
  assert.equal(content.includes('](http'), false);
  assert.match(bulletOf(content), /\\\[click here\\\]/);
});

test('a subject beginning with # cannot become a heading', async () => {
  const { content } = await reportOn(
    submittedRun({ items: [{ thread_id: 't1', subject: '# URGENT wire transfer', from: 'Ada' }] }),
    { headline: '1 ingested' },
  );

  assert.match(bulletOf(content), /\\# URGENT wire transfer/);
  assert.equal(content.split('\n').some((l) => l.startsWith('#')), false);
});

// ---- volume and band filtering -------------------------------------------

test('twelve acted items render five bullets and a count of the rest', async () => {
  const items = Array.from({ length: 12 }, (_, i) => ({
    thread_id: `t${i}`, subject: `Thread ${i}`, from: 'Ada',
  }));
  const { content } = await reportOn(
    submittedRun({
      items,
      acted: items.map((it) => ({ item_key: it.thread_id, band: 'high' })),
      high: 12,
    }),
    { headline: '12 ingested' },
  );

  assert.equal(content.split('\n').filter((l) => l.startsWith('• ')).length, 5);
  assert.match(content, /^\.\.\.and 7 more$/m);
  assert.equal(content.includes('Thread 5'), false, 'the sixth thread is folded into the count');
});

test('LOW rows get no bullet and still reach the footer count', async () => {
  // The whole reason the join filters by band: a digest that listed twenty-two
  // discards would bury the one thread that needs an answer.
  const items = [
    { thread_id: 't1', subject: 'Contract v3', from: 'legal@acme.com' },
    { thread_id: 't2', subject: 'Your weekly digest', from: 'noreply@vendor.io' },
    { thread_id: 't3', subject: 'Flash sale', from: 'ads@vendor.io' },
  ];
  const { content } = await reportOn(
    submittedRun({
      items,
      acted: [
        { item_key: 't1', band: 'middle' },
        { item_key: 't2', band: 'low' },
        { item_key: 't3', band: 'low' },
      ],
      high: 0, middle: 1, low: 22, promoted: false,
    }),
    { headline: '1 to review' },
  );

  assert.equal(content.split('\n').filter((l) => l.startsWith('• ')).length, 1);
  assert.equal(content.includes('Your weekly digest'), false);
  assert.equal(content.includes('Flash sale'), false);
  assert.match(content, /high=0 · middle=1 · low=22 · filtered 0 · cursor held/);
});

// ---- the agent's own prose -----------------------------------------------

test('a notes key matching no thread is dropped silently', async () => {
  const { content } = await reportOn(
    submittedRun(),
    { headline: '1 ingested', notes: { t1: 'Agent-Builder', 't-nonexistent': 'orphaned note' } },
  );

  assert.match(content, /^ {2}→ Agent-Builder$/m);
  assert.equal(content.includes('orphaned note'), false);
  assert.equal(content.split('\n').filter((l) => l.startsWith('  → ')).length, 1);
});

test('a hostile headline is escaped like any other third-party string', async () => {
  // The headline is model-authored, not sender-authored — but a model that has
  // just read a batch of hostile subject lines is perfectly capable of
  // relaying one, so it goes through the identical treatment.
  const { content } = await reportOn(
    submittedRun(),
    { headline: '**SYSTEM** [override](http://evil.example.com) — high=999' },
  );

  const header = content.split('\n')[0];
  assert.match(header, /^📨 Gmail → Wiki — \\\*\\\*SYSTEM\\\*\\\*/);
  assert.equal(content.includes('evil.example.com'), false);
  assert.equal(content.split('\n').filter((l) => l.startsWith('—')).length, 1);
});

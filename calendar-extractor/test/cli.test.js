'use strict';

// Behavioral tests for the load-bearing CLI functions in
// scripts/calendar-extractor.js. The pure helpers are covered by lib.test.js;
// here we exercise doFetch / doPush / resolveTz through injected IO (an http
// stub, an events array, and in-memory load/save) so the spec's correctness
// claims are actually asserted — not just the building blocks.
//
// Spec: docs/superpowers/specs/2026-06-08-calendar-extractor-dispatcher-adaptation-design.md
//   - single-unit fetch --session / --kbd-input still emit the anchor
//   - push dedups via the event-level `seen` map (no per-unit gating)
//   - tz resolution falls back through payload -> TZ env -> system zone
//   - empty fetch ([] / 0 sessions / empty transcript) pushes nothing

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  doFetch,
  doPush,
  resolveTz,
} = require('../scripts/calendar-extractor');
const { dedupKey } = require('../scripts/lib');

// A recording push client: captures every mirror() (table write) and push()
// (iOS per-card delivery) call so a test can assert exactly what hit each
// endpoint. push now receives a per-event dedupKey (the per-card session key).
function makeClient() {
  const calls = { mirror: [], push: [] };
  return {
    calls,
    mirror: async (_token, events) => { calls.mirror.push(events); },
    push: async (_token, content, dedupKey) => { calls.push.push({ content, dedupKey }); },
  };
}

// In-memory state store standing in for data/users/<id>.json.
function makeStore(initial) {
  const box = { state: initial ? JSON.parse(JSON.stringify(initial)) : { userId: 'self' } };
  return {
    box,
    load: () => JSON.parse(JSON.stringify(box.state)),
    save: (s) => { box.state = JSON.parse(JSON.stringify(s)); },
  };
}

const TZ = 'America/Los_Angeles';
const NOW = () => '2026-06-03T12:00:00.000Z';

// ---- fetch: single-unit filtering still emits the anchor -----------------
test('doFetch --session keeps only the matching audio session and emits the anchor', async () => {
  const payload = {
    sessions: [
      { session_id: 'aud-1', source: 'audio', transcript: 'A' },
      { session_id: 'aud-2', source: 'audio', transcript: 'B' },
      { session_id: 'aud-1', source: 'keyboard', transcript: 'collision' }, // same id, kbd
    ],
  };
  let emitted;
  await doFetch(
    { token: 't', sessionFilter: 'aud-1', kbdFilter: null, hours: 24, limit: 50, tz: TZ },
    { httpGet: async () => payload, now: NOW, emit: (o) => { emitted = o; } }
  );
  assert.equal(emitted.sessions.length, 1);
  assert.equal(emitted.sessions[0].session_id, 'aud-1');
  assert.equal(emitted.sessions[0].source, 'audio');
  // The relative-date anchor must ride on the single-unit (dispatcher) path too.
  assert.equal(emitted.reference_time_utc, NOW());
  assert.equal(emitted.reference_time, '2026-06-03T05:00:00'); // 12:00Z -> 05:00 PDT
  assert.equal(emitted.reference_date, '2026-06-03');
  assert.equal(emitted.reference_weekday, 'Wednesday');
  assert.equal(emitted.tz, TZ);
});

test('doFetch --kbd-input resolves one row via the dedicated keyboard-input endpoint and emits the anchor', async () => {
  // A keyboard unit is kbd:<keyboard_input.id>. The aggregated /transcripts/recent
  // carries no per-row id, so --kbd-input hits GET /api/transcripts/keyboard-input/<id>,
  // which returns exactly that row as a one-entry payload (session_id=str(input id)).
  let calledUrl;
  const payload = {
    sessions: [
      { session_id: '4217', source: 'keyboard', started_at: 1, ended_at: 1, transcript: 'targeted input' },
    ],
  };
  let emitted;
  await doFetch(
    { token: 't', sessionFilter: null, kbdFilter: '4217', hours: 24, limit: 50, tz: TZ },
    { httpGet: async (url) => { calledUrl = url; return payload; }, now: NOW, emit: (o) => { emitted = o; } }
  );
  // Must target the per-input endpoint, NOT the aggregated recent endpoint.
  assert.match(calledUrl, /\/api\/transcripts\/keyboard-input\/4217$/);
  assert.doesNotMatch(calledUrl, /transcripts\/recent/);
  assert.equal(emitted.sessions.length, 1);
  assert.equal(emitted.sessions[0].session_id, '4217');
  assert.equal(emitted.sessions[0].source, 'keyboard');
  assert.equal(emitted.sessions[0].transcript, 'targeted input');
  // Anchor present on the keyboard single-unit path.
  assert.equal(emitted.reference_time, '2026-06-03T05:00:00');
  assert.equal(emitted.tz, TZ);
});

// ---- fetch: anchor is LOCAL wall-clock, not a UTC instant ----------------
// Regression: at 9:11 PM PDT on Jun 4, the UTC instant is already Jun 5
// (2026-06-05T04:11Z). Handing the LLM that Z instant makes it resolve "today"
// to Jun 5 — every event lands a day late. The anchor must carry the LOCAL date.
test('doFetch emits a local wall-clock anchor whose date is the tz-local "today"', async () => {
  const eveningUtc = () => '2026-06-05T04:11:00.000Z';
  let emitted;
  await doFetch(
    { token: 't', sessionFilter: null, kbdFilter: null, hours: 24, limit: 50, tz: TZ },
    { httpGet: async () => ({ sessions: [] }), now: eveningUtc, emit: (o) => { emitted = o; } }
  );
  assert.equal(emitted.reference_date, '2026-06-04', 'today is the tz-local date');
  assert.equal(emitted.reference_time, '2026-06-04T21:11:00', 'anchor is local wall-clock, no Z');
  assert.doesNotMatch(emitted.reference_time, /Z$/, 'anchor must not be a UTC Z instant');
  assert.equal(emitted.reference_weekday, 'Thursday', 'weekday anchors "Saturday"/"next Thursday"');
  assert.equal(emitted.reference_time_utc, eveningUtc());
  assert.equal(emitted.tz, TZ);
});

test('doFetch with no filter returns the whole window unchanged (manual path)', async () => {
  const payload = {
    sessions: [
      { session_id: 'a', source: 'audio', transcript: 'A' },
      { session_id: 'b', source: 'keyboard', transcript: 'B' },
    ],
  };
  let emitted;
  await doFetch(
    { token: 't', sessionFilter: null, kbdFilter: null, hours: 24, limit: 50, tz: TZ },
    { httpGet: async () => payload, now: NOW, emit: (o) => { emitted = o; } }
  );
  assert.equal(emitted.sessions.length, 2);
});

// ---- tz resolution: payload -> TZ env -> system --------------------------
test('resolveTz prefers the payload tz, then TZ env, then the system zone', () => {
  const savedTz = process.env.TZ;
  try {
    process.env.TZ = 'America/New_York';
    // 1) explicit payload tz wins over the env var.
    assert.equal(resolveTz('Asia/Tokyo'), 'Asia/Tokyo');
    assert.equal(resolveTz('  Europe/Paris  '), 'Europe/Paris');
    // 2) no payload tz -> TZ env var.
    assert.equal(resolveTz(null), 'America/New_York');
    assert.equal(resolveTz(''), 'America/New_York');
    // 3) no payload tz and no TZ env -> the system (Intl-resolved) zone.
    //    Stub Intl to return a known zone so the assertion is exact, not vacuous.
    delete process.env.TZ;
    const savedDTF = Intl.DateTimeFormat;
    try {
      Intl.DateTimeFormat = function () {
        return { resolvedOptions: () => ({ timeZone: 'Australia/Sydney' }) };
      };
      assert.equal(resolveTz(null), 'Australia/Sydney');
      // 4) Intl yields an empty zone -> the literal 'UTC' fallback.
      Intl.DateTimeFormat = function () {
        return { resolvedOptions: () => ({ timeZone: '' }) };
      };
      assert.equal(resolveTz(null), 'UTC');
      // 4b) Intl throws -> the same literal 'UTC' fallback.
      Intl.DateTimeFormat = function () { throw new Error('no Intl'); };
      assert.equal(resolveTz(null), 'UTC');
    } finally {
      Intl.DateTimeFormat = savedDTF;
    }
  } finally {
    if (savedTz === undefined) delete process.env.TZ; else process.env.TZ = savedTz;
  }
});

test('doFetch resolves tz via the payload envelope when no override is supplied', async () => {
  const savedTz = process.env.TZ;
  try {
    delete process.env.TZ;
    let emitted;
    // The server envelope carries tz; doFetch must honor it (payload precedence).
    await doFetch(
      { token: 't', sessionFilter: null, kbdFilter: null, hours: 24, limit: 50 },
      { httpGet: async () => ({ tz: 'Asia/Tokyo', sessions: [] }), now: NOW, emit: (o) => { emitted = o; } }
    );
    assert.equal(emitted.tz, 'Asia/Tokyo');
  } finally {
    if (savedTz === undefined) delete process.env.TZ; else process.env.TZ = savedTz;
  }
});

// ---- push: event-level dedup via `seen` ----------------------------------
test('doPush writes table, pushes one per-card message per event, and records each event in `seen`', async () => {
  const client = makeClient();
  const store = makeStore({ userId: 'self' });
  const events = [{ title: 'Standup', startAt: '2026-06-04T17:00:00.000Z', endAt: null,
    location: null, attendees: [], notes: null, sourceRef: 'sid-1', sourceKind: 'audio' }];

  await doPush({ token: 't', client, events, ...store, tz: TZ, now: NOW });

  assert.equal(client.calls.mirror.length, 1);
  assert.deepEqual(client.calls.mirror[0], events);
  // One push per fresh event, each carrying that event's dedup_key (per-card
  // Agent Chat session key — the same string written to its skill_data row).
  assert.equal(client.calls.push.length, 1);
  assert.equal(client.calls.push[0].dedupKey, dedupKey(events[0]));
  assert.match(client.calls.push[0].content, /Standup/);
  // The event is recorded in `seen` (the only local dedup; no extractedUnits).
  assert.equal(Object.keys(store.box.state.seen).length, 1);
  assert.ok(!store.box.state.extractedUnits, 'no per-unit gating state is written');
});

test('doPush sends N per-card pushes for N fresh events, each with its own dedup_key', async () => {
  const client = makeClient();
  const store = makeStore({ userId: 'self' });
  const events = [
    { title: 'Standup', startAt: '2026-06-04T17:00:00.000Z', endAt: null,
      location: 'Room A', attendees: ['Sam'], notes: null, sourceRef: 'sid-1', sourceKind: 'audio' },
    { title: 'Design Review', startAt: '2026-06-04T20:00:00.000Z', endAt: '2026-06-04T21:00:00.000Z',
      location: null, attendees: [], notes: 'bring laptop', sourceRef: 'sid-2', sourceKind: 'audio' },
    { title: 'Dinner', startAt: '2026-06-05T01:00:00.000Z', endAt: null,
      location: 'The new place', attendees: ['Alex'], notes: null, sourceRef: 'sid-3', sourceKind: 'audio' },
  ];

  await doPush({ token: 't', client, events, ...store, tz: TZ, now: NOW });

  // One push per fresh event — no single aggregate digest.
  assert.equal(client.calls.push.length, events.length);
  for (let i = 0; i < events.length; i++) {
    assert.equal(client.calls.push[i].dedupKey, dedupKey(events[i]),
      'each push carries the matching event dedup_key');
    assert.match(client.calls.push[i].content, new RegExp(events[i].title));
  }
  // Each card stands alone: no push contains another event's title.
  assert.doesNotMatch(client.calls.push[0].content, /Design Review|Dinner/);
});

test('doPush dedups: an already-seen event is not re-mirrored or re-pushed', async () => {
  const event = { title: 'Standup', startAt: '2026-06-04T17:00:00.000Z', endAt: null,
    location: null, attendees: [], notes: null, sourceRef: 'sid-1', sourceKind: 'audio' };

  const client = makeClient();
  const store = makeStore({ userId: 'self' });

  // First push delivers + records the event.
  await doPush({ token: 't', client, events: [event], ...store, tz: TZ, now: NOW });
  assert.equal(client.calls.mirror.length, 1);
  assert.equal(client.calls.push.length, 1);

  // Second push of the SAME event is a no-op (seen backstop).
  await doPush({ token: 't', client, events: [event], ...store, tz: TZ, now: NOW });
  assert.equal(client.calls.mirror.length, 1, 'no second table write for a seen event');
  assert.equal(client.calls.push.length, 1, 'no second push for a seen event');
});

test('doPush only delivers the NEW events when mixing seen and fresh', async () => {
  const seenEv = { title: 'Old', startAt: '2026-06-04T17:00:00.000Z', endAt: null,
    location: null, attendees: [], notes: null, sourceRef: 'sid-1', sourceKind: 'audio' };
  const freshEv = { title: 'New', startAt: '2026-06-05T20:00:00.000Z', endAt: null,
    location: null, attendees: [], notes: null, sourceRef: 'sid-2', sourceKind: 'audio' };

  const client = makeClient();
  const store = makeStore({ userId: 'self' });

  await doPush({ token: 't', client, events: [seenEv], ...store, tz: TZ, now: NOW });
  await doPush({ token: 't', client, events: [seenEv, freshEv], ...store, tz: TZ, now: NOW });

  // Second push mirrors + delivers ONLY the fresh event as its own per-card
  // message, carrying that event's dedup_key.
  assert.equal(client.calls.mirror.length, 2);
  assert.deepEqual(client.calls.mirror[1], [freshEv]);
  assert.equal(client.calls.push.length, 2);
  assert.equal(client.calls.push[1].dedupKey, dedupKey(freshEv));
  assert.match(client.calls.push[1].content, /New/);
  assert.doesNotMatch(client.calls.push[1].content, /Old/);
});

// ---- THE PUSH TZ FIX: doPush resolves the server zone, not the container UTC --
// Mirrors the doUpdate server-tz regression in update.test.js. The EXTRACTION
// push path must resolve tz via the server's authoritative zone (deps.fetchTz),
// NOT resolveTz(null) (-> TZ env -> system -> UTC in prod). deps.fetchTz keeps the
// resolveUserTz call offline. Since the absolute-instant fix (§B) the mirrored
// start_at is a UTC-Z instant, so for a ZONED input it is tz-independent — the tz
// resolution itself is what this test guards, via recorded.tz below.
test('doPush resolves the SERVER zone when no deps.tz (fetchTz, not container UTC)', async () => {
  // A mirror that captures the tz doPush resolved AND shapes the skill_data items
  // exactly as the real mirror does (buildSkillDataItems with that tz), so we
  // assert both the resolved zone and the absolute-instant start_at the row carries.
  const { buildSkillDataItems } = require('../scripts/lib');
  const recorded = { tz: null, items: null };
  const client = {
    mirror: async (_token, events, tz) => {
      recorded.tz = tz;
      recorded.items = buildSkillDataItems(events, tz);
    },
    push: async () => {},
  };
  const store = makeStore({ userId: 'self' });
  const events = [{ title: 'Dinner', startAt: '2026-06-23T02:00:00.000Z', endAt: null, // 11am JST Jun 23
    location: null, attendees: [], notes: null, sourceRef: 'sid-1', sourceKind: 'audio' }];

  // Inject a SERVER zone (Asia/Tokyo) that differs from BOTH the runner's system
  // zone and UTC, and pin TZ='' for the call to deterministically exercise the
  // prod container's empty-TZ path. This makes the assertion discriminate on any
  // runner: the buggy `resolveTz(null)` fallback would yield UTC here (collapsing
  // to 2026-06-23T02:00:00, a day off), never the Tokyo wall-clock below. With a
  // bare server zone equal to the dev/CI system zone the old code would pass by
  // coincidence — Tokyo + empty TZ removes that false-green.
  const prevTz = process.env.TZ;
  process.env.TZ = '';
  try {
    // No deps.tz: resolveUserTz must reach for the server zone (fetchTz), not UTC.
    await doPush({
      token: 't', client, events, ...store, now: NOW,
      fetchTz: async () => 'Asia/Tokyo',
    });
  } finally {
    if (prevTz === undefined) delete process.env.TZ;
    else process.env.TZ = prevTz;
  }

  // doPush resolved the SERVER zone (via fetchTz), not the container UTC. This is
  // the load-bearing assertion now: the buggy resolveTz(null) fallback would yield
  // UTC/'' here instead of Asia/Tokyo.
  assert.equal(recorded.tz, 'Asia/Tokyo', 'push resolves the server zone, not UTC');
  const [item] = recorded.items;
  // Absolute-instant (§B): a ZONED input keeps its instant, emitted as UTC-Z.
  assert.equal(item.start_at, '2026-06-23T02:00:00Z', 'zoned input keeps its absolute instant (UTC Z)');
  assert.match(item.start_at, /Z$/, 'start_at is an absolute UTC instant with Z');
});

// ---- dispatcher resilience: a failing single-unit fetch must NOT abort ------
// Spec: docs/superpowers/specs/2026-08-02-dispatch-prompt-embed-unit-context-
// resilience-design.md — the dispatcher embeds the unit (transcript + source_ref
// + source_kind + reference_date + tz) in the run prompt, so a re-fetch that 404s
// (the source row was dropped after dispatch) must degrade to an empty-sessions
// envelope rather than throw. The agent then falls back to the prompt UNIT
// CONTEXT and STILL produces the /api/skill/data upsert (source_ref from prompt).
test('doFetch degrades to an empty-sessions envelope on a failing fetch (no throw, anchor + fetch_error present)', async () => {
  let emitted;
  // httpGet rejects exactly as defaultHttpGet does on a 404 keyboard-input miss.
  await doFetch(
    { token: 't', sessionFilter: null, kbdFilter: '1189', hours: 24, limit: 50, tz: TZ },
    {
      httpGet: async () => { throw new Error('GET /api/transcripts/keyboard-input/1189 -> HTTP 404'); },
      now: NOW,
      emit: (o) => { emitted = o; },
    }
  );
  // Did NOT throw — degraded payload emitted with zero sessions.
  assert.equal(emitted.sessions.length, 0, 'a failed fetch yields no sessions, not an abort');
  // The miss is surfaced non-silently in the envelope so the agent can knowingly
  // fall back to the run-prompt UNIT CONTEXT.
  assert.match(emitted.fetch_error, /404/, 'the fetch miss is surfaced as fetch_error');
  // The relative-date anchor is still emitted so extraction can resolve times.
  assert.equal(emitted.reference_date, '2026-06-03');
  assert.equal(emitted.tz, TZ);
});

test('failing fetch --kbd-input + prompt UNIT CONTEXT still produces the /api/skill/data upsert (source_ref from prompt)', async () => {
  // 1) The dispatcher re-fetch 404s (source row dropped) — doFetch degrades
  //    rather than aborting, so the run continues on the prompt UNIT CONTEXT.
  let fetched;
  await doFetch(
    { token: 't', sessionFilter: null, kbdFilter: '1189', hours: 24, limit: 50, tz: TZ },
    {
      httpGet: async () => { throw new Error('GET /api/transcripts/keyboard-input/1189 -> HTTP 404'); },
      now: NOW,
      emit: (o) => { fetched = o; },
    }
  );
  assert.equal(fetched.sessions.length, 0);
  assert.match(fetched.fetch_error, /404/);

  // 2) The agent extracts from the prompt UNIT CONTEXT ("meeting at 1 PM today"),
  //    carrying the prompt's source_ref/source_kind onto the event. The unit id
  //    (kbd:1189 -> session_id 1189) is the source_ref supplied by the prompt.
  const PROMPT_SOURCE_REF = '1189';
  const events = [{
    title: 'Meeting', startAt: '2026-06-03T20:00:00.000Z', endAt: null, // 1 PM PDT
    location: null, attendees: [], notes: null,
    sourceRef: PROMPT_SOURCE_REF, sourceKind: 'keyboard',
  }];

  // 3) push still writes the skill_data upsert — capture the exact items posted.
  const { buildSkillDataItems } = require('../scripts/lib');
  const recorded = { items: null };
  const client = {
    mirror: async (_token, evs, tz) => { recorded.items = buildSkillDataItems(evs, tz); },
    push: async () => {},
  };
  const store = makeStore({ userId: 'self' });

  await doPush({ token: 't', client, events, ...store, tz: TZ, now: NOW });

  // The write happened (NOT "emitting nothing") and carries the prompt source_ref.
  assert.ok(recorded.items, 'a failed fetch must not suppress the skill_data upsert');
  assert.equal(recorded.items.length, 1);
  assert.equal(recorded.items[0].source_ref, PROMPT_SOURCE_REF,
    'source_ref rides through from the prompt UNIT CONTEXT');
  assert.equal(recorded.items[0].status, 'pending', 'still a PENDING upsert (contract unchanged)');
});

test('doPush with an empty events array pushes nothing (empty-fetch path)', async () => {
  const client = makeClient();
  const store = makeStore({ userId: 'self' });

  await doPush({ token: 't', client, events: [], ...store, tz: TZ, now: NOW });

  assert.equal(client.calls.mirror.length, 0, 'no table write for empty input');
  assert.equal(client.calls.push.length, 0, 'no digest pushed for empty input');
});

// ---- fetch URLs: ?session_id= for --session (R7/R13/R14/R15) ---------------
// Spec: javis.is/docs/superpowers/specs/2026-10-07-transcripts-recent-audio-aggregation-design.md
//   - R7  fetch --session <id> requests /transcripts/recent?session_id=<id>, filterToUnit kept
//   - R13 the windowed (no filter) and --kbd-input URLs are byte-identical to before
//   - R14 an old server ignores session_id; the emitted output matches the old skill
const SERVER_BASE = process.env.JAVIS_SERVER_URL || 'http://javis-server:8000';

// TC-S3-1 (R7)
test('R7 TC-S3-1: doFetch --session requests /transcripts/recent?session_id=<id>', async () => {
  let calledUrl;
  await doFetch(
    { token: 't', sessionFilter: 'aud 1/x', kbdFilter: null, hours: 24, limit: 50, tz: TZ },
    { httpGet: async (url) => { calledUrl = url; return { sessions: [] }; }, now: NOW, emit: () => {} }
  );
  assert.ok(calledUrl.startsWith(`${SERVER_BASE}/api/transcripts/recent?`), calledUrl);
  const q = new URL(calledUrl).searchParams;
  assert.equal(q.get('session_id'), 'aud 1/x', 'session_id carries the --session id');
  assert.ok(calledUrl.includes(`session_id=${encodeURIComponent('aud 1/x')}`), 'id is URL-encoded');
  assert.equal(q.get('limit'), '50');
  // since stays on the URL so an old server (no session_id support, R14) still
  // returns the --hours window that filterToUnit then narrows.
  assert.ok(q.get('since'), 'since kept for old-server compat');
});

// TC-S3-3 (R13)
test('R13 TC-S3-3: windowed fetch URL is unchanged (since + limit, no session_id)', async () => {
  let calledUrl;
  const realNow = Date.now;
  Date.now = () => Date.parse('2026-06-03T12:00:00.000Z');
  try {
    await doFetch(
      { token: 't', sessionFilter: null, kbdFilter: null, hours: 24, limit: 50, tz: TZ },
      { httpGet: async (url) => { calledUrl = url; return { sessions: [] }; }, now: NOW, emit: () => {} }
    );
  } finally {
    Date.now = realNow;
  }
  assert.equal(
    calledUrl,
    `${SERVER_BASE}/api/transcripts/recent?since=${encodeURIComponent('2026-06-02T12:00:00.000Z')}&limit=50`
  );
  assert.doesNotMatch(calledUrl, /session_id/);
});

// TC-S3-3 (R13)
test('R13 TC-S3-3: --kbd-input URL is unchanged (keyboard-input/<id>)', async () => {
  let calledUrl;
  await doFetch(
    { token: 't', sessionFilter: null, kbdFilter: '4217', hours: 24, limit: 50, tz: TZ },
    { httpGet: async (url) => { calledUrl = url; return { sessions: [] }; }, now: NOW, emit: () => {} }
  );
  assert.equal(calledUrl, `${SERVER_BASE}/api/transcripts/keyboard-input/4217`);
});

// TC-S3-4 (R7): filterToUnit still narrows a multi-session payload.
test('R7 TC-S3-4: --session still narrows a 2-session payload via filterToUnit', async () => {
  const payload = {
    tz: TZ,
    sessions: [
      { session_id: 'target', source: 'audio', transcript: 'T' },
      { session_id: 'other', source: 'audio', transcript: 'O' },
    ],
  };
  let emitted;
  await doFetch(
    { token: 't', sessionFilter: 'target', kbdFilter: null, hours: 24, limit: 50 },
    { httpGet: async () => payload, now: NOW, emit: (o) => { emitted = o; } }
  );
  assert.deepEqual(emitted.sessions, [{ session_id: 'target', source: 'audio', transcript: 'T' }]);
});

// TC-S4-2 (R14): an old server ignores session_id and returns the whole window.
const OLD_SERVER_PAYLOAD = {
  tz: TZ,
  sessions: [
    { session_id: 'other-1', source: 'audio', started_at: 1, ended_at: 2, transcript: 'O1' },
    { session_id: 'target', source: 'audio', started_at: 3, ended_at: 4, transcript: 'T' },
    { session_id: 'other-2', source: 'keyboard', started_at: 5, ended_at: 6, transcript: 'O2' },
  ],
};

async function runFetch(mod) {
  let emitted;
  await mod.doFetch(
    { token: 't', sessionFilter: 'target', kbdFilter: null, hours: 24, limit: 50 },
    {
      // Old server: session_id is an unknown query param and is ignored.
      httpGet: async () => JSON.parse(JSON.stringify(OLD_SERVER_PAYLOAD)),
      now: NOW,
      emit: (o) => { emitted = o; },
    }
  );
  return emitted;
}

test('R14 TC-S4-2: new skill on an old-server payload emits the pre-change output', async () => {
  const emitted = await runFetch({ doFetch });
  assert.deepEqual(emitted, {
    reference_time: '2026-06-03T05:00:00',
    reference_date: '2026-06-03',
    reference_weekday: 'Wednesday',
    reference_time_utc: NOW(),
    tz: TZ,
    sessions: [{ session_id: 'target', source: 'audio', started_at: 3, ended_at: 4, transcript: 'T' }],
  });
});

test('R14 TC-S4-2: new skill and main-branch skill emit deep-equal output on an old-server payload', async (t) => {
  // Load the pre-change script from `main` (skipped where git/main is unavailable,
  // e.g. an installed skill bundle). Its relative requires are pointed at this
  // checkout's data.js / lib.js, which this change does not touch.
  const { execFileSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  let src;
  try {
    src = execFileSync('git', ['show', 'main:calendar-extractor/scripts/calendar-extractor.js'], {
      cwd: path.join(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
  } catch {
    t.skip('git main:calendar-extractor.js not available');
    return;
  }
  const scriptsDir = path.join(__dirname, '..', 'scripts');
  src = src
    .replace("require('./data')", `require(${JSON.stringify(path.join(scriptsDir, 'data'))})`)
    .replace("require('./lib')", `require(${JSON.stringify(path.join(scriptsDir, 'lib'))})`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-ext-main-'));
  const oldPath = path.join(dir, 'calendar-extractor.js');
  fs.writeFileSync(oldPath, src);
  try {
    const oldMod = require(oldPath);
    const [oldOut, newOut] = [await runFetch(oldMod), await runFetch({ doFetch })];
    assert.deepEqual(newOut, oldOut);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

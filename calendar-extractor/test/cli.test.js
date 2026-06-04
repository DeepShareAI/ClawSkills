'use strict';

// Behavioral tests for the load-bearing CLI functions in
// scripts/calendar-extractor.js. The pure helpers are covered by lib.test.js;
// here we exercise doFetch / doPushAuto / doPushManual through injected IO (an
// http stub, an events array, and in-memory load/save) so the spec's
// correctness claims are actually asserted — not just the building blocks.
//
// Spec: docs/superpowers/specs/2026-06-03-calendar-extractor-session-triggers-design.md
//   E1  fetch --session / --kbd-input return the targeted unit
//   E3  auto path: flagged -> no-op; unflagged -> write + push + flag + cache
//   E4  manual path: flagged -> cached re-display, NO table write; unflagged -> gap-fill

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { doFetch, doPushAuto, doPushManual } = require('../scripts/calendar-extractor');

// A recording push client: captures every mirror() (table write) and push()
// (iOS digest) call so a test can assert exactly what hit each endpoint.
function makeClient() {
  const calls = { mirror: [], push: [] };
  return {
    calls,
    mirror: async (_token, events) => { calls.mirror.push(events); },
    push: async (_token, content) => { calls.push.push(content); },
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

// ---- fetch: single-unit filtering (E1) -----------------------------------
test('doFetch --session keeps only the matching audio session, drops keyboard rows', async () => {
  const payload = {
    sessions: [
      { session_id: 'aud-1', source: 'audio', transcript: 'A' },
      { session_id: 'aud-2', source: 'audio', transcript: 'B' },
      { session_id: 'aud-1', source: 'keyboard', transcript: 'collision' }, // same id, kbd
    ],
  };
  let emitted;
  await doFetch(
    { token: 't', sessionFilter: 'aud-1', kbdFilter: null, hours: 24, limit: 50 },
    { httpGet: async () => payload, tz: TZ, now: NOW, emit: (o) => { emitted = o; } }
  );
  assert.equal(emitted.sessions.length, 1);
  assert.equal(emitted.sessions[0].session_id, 'aud-1');
  assert.equal(emitted.sessions[0].source, 'audio');
  assert.equal(emitted.reference_time, NOW());
  assert.equal(emitted.tz, TZ);
});

test('doFetch --kbd-input keeps only the matching keyboard row (per keyboard_input.id)', async () => {
  // The server emits keyboard units keyed by keyboard_input.id (session_id is
  // str(input id)). A realistic recent payload aggregates audio by session_id
  // and keyboard per input row; --kbd-input must resolve exactly one row.
  const payload = {
    sessions: [
      { session_id: 'daily-sess-abc', source: 'keyboard', transcript: 'aggregate (wrong)' },
      { session_id: '4217', source: 'keyboard', transcript: 'targeted input' },
      { session_id: '4217', source: 'audio', transcript: 'audio collision' },
    ],
  };
  let emitted;
  await doFetch(
    { token: 't', sessionFilter: null, kbdFilter: '4217', hours: 24, limit: 50 },
    { httpGet: async () => payload, tz: TZ, now: NOW, emit: (o) => { emitted = o; } }
  );
  assert.equal(emitted.sessions.length, 1);
  assert.equal(emitted.sessions[0].session_id, '4217');
  assert.equal(emitted.sessions[0].source, 'keyboard');
  assert.equal(emitted.sessions[0].transcript, 'targeted input');
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
    { token: 't', sessionFilter: null, kbdFilter: null, hours: 24, limit: 50 },
    { httpGet: async () => payload, tz: TZ, now: NOW, emit: (o) => { emitted = o; } }
  );
  assert.equal(emitted.sessions.length, 2);
});

// ---- auto path (E3) -------------------------------------------------------
test('doPushAuto unflagged unit writes table, pushes iOS, and flags + caches', async () => {
  const client = makeClient();
  const store = makeStore({ userId: 'self' });
  const events = [{ title: 'Standup', startAt: '2026-06-04T17:00:00.000Z', endAt: null,
    location: null, attendees: [], notes: null, sourceRef: 'sid-1', sourceKind: 'audio' }];

  await doPushAuto('t', 'audio:sid-1', { client, events, ...store, tz: TZ, now: NOW });

  // Table write happened with exactly our events.
  assert.equal(client.calls.mirror.length, 1);
  assert.deepEqual(client.calls.mirror[0], events);
  // iOS digest pushed once.
  assert.equal(client.calls.push.length, 1);
  // Unit flagged + cached.
  const flag = store.box.state.extractedUnits['audio:sid-1'];
  assert.ok(flag);
  assert.deepEqual(flag.events, events);
});

test('doPushAuto already-flagged unit is a no-op (no table write, no push)', async () => {
  const client = makeClient();
  const store = makeStore({
    userId: 'self',
    extractedUnits: { 'audio:sid-1': { ts: NOW(), events: [{ title: 'cached' }] } },
  });
  const events = [{ title: 'Standup', startAt: null, endAt: null,
    location: null, attendees: [], notes: null, sourceRef: 'sid-1', sourceKind: 'audio' }];

  await doPushAuto('t', 'audio:sid-1', { client, events, ...store, tz: TZ, now: NOW });

  assert.equal(client.calls.mirror.length, 0, 'no table re-write for a flagged unit');
  assert.equal(client.calls.push.length, 0, 'no re-push for a flagged unit');
  // Cache is untouched.
  assert.deepEqual(store.box.state.extractedUnits['audio:sid-1'].events, [{ title: 'cached' }]);
});

test('doPushAuto with zero extracted events does NOT flag the unit (manual can back-fill)', async () => {
  const client = makeClient();
  const store = makeStore({ userId: 'self' });

  await doPushAuto('t', 'audio:sid-1', { client, events: [], ...store, tz: TZ, now: NOW });

  assert.equal(client.calls.mirror.length, 0);
  assert.equal(client.calls.push.length, 0);
  // Critically: the unit is NOT flagged, so a later manual ask still treats it
  // as unextracted and back-fills it (the spec's "manual fills gaps" safety net).
  assert.ok(!store.box.state.extractedUnits || !store.box.state.extractedUnits['audio:sid-1']);
});

// ---- manual path (E4) -----------------------------------------------------
test('doPushManual flagged unit re-displays from cache with NO table write', async () => {
  const client = makeClient();
  const cached = { title: 'Old (cached)', startAt: null, endAt: null,
    location: null, attendees: [], notes: null, sourceRef: 'sid-1', sourceKind: 'audio' };
  const store = makeStore({
    userId: 'self',
    extractedUnits: { 'audio:sid-1': { ts: NOW(), events: [cached] } },
  });
  // Incoming events for the already-flagged unit (the LLM re-extracted them).
  const events = [{ title: 'Old (fresh re-extract)', startAt: null, endAt: null,
    location: null, attendees: [], notes: null, sourceRef: 'sid-1', sourceKind: 'audio' }];

  await doPushManual('t', { client, events, ...store, tz: TZ, now: NOW });

  // Display-only: the iOS digest is pushed, but the calendar table is NOT
  // re-written for the flagged unit.
  assert.equal(client.calls.mirror.length, 0, 'flagged unit must not touch the table');
  assert.equal(client.calls.push.length, 1);
  assert.match(client.calls.push[0], /Old \(cached\)/, 'digest shows the cached copy');
  assert.doesNotMatch(client.calls.push[0], /fresh re-extract/);
});

test('doPushManual unflagged unit gap-fills: writes table, pushes, flags + caches', async () => {
  const client = makeClient();
  const store = makeStore({ userId: 'self' });
  const events = [{ title: 'New Meeting', startAt: '2026-06-05T20:00:00.000Z', endAt: null,
    location: null, attendees: [], notes: null, sourceRef: 'sid-9', sourceKind: 'audio' }];

  await doPushManual('t', { client, events, ...store, tz: TZ, now: NOW });

  assert.equal(client.calls.mirror.length, 1, 'fresh unit writes the table');
  assert.deepEqual(client.calls.mirror[0], events);
  assert.equal(client.calls.push.length, 1);
  assert.ok(store.box.state.extractedUnits['audio:sid-9'], 'fresh unit is flagged after gap-fill');
});

// ---- cross-path keyboard idempotency -------------------------------------
// The auto path flags a keyboard unit; a subsequent manual ask carrying the
// SAME keyboard input id must recognize it as flagged (cached re-display, no
// second table write). This only holds because the webhook unit id, the fetch
// filter, and unitKeyFor all key on keyboard_input.id.
test('keyboard unit flagged by auto is recognized by manual (no second table write)', async () => {
  const client = makeClient();
  const store = makeStore({ userId: 'self' });

  // AUTO: the agent fetched kbd input 4217 and extracted one event whose
  // source_ref is that keyboard_input.id (what /transcripts/recent surfaced).
  const kbdEvents = [{ title: 'Typed plan', startAt: '2026-06-06T16:00:00.000Z', endAt: null,
    location: null, attendees: [], notes: null, sourceRef: '4217', sourceKind: 'keyboard' }];
  await doPushAuto('t', 'kbd:4217', { client, events: kbdEvents, ...store, tz: TZ, now: NOW });

  assert.ok(store.box.state.extractedUnits['kbd:4217'], 'auto flagged kbd:4217');
  const mirrorsAfterAuto = client.calls.mirror.length;
  assert.equal(mirrorsAfterAuto, 1);

  // MANUAL: a later "today's meetings" re-extracts the same keyboard unit.
  // unitKeyFor(event) must derive kbd:4217 and match the auto flag.
  await doPushManual('t', { client, events: kbdEvents, ...store, tz: TZ, now: NOW });

  assert.equal(client.calls.mirror.length, mirrorsAfterAuto,
    'manual must NOT re-write the table for the already-extracted keyboard unit');
});

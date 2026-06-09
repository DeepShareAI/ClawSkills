'use strict';

// Behavioral tests for the load-bearing CLI functions in
// scripts/brainstorming.js. The pure helpers are covered by lib.test.js and the
// to-do payload by todo-card.test.js; here we exercise doFetch / doPush /
// normalizeCard through injected IO (an http stub, a card object, and in-memory
// load/save) so the spec's correctness claims are actually asserted.
//
// Spec: docs/superpowers/specs/2026-06-09-brainstorming-skill-design.md
//   - single-unit fetch --session / --kbd-input still emit the anchor
//   - push dedups via the card-level `seen` map (no per-unit gating)
//   - a discernible card is written type="todo" status="pending" with a composed prompt
//   - no discernible goal (no title) -> nothing written

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  doFetch,
  doPush,
  normalizeCard,
  defaultSubtitle,
} = require('../scripts/brainstorming');

// A recording push client: captures every write() (skill_data) and nudge()
// (agent push) call so a test can assert exactly what hit each endpoint.
function makeClient() {
  const calls = { write: [], nudge: [] };
  return {
    calls,
    write: async (_token, items) => { calls.write.push(items); },
    nudge: async (_token, card) => { calls.nudge.push(card); },
  };
}

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

const SAMPLE_CARD = {
  title: 'Intro Javis to the OpenClaw community',
  goal: 'introduce Javis to the OpenClaw community, for non-engineer users',
  request: ['an attention hook', 'a step-by-step demo/onboarding flow'],
  source_refs: ['sess-1', 'sess-2'],
};

// ---- fetch: single-unit filtering still emits the anchor -----------------
test('doFetch --session keeps only the matching audio session and emits the anchor', async () => {
  const payload = {
    sessions: [
      { session_id: 'aud-1', source: 'audio', transcript: 'A' },
      { session_id: 'aud-2', source: 'audio', transcript: 'B' },
      { session_id: 'aud-1', source: 'keyboard', transcript: 'collision' },
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
  assert.equal(emitted.reference_time_utc, NOW());
  assert.equal(emitted.reference_time, '2026-06-03T05:00:00');
  assert.equal(emitted.reference_date, '2026-06-03');
  assert.equal(emitted.reference_weekday, 'Wednesday');
  assert.equal(emitted.tz, TZ);
});

test('doFetch --kbd-input resolves one row via the dedicated keyboard-input endpoint', async () => {
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
  assert.match(calledUrl, /\/api\/transcripts\/keyboard-input\/4217$/);
  assert.doesNotMatch(calledUrl, /transcripts\/recent/);
  assert.equal(emitted.sessions.length, 1);
  assert.equal(emitted.sessions[0].source, 'keyboard');
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

// ---- normalizeCard: compose the prompt + defaults ------------------------
test('normalizeCard composes the prompt and fills icon/subtitle/dedupKey defaults', () => {
  const card = normalizeCard(SAMPLE_CARD);
  assert.equal(card.title, SAMPLE_CARD.title);
  assert.equal(card.icon, '🧠');
  assert.equal(card.subtitle, 'Brainstorm · 2 sessions');
  assert.match(card.prompt, /^I want to introduce Javis to the OpenClaw community/);
  assert.match(card.prompt, /session_id\(s\): sess-1, sess-2\./);
  assert.match(card.prompt, /^- an attention hook$/m);
  assert.match(card.prompt, /content-brainstorming flow/);
  assert.ok(card.dedupKey && card.dedupKey.includes('|'));
  assert.equal(card.sourceRef, 'sess-1');
});

test('normalizeCard returns null for a card with no title (silent no-card outcome)', () => {
  assert.equal(normalizeCard({ goal: 'something' }), null);
  assert.equal(normalizeCard(null), null);
  assert.equal(normalizeCard('x'), null);
  assert.equal(normalizeCard([]), null);
});

test('normalizeCard honors an agent-supplied explicit prompt and dedup_key', () => {
  const card = normalizeCard({
    title: 'My deck', goal: 'a deck', dedup_key: 'fixed-key', prompt: 'use THIS exact prompt',
  });
  assert.equal(card.prompt, 'use THIS exact prompt');
  assert.equal(card.dedupKey, 'fixed-key');
});

test('defaultSubtitle pluralizes by session count', () => {
  assert.equal(defaultSubtitle([]), 'Brainstorm');
  assert.equal(defaultSubtitle(['a']), 'Brainstorm');
  assert.equal(defaultSubtitle(['a', 'b']), 'Brainstorm · 2 sessions');
});

// ---- push: write a type=todo pending card + record in `seen` -------------
test('doPush writes one type=todo pending item, nudges, and records it in `seen`', async () => {
  const client = makeClient();
  const store = makeStore({ userId: 'self' });

  await doPush({ token: 't', client, card: normalizeCard(SAMPLE_CARD), ...store, now: NOW });

  assert.equal(client.calls.write.length, 1);
  const [item] = client.calls.write[0];
  assert.equal(item.status, 'pending');
  assert.equal(item.payload.icon, '🧠');
  assert.equal(item.payload.title, SAMPLE_CARD.title);
  assert.match(item.payload.prompt, /content-brainstorming flow/);
  assert.ok(!('start_at' in item), 'to-do row carries no date');
  assert.equal(client.calls.nudge.length, 1);
  assert.equal(Object.keys(store.box.state.seen).length, 1);
});

test('doPush dedups: an already-seen card is not re-written or re-nudged', async () => {
  const client = makeClient();
  const store = makeStore({ userId: 'self' });

  await doPush({ token: 't', client, card: normalizeCard(SAMPLE_CARD), ...store, now: NOW });
  assert.equal(client.calls.write.length, 1);

  await doPush({ token: 't', client, card: normalizeCard(SAMPLE_CARD), ...store, now: NOW });
  assert.equal(client.calls.write.length, 1, 'no second write for a seen card');
  assert.equal(client.calls.nudge.length, 1, 'no second nudge for a seen card');
});

test('doPush with a null card (no discernible goal) writes nothing', async () => {
  const client = makeClient();
  const store = makeStore({ userId: 'self' });

  await doPush({ token: 't', client, card: null, ...store, now: NOW });

  assert.equal(client.calls.write.length, 0, 'no write when there is no card');
  assert.equal(client.calls.nudge.length, 0);
  assert.ok(!store.box.state.seen || Object.keys(store.box.state.seen).length === 0);
});

test('doPush can suppress the optional nudge', async () => {
  const client = makeClient();
  const store = makeStore({ userId: 'self' });

  await doPush({ token: 't', client, card: normalizeCard(SAMPLE_CARD), ...store, now: NOW, nudge: false });

  assert.equal(client.calls.write.length, 1, 'card still written');
  assert.equal(client.calls.nudge.length, 0, 'nudge suppressed');
});

test('doPush does NOT write per-unit gating state (server owns run-once)', async () => {
  const client = makeClient();
  const store = makeStore({ userId: 'self' });
  await doPush({ token: 't', client, card: normalizeCard(SAMPLE_CARD), ...store, now: NOW });
  assert.ok(!store.box.state.extractedUnits, 'no per-unit gating state is written');
});

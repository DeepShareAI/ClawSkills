'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  SEEN_TTL_DAYS,
  isoOrNull,
  normalizeEvent,
  dedupKey,
  toNaiveLocal,
  buildSkillDataItems,
  unitKeyFor,
  pruneSeen,
  pruneExtractedUnits,
  partitionForManual,
} = require('../scripts/lib');

// ---- isoOrNull -----------------------------------------------------------
test('isoOrNull returns null for falsy / unparseable, ISO for valid', () => {
  assert.equal(isoOrNull(null), null);
  assert.equal(isoOrNull(''), null);
  assert.equal(isoOrNull('not a date'), null);
  assert.equal(isoOrNull('2026-06-03T10:00:00Z'), '2026-06-03T10:00:00.000Z');
});

// ---- normalizeEvent ------------------------------------------------------
test('normalizeEvent rejects non-objects and title-less input', () => {
  assert.equal(normalizeEvent(null), null);
  assert.equal(normalizeEvent('x'), null);
  assert.equal(normalizeEvent({}), null);
  assert.equal(normalizeEvent({ title: '   ' }), null);
});

test('normalizeEvent reads title/name/event_name aliases', () => {
  assert.equal(normalizeEvent({ name: 'Standup' }).title, 'Standup');
  assert.equal(normalizeEvent({ event_name: 'Demo' }).title, 'Demo');
  assert.equal(normalizeEvent({ title: '  Sync  ' }).title, 'Sync');
});

test('normalizeEvent coerces attendees (array, string, missing)', () => {
  assert.deepEqual(normalizeEvent({ title: 'a', attendees: ['  X ', '', 'Y'] }).attendees, ['X', 'Y']);
  assert.deepEqual(normalizeEvent({ title: 'a', attendees: ' solo ' }).attendees, ['solo']);
  assert.deepEqual(normalizeEvent({ title: 'a' }).attendees, []);
});

test('normalizeEvent maps date/location/notes aliases and nulls', () => {
  const ev = normalizeEvent({
    title: 'Lunch',
    date: '2026-06-04T12:00:00Z',
    address: 'Cafe',
    description: 'bring slides',
  });
  assert.equal(ev.startAt, '2026-06-04T12:00:00.000Z');
  assert.equal(ev.location, 'Cafe');
  assert.equal(ev.notes, 'bring slides');
  assert.equal(ev.endAt, null);

  const bare = normalizeEvent({ title: 'x' });
  assert.equal(bare.location, null);
  assert.equal(bare.notes, null);
  assert.equal(bare.startAt, null);
});

test('normalizeEvent carries source_ref and source_kind', () => {
  const a = normalizeEvent({ title: 'x', session_id: 'sid-1', source: 'AUDIO' });
  assert.equal(a.sourceRef, 'sid-1');
  assert.equal(a.sourceKind, 'audio');

  const k = normalizeEvent({ title: 'x', source_ref: 'kb-9', source_kind: 'keyboard' });
  assert.equal(k.sourceRef, 'kb-9');
  assert.equal(k.sourceKind, 'keyboard');

  const none = normalizeEvent({ title: 'x' });
  assert.equal(none.sourceRef, null);
  assert.equal(none.sourceKind, null);
});

// ---- dedupKey ------------------------------------------------------------
test('dedupKey is stable for equivalent events', () => {
  const a = normalizeEvent({ title: 'Team  Sync', start_at: '2026-06-03T17:00:00Z' });
  const b = normalizeEvent({ name: 'team sync', start: '2026-06-03T17:00:00Z' });
  assert.equal(dedupKey(a), dedupKey(b));
});

test('dedupKey differs by day, title, and start time', () => {
  const base = normalizeEvent({ title: 'Sync', start_at: '2026-06-03T17:00:00Z' });
  const otherTitle = normalizeEvent({ title: 'Standup', start_at: '2026-06-03T17:00:00Z' });
  const otherTime = normalizeEvent({ title: 'Sync', start_at: '2026-06-03T18:00:00Z' });
  const noDate = normalizeEvent({ title: 'Sync' });
  assert.notEqual(dedupKey(base), dedupKey(otherTitle));
  assert.notEqual(dedupKey(base), dedupKey(otherTime));
  assert.ok(dedupKey(noDate).startsWith('nodate|'));
});

// ---- toNaiveLocal / buildSkillDataItems (naive-local mirror) -------------
test('toNaiveLocal renders the instant as naive wall-clock in tz (no Z)', () => {
  // 04:00Z Jun 6 == 21:00 Jun 5 in Los Angeles (PDT, -7).
  assert.equal(toNaiveLocal('2026-06-06T04:00:00.000Z', 'America/Los_Angeles'), '2026-06-05T21:00:00');
  // Same instant in New York (EDT, -4) == 00:00 Jun 6.
  assert.equal(toNaiveLocal('2026-06-06T04:00:00.000Z', 'America/New_York'), '2026-06-06T00:00:00');
  // No Z / offset designator on the output.
  assert.doesNotMatch(toNaiveLocal('2026-06-06T04:00:00.000Z', 'America/Los_Angeles'), /[Z+]/);
  assert.equal(toNaiveLocal(null, 'America/Los_Angeles'), null);
  assert.equal(toNaiveLocal('not-a-date', 'America/Los_Angeles'), null);
});

test('buildSkillDataItems emits naive-local start/end and instant-based dedup_key', () => {
  const ev = normalizeEvent({
    title: 'Meeting', start_at: '2026-06-06T04:00:00Z', end_at: '2026-06-06T04:30:00Z',
    source_ref: '521', source_kind: 'keyboard',
  });
  const [item] = buildSkillDataItems([ev], 'America/Los_Angeles');
  assert.equal(item.start_at, '2026-06-05T21:00:00');  // 9:00 PM local, not 04:00Z
  assert.equal(item.end_at, '2026-06-05T21:30:00');
  assert.doesNotMatch(item.start_at, /Z$/);
  assert.equal(item.dedup_key, dedupKey(ev));          // dedup identity unchanged
  assert.equal(item.source_ref, '521');
  assert.deepEqual(item.payload, { title: 'Meeting', location: null, attendees: [], notes: null });
});

test('buildSkillDataItems preserves null start/end and tolerates empty input', () => {
  const ev = normalizeEvent({ title: 'TBD' }); // no start_at
  const [item] = buildSkillDataItems([ev], 'America/Los_Angeles');
  assert.equal(item.start_at, null);
  assert.equal(item.end_at, null);
  assert.deepEqual(buildSkillDataItems(null, 'America/Los_Angeles'), []);
  assert.deepEqual(buildSkillDataItems([], 'America/Los_Angeles'), []);
});

// ---- unitKeyFor ----------------------------------------------------------
test('unitKeyFor derives audio vs keyboard unit keys', () => {
  assert.equal(unitKeyFor(normalizeEvent({ title: 'x', session_id: 's1', source: 'audio' })), 'audio:s1');
  assert.equal(unitKeyFor(normalizeEvent({ title: 'x', session_id: 's1' })), 'audio:s1'); // default
  assert.equal(unitKeyFor(normalizeEvent({ title: 'x', source_ref: 'k1', source_kind: 'keyboard' })), 'kbd:k1');
  assert.equal(unitKeyFor(normalizeEvent({ title: 'x', source_ref: 'k1', source_kind: 'KEYBOARD' })), 'kbd:k1');
});

test('unitKeyFor returns null without a source ref', () => {
  assert.equal(unitKeyFor(normalizeEvent({ title: 'x' })), null);
  assert.equal(unitKeyFor(null), null);
  assert.equal(unitKeyFor({}), null);
});

// ---- pruning by TTL ------------------------------------------------------
test('pruneSeen drops entries older than TTL and unparseable ones', () => {
  const now = Date.now();
  const fresh = new Date(now - 1 * 86400 * 1000).toISOString();
  const stale = new Date(now - (SEEN_TTL_DAYS + 1) * 86400 * 1000).toISOString();
  const seen = { keep: fresh, drop: stale, bad: 'not-a-date' };
  const out = pruneSeen(seen);
  assert.deepEqual(Object.keys(out), ['keep']);
  assert.equal(out.keep, fresh);
});

test('pruneSeen on empty / missing map yields {}', () => {
  assert.deepEqual(pruneSeen(null), {});
  assert.deepEqual(pruneSeen({}), {});
});

test('pruneExtractedUnits drops stale units, keeps fresh with payload', () => {
  const now = Date.now();
  const fresh = new Date(now - 2 * 86400 * 1000).toISOString();
  const stale = new Date(now - (SEEN_TTL_DAYS + 5) * 86400 * 1000).toISOString();
  const units = {
    'audio:a': { ts: fresh, events: [{ title: 'x' }] },
    'kbd:b': { ts: stale, events: [] },
    'audio:c': { ts: undefined, events: [] }, // unparseable ts -> dropped
  };
  const out = pruneExtractedUnits(units);
  assert.deepEqual(Object.keys(out), ['audio:a']);
  assert.deepEqual(out['audio:a'].events, [{ title: 'x' }]);
});

test('prune honors a custom ttlDays', () => {
  const now = Date.now();
  const tenDaysAgo = new Date(now - 10 * 86400 * 1000).toISOString();
  // With a 5-day TTL the 10-day-old entry is stale.
  assert.deepEqual(pruneSeen({ k: tenDaysAgo }, 5), {});
  // With a 30-day TTL it survives.
  assert.deepEqual(Object.keys(pruneSeen({ k: tenDaysAgo }, 30)), ['k']);
});

// ---- partitionForManual --------------------------------------------------
test('partitionForManual splits flagged (cached) vs fresh units', () => {
  const flaggedEv = normalizeEvent({ title: 'Old', session_id: 'a', source: 'audio' });
  const freshEv = normalizeEvent({ title: 'New', session_id: 'b', source: 'audio' });
  const kbdFreshEv = normalizeEvent({ title: 'Typed', source_ref: 'k1', source_kind: 'keyboard' });

  const cachedCopy = { title: 'Old (cached)', startAt: null };
  const extractedUnits = {
    'audio:a': { ts: new Date().toISOString(), events: [cachedCopy] },
  };

  const { flaggedUnits, freshEvents } = partitionForManual(
    [flaggedEv, freshEv, kbdFreshEv],
    extractedUnits
  );

  assert.equal(flaggedUnits.length, 1);
  assert.equal(flaggedUnits[0].key, 'audio:a');
  // Flagged unit re-displays the CACHED events, not the incoming one.
  assert.deepEqual(flaggedUnits[0].events, [cachedCopy]);

  assert.deepEqual(freshEvents.map((e) => e.title), ['New', 'Typed']);
});

test('partitionForManual dedups repeated flagged keys and treats keyless as fresh', () => {
  const ev1 = normalizeEvent({ title: 'A', session_id: 'a', source: 'audio' });
  const ev2 = normalizeEvent({ title: 'B', session_id: 'a', source: 'audio' }); // same unit
  const keyless = normalizeEvent({ title: 'NoRef' }); // no source_ref -> fresh

  const extractedUnits = { 'audio:a': { ts: new Date().toISOString(), events: [] } };
  const { flaggedUnits, freshEvents } = partitionForManual([ev1, ev2, keyless], extractedUnits);

  assert.equal(flaggedUnits.length, 1);
  assert.equal(flaggedUnits[0].key, 'audio:a');
  assert.deepEqual(freshEvents.map((e) => e.title), ['NoRef']);
});

test('partitionForManual with empty extractedUnits treats everything as fresh', () => {
  const ev = normalizeEvent({ title: 'A', session_id: 'a', source: 'audio' });
  const { flaggedUnits, freshEvents } = partitionForManual([ev], {});
  assert.deepEqual(flaggedUnits, []);
  assert.equal(freshEvents.length, 1);
});

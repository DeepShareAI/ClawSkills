'use strict';

// Behavioral tests for the in-thread card-edit subcommands `update` and
// `anchor` in scripts/calendar-extractor.js. Network-free: doUpdate is exercised
// through an injected client (deps.client.upsert) and an injected input object
// (deps.input), exactly the IO-injection seam doPush uses. The invariants under
// test are the whole point of the feature:
//   - the ORIGINAL dedup_key is sent VERBATIM (never recomputed from the new time);
//   - the item rides status:"confirmed" (server flips pending -> confirmed);
//   - start_at/end_at are naive-local wall-clock (no Z / offset leaves the process);
//   - the FULL merged payload is sent (a time-only patch still carries title/etc.);
//   - missing key -> hard error (no write); empty patch -> no-op (no write).
// And the anchor output shape (the five fields, no `sessions`).
//
// Spec: docs/superpowers/specs/2026-06-22-calendar-extractor-update-anchor-implementation.md

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { doUpdate, doAnchor } = require('../scripts/calendar-extractor');
const { dedupKey } = require('../scripts/lib');

const TZ = 'America/Los_Angeles';
const NOW = () => '2026-06-22T12:00:00.000Z';

// A recording skill_data client: captures every upsert(token, items) so a test
// can assert the EXACT item posted, without any network.
function makeClient() {
  const calls = { upsert: [] };
  return {
    calls,
    upsert: async (_token, items) => { calls.upsert.push(items); },
  };
}

// The card's original key, computed at PUSH time off the ORIGINAL start time.
// The edit moves the event to 18:00; if update recomputed the key off 18:00 it
// would differ from this and spawn a second row — the bug this feature fixes.
const ORIGINAL_KEY = '2026-06-22|design review|2026-06-22T22:00:00.000Z';

// ---- verbatim dedup_key (NEVER recomputed) -------------------------------
test('doUpdate sends the ORIGINAL dedup_key verbatim, not recomputed from the new time', async () => {
  const client = makeClient();
  await doUpdate({
    token: 't', client, tz: TZ,
    input: {
      dedup_key: ORIGINAL_KEY,
      patch: {
        title: 'Design Review',
        start_at: '2026-06-22T18:00:00-07:00', // moved 3pm -> 6pm local
        end_at: '2026-06-22T19:00:00-07:00',
        location: 'Zoom', attendees: ['Sam'], notes: 'bring laptop',
      },
    },
  });

  assert.equal(client.calls.upsert.length, 1, 'exactly one upsert');
  const [item] = client.calls.upsert[0];
  assert.equal(item.dedup_key, ORIGINAL_KEY, 'key is passed through verbatim');

  // Prove it was NOT recomputed: dedupKey() off the new 18:00 time would differ.
  const recomputed = dedupKey({ title: 'Design Review', startAt: '2026-06-23T01:00:00.000Z' });
  assert.notEqual(item.dedup_key, recomputed, 'must not be the recomputed (new-time) key');
});

// ---- status:"confirmed" rides the item -----------------------------------
test('doUpdate tags the item status "confirmed" (server flips pending -> confirmed)', async () => {
  const client = makeClient();
  await doUpdate({
    token: 't', client, tz: TZ,
    input: { dedup_key: ORIGINAL_KEY, patch: { title: 'Design Review', location: 'Zoom' } },
  });
  const [item] = client.calls.upsert[0];
  assert.equal(item.status, 'confirmed');
});

// ---- naive-local times (no Z / offset leaves the process) ----------------
test('doUpdate writes start_at/end_at as naive-local wall-clock (no Z, no offset)', async () => {
  const client = makeClient();
  await doUpdate({
    token: 't', client, tz: TZ,
    input: {
      dedup_key: ORIGINAL_KEY,
      patch: {
        title: 'Design Review',
        start_at: '2026-06-22T18:00:00-07:00',
        end_at: '2026-06-22T19:00:00-07:00',
      },
    },
  });
  const [item] = client.calls.upsert[0];
  assert.equal(item.start_at, '2026-06-22T18:00:00', '6pm PDT as zoneless local');
  assert.equal(item.end_at, '2026-06-22T19:00:00');
  // No Z / offset designator on the time fields (the dedup_key legitimately
  // ends in the original instant's `...Z`, so we check the time fields directly,
  // not the whole serialized body).
  assert.doesNotMatch(item.start_at, /[Z+]/, 'start_at carries no Z/offset');
  assert.doesNotMatch(item.end_at, /[Z+]/, 'end_at carries no Z/offset');
});

// ---- FULL merged payload (a time-only edit still carries title/location/etc) --
test('doUpdate sends the full merged payload — a time-only patch keeps title/location/attendees/notes', async () => {
  const client = makeClient();
  // The agent has already merged [CURRENT CARD] fields with the time change, so
  // even a "change time" edit arrives as a full patch. Assert the whole payload
  // is resent (the server overwrites payload wholesale, so omitting blanks them).
  await doUpdate({
    token: 't', client, tz: TZ,
    input: {
      dedup_key: ORIGINAL_KEY,
      patch: {
        title: 'Design Review',
        location: 'Room A',
        attendees: ['Sam', 'Alex'],
        notes: 'bring laptop',
        start_at: '2026-06-22T18:00:00-07:00',
      },
    },
  });
  const [item] = client.calls.upsert[0];
  assert.deepEqual(item.payload, {
    title: 'Design Review',
    location: 'Room A',
    attendees: ['Sam', 'Alex'],
    notes: 'bring laptop',
  });
  assert.equal(item.start_at, '2026-06-22T18:00:00');
});

// ---- end_at omitted -> null (not stale/garbage), and end-only -> start null --
test('doUpdate yields end_at:null when the patch has start_at but no end_at', async () => {
  const client = makeClient();
  await doUpdate({
    token: 't', client, tz: TZ,
    input: {
      dedup_key: ORIGINAL_KEY,
      patch: { title: 'Design Review', start_at: '2026-06-22T18:00:00-07:00' },
    },
  });
  const [item] = client.calls.upsert[0];
  assert.equal(item.start_at, '2026-06-22T18:00:00');
  assert.equal(item.end_at, null, 'omitted end_at collapses to null, not a stale value');
});

test('doUpdate yields start_at:null for an end-only patch', async () => {
  const client = makeClient();
  await doUpdate({
    token: 't', client, tz: TZ,
    input: {
      dedup_key: ORIGINAL_KEY,
      patch: { title: 'Design Review', end_at: '2026-06-22T19:00:00-07:00' },
    },
  });
  const [item] = client.calls.upsert[0];
  assert.equal(item.start_at, null);
  assert.equal(item.end_at, '2026-06-22T19:00:00');
});

// ---- naive-local across DST / Z-collapse ---------------------------------
test('doUpdate collapses a winter (PST -08:00) offset and a Z instant to wall-clock', async () => {
  const client = makeClient();
  await doUpdate({
    token: 't', client, tz: TZ,
    input: {
      dedup_key: ORIGINAL_KEY,
      patch: {
        title: 'Design Review',
        start_at: '2026-01-15T18:00:00-08:00',     // PST winter offset
        end_at: '2026-06-23T01:00:00.000Z',         // Z instant -> 18:00 PDT prev day
      },
    },
  });
  const [item] = client.calls.upsert[0];
  assert.equal(item.start_at, '2026-01-15T18:00:00', 'PST offset collapsed to wall-clock');
  assert.equal(item.end_at, '2026-06-22T18:00:00', 'Z instant collapsed to LA wall-clock');
  assert.doesNotMatch(item.start_at, /[Z+]/);
  assert.doesNotMatch(item.end_at, /[Z+]/);
});

// ---- offset-less unchanged time is NOT re-projected by the runner zone ----
// The [CURRENT CARD] block stores start_at/end_at as naive-local (no offset). On a
// NON-time edit (e.g. "location is Zoom") the agent copies that value forward. It
// must survive byte-identical regardless of the runner process zone — otherwise a
// container running a zone != the card zone silently shifts a time the user never
// touched. (Pinning the patchTimeToNaiveLocal passthrough.)
test('doUpdate passes an offset-less [CURRENT CARD] time through unchanged (no runner-zone shift)', async () => {
  const origTZ = process.env.TZ;
  process.env.TZ = 'America/New_York'; // runner zone != card zone (LA)
  try {
    const client = makeClient();
    await doUpdate({
      // No deps.tz: resolve via stdin tz (the card zone) so this exercises the
      // realistic update path, not a test-injected tz.
      token: 't', client,
      input: {
        dedup_key: ORIGINAL_KEY,
        tz: TZ,
        patch: {
          title: 'Design Review',
          location: 'Zoom',                       // the only real change
          start_at: '2026-06-22T15:00:00',        // unchanged, copied from [CURRENT CARD]
          end_at: '2026-06-22T16:00:00',
        },
      },
    });
    const [item] = client.calls.upsert[0];
    assert.equal(item.start_at, '2026-06-22T15:00:00', 'unchanged naive time is byte-identical');
    assert.equal(item.end_at, '2026-06-22T16:00:00');
    assert.equal(item.payload.location, 'Zoom');
  } finally {
    if (origTZ === undefined) delete process.env.TZ; else process.env.TZ = origTZ;
  }
});

// ---- string fields are trimmed (matches normalizeEvent) ------------------
test('doUpdate trims title/location/notes (no leading/trailing whitespace written)', async () => {
  const client = makeClient();
  await doUpdate({
    token: 't', client, tz: TZ,
    input: {
      dedup_key: ORIGINAL_KEY,
      patch: { title: '  Design Review  ', location: ' Room A ', notes: '  bring laptop  ', start_at: '2026-06-22T18:00:00-07:00' },
    },
  });
  const [item] = client.calls.upsert[0];
  assert.equal(item.payload.title, 'Design Review');
  assert.equal(item.payload.location, 'Room A');
  assert.equal(item.payload.notes, 'bring laptop');
});

// ---- WHOLESALE-PAYLOAD HAZARD: a partial patch blanks the omitted fields --
// The server overwrites payload/start_at/end_at WHOLESALE, so a patch that omits a
// field destroys it on the live row. This is by design (the agent is responsible
// for merging the full state) — pin the destructive behavior so any future change
// to it is caught.
test('doUpdate writes a partial (non-merged) patch as-is — omitted fields are blanked', async () => {
  const client = makeClient();
  await doUpdate({
    token: 't', client, tz: TZ,
    input: { dedup_key: ORIGINAL_KEY, patch: { start_at: '2026-06-22T18:00:00-07:00' } },
  });
  const [item] = client.calls.upsert[0];
  assert.equal(item.dedup_key, ORIGINAL_KEY);
  assert.deepEqual(item.payload, { title: null, location: null, attendees: [], notes: null });
  assert.equal(item.start_at, '2026-06-22T18:00:00');
  assert.equal(item.end_at, null);
});

// ---- non-silent failure: an upsert HTTP error propagates (no false success) --
test('doUpdate propagates a /api/skill/data failure (does not claim success)', async () => {
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => { logs.push(a.join(' ')); };
  try {
    const client = { upsert: async () => { throw new Error('POST /api/skill/data -> HTTP 500'); } };
    await assert.rejects(
      doUpdate({
        token: 't', client, tz: TZ,
        input: { dedup_key: ORIGINAL_KEY, patch: { title: 'Design Review', location: 'Zoom' } },
      }),
      /HTTP 500/
    );
  } finally {
    console.log = origLog;
  }
  assert.ok(!logs.some((l) => /Updated card/.test(l)), 'no success line printed before the throw');
});

// ---- missing key -> hard error, no write ---------------------------------
test('doUpdate throws and writes nothing when dedup_key is missing', async () => {
  const client = makeClient();
  await assert.rejects(
    doUpdate({ token: 't', client, tz: TZ, input: { patch: { title: 'x' } } }),
    /non-empty dedup_key/
  );
  assert.equal(client.calls.upsert.length, 0, 'no write on missing key');
});

test('doUpdate throws and writes nothing when dedup_key is whitespace-only', async () => {
  const client = makeClient();
  await assert.rejects(
    doUpdate({ token: 't', client, tz: TZ, input: { dedup_key: '   ', patch: { title: 'x' } } }),
    /non-empty dedup_key/
  );
  assert.equal(client.calls.upsert.length, 0);
});

// ---- empty patch -> no-op, no write --------------------------------------
test('doUpdate is a no-op (no write) for an empty / whitespace-only patch', async () => {
  const client = makeClient();
  await doUpdate({ token: 't', client, tz: TZ, input: { dedup_key: ORIGINAL_KEY, patch: {} } });
  assert.equal(client.calls.upsert.length, 0, 'empty patch writes nothing');

  await doUpdate({
    token: 't', client, tz: TZ,
    input: { dedup_key: ORIGINAL_KEY, patch: { title: '   ', notes: '', attendees: [] } },
  });
  assert.equal(client.calls.upsert.length, 0, 'whitespace-only patch writes nothing');

  await doUpdate({ token: 't', client, tz: TZ, input: { dedup_key: ORIGINAL_KEY } });
  assert.equal(client.calls.upsert.length, 0, 'missing patch writes nothing');
});

// ---- update does NOT push to iOS -----------------------------------------
test('doUpdate never calls the iOS push path (only the skill_data upsert)', async () => {
  const calls = { upsert: 0, push: 0, mirror: 0 };
  const client = {
    upsert: async () => { calls.upsert++; },
    push: async () => { calls.push++; },
    mirror: async () => { calls.mirror++; },
  };
  await doUpdate({
    token: 't', client, tz: TZ,
    input: { dedup_key: ORIGINAL_KEY, patch: { title: 'Design Review', location: 'Zoom' } },
  });
  assert.equal(calls.upsert, 1);
  assert.equal(calls.push, 0, 'no /api/agent/push from update');
  assert.equal(calls.mirror, 0, 'no pending mirror from update');
});

// ---- anchor output shape (the five fields, no sessions) ------------------
test('doAnchor prints only the anchor (five fields + tz), no sessions', () => {
  let emitted;
  doAnchor({ tz: TZ, now: NOW, emit: (o) => { emitted = o; } });
  assert.deepEqual(Object.keys(emitted).sort(), [
    'reference_date', 'reference_time', 'reference_time_utc', 'reference_weekday', 'tz',
  ]);
  assert.equal(emitted.reference_time, '2026-06-22T05:00:00'); // 12:00Z -> 05:00 PDT
  assert.equal(emitted.reference_date, '2026-06-22');
  assert.equal(emitted.reference_weekday, 'Monday');
  assert.equal(emitted.reference_time_utc, NOW());
  assert.equal(emitted.tz, TZ);
  assert.ok(!('sessions' in emitted), 'anchor carries no sessions / transcript');
});

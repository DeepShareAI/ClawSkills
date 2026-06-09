'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  SEEN_TTL_DAYS,
  resolveTz,
  toNaiveLocal,
  localAnchor,
  todoDedupKey,
  composePrompt,
  pruneSeen,
} = require('../scripts/lib');

// ---- resolveTz: payload -> TZ env -> system ------------------------------
test('resolveTz prefers the payload tz, then TZ env, then the system zone', () => {
  const savedTz = process.env.TZ;
  try {
    process.env.TZ = 'America/New_York';
    assert.equal(resolveTz('Asia/Tokyo'), 'Asia/Tokyo');
    assert.equal(resolveTz('  Europe/Paris  '), 'Europe/Paris');
    assert.equal(resolveTz(null), 'America/New_York');
    assert.equal(resolveTz(''), 'America/New_York');
    delete process.env.TZ;
    const savedDTF = Intl.DateTimeFormat;
    try {
      Intl.DateTimeFormat = function () {
        return { resolvedOptions: () => ({ timeZone: 'Australia/Sydney' }) };
      };
      assert.equal(resolveTz(null), 'Australia/Sydney');
      Intl.DateTimeFormat = function () {
        return { resolvedOptions: () => ({ timeZone: '' }) };
      };
      assert.equal(resolveTz(null), 'UTC');
      Intl.DateTimeFormat = function () { throw new Error('no Intl'); };
      assert.equal(resolveTz(null), 'UTC');
    } finally {
      Intl.DateTimeFormat = savedDTF;
    }
  } finally {
    if (savedTz === undefined) delete process.env.TZ; else process.env.TZ = savedTz;
  }
});

// ---- localAnchor (informational; to-do rows carry no date) ---------------
test('toNaiveLocal renders the instant as naive wall-clock in tz (no Z)', () => {
  assert.equal(toNaiveLocal('2026-06-06T04:00:00.000Z', 'America/Los_Angeles'), '2026-06-05T21:00:00');
  assert.doesNotMatch(toNaiveLocal('2026-06-06T04:00:00.000Z', 'America/Los_Angeles'), /[Z+]/);
  assert.equal(toNaiveLocal(null, 'America/Los_Angeles'), null);
  assert.equal(toNaiveLocal('not-a-date', 'America/Los_Angeles'), null);
});

test('localAnchor emits a local wall-clock anchor whose date is the tz-local "today"', () => {
  // 9:11 PM PDT Jun 4 == 2026-06-05T04:11Z. The anchor must carry the LOCAL date.
  const a = localAnchor('2026-06-05T04:11:00.000Z', 'America/Los_Angeles');
  assert.equal(a.reference_date, '2026-06-04');
  assert.equal(a.reference_time, '2026-06-04T21:11:00');
  assert.doesNotMatch(a.reference_time, /Z$/);
  assert.equal(a.reference_weekday, 'Thursday');
  assert.equal(a.reference_time_utc, '2026-06-05T04:11:00.000Z');
});

// ---- todoDedupKey --------------------------------------------------------
test('todoDedupKey is stable for equivalent cards and varies by title/goal', () => {
  const a = todoDedupKey({ title: 'Intro  Javis', goal: 'introduce Javis to the community' });
  const b = todoDedupKey({ title: 'intro javis', goal: '  introduce Javis to the community ' });
  assert.equal(a, b, 'whitespace/case-insensitive on title and goal');

  const otherTitle = todoDedupKey({ title: 'Pitch Javis', goal: 'introduce Javis to the community' });
  const otherGoal = todoDedupKey({ title: 'Intro Javis', goal: 'a totally different objective' });
  assert.notEqual(a, otherTitle, 'different title -> different key');
  assert.notEqual(a, otherGoal, 'same title, different goal -> different key (re-brainstorm is new)');
});

test('todoDedupKey is bounded (<=512 chars) even for very long goals', () => {
  const key = todoDedupKey({ title: 'x', goal: 'g'.repeat(5000) });
  assert.ok(key.length <= 512);
});

// ---- composePrompt: sample card -> expected prompt substrings ------------
test('composePrompt assembles the literal template with the card fields', () => {
  const prompt = composePrompt({
    goal: 'introduce Javis to the OpenClaw community, for non-engineer users',
    request: ['an attention hook', 'a step-by-step demo/onboarding flow'],
    source_refs: ['sess-aaa', 'sess-bbb'],
  });
  // Goal line.
  assert.match(prompt, /^I want to introduce Javis to the OpenClaw community, for non-engineer users\./m);
  // Source line names the javis_mcp connector and the session ids.
  assert.match(prompt, /Source: my Javis voice note\(s\), session_id\(s\): sess-aaa, sess-bbb\./);
  assert.match(prompt, /javis_mcp connector \(get_transcript_tool \/ search_transcripts_tool\)/);
  // Each request becomes a bullet.
  assert.match(prompt, /^- an attention hook$/m);
  assert.match(prompt, /^- a step-by-step demo\/onboarding flow$/m);
  // The literal content-brainstorming hand-off instruction is always present.
  assert.match(prompt, /Run the content-brainstorming flow: ask me clarifying questions one at a time/);
  assert.match(prompt, /produce a structured brief before drafting\./);
});

test('composePrompt degrades gracefully with no requests and no source_refs', () => {
  const prompt = composePrompt({ goal: 'organize my product launch ideas' });
  assert.match(prompt, /^I want to organize my product launch ideas\./m);
  // Falls back to a placeholder source hint and a generic bullet.
  assert.match(prompt, /session_id\(s\): \(see my recent voice notes\)/);
  assert.match(prompt, /^- a structured brief I can act on$/m);
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

test('prune honors a custom ttlDays', () => {
  const now = Date.now();
  const tenDaysAgo = new Date(now - 10 * 86400 * 1000).toISOString();
  assert.deepEqual(pruneSeen({ k: tenDaysAgo }, 5), {});
  assert.deepEqual(Object.keys(pruneSeen({ k: tenDaysAgo }, 30)), ['k']);
});

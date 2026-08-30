'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

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

test('fetch posts the skill slug and the limit', async () => {
  const f = fakeFetch(ok({ status: 'ok', items: [] }));
  const out = await cli.doFetch({ limit: 7 }, { fetch: f, token: 't' });
  assert.equal(out.status, 'ok');
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].url, /\/api\/skill\/candidates\/fetch$/);
  assert.deepEqual(f.calls[0].body, { skill: 'gmail-wiki-ingest', limit: 7 });
});

test('the gateway token travels as a bearer header', async () => {
  const f = fakeFetch(ok({ status: 'ok' }));
  await cli.doFetch({}, { fetch: f, token: 'secret-token' });
  assert.equal(f.calls[0].init.headers.Authorization, 'Bearer secret-token');
});

test('a non-2xx comes back as an envelope, not a throw', async () => {
  // The agent must be able to tell a failed call from an empty mailbox. A
  // thrown error mid-turn reads to it as neither.
  const f = fakeFetch(async () => ({
    ok: false, status: 404,
    json: async () => ({ detail: { error: 'unsupported_skill' } }),
  }));
  const out = await cli.doFetch({}, { fetch: f, token: 't' });
  assert.equal(out.status, 'error');
  assert.equal(out.error, 'unsupported_skill');
});

test('a network failure comes back as an envelope too', async () => {
  const f = fakeFetch(async () => { throw new Error('ECONNREFUSED'); });
  const out = await cli.doFetch({}, { fetch: f, token: 't' });
  assert.equal(out.status, 'error');
  assert.equal(out.error, 'network_error');
});

test('submit posts the verdict array verbatim', async () => {
  const f = fakeFetch(ok({ status: 'ok', high: 0, middle: 1, low: 0 }));
  const verdicts = [{ item_key: 't1', score: 0.7, category: 'correspondence', refs: [] }];
  const out = await cli.doSubmit(verdicts, { fetch: f, token: 't' });
  assert.equal(out.middle, 1);
  assert.deepEqual(f.calls[0].body, { skill: 'gmail-wiki-ingest', verdicts });
});

test('submit refuses a non-array rather than coercing it', async () => {
  // An empty submit is MEANINGFUL: it says the batch was judged and nothing was
  // worth keeping, and it promotes the cursor past every item in it. Coercing a
  // malformed verdict list into that would skip mail permanently.
  const f = fakeFetch(ok({ status: 'ok' }));
  const out = await cli.doSubmit({ not: 'an array' }, { fetch: f, token: 't' });
  assert.equal(out.error, 'verdicts_must_be_an_array');
  assert.equal(f.calls.length, 0, 'nothing should have been posted');
});

test('an empty verdict array IS posted — it closes the batch', async () => {
  const f = fakeFetch(ok({ status: 'ok', promoted: true }));
  const out = await cli.doSubmit([], { fetch: f, token: 't' });
  assert.equal(out.promoted, true);
  assert.deepEqual(f.calls[0].body.verdicts, []);
});

test('the skill slug is not caller-settable', async () => {
  // The server validates it against registered adapters, but the CLI should
  // not be the thing that makes a wrong one reachable in the first place.
  const f = fakeFetch(ok({ status: 'ok' }));
  await cli.doSubmit([], { fetch: f, token: 't' });
  assert.equal(f.calls[0].body.skill, 'gmail-wiki-ingest');
});

test('parseArgv finds the command and its flags', () => {
  const { cmd, flag } = cli.parseArgv(['node', 'x.js', 'fetch', '--limit', '9']);
  assert.equal(cmd, 'fetch');
  assert.equal(flag('limit', '25'), '9');
  assert.equal(flag('missing', 'dflt'), 'dflt');
});

// Tests for src/api2Client.ts — built-in node:test runner.
// Run after `npm run build`:
//   node --test tests/api2Client.test.js
//
// We import from dist/ so the JS test exercises real compiled output (same
// thing the container runs).

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  LumaApi2Client,
  LumaApi2Error,
  LUMA_API_HEADERS,
} = require('../dist/api2Client');

const ORIGINAL_FETCH = globalThis.fetch;

function mockFetch(impl) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init || {} });
    return impl(url, init);
  };
  return calls;
}

beforeEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

function textResponse(body, status) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      throw new Error('not json');
    },
    async text() {
      return body;
    },
  };
}

test('search() returns parsed JSON on 200', async () => {
  mockFetch(() =>
    jsonResponse({
      query: 'startup',
      events: [{ api_id: 'evt-1', event: { api_id: 'evt-1', name: 'X', url: 'abc' } }],
    }),
  );

  const client = new LumaApi2Client('luma.auth-session-key=secret');
  const result = await client.search('startup');

  assert.equal(result.query, 'startup');
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].event.url, 'abc');
});

test('search() URL-encodes the query', async () => {
  const calls = mockFetch(() => jsonResponse({ events: [] }));

  const client = new LumaApi2Client('luma.auth-session-key=secret');
  await client.search('a b&c');

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/search\/get-results\?query=a%20b%26c$/);
});

test('request() sends Cookie + LUMA_API_HEADERS', async () => {
  const calls = mockFetch(() => jsonResponse({ ok: true }));

  const client = new LumaApi2Client('luma.auth-session-key=abc; luma.did=xyz');
  await client.search('hi');

  const headers = calls[0].init.headers;
  assert.equal(headers.Cookie, 'luma.auth-session-key=abc; luma.did=xyz');
  assert.equal(headers['x-luma-client-type'], LUMA_API_HEADERS['x-luma-client-type']);
  assert.equal(headers['x-luma-client-version'], LUMA_API_HEADERS['x-luma-client-version']);
  assert.equal(headers.origin, 'https://luma.com');
});

test('401 throws LumaApi2Error with status + body', async () => {
  mockFetch(() => textResponse('not authenticated', 401));

  const client = new LumaApi2Client('luma.auth-session-key=expired');
  await assert.rejects(() => client.search('q'), (err) => {
    assert.ok(err instanceof LumaApi2Error);
    assert.equal(err.status, 401);
    assert.match(err.bodyText, /not authenticated/);
    return true;
  });
});

test('500 throws LumaApi2Error', async () => {
  mockFetch(() => textResponse('boom', 500));

  const client = new LumaApi2Client('luma.auth-session-key=v');
  await assert.rejects(() => client.search('q'), LumaApi2Error);
});

test('listCalendars() hits /calendar/admin/list', async () => {
  const calls = mockFetch(() => jsonResponse({ infos: [] }));

  const client = new LumaApi2Client('luma.auth-session-key=v');
  await client.listCalendars();

  assert.match(calls[0].url, /\/calendar\/admin\/list$/);
});

test('myEvents() hits /home/get-events with period + limit', async () => {
  const calls = mockFetch(() => jsonResponse({ entries: [] }));

  const client = new LumaApi2Client('luma.auth-session-key=v');
  await client.myEvents('future', 15);

  assert.match(calls[0].url, /\/home\/get-events\?/);
  assert.match(calls[0].url, /period=future/);
  assert.match(calls[0].url, /pagination_limit=15/);
  assert.doesNotMatch(calls[0].url, /calendar_api_id/);
});

test('myEvents() defaults period=future, limit=20', async () => {
  const calls = mockFetch(() => jsonResponse({ entries: [] }));

  const client = new LumaApi2Client('luma.auth-session-key=v');
  await client.myEvents();

  assert.match(calls[0].url, /period=future/);
  assert.match(calls[0].url, /pagination_limit=20/);
});

test('register() POSTs to /event/register with minimal body', async () => {
  const calls = mockFetch(() => jsonResponse({ ticket: { api_id: 't1' } }));

  const client = new LumaApi2Client('luma.auth-session-key=v');
  await client.register({
    eventApiId: 'evt-abc',
    ticketTypeApiId: 'evtticktyp-xyz',
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'POST');
  assert.match(calls[0].url, /\/event\/register$/);

  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.event_api_id, 'evt-abc');
  assert.equal(body.for_waitlist, false);
  assert.equal(body.expected_amount_cents, 0);
  assert.equal(body.currency, null);
  assert.deepEqual(body.ticket_type_to_selection, {
    'evtticktyp-xyz': { count: 1, amount: 0 },
  });
  assert.deepEqual(body.registration_answers, []);
  assert.deepEqual(body.opened_from, { source: 'home' });

  // PII / invite / payment fields omitted unless explicitly supplied
  assert.equal(body.name, undefined);
  assert.equal(body.email, undefined);
  assert.equal(body.event_invite_api_id, undefined);
});

test('register() honors forWaitlist=true', async () => {
  const calls = mockFetch(() => jsonResponse({}));

  const client = new LumaApi2Client('luma.auth-session-key=v');
  await client.register({
    eventApiId: 'evt-abc',
    ticketTypeApiId: 'evtticktyp-xyz',
    forWaitlist: true,
  });

  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.for_waitlist, true);
});

test('register() includes user PII + invite + answers when provided', async () => {
  const calls = mockFetch(() => jsonResponse({}));

  const client = new LumaApi2Client('luma.auth-session-key=v');
  await client.register({
    eventApiId: 'evt-abc',
    ticketTypeApiId: 'evtticktyp-xyz',
    ticketCount: 2,
    eventInviteApiId: 'evinv-123',
    registrationAnswers: [
      { question_id: 'q1', question_type: 'text', value: 'Acme' },
    ],
    user: { name: 'Sam', email: 's@e.com', phoneNumber: '+1...' },
  });

  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.event_invite_api_id, 'evinv-123');
  assert.equal(body.name, 'Sam');
  assert.equal(body.email, 's@e.com');
  assert.equal(body.phone_number, '+1...');
  assert.equal(body.ticket_type_to_selection['evtticktyp-xyz'].count, 2);
  assert.equal(body.registration_answers.length, 1);
  assert.equal(body.registration_answers[0].value, 'Acme');
});

test('register() propagates LumaApi2Error on 400 with validation body', async () => {
  mockFetch(() => textResponse('{"message":"registration_answers required","code":"missing"}', 400));

  const client = new LumaApi2Client('luma.auth-session-key=v');
  await assert.rejects(
    () => client.register({ eventApiId: 'evt-x', ticketTypeApiId: 'evtticktyp-y' }),
    (err) => {
      assert.equal(err.status, 400);
      assert.match(err.bodyText, /registration_answers/);
      return true;
    },
  );
});

#!/usr/bin/env node
/**
 * gmail-wiki-ingest — the I/O half of the skill.
 *
 * Spec: javis.is/docs/superpowers/specs/2026-08-28-gmail-wiki-ingest-skill-migration-design.md
 *
 * Two commands, mirroring calendar-extractor's split: the SCRIPT does the I/O,
 * the AGENT does the reasoning. Nothing in here judges an email — it fetches a
 * batch of headers and posts back the verdicts the agent produced.
 *
 *   fetch   GET-shaped POST to /api/skill/candidates/fetch; prints the envelope
 *   submit  reads the verdict array on stdin; POSTs /api/skill/candidates/submit
 *
 * WHY A SCRIPT AT ALL. The design first had the agent call two openclaw client
 * tools, which needed no script. That transport is invisible to an `openclaw
 * cron` turn — openclaw starts that turn itself and javis-server never builds a
 * body.tools for it — so the trigger and the transport could not both stand.
 * The trigger won, and a cron turn can run a script that makes an HTTP call
 * with the gateway token, which is what this is.
 *
 * Env:
 *   OPENCLAW_GATEWAY_TOKEN  required — Bearer auth to javis-server
 *   JAVIS_SERVER_URL        optional — defaults to http://javis-server:8000
 */
'use strict';

const SERVER = process.env.JAVIS_SERVER_URL || 'http://javis-server:8000';
const SKILL = 'gmail-wiki-ingest';

function requireToken() {
  const t = process.env.OPENCLAW_GATEWAY_TOKEN;
  if (!t) {
    throw new Error(
      'OPENCLAW_GATEWAY_TOKEN is required (injected inside the openclaw container).'
    );
  }
  return t;
}

function parseArgv(argv) {
  const rest = argv.slice(2);
  const cmd = rest.find((a) => !a.startsWith('--')) || '';
  const flag = (name, dflt) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 && i + 1 < rest.length ? rest[i + 1] : dflt;
  };
  return { cmd, flag };
}

/**
 * POST json to `path` and return the parsed body.
 *
 * A non-2xx is returned as an envelope rather than thrown, for the same reason
 * the server 200s its domain errors: the agent has to be able to tell "the
 * mailbox is empty" from "the call failed", and an exception mid-turn reads to
 * it as neither. The one exception is a missing token, which is a broken
 * container rather than a runtime state and should stop the run loudly.
 */
async function postJson(path, body, deps = {}) {
  const fetchFn = deps.fetch || globalThis.fetch;
  const token = deps.token || requireToken();
  let res;
  try {
    res = await fetchFn(`${SERVER}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { status: 'error', error: 'network_error', detail: String(e && e.message || e) };
  }

  let parsed = null;
  try {
    parsed = await res.json();
  } catch (_) {
    parsed = null;
  }
  if (!res.ok) {
    return {
      status: 'error',
      error: (parsed && parsed.detail && parsed.detail.error) || `http_${res.status}`,
      detail: parsed,
    };
  }
  return parsed;
}

async function doFetch(opts = {}, deps = {}) {
  const limit = Number(opts.limit) || 25;
  return postJson('/api/skill/candidates/fetch', { skill: SKILL, limit }, deps);
}

async function doSubmit(verdicts, deps = {}) {
  if (!Array.isArray(verdicts)) {
    return { status: 'error', error: 'verdicts_must_be_an_array' };
  }
  return postJson('/api/skill/candidates/submit', { skill: SKILL, verdicts }, deps);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { buf += d; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}

async function main() {
  const { cmd, flag } = parseArgv(process.argv);

  if (cmd === 'fetch') {
    const out = await doFetch({ limit: flag('limit', '25') });
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (cmd === 'submit') {
    const raw = (await readStdin()).trim();
    let verdicts;
    try {
      verdicts = raw ? JSON.parse(raw) : [];
    } catch (e) {
      // An unparseable verdict list must NOT reach submit as an empty array:
      // an empty submit is a meaningful message (the batch was judged and
      // nothing was worth keeping) and it promotes the cursor past every item
      // in the batch. Silently turning a JSON error into that would skip mail.
      console.log(JSON.stringify(
        { status: 'error', error: 'unparseable_verdicts', detail: e.message },
        null, 2,
      ));
      process.exitCode = 1;
      return;
    }
    const out = await doSubmit(verdicts);
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  console.error('usage: gmail-wiki-ingest.js fetch [--limit N] | submit  (verdicts JSON on stdin)');
  process.exitCode = 2;
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e && e.message ? e.message : String(e));
    process.exitCode = 1;
  });
}

module.exports = { doFetch, doSubmit, postJson, parseArgv, SKILL, SERVER };

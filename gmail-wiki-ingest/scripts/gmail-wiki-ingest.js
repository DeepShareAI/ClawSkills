#!/usr/bin/env node
/**
 * gmail-wiki-ingest — the I/O half of the skill.
 *
 * Spec: javis.is/docs/superpowers/specs/2026-08-28-gmail-wiki-ingest-skill-migration-design.md
 *       javis.is/docs/superpowers/specs/2026-09-04-gmail-wiki-ingest-daily-report-design.md
 *
 * Three commands, mirroring calendar-extractor's split: the SCRIPT does the
 * I/O, the AGENT does the reasoning. Nothing in here judges an email — it
 * fetches a batch of headers, posts back the verdicts the agent produced, and
 * renders a digest out of what the server said about them.
 *
 *   fetch   GET-shaped POST to /api/skill/candidates/fetch; prints the envelope
 *   submit  reads the verdict array on stdin; POSTs /api/skill/candidates/submit
 *   report  reads {headline, notes} on stdin; POSTs the run digest to
 *           /api/agent/push and clears the run state
 *
 * WHY A SCRIPT AT ALL. The design first had the agent call two openclaw client
 * tools, which needed no script. That transport is invisible to an `openclaw
 * cron` turn — openclaw starts that turn itself and javis-server never builds a
 * body.tools for it — so the trigger and the transport could not both stand.
 * The trigger won, and a cron turn can run a script that makes an HTTP call
 * with the gateway token, which is what this is.
 *
 * WHY THE REPORT IS SPLIT IN TWO. The run is otherwise silent by design, and
 * that silence makes a quiet mailbox indistinguishable from a broken sync. The
 * fix is one message a day — but the numbers in it are facts only the server
 * holds, and the subjects in it are text strangers wrote. So the agent authors
 * *prose* (a headline, optional per-thread notes) and this script renders
 * *facts*: every counter, subject and sender comes back out of the run-state
 * file below, and the agent never retypes one.
 *
 * Env:
 *   OPENCLAW_GATEWAY_TOKEN  required — Bearer auth to javis-server
 *   JAVIS_SERVER_URL        optional — defaults to http://javis-server:8000
 */
'use strict';

const fs = require('fs');
const path = require('path');

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

// The clock, injectable everywhere it is read. `started_at` and the 6-hour
// staleness window are the only things standing between "today's run" and a
// leftover file from a run that died yesterday, so a test has to be able to
// move time without moving the machine's.
function nowMs(deps = {}) {
  if (typeof deps.now === 'function') return Number(deps.now());
  if (deps.now != null) return Number(deps.now);
  return Date.now();
}

function nowIso(deps) {
  return new Date(nowMs(deps)).toISOString();
}

/**
 * POST json to `path` and return the parsed body.
 *
 * A non-2xx is returned as an envelope rather than thrown, for the same reason
 * the server 200s its domain errors: the agent has to be able to tell "the
 * mailbox is empty" from "the call failed", and an exception mid-turn reads to
 * it as neither. The one exception is a missing token, which is a broken
 * container rather than a runtime state and should stop the run loudly.
 *
 * It never returns a bare `null`. A 2xx whose body is not JSON — an ingress
 * that answered before the app did, a truncated response — is a transport
 * failure wearing a success code, and handing `null` back to a caller that is
 * about to read `.status` off it turns that into a TypeError two frames later,
 * which the shell then reports with the exit code reserved for a malformed
 * agent payload.
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
  if (parsed == null || typeof parsed !== 'object') {
    return { status: 'error', error: 'unparseable_response', detail: `http_${res.status}` };
  }
  return parsed;
}

// postJson's failure envelope is the only shape it invents; every 2xx body is
// the server's own. So "did the call land" is exactly "is this not that shape",
// which is what `report` tests before it deletes the run state.
function failed(envelope) {
  return !envelope || envelope.status === 'error';
}

// ---- run state -----------------------------------------------------------
/**
 * `data/last-run.json` — the single source of every fact a report renders.
 *
 * `fetch` writes what the server offered, `submit` merges what the server did,
 * `report` reads both back and deletes the file once the digest has landed.
 * Nothing the agent typed reaches the counters or the subject lines; a footer
 * the agent transcribed would be decorative rather than evidential, and a
 * subject the agent paraphrased is no longer the subject the user received.
 *
 * `fetch` OVERWRITES rather than merges, and that is what makes the empty-batch
 * path fall out for free: state exists even on a run where `submit` never
 * happened, so `report` renders "nothing new" from real server-issued filter
 * counters instead of from a special case. It also means yesterday's leftovers
 * can never be read as today's run.
 *
 * The path resolves against __dirname rather than cwd, following
 * calendar-extractor/scripts/data.js, so the file travels with the skill bundle
 * wherever the container mounts it and does not depend on where the cron turn
 * happened to be standing when it shelled out.
 */
const STATE_PATH = path.join(__dirname, '../data/last-run.json');

// Absent and corrupt are the same condition to every caller: there is no run
// behind this file. Telling them apart would only let a half-written file
// produce a half-true digest.
function readState(deps = {}) {
  try {
    return JSON.parse(fs.readFileSync(deps.statePath || STATE_PATH, 'utf-8'));
  } catch (_) {
    return null;
  }
}

// Atomic write: serialize to a sibling .tmp then rename over the target, the
// same shape calendar-extractor uses. rename(2) is atomic within a filesystem,
// so a container reaped mid-write can never leave behind a file that parses
// into a partial run.
function writeState(state, deps = {}) {
  const file = deps.statePath || STATE_PATH;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

function deleteState(deps = {}) {
  try {
    fs.unlinkSync(deps.statePath || STATE_PATH);
    return true;
  } catch (_) {
    return false;
  }
}

// A failed state write must never turn a good server call into a failed one:
// the agent has the batch in hand and still has to judge it. The cost of the
// lost write is this run's report — `report` finds no file and refuses — which
// is far cheaper than losing the batch.
function saveState(state, deps) {
  try {
    writeState(state, deps);
  } catch (e) {
    console.error(`run state not written: ${e && e.message ? e.message : e}`);
  }
}

async function doFetch(opts = {}, deps = {}) {
  const limit = Number(opts.limit) || 25;
  const out = await postJson('/api/skill/candidates/fetch', { skill: SKILL, limit }, deps);
  if (!failed(out) && out.status === 'ok') {
    const items = Array.isArray(out.items) ? out.items : [];
    // Only the three fields a bullet renders are kept. `date`, `rfc822_msgid`
    // and `message_count` are the agent's business for the length of the turn;
    // parking them on disk would widen the footprint of a file whose whole job
    // is to outlive the turn.
    saveState({
      started_at: nowIso(deps),
      n_items: items.length,
      filtered: (out.filtered && typeof out.filtered === 'object') ? out.filtered : {},
      items: items.map((it) => ({
        thread_id: it && it.thread_id,
        subject: it && it.subject,
        from: it && it.from,
      })),
    }, deps);
  }
  return out;
}

// What `submit` contributes to the run state. `acted` is the join key half —
// one row per verdict, LOW included — and the rest is the footer.
const SUBMIT_FIELDS = [
  'high', 'middle', 'low', 'unvalidated', 'dropped',
  'rejected', 'uncovered', 'promoted',
];

async function doSubmit(verdicts, deps = {}) {
  if (!Array.isArray(verdicts)) {
    return { status: 'error', error: 'verdicts_must_be_an_array' };
  }
  const out = await postJson('/api/skill/candidates/submit', { skill: SKILL, verdicts }, deps);
  if (!failed(out) && out.status === 'ok') {
    // MERGES, where fetch overwrites: the report's join needs both halves, and
    // `items` only exists on the fetch side. A submit that arrives with no
    // prior state (a fetch whose write failed) still records what it can, and
    // `report` then refuses on the missing started_at rather than on a
    // half-populated file it cannot date.
    const merged = Object.assign({}, readState(deps) || {}, {
      acted: Array.isArray(out.acted) ? out.acted : [],
      submitted_at: nowIso(deps),
    });
    for (const key of SUBMIT_FIELDS) merged[key] = out[key];
    saveState(merged, deps);
  }
  return out;
}

// ---- sanitization --------------------------------------------------------
/**
 * Subjects and senders are written by people who are not the user, and they are
 * about to be rendered as markdown inside the user's chat. Everything below
 * exists so that a hostile header is *visible but inert*: it renders as literal
 * text, it cannot forge a bullet or a counter footer, and nothing downstream
 * feeds it back to the agent as instruction.
 *
 * `headline` and `notes` go through the identical treatment even though they
 * are model-authored: a model that has just read a batch of hostile subject
 * lines is perfectly capable of relaying one.
 */
const MAX_HEADER_CHARS = 80;   // subject, sender
const MAX_PROSE_CHARS = 120;   // headline, notes

// Anything that could open a link, an autolink or a scheme handler. Matched
// before the markdown escaping below so that the replacement text's own parens
// get escaped along with everything else.
const URL_RE = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.|mailto:|data:|javascript:)\S*/gi;

// GFM autolinks a *bare* address out of running text — `billing@evil.example`
// becomes a tappable mailto with no markdown syntax anywhere in the subject —
// and an escape cannot reach inside a text run the autolinker post-processes.
// So the `@` goes, and only the `@`: unlike a URL, the address IS the
// information (a From header is mostly address), so it is defused in place
// rather than redacted the way `(link removed)` redacts a URL.
const EMAIL_RE =
  /([^\s@<>()[\]",;:]+)@([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)/gi;

// The backslash is FIRST in the class, and it is the whole reason this is one
// pass instead of two. A subject that supplies its own `\` before an active
// character would otherwise consume the escape we are about to add — `\*x\*`
// escaping to `\\*x\\*` reads as a literal backslash plus live emphasis — so
// the escaper's own escape has to be escapable, and every active has to be
// visited exactly once.
//
// `<` and `>` are in the set for two separate reasons: an inline `<br>` is raw
// HTML the chat renderer turns into a real line break (rule 1's forgery, by
// another door), and `<ada@x.com>` is a CommonMark autolink, which is how a
// From header would otherwise render as a tappable link.
const MD_ACTIVE_RE = /[\\*_[\]()`<>]/g;

// Characters that can start a new line where none was written. CR and LF are
// the obvious pair, but the iOS text layer breaks on U+2028, U+2029 and NEL
// (U+0085) too, and `.trim()` alone does not remove them from the middle of a
// string — so a subject carrying one still forges a counter footer.
const LINE_BREAKING_RE = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]+/g;

// Characters that are invisible or reorder what surrounds them: zero-width
// spaces and joiners hide a boundary, the bidi overrides make a sender read
// backwards. Neither belongs in a header, and neither is escapable — they are
// not syntax, they are the rendering.
const INVISIBLE_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

function sanitize(value, max) {
  let s = String(value == null ? '' : value);

  // 4. Never a link and never a bare URL. Escaping the brackets below kills
  //    markdown link syntax, but GFM autolinks a naked `https://…`, `www.…` or
  //    `name@host.tld` out of the text itself, where an escape cannot reach
  //    it. The only defence is to not emit the sequence.
  s = s.replace(URL_RE, '(link removed)').replace(EMAIL_RE, '$1 at $2');

  // 1. Anything that could break a line collapses to a single space, and
  //    anything invisible is dropped outright. A newline inside a subject
  //    otherwise forges a bullet of its own, or a whole counter footer, in a
  //    message the user reads as server-issued.
  s = s.replace(LINE_BREAKING_RE, ' ').replace(INVISIBLE_RE, '').trim();

  // 2. The markdown actives — the backslash among them, so that a subject
  //    cannot supply the escape that disarms our own — then any leading `#`
  //    or `-`, which turn a line into a heading or a list item. `>`, the
  //    third, is escaped as an active above.
  s = s.replace(MD_ACTIVE_RE, (c) => `\\${c}`);
  s = s.replace(/^[#-]+/, (run) => run.replace(/./g, (c) => `\\${c}`));

  // 3. Truncate on grapheme-ish units rather than UTF-16 code units: `.slice`
  //    on a subject full of emoji or CJK cuts a surrogate pair in half and
  //    emits a replacement character.
  return truncate(s, max);
}

function truncate(s, max) {
  const chars = Array.from(s);
  if (chars.length <= max) return s;
  // A cut that lands between a backslash and the character it escapes leaves a
  // dangling escape, which then eats the `**` that closes the bullet's bold.
  const kept = chars.slice(0, max - 1).join('')
    .replace(/\\+$/, (run) => (run.length % 2 ? run.slice(0, -1) : run));
  return `${kept}…`;
}

// ---- rendering -----------------------------------------------------------
const HEADER_PREFIX = '📨 Gmail → Wiki — ';
const SECTION_TITLES = { high: 'Added to your wiki', middle: 'Waiting for your confirm' };
const MAX_BULLETS = 5;

// Well under AgentPushRequest.content's 50,000, because the ceiling that
// matters is a chat bubble a human scrolls past rather than the schema's. With
// MAX_BULLETS in force this is a backstop against pathological headers, not the
// primary volume control.
const MAX_MESSAGE_CHARS = 8000;

function renderSection(band, rows, notes) {
  if (!rows.length) return [];
  const lines = [`**${SECTION_TITLES[band]}**`];
  for (const item of rows.slice(0, MAX_BULLETS)) {
    const subject = sanitize(item.subject || '(no subject)', MAX_HEADER_CHARS);
    const from = sanitize(item.from || '(unknown sender)', MAX_HEADER_CHARS);
    lines.push(`• **${subject}** — ${from}`);
    const note = notes[item.thread_id];
    if (typeof note === 'string' && note.trim()) {
      lines.push(`  → ${sanitize(note, MAX_PROSE_CHARS)}`);
    }
  }
  if (rows.length > MAX_BULLETS) lines.push(`...and ${rows.length - MAX_BULLETS} more`);
  return lines;
}

/**
 * The footer, and the only place LOW is ever visible.
 *
 * Two shapes, chosen by whether `submit` ever answered. The fetch-only shape
 * carries the filter breakdown because it is the only thing that footer has to
 * say, and because a discard's *cause* has to stay knowable after the fact — a
 * thread that vanished at the machine-mail filter and one that lost the LOW
 * band must not read the same in the morning.
 */
function renderFooter(state) {
  const filtered = (state.filtered && typeof state.filtered === 'object') ? state.filtered : {};
  const counted = Object.entries(filtered).filter(([, n]) => Number(n) > 0);
  const total = counted.reduce((sum, [, n]) => sum + Number(n), 0);

  if (!state.submitted_at) {
    const detail = counted.length
      ? ` (${counted.map(([k, n]) => `${k} ${n}`).join(', ')})`
      : '';
    return `${Number(state.n_items) || 0} fetched · filtered ${total}${detail}`;
  }

  return [
    `high=${Number(state.high) || 0}`,
    `middle=${Number(state.middle) || 0}`,
    `low=${Number(state.low) || 0}`,
    `filtered ${total}`,
    state.promoted ? 'cursor promoted' : 'cursor held',
  ].join(' · ');
}

/**
 * Render the whole message from run state plus the agent's prose.
 *
 * The join is `acted[]` against `items[]` on thread_id, **HIGH and MIDDLE
 * only**. `submit`'s `acted` carries a row per verdict, LOW included, so the
 * band filter is what keeps a digest from burying the two threads that need an
 * answer under the twenty-two that do not. LOW reaches the footer count and
 * nowhere else.
 *
 * An `acted` row whose thread_id is not in `items` has no subject to render and
 * is dropped, as is a `notes` key matching no thread — silently, both of them,
 * because neither is something the user can act on.
 */
function renderReport(state, input) {
  const notes = (input && input.notes && typeof input.notes === 'object') ? input.notes : {};
  const byThread = new Map();
  for (const it of (Array.isArray(state.items) ? state.items : [])) {
    if (it && it.thread_id) byThread.set(String(it.thread_id), it);
  }

  const bands = { high: [], middle: [] };
  for (const row of (Array.isArray(state.acted) ? state.acted : [])) {
    if (!row || !Object.prototype.hasOwnProperty.call(bands, row.band)) continue;
    const item = byThread.get(String(row.item_key));
    if (item) bands[row.band].push(item);
  }

  const lines = [HEADER_PREFIX + sanitize(input.headline, MAX_PROSE_CHARS), ''];
  const body = [
    ...renderSection('high', bands.high, notes),
    ...renderSection('middle', bands.middle, notes),
  ];
  if (body.length) lines.push(...body, '');
  lines.push('—', renderFooter(state));

  return truncate(lines.join('\n'), MAX_MESSAGE_CHARS);
}

// ---- report --------------------------------------------------------------
// A report with no run behind it is a lie. Six hours is longer than any real
// gap between a run's fetch and its report, and short enough that yesterday's
// abandoned state can never be dressed up as this morning's digest.
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

/**
 * Push the run digest, then clear the run state.
 *
 * NO `session_id` and NO `dedup_key`, deliberately. With neither set the server
 * resolves `session_source="history"`, which joins the newest existing
 * `gmail-wiki-ingest` session — the one running thread this design wants, so
 * that a daily message appends to yesterday's rather than opening a new branch
 * of the chat tree every morning.
 *
 * The state file is deleted only once the push has landed. A non-2xx comes back
 * as postJson's envelope and leaves the file on disk, so a manual re-run of
 * `report` is a working retry rather than a refusal.
 */
async function doReport(input, deps = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || typeof input.headline !== 'string' || !input.headline.trim()) {
    // Never degrade to an empty headline: a report is cheap to retry and a
    // wrong one is not.
    return { status: 'error', error: 'headline_required' };
  }

  const state = readState(deps);
  if (!state) return { status: 'error', error: 'no_recent_run' };

  const started = Date.parse(state.started_at);
  if (!(started > 0) || nowMs(deps) - started > STALE_AFTER_MS) {
    return { status: 'error', error: 'stale_run', started_at: state.started_at || null };
  }

  const content = renderReport(state, input);
  const pushed = await postJson('/api/agent/push', { skill: SKILL, content }, deps);
  if (failed(pushed)) return pushed;

  deleteState(deps);
  return { status: 'ok', content };
}

// A refusal has to be visible to the shell, because the agent is not the only
// thing reading this: a cron turn that produced no report should be diagnosable
// from the exit code alone. Everything else keeps postJson's contract, where an
// error envelope on stdout is the signal and the exit code stays 0.
const REPORT_EXIT_CODES = { no_recent_run: 2, stale_run: 2, headline_required: 1 };

function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { buf += d; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}

/**
 * The whole dispatch, one frame below process.argv and process.exitCode.
 *
 * It is split out of `main` because the exit code is a contract, not a detail:
 * a cron turn that produced no report is diagnosable from it alone, and a
 * table asserted against itself proves nothing about the code that reads it.
 * Everything the shell observes is decided here and returned; `main` only
 * prints it. `stdin` arrives as a string because a command that does not read
 * stdin must not block waiting for one.
 *
 * `out === null` means the argv named no command, and is the usage case.
 */
async function runCommand(argv, stdin, deps = {}) {
  const { cmd, flag } = parseArgv(argv);
  const raw = String(stdin == null ? '' : stdin).trim();

  if (cmd === 'fetch') {
    return { out: await doFetch({ limit: flag('limit', '25') }, deps), exitCode: 0 };
  }

  if (cmd === 'submit') {
    let verdicts;
    try {
      verdicts = raw ? JSON.parse(raw) : [];
    } catch (e) {
      // An unparseable verdict list must NOT reach submit as an empty array:
      // an empty submit is a meaningful message (the batch was judged and
      // nothing was worth keeping) and it promotes the cursor past every item
      // in the batch. Silently turning a JSON error into that would skip mail.
      return {
        out: { status: 'error', error: 'unparseable_verdicts', detail: e.message },
        exitCode: 1,
      };
    }
    return { out: await doSubmit(verdicts, deps), exitCode: 0 };
  }

  if (cmd === 'report') {
    let input;
    try {
      input = raw ? JSON.parse(raw) : null;
    } catch (e) {
      return {
        out: { status: 'error', error: 'unparseable_report_input', detail: e.message },
        exitCode: 1,
      };
    }
    const out = await doReport(input, deps);
    const exitCode = out && out.status === 'error' ? (REPORT_EXIT_CODES[out.error] || 0) : 0;
    return { out, exitCode };
  }

  return { out: null, exitCode: 2 };
}

const USAGE = 'usage: gmail-wiki-ingest.js fetch [--limit N]'
  + ' | submit  (verdicts JSON on stdin)'
  + ' | report  ({"headline":"…","notes":{…}} on stdin)';

async function main() {
  const { cmd } = parseArgv(process.argv);
  // Only the two commands with a stdin contract wait for one. Reading it
  // unconditionally would hang `fetch` on a terminal that never closes it.
  const stdin = (cmd === 'submit' || cmd === 'report') ? await readStdin() : '';

  const { out, exitCode } = await runCommand(process.argv, stdin);
  if (out === null) console.error(USAGE);
  else console.log(JSON.stringify(out, null, 2));
  if (exitCode) process.exitCode = exitCode;
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e && e.message ? e.message : String(e));
    process.exitCode = 1;
  });
}

module.exports = {
  runCommand,
  doFetch,
  doSubmit,
  doReport,
  postJson,
  parseArgv,
  readState,
  writeState,
  deleteState,
  sanitize,
  truncate,
  renderReport,
  renderFooter,
  REPORT_EXIT_CODES,
  STATE_PATH,
  STALE_AFTER_MS,
  MAX_BULLETS,
  MAX_MESSAGE_CHARS,
  SKILL,
  SERVER,
};

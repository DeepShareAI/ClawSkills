#!/usr/bin/env node
/**
 * brainstorming — pure logic library (no network, no stdin, no fs).
 *
 * Everything here is deterministic and unit-testable: tz resolution,
 * the relative-date anchor, the to-do dedup key, the ready-to-paste
 * prompt-template assembly, and TTL pruning of the local `seen` map.
 * The CLI (`brainstorming.js`) requires these and stays thin.
 */
'use strict';

const SEEN_TTL_DAYS = 30;

// ---- tz resolution -------------------------------------------------------
// tz resolution order: tz from the fetch payload -> TZ env var -> system zone.
// No per-user prefs lookup; identical discipline to calendar-extractor.
function resolveTz(payloadTz) {
  if (payloadTz && typeof payloadTz === 'string' && payloadTz.trim()) return payloadTz.trim();
  if (process.env.TZ && process.env.TZ.trim()) return process.env.TZ.trim();
  try {
    const z = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (z) return z;
  } catch (_) { /* fall through */ }
  return 'UTC';
}

// ---- naive-local wall-clock ----------------------------------------------
// Render an instant as zoneless local wall-clock in `tz` (no Z). Used only for
// the relative-date anchor handed to the agent; to-do rows carry NO date.
function toNaiveLocal(iso, tz) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(d).reduce((o, x) => ((o[x.type] = x.value), o), {});
  let { year, month, day, hour } = p;
  // Node/V8 emits "00" at local midnight, but some ICU builds emit "24:00",
  // meaning the END of this calendar day (= start of the next). Normalize to
  // "00" AND roll the date forward a day, else the result is off by a full day.
  if (hour === '24') {
    hour = '00';
    const next = new Date(Date.UTC(+year, +month - 1, +day) + 86400000);
    year = String(next.getUTCFullYear()).padStart(4, '0');
    month = String(next.getUTCMonth() + 1).padStart(2, '0');
    day = String(next.getUTCDate()).padStart(2, '0');
  }
  return `${year}-${month}-${day}T${hour}:${p.minute}:${p.second}`;
}

// Build the relative-date anchor handed to the agent — the LOCAL wall-clock in
// `tz`, plus the explicit local date and weekday and the raw instant. Identical
// to calendar-extractor so the agent never resolves "today" off a UTC instant.
function localAnchor(iso, tz) {
  const local = toNaiveLocal(iso, tz);
  const d = new Date(iso);
  const weekday = isNaN(d.getTime())
    ? null
    : new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(d);
  return {
    reference_time: local,
    reference_date: local ? local.slice(0, 10) : null,
    reference_weekday: weekday,
    reference_time_utc: iso,
  };
}

// ---- to-do dedup key -----------------------------------------------------
// A to-do card has no date, so its identity is (title + goal). Hashing the goal
// keeps the key stable and bounded even for long goals. Two cards with the same
// title but different goals stay distinct (re-brainstorming the same unit toward
// a new objective is a genuinely new card).
function normalizeText(s) {
  return (s == null ? '' : String(s)).toLowerCase().replace(/\s+/g, ' ').trim();
}

// A tiny, dependency-free 32-bit FNV-1a hash, hex-encoded. Builtins only — no
// `crypto` import needed, deterministic across Node versions.
function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function todoDedupKey(card) {
  const title = normalizeText(card && card.title);
  const goal = normalizeText(card && card.goal);
  return `${title}|${hash32(goal)}`.slice(0, 512);
}

// ---- ready-to-paste prompt-template assembly -----------------------------
// The literal template from the design spec. The agent supplies the bracketed
// fields ({goal, request[], source_refs[]}); everything else is fixed text so a
// Confirm always copies a coherent content-brainstorming hand-off prompt.
function composePrompt(card) {
  const goal = normalizeText(card && card.goal) || 'organize my thoughts on this';
  const refs = Array.isArray(card && card.source_refs)
    ? card.source_refs.map((r) => String(r).trim()).filter(Boolean)
    : [];
  const refList = refs.length ? refs.join(', ') : '(see my recent voice notes)';
  const requests = Array.isArray(card && card.request)
    ? card.request.map((r) => String(r).trim()).filter(Boolean)
    : [];
  const bullets = (requests.length ? requests : ['a structured brief I can act on'])
    .map((r) => `- ${r}`)
    .join('\n');

  return [
    `I want to ${card && card.goal ? String(card.goal).trim() : goal}.`,
    '',
    `Source: my Javis voice note(s), session_id(s): ${refList}. Before we start, pull the full`,
    'transcript via the javis_mcp connector (get_transcript_tool / search_transcripts_tool).',
    '',
    'Please produce:',
    bullets,
    '',
    'Run the content-brainstorming flow: ask me clarifying questions one at a time,',
    'inventory the source material, then produce a structured brief before drafting.',
  ].join('\n');
}

// ---- TTL pruning ---------------------------------------------------------
// Generic pruner for any { key: <something-with-a-timestamp> } map. `tsOf`
// extracts the ISO timestamp from each value; entries older than the 30-day
// cutoff (or with an unparseable ts) are dropped.
function pruneByTtl(map, tsOf, ttlDays) {
  const days = ttlDays == null ? SEEN_TTL_DAYS : ttlDays;
  const cutoff = Date.now() - days * 86400 * 1000;
  const out = {};
  for (const [k, v] of Object.entries(map || {})) {
    const t = Date.parse(tsOf(v));
    if (!isNaN(t) && t >= cutoff) out[k] = v;
  }
  return out;
}

// `seen` is a { key: isoTimestamp } map — the value IS the timestamp.
function pruneSeen(seen, ttlDays) {
  return pruneByTtl(seen, (iso) => iso, ttlDays);
}

module.exports = {
  SEEN_TTL_DAYS,
  resolveTz,
  toNaiveLocal,
  localAnchor,
  normalizeText,
  hash32,
  todoDedupKey,
  composePrompt,
  pruneByTtl,
  pruneSeen,
};

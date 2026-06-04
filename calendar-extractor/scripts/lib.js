#!/usr/bin/env node
/**
 * calendar-extractor — pure logic library (no network, no stdin, no fs).
 *
 * Everything here is deterministic and unit-testable: event normalization,
 * dedup keys, TTL pruning, per-unit keying, and the manual-path partition.
 * The CLI (`calendar-extractor.js`) requires these and stays thin.
 */
'use strict';

const SEEN_TTL_DAYS = 30;

// ---- event normalization -------------------------------------------------
function isoOrNull(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function normalizeEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = (raw.title || raw.name || raw.event_name || '').toString().trim();
  if (!title) return null;
  const startAt = isoOrNull(raw.start_at || raw.start_time || raw.start || raw.date);
  const endAt = isoOrNull(raw.end_at || raw.end_time || raw.end);
  const location = (raw.location || raw.address || '').toString().trim() || null;
  const attendees = Array.isArray(raw.attendees)
    ? raw.attendees.map((a) => a.toString().trim()).filter(Boolean)
    : (typeof raw.attendees === 'string' && raw.attendees.trim() ? [raw.attendees.trim()] : []);
  const notes = (raw.notes || raw.description || '').toString().trim() || null;
  const sourceRef = (raw.source_ref || raw.session_id || '').toString().trim() || null;
  const sourceKind = (raw.source_kind || raw.source || '').toString().trim().toLowerCase() || null;
  return { title, startAt, endAt, location, attendees, notes, sourceRef, sourceKind };
}

function dedupKey(ev) {
  const day = ev.startAt ? ev.startAt.slice(0, 10) : 'nodate';
  const title = ev.title.toLowerCase().replace(/\s+/g, ' ').trim();
  return `${day}|${title}|${ev.startAt || ''}`.slice(0, 512);
}

// ---- per-unit keying -----------------------------------------------------
// A unit is "kbd:<source_ref>" for keyboard input, else "audio:<source_ref>".
// source_kind carries through normalizeEvent (from the session's `source`).
function unitKeyFor(event) {
  if (!event || typeof event !== 'object') return null;
  const ref = (event.sourceRef || '').toString().trim();
  if (!ref) return null;
  const kind = (event.sourceKind || '').toString().trim().toLowerCase();
  return kind === 'keyboard' ? `kbd:${ref}` : `audio:${ref}`;
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

// `extractedUnits` is a { unitKey: { ts, events } } map — ts lives on the value.
function pruneExtractedUnits(units, ttlDays) {
  return pruneByTtl(units, (u) => (u && u.ts), ttlDays);
}

// ---- manual-path partition -----------------------------------------------
// Split incoming events by unit against the extractedUnits flag store:
//   - flaggedUnits: units already extracted (display-only). Each carries the
//     CACHED events from extractedUnits — not the freshly-fetched ones — so the
//     digest re-shows exactly what was first written, without a table re-write.
//   - freshEvents:  events whose unit is not yet flagged (gap-fill: extract +
//     write + push + flag).
// Events with no derivable unit key are treated as fresh.
function partitionForManual(events, extractedUnits) {
  const units = extractedUnits || {};
  const flaggedKeys = [];
  const seenFlagged = new Set();
  const freshEvents = [];
  for (const ev of events || []) {
    const key = unitKeyFor(ev);
    if (key && units[key]) {
      if (!seenFlagged.has(key)) {
        seenFlagged.add(key);
        flaggedKeys.push(key);
      }
    } else {
      freshEvents.push(ev);
    }
  }
  const flaggedUnits = flaggedKeys.map((key) => ({
    key,
    events: Array.isArray(units[key].events) ? units[key].events : [],
  }));
  return { flaggedUnits, freshEvents };
}

module.exports = {
  SEEN_TTL_DAYS,
  isoOrNull,
  normalizeEvent,
  dedupKey,
  unitKeyFor,
  pruneByTtl,
  pruneSeen,
  pruneExtractedUnits,
  partitionForManual,
};

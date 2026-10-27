'use strict';
// SKILL.md and repo wiring — R6 (low-risk dispatch route), R7 (extraction
// rules), R9 (the 9 categories), R25 (chat runs the counting script).
// TC-S0-3 (route declared), TC-S5-3 (SKILL.md routes both questions to the script).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..');
const md = fs.readFileSync(path.join(DIR, 'SKILL.md'), 'utf8');
const front = md.match(/^---\n([\s\S]*?)\n---/)[1];

test('SKILL.md [R6, TC-S0-3]: front matter declares the low-risk ledger route', () => {
  assert.match(front, /^name: todo-spend-tracker$/m);
  assert.match(front, /- route_id: ledger\n\s+skill: todo-spend-tracker\n/);
  assert.match(front, /risk: low/);
});

test('SKILL.md [R9]: lists the 9 categories exactly, in order', () => {
  const line = md.split('\n').map((l) => l.trim()).find((l) => l.startsWith('Categories (exactly one): '));
  assert.ok(line, 'categories line');
  assert.equal(line.replace('Categories (exactly one): ', ''),
    '`Food & drink`, `Groceries`, `Transport`, `Shopping`, `Bills & subscriptions`, `Entertainment`, `Health`, `Travel`, `Other`');
});

test('SKILL.md [R7]: states the extraction rules', () => {
  for (const s of ['first person', 'speaker_', 'keyboard', 'calendar-extractor', 'fetch-open', '25 words', 'Chinese']) {
    assert.ok(md.includes(s), `SKILL.md should mention ${s}`);
  }
});

test('SKILL.md [R25, TC-S5-3]: chat questions run the counting script and copy its numbers', () => {
  assert.ok(md.includes('node scripts/ledger.js todos'));
  assert.ok(md.includes('node scripts/ledger.js spending'));
  assert.match(md, /copy its numbers/i);
  assert.ok(md.includes('javis://todos'));
  assert.ok(md.includes('javis://todos/month'));
});

test('SKILL.md [R0-6]: the push step never pipes user quotes through echo \'…\'', () => {
  assert.doesNotMatch(md, /\|\s*node scripts\/todo-spend-tracker\.js push/);
  assert.ok(md.includes('push --file'));
  assert.ok(md.includes("<<'JAVIS_LEDGER_JSON'"));
});

test('SKILL.md [R0-5, R0-4, R0-2]: documents the unit field, the date window and the no-fallback read', () => {
  assert.match(md, /"unit":/);
  assert.match(md, /last month\s+or this month/);
  assert.match(md, /source` is `unavailable`/);
  assert.doesNotMatch(md, /data\/users/);
});

test('repo [R6]: todo-spend-tracker is in hijavis-skills.json', () => {
  const list = JSON.parse(fs.readFileSync(path.join(DIR, '..', 'hijavis-skills.json'), 'utf8'));
  assert.ok(list.skills.includes('todo-spend-tracker'));
});

test('repo: starters.json passes the shared validator', () => {
  const { validate } = require('../../scripts/validate-starters');
  const starters = JSON.parse(fs.readFileSync(path.join(DIR, 'starters.json'), 'utf8'));
  assert.deepEqual(validate(starters, md), []);
});

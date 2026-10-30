'use strict';
// HiJavis skill catalog — hijavis-skills.json schema v3.
// Proves R3 (test plan TC-S0-2): version 3, `skills` is the plain slug list
// today's app parses and equals the catalog slugs in order, every catalog
// entry carries the required keys, and each slug equals its folder's SKILL.md
// `name:`.
// Run from the ClawSkills root: node --test test/

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CATALOG = JSON.parse(fs.readFileSync(path.join(ROOT, 'hijavis-skills.json'), 'utf8'));

const REQUIRED = {
  slug: 'string',
  folder: 'string',
  default: 'boolean',
  display_name: 'string',
  summary: 'string',
  creator: 'string',
  license: 'string',
};

function skillMdName(folder) {
  const p = path.join(ROOT, folder, 'SKILL.md');
  assert.ok(fs.existsSync(p), `${folder}/SKILL.md exists`);
  const md = fs.readFileSync(p, 'utf8');
  const fm = md.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(fm, `${folder}/SKILL.md has front matter`);
  const line = fm[1].split('\n').find((l) => l.startsWith('name:'));
  assert.ok(line, `${folder}/SKILL.md has a name: line`);
  return line.slice('name:'.length).trim();
}

test('catalog [R3, TC-S0-2]: schema version is 3', () => {
  assert.equal(CATALOG.version, 3);
});

test('catalog [R3, TC-S0-2]: skills is a plain slug list equal to the catalog slugs, in order', () => {
  assert.ok(Array.isArray(CATALOG.skills));
  for (const s of CATALOG.skills) assert.equal(typeof s, 'string');
  assert.ok(Array.isArray(CATALOG.catalog) && CATALOG.catalog.length > 0);
  assert.deepEqual(CATALOG.skills, CATALOG.catalog.map((e) => e.slug));
});

test('catalog [R3, TC-S0-2]: every entry has the required keys with the right types', () => {
  for (const e of CATALOG.catalog) {
    for (const [k, type] of Object.entries(REQUIRED)) {
      assert.ok(k in e, `${e.slug}: missing ${k}`);
      assert.equal(typeof e[k], type, `${e.slug}: ${k} should be ${type}`);
      if (type === 'string') assert.ok(e[k].trim().length > 0, `${e.slug}: ${k} is empty`);
    }
  }
});

test('catalog [R3, TC-S0-2]: slugs and folders are unique', () => {
  const slugs = CATALOG.catalog.map((e) => e.slug);
  const folders = CATALOG.catalog.map((e) => e.folder);
  assert.equal(new Set(slugs).size, slugs.length);
  assert.equal(new Set(folders).size, folders.length);
});

test('catalog [R3, TC-S0-2]: every slug equals its folder SKILL.md name:', () => {
  for (const e of CATALOG.catalog) {
    assert.equal(skillMdName(e.folder), e.slug, `${e.folder}/SKILL.md name`);
  }
});

test('catalog [R3, TC-S0-2]: ships the agreed skills, defaults, creator and license', () => {
  assert.deepEqual(
    CATALOG.catalog.map((e) => [e.slug, e.folder, e.default]),
    [
      ['calendar-extractor', 'calendar-extractor', true],
      ['gmail-wiki-ingest', 'gmail-wiki-ingest', true],
      ['javis-todo-spend-tracker', 'todo-spend-tracker', true],
      ['javis-brainstorming', 'brainstorming', false],
    ],
  );
  for (const e of CATALOG.catalog) {
    assert.equal(e.creator, 'samuel-wei');
    assert.equal(e.license, 'MIT-0');
  }
});

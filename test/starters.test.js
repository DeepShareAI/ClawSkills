'use strict';
// Agent Chat starters — repo-root validator suite.
// Proves R2, R12, R13, R14 (test plan TC-S1-1, TC-S1-2, TC-S1-4, TC-S0-1..3).
// Run from the ClawSkills root: node --test test/

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { validate, skillName } = require('../scripts/validate-starters');

const ROOT = path.join(__dirname, '..');

// Every <skill>/starters.json one level below the repo root (the bundle layout).
function starterFiles() {
  return fs
    .readdirSync(ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
    .map((d) => path.join(ROOT, d.name, 'starters.json'))
    .filter((p) => fs.existsSync(p));
}

function readSkillMd(dir) {
  const p = path.join(dir, 'SKILL.md');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

const SKILL_MD = '---\nname: demo-skill\ndescription: x\n---\n\n# Demo\n';

function good() {
  return {
    version: 1,
    title: 'Demo',
    icon: 'sparkles',
    starters: [
      {
        id: 'demo-one',
        label: 'Do the demo thing',
        prompt: 'demo',
        source: 'recordings',
        requires: ['has_recording'],
        order: 10,
      },
      {
        id: 'demo-two',
        label: 'Do the other demo thing',
        prompt: 'demo two',
        source: 'inbox',
        requires: [],
        order: 20,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// R12 / TC-S1-1 — every real starters.json in the repo passes the validator.
// ---------------------------------------------------------------------------

test('R12 TC-S1-1: every */starters.json in the repo is valid', () => {
  const files = starterFiles();
  assert.ok(files.length >= 3, `expected at least 3 starters.json files, found ${files.length}`);
  for (const file of files) {
    const raw = fs.readFileSync(file, 'utf8');
    let obj;
    assert.doesNotThrow(() => {
      obj = JSON.parse(raw);
    }, `${path.relative(ROOT, file)} is not valid JSON`);
    const errors = validate(obj, readSkillMd(path.dirname(file)));
    assert.deepEqual(errors, [], `${path.relative(ROOT, file)}: ${errors.join('; ')}`);
  }
});

test('R12 TC-S1-1: the fixture baseline is valid (so each rejection below isolates one rule)', () => {
  assert.deepEqual(validate(good(), SKILL_MD), []);
});

test('R2: unknown fields are ignored and icon is optional', () => {
  const obj = good();
  delete obj.icon;
  obj.extra = { anything: true };
  obj.starters[0].future_field = 'ignored';
  assert.deepEqual(validate(obj, SKILL_MD), []);
});

// ---------------------------------------------------------------------------
// R12 / TC-S1-1 — the six broken fixtures, one rule each.
// ---------------------------------------------------------------------------

test('R12 TC-S1-1: rejects a duplicate id', () => {
  const obj = good();
  obj.starters[1].id = 'demo-one';
  const errors = validate(obj, SKILL_MD);
  assert.equal(errors.length, 1, errors.join('; '));
  assert.match(errors[0], /duplicate id "demo-one"/);
});

test('R12 TC-S1-1: rejects a 61-char label (60 is the limit)', () => {
  const obj = good();
  obj.starters[0].label = 'x'.repeat(60);
  assert.deepEqual(validate(obj, SKILL_MD), [], '60 chars must pass');
  obj.starters[0].label = 'x'.repeat(61);
  const errors = validate(obj, SKILL_MD);
  assert.equal(errors.length, 1, errors.join('; '));
  assert.match(errors[0], /starters\[0\]\.label/);
});

test('R12 TC-S1-1: rejects requires has_pet', () => {
  const obj = good();
  obj.starters[0].requires = ['has_pet'];
  const errors = validate(obj, SKILL_MD);
  assert.equal(errors.length, 1, errors.join('; '));
  assert.match(errors[0], /unknown requirement "has_pet"/);
});

test('R12 TC-S1-1: rejects source email', () => {
  const obj = good();
  obj.starters[0].source = 'email';
  const errors = validate(obj, SKILL_MD);
  assert.equal(errors.length, 1, errors.join('; '));
  assert.match(errors[0], /starters\[0\]\.source/);
});

test('R12 TC-S1-1: rejects an empty prompt', () => {
  const obj = good();
  obj.starters[0].prompt = '';
  const errors = validate(obj, SKILL_MD);
  assert.equal(errors.length, 1, errors.join('; '));
  assert.match(errors[0], /starters\[0\]\.prompt/);
});

test('R12 TC-S1-1: rejects a missing SKILL.md name (and a missing SKILL.md)', () => {
  const noName = '---\ndescription: x\n---\n\n# Demo\n';
  let errors = validate(good(), noName);
  assert.equal(errors.length, 1, errors.join('; '));
  assert.match(errors[0], /SKILL\.md: frontmatter has no name/);

  errors = validate(good(), null);
  assert.equal(errors.length, 1, errors.join('; '));
  assert.match(errors[0], /SKILL\.md: missing/);
});

// ---------------------------------------------------------------------------
// R12 — the remaining field rules.
// ---------------------------------------------------------------------------

test('R12: rejects version other than 1', () => {
  const obj = good();
  obj.version = 2;
  assert.match(validate(obj, SKILL_MD).join('\n'), /version/);
});

test('R12: title must be 1-30 chars', () => {
  const obj = good();
  obj.title = '';
  assert.match(validate(obj, SKILL_MD).join('\n'), /title/);
  obj.title = 'x'.repeat(31);
  assert.match(validate(obj, SKILL_MD).join('\n'), /title/);
  obj.title = 'x'.repeat(30);
  assert.deepEqual(validate(obj, SKILL_MD), []);
  delete obj.title;
  assert.match(validate(obj, SKILL_MD).join('\n'), /title/);
});

test('R12: icon, when present, must be a non-empty string', () => {
  const obj = good();
  obj.icon = 42;
  assert.match(validate(obj, SKILL_MD).join('\n'), /icon/);
});

test('R12: starters must be a non-empty array', () => {
  const obj = good();
  obj.starters = [];
  assert.match(validate(obj, SKILL_MD).join('\n'), /starters: must be a non-empty array/);
  delete obj.starters;
  assert.match(validate(obj, SKILL_MD).join('\n'), /starters: must be a non-empty array/);
});

test('R12: id must be kebab-case', () => {
  for (const bad of ['Cal_Today', 'cal today', '-cal', 'cal-', '', 7]) {
    const obj = good();
    obj.starters[0].id = bad;
    assert.match(validate(obj, SKILL_MD).join('\n'), /\.id: must be kebab-case/, `id ${JSON.stringify(bad)}`);
  }
});

test('R12: requires must be an array; order must be an integer', () => {
  const obj = good();
  obj.starters[0].requires = 'has_recording';
  obj.starters[1].order = 1.5;
  const joined = validate(obj, SKILL_MD).join('\n');
  assert.match(joined, /starters\[0\]\.requires: must be an array/);
  assert.match(joined, /starters\[1\]\.order: must be an integer/);
});

test('R12: every allowed source and requirement passes', () => {
  for (const source of ['recordings', 'inbox', 'events', 'ideas']) {
    const obj = good();
    obj.starters[0].source = source;
    obj.starters[0].requires = ['has_recording', 'google_connected'];
    assert.deepEqual(validate(obj, SKILL_MD), [], source);
  }
});

test('R12: skillName reads the frontmatter name (quoted or bare)', () => {
  assert.equal(skillName('---\nname: javis-brainstorming\n---\n'), 'javis-brainstorming');
  assert.equal(skillName('---\nname: "calendar-extractor"\n---\n'), 'calendar-extractor');
  assert.equal(skillName('# no frontmatter\nname: x\n'), null);
  // An indented `name:` inside metadata is not the skill name.
  assert.equal(skillName('---\nmetadata:\n  name: nested\n---\n'), null);
});

// ---------------------------------------------------------------------------
// R13 / TC-S1-2, TC-S0-1..3 — the three default skills ship starters.
// ---------------------------------------------------------------------------

const DEFAULTS = [
  { dir: 'calendar-extractor', name: 'calendar-extractor', tc: 'TC-S0-1' },
  { dir: 'brainstorming', name: 'javis-brainstorming', tc: 'TC-S0-2' },
  { dir: 'gmail-wiki-ingest', name: 'gmail-wiki-ingest', tc: 'TC-S0-3' },
];

for (const { dir, name, tc } of DEFAULTS) {
  test(`R13 TC-S1-2 ${tc}: ${dir} ships a valid starters.json with at least one starter`, () => {
    const file = path.join(ROOT, dir, 'starters.json');
    assert.ok(fs.existsSync(file), `${dir}/starters.json is missing`);
    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(raw.endsWith('}\n'), `${dir}/starters.json must end with a single trailing newline`);
    const obj = JSON.parse(raw);
    const skillMd = readSkillMd(path.join(ROOT, dir));
    assert.deepEqual(validate(obj, skillMd), []);
    assert.equal(skillName(skillMd), name, 'slash command is the SKILL.md name');
    assert.ok(obj.starters.length >= 1);
  });
}

test('R13 TC-S1-2 TC-S0-3: the gmail starter requires google_connected', () => {
  const obj = JSON.parse(fs.readFileSync(path.join(ROOT, 'gmail-wiki-ingest', 'starters.json'), 'utf8'));
  for (const s of obj.starters) {
    assert.ok(s.requires.includes('google_connected'), `${s.id} must require google_connected`);
  }
});

test('R13: starter ids are unique across the default skills (on-device counts key on them)', () => {
  const ids = DEFAULTS.flatMap(({ dir }) =>
    JSON.parse(fs.readFileSync(path.join(ROOT, dir, 'starters.json'), 'utf8')).starters.map((s) => s.id),
  );
  assert.equal(new Set(ids).size, ids.length, ids.join(', '));
});

// ---------------------------------------------------------------------------
// R14 / TC-S1-4 — each default SKILL.md states the on-demand always-reply rule.
// ---------------------------------------------------------------------------

for (const { dir } of DEFAULTS) {
  test(`R14 TC-S1-4: ${dir}/SKILL.md states the on-demand always-reply rule`, () => {
    const md = readSkillMd(path.join(ROOT, dir));
    assert.match(md, /^## On-demand runs always reply$/m, 'missing the "On-demand runs always reply" section');
    const section = md.split(/^## On-demand runs always reply$/m)[1].split(/^## /m)[0];
    assert.match(section, /ALWAYS ends with a chat\s+reply/);
    assert.match(section, /slash command/, 'must name the starter slash-command path');
    assert.match(section, /nothing/i, 'must cover the found-nothing case');
    assert.match(section, /dispatcher|scheduled/i, 'must state the dispatcher/scheduled path is unchanged');
  });
}

// ---------------------------------------------------------------------------
// R14 / TC-S1-4 (review F26) — the always-reply wording must not weaken the
// dispatcher path: nothing may tie "silence on a failed/empty fetch" to the
// dispatcher, and calendar-extractor's UNIT CONTEXT fallback must still win.
// ---------------------------------------------------------------------------

for (const { dir } of DEFAULTS) {
  test(`R14 TC-S1-4 F26: ${dir}/SKILL.md does not tie fetch-failure silence to the dispatcher`, () => {
    const md = readSkillMd(path.join(ROOT, dir));
    assert.doesNotMatch(md, /silence is for the dispatcher/i);
    assert.doesNotMatch(md, /dispatcher run that silence is the whole outcome/i);
  });
}

test('R14 TC-S1-4 F26: calendar-extractor UNIT CONTEXT fallback still says STILL extract and push', () => {
  const md = readSkillMd(path.join(ROOT, 'calendar-extractor'));
  assert.match(md, /UNIT CONTEXT[\s\S]{0,400}STILL extract and push/);
});

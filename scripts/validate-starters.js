'use strict';
// Validator for a skill's starters.json (Agent Chat starters, R2/R12).
// Pure: validate(obj, skillMd) -> string[] of errors ([] means valid).
//   obj     — the parsed starters.json value
//   skillMd — the sibling SKILL.md text, or null/undefined when it is missing
// Schema: javis.is/docs/superpowers/specs/2026-10-15-agent-chat-starters-design.md §2.
// Unknown fields are ignored on purpose (iOS ignores them too).

const SOURCES = ['recordings', 'inbox', 'events', 'ideas'];
const REQUIRES = ['has_recording', 'google_connected'];
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Top-level `name:` from YAML frontmatter (single-line value, optional quotes).
function skillName(skillMd) {
  if (typeof skillMd !== 'string') return null;
  const m = skillMd.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^name:\s*(.*?)\s*$/);
    if (kv) {
      const v = kv[1].replace(/^(['"])(.*)\1$/, '$2').trim();
      return v || null;
    }
  }
  return null;
}

// Length in Unicode code points, so a CJK or emoji label counts as the user sees it.
function isStringOfLength(v, min, max) {
  if (typeof v !== 'string') return false;
  const n = Array.from(v).length;
  return n >= min && n <= max;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function validate(obj, skillMd) {
  const errors = [];

  if (skillMd == null) errors.push('SKILL.md: missing next to starters.json');
  else if (!skillName(skillMd)) errors.push('SKILL.md: frontmatter has no name');

  if (!isPlainObject(obj)) {
    errors.push('starters.json: top level must be an object');
    return errors;
  }
  if (obj.version !== 1) errors.push(`version: must be 1 (got ${JSON.stringify(obj.version)})`);

  if (!isStringOfLength(obj.title, 1, 30)) {
    errors.push('title: must be a string of 1-30 chars');
  }
  if (obj.icon !== undefined && (typeof obj.icon !== 'string' || obj.icon.length === 0)) {
    errors.push('icon: when present, must be a non-empty string (SF Symbol name)');
  }

  if (!Array.isArray(obj.starters) || obj.starters.length === 0) {
    errors.push('starters: must be a non-empty array');
    return errors;
  }

  const seen = new Set();
  obj.starters.forEach((s, i) => {
    const at = `starters[${i}]`;
    if (!isPlainObject(s)) {
      errors.push(`${at}: must be an object`);
      return;
    }
    if (typeof s.id !== 'string' || !KEBAB.test(s.id)) {
      errors.push(`${at}.id: must be kebab-case (got ${JSON.stringify(s.id)})`);
    } else if (seen.has(s.id)) {
      errors.push(`${at}.id: duplicate id "${s.id}"`);
    } else {
      seen.add(s.id);
    }
    if (!isStringOfLength(s.label, 1, 60)) {
      errors.push(`${at}.label: must be a string of 1-60 chars`);
    }
    if (typeof s.prompt !== 'string' || s.prompt.trim().length === 0) {
      errors.push(`${at}.prompt: must be a non-empty string`);
    }
    if (!SOURCES.includes(s.source)) {
      errors.push(`${at}.source: must be one of ${SOURCES.join(', ')} (got ${JSON.stringify(s.source)})`);
    }
    if (!Array.isArray(s.requires)) {
      errors.push(`${at}.requires: must be an array`);
    } else {
      for (const r of s.requires) {
        if (!REQUIRES.includes(r)) {
          errors.push(`${at}.requires: unknown requirement ${JSON.stringify(r)} (allowed: ${REQUIRES.join(', ')})`);
        }
      }
    }
    if (!Number.isInteger(s.order)) {
      errors.push(`${at}.order: must be an integer`);
    }
  });

  return errors;
}

module.exports = { validate, skillName, SOURCES, REQUIRES };

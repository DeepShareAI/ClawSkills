'use strict';
// Entry point so `node --test test/` works from the ClawSkills root: Node resolves
// the directory argument to this file, which loads every *.test.js beside it.
const fs = require('node:fs');
const path = require('node:path');

for (const f of fs.readdirSync(__dirname).sort()) {
  if (f.endsWith('.test.js')) require(path.join(__dirname, f));
}

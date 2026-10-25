"use strict";

/*
 * Entry point for `node --test extension/tests` (the plan's acceptance command).
 * Node >= 21 treats each --test argument as a file or glob, not a directory to
 * search, so the directory resolves to this file, which loads every suite.
 * `node --test extension/tests/*.test.js` runs the same suites directly.
 */

const fs = require("node:fs");
const path = require("node:path");

for (const file of fs.readdirSync(__dirname).sort()) {
  if (file.endsWith(".test.js")) require(path.join(__dirname, file));
}

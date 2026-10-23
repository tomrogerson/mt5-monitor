'use strict';
// Tiny .env loader so the project needs no extra dependency.
const fs = require('fs');
const path = require('path');

function loadDotEnv(file) {
  const p = file || path.join(__dirname, '..', '.env');
  let text;
  try { text = fs.readFileSync(p, 'utf8'); } catch (e) { return; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

module.exports = { loadDotEnv };

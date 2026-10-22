'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const controls = [
  ['cancellation', 'lib/hub.js', "art cancellation on switch", '    this.art.cancel(client);', '    /* cancellation deliberately removed */'],
  ['ignore', 'lib/hub.js', 'ignore is checked on every art line', 'member === client || !member.ignores.has(client.key)', 'true'],
  ['whitespace', 'lib/art.js', 'art skull scrolls exact ASCII', 'publish(lines[job.line],', 'publish(lines[job.line].trim(),'],
  ['pacing', 'lib/art.js', 'art skull scrolls exact ASCII', 'setTimeout(tick, ART_INTERVAL_MS)', 'setTimeout(tick, 0)'],
  ['origin', 'lib/security.js', 'origin and Host boundaries', "req.headers.origin === `http://${host}`", 'true', 'test/security.test.js'],
  ['canonical path', 'lib/static.js', 'canonical static boundary', "relative.startsWith('..') || path.isAbsolute(relative)", 'false', 'test/security.test.js'],
  ['backpressure', 'lib/hub.js', 'slow-client output is bounded', 'ws.bufferedAmount > MAX_BUFFERED_BYTES', 'false', 'test/security.test.js'],
  ['connections', 'lib/app.js', 'connection budget rejects', 'wss.clients.size >= MAX_WS_CLIENTS', 'false', 'test/security.test.js'],
];

for (const [name, file, pattern, before, after, testFile = 'test/art.test.js'] of controls) {
  const work = fs.mkdtempSync(path.join(root, '.controls-'));
  try {
    fs.cpSync(path.join(root, 'lib'), path.join(work, 'lib'), { recursive: true });
    fs.cpSync(path.join(root, 'test'), path.join(work, 'test'), { recursive: true });
    fs.cpSync(path.join(root, 'public'), path.join(work, 'public'), { recursive: true });
    const target = path.join(work, file);
    const source = fs.readFileSync(target, 'utf8');
    if (!source.includes(before)) throw new Error(`${name}: mutation anchor missing`);
    const offset = name === 'canonical path' ? source.lastIndexOf(before) : source.indexOf(before);
    fs.writeFileSync(target, source.slice(0, offset) + after + source.slice(offset + before.length));
    const result = spawnSync(process.execPath, ['--test', `--test-name-pattern=${pattern}`, testFile], {
      cwd: work, encoding: 'utf8', windowsHide: true, timeout: 15000,
    });
    if (result.status === 0 || !/[✖×]|not ok/.test(result.stdout)) {
      throw new Error(`${name}: broken control did not fail an assertion\n${result.stdout}\n${result.stderr}`);
    }
    console.log(`${name}: deliberately broken implementation detected`);
  } finally {
    if (path.dirname(work) !== root || !path.basename(work).startsWith('.controls-')) throw new Error('Invalid control directory');
    fs.rmSync(work, { recursive: true, force: true });
  }
}

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const cli = path.join(path.dirname(require.resolve('@playwright/test/package.json')), 'cli.js');
const controls = [
  ['HTML rendering', 'HTML injection stays literal',
    "appendSmileys(span, String(text === undefined || text === null ? '' : text));",
    "span.innerHTML = String(text === undefined || text === null ? '' : text);"],
  ['Stop button', 'Stop cancels scrolling',
    "btn('Stop', function () { print('stop'); })))",
    "btn('Stop', function () {})))"],
];

for (const [name, pattern, before, after] of controls) {
  const work = fs.mkdtempSync(path.join(root, '.controls-browser-'));
  try {
    for (const dir of ['lib', 'public', 'e2e', 'test/support']) {
      fs.cpSync(path.join(root, dir), path.join(work, dir), { recursive: true });
    }
    for (const file of ['server.js', 'playwright.config.js']) fs.copyFileSync(path.join(root, file), path.join(work, file));
    const target = path.join(work, 'public/app.js');
    const source = fs.readFileSync(target, 'utf8');
    if (!source.includes(before)) throw new Error(`${name}: mutation anchor missing`);
    fs.writeFileSync(target, source.replace(before, after));
    const result = spawnSync(process.execPath, [cli, 'test', '--workers=1', '--reporter=json', '--grep', pattern], {
      cwd: work, encoding: 'utf8', windowsHide: true, timeout: 45000,
      env: { ...process.env, FORCE_COLOR: '0' }, maxBuffer: 4 * 1024 * 1024,
    });
    let report;
    try { report = JSON.parse(result.stdout); } catch {
      throw new Error(`${name}: control did not produce a test report\n${result.stdout}\n${result.stderr}`);
    }
    const failures = report.suites.flatMap(suite => suite.specs || []).flatMap(spec => spec.tests).flatMap(test => test.results);
    if (result.status === 0 || report.stats.unexpected !== 1 || report.errors.length ||
        !failures.some(run => run.status === 'failed' && run.errors.some(error => /expect\(/.test(error.message)))) {
      throw new Error(`${name}: broken control did not fail an assertion\n${result.stdout}\n${result.stderr}`);
    }
    console.log(`${name}: deliberately broken browser implementation detected`);
  } finally {
    if (path.dirname(work) !== root || !path.basename(work).startsWith('.controls-browser-')) throw new Error('Invalid control directory');
    fs.rmSync(work, { recursive: true, force: true });
  }
}

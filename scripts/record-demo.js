'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium, expect } = require('@playwright/test');
const { startServer } = require('../test/support/server');
const { chat, art, window, signOn, say, createRoom, joinRoom, im } = require('../e2e/ui');
const { ART } = require('../lib/art');

const output = path.resolve(process.env.DEMO_OUTPUT_DIR || 'artifacts/demo');
const viewport = { width: 1440, height: 810 };
const hold = ms => new Promise(resolve => setTimeout(resolve, ms));
const stamp = seconds => new Date(Math.round(seconds * 1000)).toISOString().slice(11, 23).replace('.', ',');

async function main() {
  await fs.mkdir(output, { recursive: true });
  const server = await startServer();
  let browser;
  try {
    browser = await chromium.launch();
    const baseURL = `http://127.0.0.1:${server.port}`;
    const context = await browser.newContext({ baseURL, viewport, recordVideo: { dir: output, size: viewport } });
    const peerContext = await browser.newContext({ baseURL, viewport });
    const page = await context.newPage();
    const peer = await peerContext.newPage();
    const video = page.video();
    const started = Date.now();
    const chapters = [];
    const scene = text => {
      const start = (Date.now() - started) / 1000;
      chapters.push({ start, text });
      console.log(`${start.toFixed(1)}s ${text}`);
    };

    scene("You've got nostalgia.");
    await page.goto('/');
    await expect(page.locator('#conn')).toHaveText('Connected');
    await hold(2400);
    await page.getByRole('textbox', { name: 'Screen name', exact: true }).pressSequentially('ZeroCool', { delay: 110 });
    await page.getByRole('button', { name: 'Sign On', exact: true }).click();
    await expect(page.locator('#conn')).toHaveText('Signed on as ZeroCool');
    await signOn(peer, 'AcidBurn');
    await say(peer, 'Anyone else remember their first screen name?');
    await expect(chat(page).getByRole('log')).toContainText('Anyone else remember');
    await hold(2300);

    scene('Two people. One little corner of 1996.');
    await createRoom(page, 'Hack The Planet');
    await joinRoom(peer, 'Hack The Planet');
    await say(page, 'Welcome back to 1996!');
    await expect(chat(peer).getByRole('log')).toContainText('Welcome back to 1996!');
    await say(peer, 'Hack the planet!');
    await hold(2400);

    scene('Instant messages. And the inevitable away message.');
    await page.getByRole('button', { name: 'Set Away', exact: true }).click();
    await page.getByRole('textbox', { name: 'Away message', exact: true }).pressSequentially('Mom needs the phone. BRB.', { delay: 45 });
    await hold(800);
    await window(page, 'Away Message').getByRole('button', { name: 'OK', exact: true }).click();
    await expect(window(page, 'Away Message')).toHaveCount(0);
    await im(peer, 'ZeroCool', 'You had me at 28.8k.');
    await expect(window(page, 'Instant Message from AcidBurn').getByRole('log')).toContainText('You had me at 28.8k.');
    await hold(2500);
    await window(page, 'Instant Message from AcidBurn').getByRole('button', { name: 'Close', exact: true }).click();

    scene('Your buddy list is waiting.');
    await page.getByRole('button', { name: 'Buddy List', exact: true }).click();
    await page.getByRole('textbox', { name: 'Screen name to add', exact: true }).pressSequentially('AcidBurn', { delay: 90 });
    await window(page, 'Buddy List').getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByRole('listbox', { name: 'Buddies', exact: true })).toContainText('AcidBurn - Online');
    await hold(2200);
    await window(page, 'Buddy List').getByRole('button', { name: 'Close', exact: true }).click();

    scene('The classics. One line every 650 milliseconds.');
    await say(page, '/art');
    await expect(art(page).locator('option')).toHaveCount(4);
    await hold(2000);
    await art(page).getByRole('button', { name: 'Scroll It!', exact: true }).click();
    await expect(chat(page).locator('.art-line')).toHaveCount(ART.skull.lines.length, { timeout: 10000 });
    await expect(chat(page).getByRole('log')).toContainText('Scroll complete.');
    await page.screenshot({ path: path.join(output, 'poster.png') });
    await hold(2300);

    scene('A Fate X 3.0 tribute, rebuilt for your own room.');
    await art(page).getByRole('combobox', { name: 'ASCII art' }).selectOption('finger');
    await hold(1800);
    await art(page).getByRole('combobox', { name: 'ASCII art' }).selectOption('banner');
    await art(page).getByRole('button', { name: 'Scroll It!', exact: true }).click();
    await expect(chat(page).locator('.art-line')).toHaveCount(ART.skull.lines.length + ART.banner.lines.length, { timeout: 7000 });
    await hold(2000);

    scene('And yes, Stop actually stops it.');
    await art(page).getByRole('combobox', { name: 'ASCII art' }).selectOption('skull');
    await art(page).getByRole('button', { name: 'Scroll It!', exact: true }).click();
    await expect(chat(page).locator('.art-line').nth(15)).toBeVisible();
    await hold(800);
    await art(page).getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(chat(page).getByRole('log')).toContainText('Scroller stopped.');
    await hold(1800);

    scene('MIT licensed. Help bring the good parts back.');
    await say(peer, "Let's bring the good parts back.");
    await expect(chat(page).getByRole('log')).toContainText("Let's bring the good parts back.");
    await hold(2500);
    scene('github.com/pnmcguire480/almost-online');
    await hold(4500);
    const duration = (Date.now() - started) / 1000;
    await context.close();
    await video.saveAs(path.join(output, 'almost-online-demo.webm'));
    await video.delete();
    await peerContext.close();
    await fs.writeFile(path.join(output, 'chapters.json'), JSON.stringify({ viewport, duration, browser: browser.version(), chapters }, null, 2) + '\n');
    await fs.writeFile(path.join(output, 'captions.srt'), chapters.map((chapter, i) =>
      `${i + 1}\n${stamp(chapter.start)} --> ${stamp(chapters[i + 1]?.start ?? duration)}\n${chapter.text}\n`).join('\n'));
    console.log(`Recorded ${duration.toFixed(1)}s to ${output}`);
  } finally {
    if (browser) await browser.close();
    const stopped = await server.stop();
    if (stopped.code !== 0) throw new Error('Demo server did not shut down cleanly');
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });

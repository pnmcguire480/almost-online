'use strict';

const { test, expect } = require('./fixtures');
const { chat, art, window, signOn, say, createRoom, joinRoom, im } = require('./ui');
const { ART } = require('../lib/art');

test('two people create a room, chat, exchange IMs and receive away replies', async ({ page, peer }) => {
  await signOn(page, 'ZeroCool');
  await signOn(peer, 'AcidBurn');
  await createRoom(page, 'Hack The Planet');
  await joinRoom(peer, 'Hack The Planet');
  await expect(chat(page).getByRole('listbox')).toContainText('AcidBurn');
  await expect(chat(peer).getByRole('listbox')).toContainText('ZeroCool (Host)');
  await say(page, 'Welcome back to 1996!');
  await expect(chat(peer).getByRole('log')).toContainText('ZeroCool: Welcome back to 1996!');
  await say(peer, 'Hack the planet!');
  await expect(chat(page).getByRole('log')).toContainText('AcidBurn: Hack the planet!');

  await peer.getByRole('button', { name: 'Set Away', exact: true }).click();
  await peer.getByRole('textbox', { name: 'Away message', exact: true }).fill('Mom needs the phone. BRB.');
  await window(peer, 'Away Message').getByRole('button', { name: 'OK', exact: true }).click();
  await expect(window(peer, 'Away Message')).toHaveCount(0);
  const sent = await im(page, 'AcidBurn', 'You still there?');
  await expect(window(peer, 'Instant Message from ZeroCool').getByRole('log')).toContainText('You still there?');
  await expect(sent.getByRole('log')).toContainText('AcidBurn (away message): Mom needs the phone. BRB.');
});

test('HTML injection stays literal text in room messages and IMs', async ({ page, peer }) => {
  await signOn(page, 'Alice96');
  await signOn(peer, 'Bob96');
  const payload = '<img src=x onerror=alert(1)><svg onload=alert(2)>';
  await say(page, payload);
  await expect(chat(peer).getByRole('log')).toContainText(payload);
  expect(await chat(peer).getByRole('log').locator('img, svg').count()).toBe(0);
  await im(page, 'Bob96', payload);
  const received = window(peer, 'Instant Message from Alice96').getByRole('log');
  await expect(received).toContainText(payload);
  await expect(received.locator('img, svg')).toHaveCount(0);
});

test('ignore blocks room messages and IM windows until delivery is restored', async ({ page, peer }) => {
  await signOn(page, 'Alice96');
  await signOn(peer, 'Bob96');
  await chat(peer).getByRole('option', { name: 'Alice96', exact: true }).click();
  await chat(peer).getByRole('button', { name: 'Ignore', exact: true }).click();
  await expect(chat(peer).getByRole('button', { name: 'Unignore', exact: true })).toBeEnabled();
  await say(page, 'This room message is ignored');
  await expect(chat(page).getByRole('log')).toContainText('This room message is ignored');
  await im(page, 'Bob96', 'This IM is ignored');
  await say(peer, 'Delivery barrier');
  await expect(chat(peer).getByRole('log')).toContainText('Delivery barrier');
  await expect(chat(peer).getByRole('log')).not.toContainText('This room message is ignored');
  await expect(peer.locator('.win.im')).toHaveCount(0);
  await chat(peer).getByRole('button', { name: 'Unignore', exact: true }).click();
  await expect(chat(peer).getByRole('button', { name: 'Ignore', exact: true })).toBeEnabled();
  await say(page, 'Delivery restored');
  await expect(chat(peer).getByRole('log')).toContainText('Delivery restored');
});

test('the art picker prints a complete skull with exact spaces to both people', async ({ page, peer }) => {
  await signOn(page, 'Alice96');
  await signOn(peer, 'Bob96');
  await say(page, '/art');
  const picker = art(page);
  await expect(picker.getByRole('combobox', { name: 'ASCII art' }).locator('option')).toHaveCount(4);
  await expect(picker.locator('.art-preview')).toHaveText(ART.skull.lines.join('\n'));
  await picker.getByRole('button', { name: 'Scroll It!', exact: true }).click();
  for (const target of [page, peer]) {
    const lines = chat(target).locator('.art-line span');
    await expect(lines).toHaveCount(ART.skull.lines.length, { timeout: 10000 });
    expect(await lines.allTextContents()).toEqual(ART.skull.lines);
    await expect(chat(target).locator('.art-line').first()).toHaveCSS('white-space', 'pre');
  }
  await expect(chat(page).getByRole('log')).toContainText('Scroll complete.');
});

test('Stop cancels scrolling while the other person can finish a new scroll', async ({ page, peer }) => {
  await signOn(page, 'Alice96');
  await signOn(peer, 'Bob96');
  await say(page, '/art');
  await expect(art(page).locator('option')).toHaveCount(4);
  await art(page).getByRole('button', { name: 'Scroll It!', exact: true }).click();
  const printed = chat(peer).locator('.art-line[data-from="alice96"]');
  await expect(printed.first()).toBeVisible();
  await art(page).getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(chat(page).getByRole('log')).toContainText('Scroller stopped.');
  const stoppedAt = await printed.count();
  expect(stoppedAt).toBeLessThan(ART.skull.lines.length);
  await say(peer, '/art skull');
  await expect(chat(peer).locator('.art-line[data-from="bob96"]')).toHaveCount(ART.skull.lines.length, { timeout: 10000 });
  await expect(printed).toHaveCount(stoppedAt);
});

test('changing rooms cancels art and never leaks the old room into the new one', async ({ page, peer }) => {
  await signOn(page, 'Alice96');
  await signOn(peer, 'Bob96');
  await say(page, '/art skull');
  const printed = chat(peer).locator('.art-line[data-from="alice96"]');
  await expect(printed.first()).toBeVisible();
  await createRoom(page, 'Elsewhere');
  const stoppedAt = await printed.count();
  expect(stoppedAt).toBeLessThan(ART.skull.lines.length);
  await say(peer, '/art skull');
  await expect(chat(peer).locator('.art-line[data-from="bob96"]')).toHaveCount(ART.skull.lines.length, { timeout: 10000 });
  await expect(printed).toHaveCount(stoppedAt);
  await expect(chat(page).locator('.art-line')).toHaveCount(0);
  await expect(chat(page).getByRole('listbox')).not.toContainText('Bob96');
});

test('buddy presence updates and signing off clears the browser session', async ({ page, peer }) => {
  await signOn(page, 'Alice96');
  await page.getByRole('button', { name: 'Buddy List', exact: true }).click();
  await page.getByRole('textbox', { name: 'Screen name to add', exact: true }).fill('Bob96');
  await window(page, 'Buddy List').getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('listbox', { name: 'Buddies', exact: true })).toContainText('Offline');
  await signOn(peer, 'Bob96');
  await expect(page.getByRole('listbox', { name: 'Buddies', exact: true })).toContainText('Online');
  await chat(peer).getByRole('button', { name: 'Sign Off', exact: true }).click();
  await expect(peer.getByRole('textbox', { name: 'Screen name', exact: true })).toBeVisible();
  await expect(page.getByRole('listbox', { name: 'Buddies', exact: true })).toContainText('Offline');
  await chat(page).getByRole('button', { name: 'Sign Off', exact: true }).click();
  await expect(page.locator('.win.chat, .win.im')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Screen name', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Screen name', exact: true }).press('Enter');
  await expect(page.locator('#conn')).toHaveText('Signed on as Alice96');
  await page.getByRole('button', { name: 'Buddy List', exact: true }).click();
  await expect(page.getByRole('listbox', { name: 'Buddies', exact: true }).getByRole('option')).toHaveCount(0);
});

test('narrow layout supports keyboard sign-on, slash commands and rolling up the proggie', async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 760 });
  await signOn(page, 'Narrow96');
  await say(page, '/art');
  const picker = art(page);
  await expect(picker.locator('option')).toHaveCount(4);
  await picker.getByRole('combobox', { name: 'ASCII art' }).selectOption('divider');
  await picker.getByRole('button', { name: 'Scroll It!', exact: true }).click();
  await expect(chat(page).locator('.art-line')).toHaveCount(ART.divider.lines.length);
  const height = (await picker.boundingBox()).height;
  await picker.getByRole('button', { name: 'Roll Up', exact: true }).click();
  await expect(picker).toHaveClass(/rolled/);
  expect((await picker.boundingBox()).height).toBeLessThan(height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

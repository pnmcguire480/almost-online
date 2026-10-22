'use strict';

const { expect } = require('@playwright/test');

const chat = page => page.locator('.win.chat');
const art = page => page.locator('.win.fatex');
const window = (page, title) => page.locator('.win').filter({
  has: page.locator('.titletext').filter({ hasText: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }),
});

async function signOn(page, name) {
  await page.goto('/');
  await expect(page.locator('#conn')).toHaveText('Connected');
  await page.getByRole('textbox', { name: 'Screen name', exact: true }).fill(name);
  await page.getByRole('textbox', { name: 'Screen name', exact: true }).press('Enter');
  await expect(page.locator('#conn')).toHaveText(`Signed on as ${name}`);
  await expect(chat(page).getByRole('listbox')).toContainText(name);
}

async function say(page, text) {
  const input = chat(page).getByRole('textbox', { name: 'Message', exact: true });
  await input.fill(text);
  await input.press('Enter');
}

async function createRoom(page, name) {
  await chat(page).getByRole('button', { name: 'Rooms', exact: true }).click();
  const rooms = window(page, 'Rooms');
  await rooms.getByRole('button', { name: 'Create', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Room name', exact: true });
  await input.fill(name);
  await input.press('Enter');
  await expect(chat(page).locator('.titletext')).toHaveText(name);
  await rooms.getByRole('button', { name: 'Close', exact: true }).click();
}

async function joinRoom(page, name) {
  const input = page.getByRole('textbox', { name: 'Keyword:', exact: true });
  await input.fill(name);
  await input.press('Enter');
  await expect(chat(page).locator('.titletext')).toHaveText(name);
}

async function im(page, name, text) {
  await page.getByRole('button', { name: 'Instant Message', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'IM screen name', exact: true });
  await input.fill(name);
  await input.press('Enter');
  const target = window(page, `Instant Message from ${name}`);
  await target.getByRole('textbox', { name: 'Message', exact: true }).fill(text);
  await target.getByRole('textbox', { name: 'Message', exact: true }).press('Enter');
  await expect(target.getByRole('log')).toContainText(text);
  return target;
}

module.exports = { chat, art, window, signOn, say, createRoom, joinRoom, im };

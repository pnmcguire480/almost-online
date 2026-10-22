'use strict';

const { test: base, expect } = require('@playwright/test');
const { startServer } = require('../test/support/server');

function watch(page, errors) {
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('dialog', async dialog => {
    errors.push(`Unexpected dialog: ${dialog.message()}`);
    await dialog.dismiss();
  });
}

const test = base.extend({
  server: async ({}, use) => {
    const server = await startServer();
    try {
      await use(server);
    } finally {
      expect((await server.stop()).code).toBe(0);
    }
  },
  baseURL: async ({ server }, use) => {
    await use(`http://127.0.0.1:${server.port}`);
  },
  health: [async ({ context }, use) => {
    const errors = [];
    context.on('page', page => watch(page, errors));
    await use(errors);
    expect(errors).toEqual([]);
  }, { auto: true }],
  peer: async ({ browser, baseURL, health }, use, info) => {
    const context = await browser.newContext({
      baseURL,
      viewport: { width: 1440, height: 900 },
      recordVideo: { dir: info.outputPath('peer-video') },
    });
    const page = await context.newPage();
    watch(page, health);
    const video = page.video();
    try {
      await use(page);
    } finally {
      const failed = info.status !== info.expectedStatus;
      await context.close();
      if (failed) {
        await info.attach('peer video', { path: await video.path(), contentType: 'video/webm' });
      } else {
        await video.delete();
      }
    }
  },
});

module.exports = { test, expect };

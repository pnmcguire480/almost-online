'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { WebSocket } = require('ws');
const { createApp } = require('../lib/app');
const { loadConfig, ConfigError } = require('../lib/config');
const { CONFIG, SILENT_LOGGER } = require('./support/hub-harness');
const { startServer } = require('./support/server');
const { Client } = require('./support/client');

function request(port, path, method = 'GET') {
  return new Promise((resolve, reject) => {
    http.request({ hostname: '127.0.0.1', port, path, method }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => text += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    }).on('error', reject).end();
  });
}

test('browser assets load, HEAD returns headers, and static access cannot escape public/', async () => {
  const app = createApp({ config: CONFIG, logger: SILENT_LOGGER });
  const { port } = await app.listen(0);
  try {
    assert.equal(app.server.address().address, '127.0.0.1');
    for (const [path, type, text] of [
      ['/', 'text/html', "Chat Room '96"],
      ['/app.js', 'text/javascript', 'onArtStatus'],
      ['/style.css', 'text/css', '.art-line'],
    ]) {
      const res = await request(port, path);
      assert.equal(res.status, 200);
      assert.ok(res.headers['content-type'].startsWith(type));
      assert.ok(res.text.includes(text));
      assert.equal(res.headers['x-content-type-options'], 'nosniff');
    }
    const head = await request(port, '/', 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.text, '');
    assert.ok(Number(head.headers['content-length']) > 0);
    for (const path of ['/missing', '/.env', '/%2e%2e%2fserver.js', '/%5c..%5cserver.js', '/%00', '/app.js/']) {
      assert.equal((await request(port, path)).status, 404, path);
    }
    assert.equal((await request(port, '/%E0%A4')).status, 400);
    assert.equal((await request(port, '/', 'POST')).status, 405);
  } finally {
    await app.shutdown();
  }
});

test('wrong WebSocket endpoints are refused without signing a client on', async () => {
  const app = createApp({ config: CONFIG, logger: SILENT_LOGGER });
  const { port } = await app.listen(0);
  try {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/not-ws`);
      ws.on('open', () => reject(new Error('unexpected upgrade')));
      ws.on('error', error => {
        assert.match(error.message, /404/);
        resolve();
      });
    });
    assert.equal(app.hub.online.size, 0);
  } finally {
    await app.shutdown();
  }
});

test('Windows-compatible child shutdown signs off a live scroller and exits cleanly', async () => {
  const server = await startServer();
  const client = await Client.connect(server.url, 'live shutdown');
  try {
    await client.signOn('Shutdown96');
    await client.send({ type: 'art', name: 'skull' });
    await client.expectNext('art_status', { state: 'started' });
    await client.expectNext('room_message');
    const stopping = server.stop();
    await client.expectNext('signed_off', { reason: 'server_shutdown' });
    assert.equal((await stopping).code, 0);
    assert.match(server.output.stdout, /has stopped/);
  } finally {
    await client.close();
    await server.stop();
  }
});

test('configuration rejects invalid values instead of starting with unintended limits', () => {
  assert.deepEqual(loadConfig({}), { port: 1996, lobbyCapacity: 23, idleMinutes: 15, graceMinutes: 5 });
  assert.equal(loadConfig({ PORT: ' 1997 ', LOBBY_CAPACITY: '2', IDLE_MINUTES: '.5', GRACE_MINUTES: '.1' }).idleMinutes, .5);
  for (const env of [{ PORT: '65536' }, { PORT: '1.5' }, { PORT: '' }, { LOBBY_CAPACITY: '0' }, { IDLE_MINUTES: 'nan' }, { GRACE_MINUTES: '-1' }]) {
    assert.throws(() => loadConfig(env), ConfigError);
  }
});

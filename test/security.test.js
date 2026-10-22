'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const { createApp } = require('../lib/app');
const { ChatHub } = require('../lib/hub');
const { IncidentLog, INCIDENT_MAX } = require('../lib/incidents');
const { IGNORE_MAX, FRAME_MAX_BYTES } = require('../lib/protocol');
const { MAX_WS_CLIENTS, MAX_BUFFERED_BYTES, localHost } = require('../lib/security');
const { CONFIG, SILENT_LOGGER, fakeSocket, deliver } = require('./support/hub-harness');

async function running(t, options = {}) {
  const app = createApp({ config: CONFIG, logger: SILENT_LOGGER, ...options });
  t.after(() => app.shutdown());
  const { port } = await app.listen(0);
  return { app, port, url: `ws://127.0.0.1:${port}/ws` };
}

function request(port, url, headers) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: url, headers, agent: false }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}

function connect(url, options) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { handshakeTimeout: 3000, ...options });
    ws.once('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

async function refused(url, options, status) {
  await assert.rejects(connect(url, options), new RegExp(`Unexpected server response: ${status}`));
}

async function close(ws) {
  const closed = once(ws, 'close');
  ws.close();
  await closed;
}

test('origin and Host boundaries reject hostile websites and DNS rebinding', async t => {
  const { app, port, url } = await running(t);
  const host = `127.0.0.1:${port}`;
  for (const origin of ['https://evil.example', 'null', `http://127.0.0.1:${port + 1}`, `http://${host}.evil.example`, `https://${host}`]) {
    await refused(url, { origin }, 403);
  }
  for (const host of [`evil.example:${port}`, `localhost.evil.example:${port}`, '127.0.0.1', `127.0.0.1:${port + 1}`, `127.0.0.1.:${port}`]) {
    assert.equal((await request(port, '/', { Host: host })).status, 403, host);
    await refused(url, { headers: { Host: host }, origin: `http://${host}` }, 403);
  }
  for (const origin of [undefined, `http://${host}`]) {
    await close(await connect(url, { origin }));
  }
  await close(await connect(url, { headers: { Host: `localhost:${port}` }, origin: `http://localhost:${port}` }));
  assert.equal(app.hub.online.size, 0);
  assert.equal((await request(port, '/', { Host: `localhost:${port}` })).status, 200);
  assert.equal(localHost({ headers: {}, headersDistinct: {} }, port), null);
  assert.equal(localHost({ headers: { host }, headersDistinct: { host: [host, host] } }, port), null);
  assert.equal(localHost({ headers: { host: 'localhost' }, headersDistinct: { host: ['localhost'] } }, 80), 'localhost');
});

test('HTTP policy permits local scripts and styles while blocking scripts from other origins and framing', async t => {
  const { port } = await running(t);
  for (const url of ['/', '/app.js', '/missing']) {
    const { headers } = await request(port, url);
    const csp = headers['content-security-policy'];
    assert.ok(csp.includes("script-src 'self';"));
    assert.ok(csp.includes("style-src 'self' 'unsafe-inline';"));
    assert.ok(csp.includes(`connect-src 'self' ws://127.0.0.1:${port};`));
    assert.ok(csp.includes("frame-ancestors 'none'"));
    assert.equal(headers['x-frame-options'], 'DENY');
    assert.equal(headers['x-content-type-options'], 'nosniff');
    assert.equal(headers['referrer-policy'], 'no-referrer');
    assert.equal(headers['cross-origin-resource-policy'], 'same-origin');
    assert.equal(headers['permissions-policy'], 'camera=(), microphone=(), geolocation=()');
    assert.equal(headers['access-control-allow-origin'], undefined);
  }
});

test('canonical static boundary blocks a junction escape and keeps internal links usable', async t => {
  const parent = fs.realpathSync(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(parent, 'almost-online-security-'));
  t.after(() => {
    assert.equal(path.dirname(dir), parent);
    assert.ok(path.basename(dir).startsWith('almost-online-security-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const publicDir = path.join(dir, 'public');
  const privateDir = path.join(dir, 'private');
  fs.mkdirSync(path.join(publicDir, 'assets'), { recursive: true });
  fs.mkdirSync(privateDir);
  fs.writeFileSync(path.join(privateDir, 'secret.txt'), 'PRIVATE_CANARY_NEVER_SERVE');
  fs.writeFileSync(path.join(publicDir, 'assets', 'ok.txt'), 'public asset');
  fs.symlinkSync(privateDir, path.join(publicDir, 'escape'), 'junction');
  fs.symlinkSync(path.join(publicDir, 'assets'), path.join(publicDir, 'internal'), 'junction');
  const { port } = await running(t, { publicDir });
  for (const url of ['/escape/secret.txt', '/%65scape/secret.txt', '/%2e%2e/private/secret.txt', '/assets/ok.txt::$DATA']) {
    const res = await request(port, url);
    assert.equal(res.status, 404, url);
    assert.ok(!res.body.includes('PRIVATE_CANARY'));
  }
  assert.equal((await request(port, '/internal/ok.txt')).body, 'public asset');
  assert.equal((await request(port, '/assets')).status, 404);
});

test('connection budget rejects excess clients and recovers after a client leaves', async t => {
  const { app, url } = await running(t);
  const sockets = [];
  t.after(() => Promise.all(sockets.filter(ws => ws.readyState === WebSocket.OPEN).map(close)));
  for (let i = 0; i < MAX_WS_CLIENTS; i++) sockets.push(await connect(url));
  assert.equal(app.wss.clients.size, MAX_WS_CLIENTS);
  await refused(url, {}, 429);
  const departed = once([...app.wss.clients][0], 'close');
  await close(sockets.shift());
  await departed;
  sockets.push(await connect(url));
  assert.equal(app.wss.clients.size, MAX_WS_CLIENTS);
});

test('oversized fragmented frames close only the offender and the service remains usable', async t => {
  const { url } = await running(t);
  const offender = await connect(url);
  offender.on('error', () => {});
  const closed = once(offender, 'close');
  offender.send('a'.repeat(FRAME_MAX_BYTES), { fin: false });
  offender.send('b', { fin: true });
  assert.equal((await closed)[0], 1009);
  const healthy = await connect(url);
  const message = once(healthy, 'message');
  healthy.send(JSON.stringify({ type: 'sign_on', screen_name: 'Healthy96' }));
  assert.equal(JSON.parse((await message)[0]).type, 'signed_on');
  await close(healthy);
});

test('slow-client output is bounded and disconnect cancels its active scroll', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const hub = new ChatHub({ config: CONFIG, logger: SILENT_LOGGER });
  t.after(() => hub.shutdown());
  const ws = fakeSocket();
  hub.attach(ws);
  deliver(ws, { type: 'sign_on', screen_name: 'Slow96' });
  deliver(ws, { type: 'art', name: 'skull' });
  assert.equal(hub.art.jobs.size, 1);
  ws.bufferedAmount = MAX_BUFFERED_BYTES + 1;
  const before = ws.frames.length;
  const reasons = [];
  ws.close = (code, reason) => {
    reasons.push([code, reason]);
    ws.readyState = WebSocket.CLOSED;
    ws.emit('close');
  };
  deliver(ws, { type: 'list_rooms' });
  assert.deepEqual(reasons, [[1013, 'Client is not keeping up']]);
  assert.equal(hub.online.size, 0);
  assert.equal(hub.sockets.size, 0);
  assert.equal(hub.art.jobs.size, 0);
  t.mock.timers.tick(10000);
  assert.equal(ws.frames.length, before);
});

test('ignore budget preserves existing entries and removal permits a new entry', t => {
  let clock = 0;
  const hub = new ChatHub({ config: CONFIG, logger: SILENT_LOGGER, monotonic: () => clock += 1000 });
  t.after(() => hub.shutdown());
  const ws = fakeSocket();
  hub.attach(ws);
  deliver(ws, { type: 'sign_on', screen_name: 'Ignore96' });
  for (let i = 0; i < IGNORE_MAX; i++) deliver(ws, { type: 'ignore', screen_name: `User${i}`, on: true });
  deliver(ws, { type: 'ignore', screen_name: 'uSER0', on: true });
  assert.equal(ws.frames.at(-1).type, 'ignore_status');
  deliver(ws, { type: 'ignore', screen_name: 'Extra96', on: true });
  assert.equal(ws.frames.at(-1).code, 'ignore_limit');
  const client = hub.online.get('ignore96');
  assert.equal(client.ignores.size, IGNORE_MAX);
  assert.ok(client.ignores.has('user0'));
  deliver(ws, { type: 'ignore', screen_name: 'User0', on: false });
  deliver(ws, { type: 'ignore', screen_name: 'Extra96', on: true });
  assert.equal(ws.frames.at(-1).type, 'ignore_status');
  assert.equal(client.ignores.size, IGNORE_MAX);
  assert.ok(client.ignores.has('extra96'));
  deliver(ws, { type: 'sign_off' });
  assert.equal(client.ignores.size, 0);
});

test('incident retention is bounded, minimizes recorded data, and returns independent snapshots', () => {
  const log = new IncidentLog();
  for (let i = 0; i <= INCIDENT_MAX; i++) {
    log.add({ screen_name: `User${i}`, time: String(i), reporter: 'PRIVATE', text: 'SECRET' });
  }
  assert.equal(log.size, INCIDENT_MAX);
  const entries = log.list();
  assert.deepEqual(entries[0], { screen_name: 'User1', time: '1' });
  assert.deepEqual(entries.at(-1), { screen_name: `User${INCIDENT_MAX}`, time: String(INCIDENT_MAX) });
  entries[0].screen_name = 'changed';
  entries.pop();
  assert.equal(log.size, INCIDENT_MAX);
  assert.equal(log.list()[0].screen_name, 'User1');
});

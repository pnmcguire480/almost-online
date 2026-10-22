'use strict';

// Addendum A1 (docs/PROTOCOL.md section 15): the inbound limit is a burst of 20 frames, then 5 frames per second,
// measured on a monotonic clock. Every frame over the limit is dropped and gets its own rate_limited error that
// names the dropped frame's type.
//
// The wire tests below talk to a real server.js child process. They use the raw socket, so frames can be sent faster
// than the client's own pacing allows. The last three tests drive lib/ratelimit.js and lib/hub.js in this process,
// because a clock step cannot be made on the child server from outside. They say so in their names.

const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const { startServer, sleep } = require('./support/server');
const { withClients } = require('./support/client');
const { SILENT_LOGGER, CONFIG, fakeSocket, deliver, deliverRaw } = require('./support/hub-harness');
const { WebSocket } = require('ws');
const { ChatHub } = require('../lib/hub');
const { RateLimiter } = require('../lib/ratelimit');

const RATE_TEXT = 'You are sending messages too fast. Wait a moment.';
const TUNING = { IDLE_MINUTES: '0.5', GRACE_MINUTES: '0.01' };
const OPTIONS = { timeout: 30000 };

let server;
before(async () => {
  server = await startServer(TUNING);
});
after(async () => {
  await server.stop();
});

// Waits until the client has read at least `count` frames. This is used instead of flush(), because a flush is itself
// a frame, and the server drops it once the burst is spent.
async function waitForFrameCount(client, count) {
  const deadline = Date.now() + 3000;
  while (client.frames.length < count) {
    if (Date.now() > deadline) {
      const types = client.frames.map((frame) => frame.type).join(', ');
      throw new Error(`expected ${count} frames, received ${client.frames.length}: ${types}`);
    }
    await sleep(10);
  }
}

// ---- wire tests (child server process) -----------------------------------

test('A1 a burst of 25 frames gets 20 replies, the sign-on and 19 list_rooms, and 6 rate_limited errors, one per dropped frame', OPTIONS, () =>
  withClients(server.url, async (connect) => {
    const client = await connect('Burst');
    // Sign-on takes one token of the burst of 20. The 25 list_rooms below are sent in one go, so 19 are processed and 6 are dropped.
    client.ws.send(JSON.stringify({ type: 'sign_on', screen_name: 'Burst01' }));
    for (let i = 0; i < 25; i += 1) client.ws.send(JSON.stringify({ type: 'list_rooms' }));

    await waitForFrameCount(client, 3 + 19 + 6);
    await sleep(100); // Any frame beyond the expected ones would arrive in this window.

    const types = client.frames.map((frame) => frame.type);
    assert.deepEqual(types, [
      'signed_on',
      'room_state',
      ...Array(20).fill('room_list'),
      ...Array(6).fill('error'),
    ]);
    for (const frame of client.frames.slice(-6)) {
      assert.deepEqual(frame, { type: 'error', code: 'rate_limited', message: RATE_TEXT, ref: 'list_rooms', field: null });
    }
    assert.equal(client.closed, false, 'the connection should stay open after a rate limit');

    await sleep(1100); // Lets the bucket refill so that the teardown sign-off is accepted.
  }));

test('A1 a dropped frame gets ref set to its type cut to 40 characters, and a frame with no readable type gets ref null', OPTIONS, () =>
  withClients(server.url, async (connect) => {
    const client = await connect('Refs');
    client.ws.send(JSON.stringify({ type: 'sign_on', screen_name: 'Refs01' }));
    for (let i = 0; i < 19; i += 1) client.ws.send(JSON.stringify({ type: 'list_rooms' }));

    // The burst is spent, so these three frames are all dropped: a long type, a binary message, and text that is not JSON.
    const longType = 'x'.repeat(60);
    client.ws.send(JSON.stringify({ type: longType }));
    client.ws.send(Buffer.from([1, 2, 3]), { binary: true });
    client.ws.send('not json');

    await waitForFrameCount(client, 3 + 19 + 3);
    await sleep(100);
    assert.equal(client.frames.length, 3 + 19 + 3, 'no frame beyond the expected ones should arrive');
    assert.deepEqual(client.frames.slice(-3), [
      { type: 'error', code: 'rate_limited', message: RATE_TEXT, ref: 'x'.repeat(40), field: null },
      { type: 'error', code: 'rate_limited', message: RATE_TEXT, ref: null, field: null },
      { type: 'error', code: 'rate_limited', message: RATE_TEXT, ref: null, field: null },
    ]);

    await sleep(1100);
  }));

test('A1 after a pause the bucket refills, so five more frames are processed', OPTIONS, () =>
  withClients(server.url, async (connect) => {
    const client = await connect('Pause');
    client.ws.send(JSON.stringify({ type: 'sign_on', screen_name: 'Pause01' }));
    for (let i = 0; i < 25; i += 1) client.ws.send(JSON.stringify({ type: 'list_rooms' }));
    await waitForFrameCount(client, 3 + 19 + 6);

    await sleep(1100); // At 5 frames per second, about five tokens are back.
    const start = client.frames.length;
    for (let i = 0; i < 5; i += 1) client.ws.send(JSON.stringify({ type: 'list_rooms' }));
    await waitForFrameCount(client, start + 5);
    await sleep(100);

    assert.deepEqual(
      client.frames.slice(start).map((frame) => frame.type),
      ['room_list', 'room_list', 'room_list', 'room_list', 'room_list'],
    );
    assert.equal(client.closed, false, 'the connection should stay open');
  }));

// ---- in-process checks (lib/ratelimit.js and lib/hub.js, no child process) ----

test('A1 (in-process) a backward step of the clock removes no tokens and drops no frame', () => {
  let clock = 1000000; // milliseconds
  const limiter = new RateLimiter({ capacity: 20, perSecond: 5, now: () => clock });
  for (let i = 0; i < 5; i += 1) assert.equal(limiter.take(), true);

  // The clock is corrected back ten minutes. Ten tokens are left, so five more frames pass.
  clock -= 600000;
  for (let i = 0; i < 5; i += 1) assert.equal(limiter.take(), true);

  // One second of forward time from the corrected clock refills five tokens: 10 + 5 = 15 are now available.
  clock += 1000;
  for (let i = 0; i < 15; i += 1) assert.equal(limiter.take(), true);
  assert.equal(limiter.take(), false);
});

test('A1 (in-process) the default clock never reads the wall clock', () => {
  const realNow = Date.now;
  let wall = 1e12;
  Date.now = () => {
    wall -= 1000000; // Every reading is earlier than the one before, as if the clock kept being corrected backwards.
    return wall;
  };
  try {
    const limiter = new RateLimiter({ capacity: 20, perSecond: 5 });
    let accepted = 0;
    for (let i = 0; i < 25; i += 1) {
      if (limiter.take()) accepted += 1;
    }
    assert.equal(accepted, 20);
  } finally {
    Date.now = realNow;
  }
});

test('A1 (in-process) a ten-minute backward step of the server clock drops no frames', () => {
  let wall = 1700000000000;
  const hub = new ChatHub({ config: CONFIG, logger: SILENT_LOGGER, now: () => wall });
  const ws = fakeSocket();
  try {
    hub.attach(ws);
    deliver(ws, { type: 'sign_on', screen_name: 'abc' });
    for (let i = 0; i < 5; i += 1) deliver(ws, { type: 'list_rooms' });

    wall -= 600000; // The server clock is corrected back ten minutes.
    for (let i = 0; i < 5; i += 1) deliver(ws, { type: 'list_rooms' });

    const types = ws.frames.map((frame) => frame.type);
    assert.equal(types.filter((type) => type === 'error').length, 0);
    // One room_list from sign_on, then one for each of the ten list_rooms frames.
    assert.equal(types.filter((type) => type === 'room_list').length, 11);
  } finally {
    hub.shutdown();
  }
});

test('A1 (in-process) a frame over the limit is dropped unprocessed, with one rate_limited error each', () => {
  const hub = new ChatHub({ config: CONFIG, logger: SILENT_LOGGER });
  const ws = fakeSocket();
  try {
    hub.attach(ws);
    deliver(ws, { type: 'sign_on', screen_name: 'abc' }); // The first frame takes one token of the 20-frame burst.
    ws.frames.length = 0;

    for (let i = 0; i < 25; i += 1) deliver(ws, { type: 'list_rooms' });

    // 19 tokens are left: 19 room_list replies, then 6 frames are dropped and each one gets an error.
    const errors = ws.frames.filter((frame) => frame.type === 'error');
    assert.equal(ws.frames.filter((frame) => frame.type === 'room_list').length, 19);
    assert.equal(errors.length, 6);
    for (const error of errors) {
      assert.deepEqual(error, {
        type: 'error',
        code: 'rate_limited',
        message: RATE_TEXT,
        ref: 'list_rooms',
        field: null,
      });
    }
    assert.equal(ws.readyState, WebSocket.OPEN, 'the connection stays open');
  } finally {
    hub.shutdown();
  }
});

test('A1 (in-process) a dropped binary or non-JSON frame gets rate_limited with ref null', () => {
  const hub = new ChatHub({ config: CONFIG, logger: SILENT_LOGGER });
  const ws = fakeSocket();
  try {
    hub.attach(ws);
    deliver(ws, { type: 'sign_on', screen_name: 'abc' });
    for (let i = 0; i < 19; i += 1) deliver(ws, { type: 'list_rooms' }); // Uses the rest of the burst.
    ws.frames.length = 0;

    deliverRaw(ws, [1, 2, 3], true); // binary
    deliverRaw(ws, 'not json', false); // text that is not JSON

    const errors = ws.frames.filter((frame) => frame.type === 'error');
    assert.equal(errors.length, 2);
    for (const error of errors) {
      assert.equal(error.code, 'rate_limited');
      assert.equal(error.ref, null);
    }
  } finally {
    hub.shutdown();
  }
});

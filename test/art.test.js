'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ChatHub } = require('../lib/hub');
const { ART, ART_INTERVAL_MS, ArtScroller } = require('../lib/art');
const { createApp } = require('../lib/app');
const { CONFIG, SILENT_LOGGER, fakeSocket, deliver } = require('./support/hub-harness');
const { withClients } = require('./support/client');

function setup(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let clock = 0;
  const hub = new ChatHub({ config: CONFIG, logger: SILENT_LOGGER, monotonic: () => clock += 2000 });
  t.after(() => hub.shutdown());
  const connect = (name) => {
    const ws = fakeSocket();
    hub.attach(ws);
    deliver(ws, { type: 'sign_on', screen_name: name });
    ws.frames.length = 0;
    return ws;
  };
  const alice = connect('Alice96');
  const bob = connect('Bob96');
  alice.frames.length = 0;
  return { hub, alice, bob, connect };
}

const artFrames = (ws) => ws.frames.filter(f => f.type === 'room_message' && f.art);

function finish(t, name) {
  for (let i = 1; i < ART[name].lines.length; i++) t.mock.timers.tick(ART_INTERVAL_MS);
}

test('art requires sign-on; catalog is private, complete, and cannot expose object properties', t => {
  const { hub, alice, bob } = setup(t);
  const guest = fakeSocket();
  hub.attach(guest);
  deliver(guest, { type: 'art', name: 'skull' });
  assert.equal(guest.frames[0].code, 'not_signed_on');
  for (const name of [undefined, '', 'list', 'help']) {
    deliver(alice, { type: 'art', name });
    const result = alice.frames.at(-1);
    assert.equal(result.state, 'catalog');
    assert.deepEqual(result.pieces.map(p => p.name), ['skull', 'finger', 'banner', 'divider']);
    assert.deepEqual(result.pieces[0].lines, ART.skull.lines);
    assert.equal(result.interval_ms, 650);
  }
  for (const name of [null, {}, 5, '__proto__', 'constructor', 'toString', 'nope']) {
    deliver(alice, { type: 'art', name });
    assert.equal(alice.frames.at(-1).code, 'invalid_field');
    assert.equal(alice.frames.at(-1).ref, 'art');
  }
  assert.equal(bob.frames.length, 0);
});

for (const name of Object.keys(ART)) {
  test(`art ${name} scrolls exact ASCII lines to sender and peer at 650ms, then releases its job`, t => {
    const { hub, alice, bob } = setup(t);
    deliver(alice, { type: 'art', name: name === 'finger' ? ' MiddleFinger ' : name.toUpperCase() });
    assert.equal(alice.frames[0].state, 'started');
    assert.equal(artFrames(alice).length, 1);
    if (ART[name].lines.length > 1) {
      t.mock.timers.tick(ART_INTERVAL_MS - 1);
      assert.equal(artFrames(alice).length, 1);
      t.mock.timers.tick(1);
      for (let i = 2; i < ART[name].lines.length; i++) t.mock.timers.tick(ART_INTERVAL_MS);
    }
    const frames = artFrames(bob);
    assert.deepEqual(frames.map(f => f.text), ART[name].lines);
    assert.deepEqual(artFrames(alice), frames);
    assert.deepEqual(frames.map(f => f.art.line), ART[name].lines.map((_, i) => i + 1));
    assert.ok(frames.every(f => f.art.total === ART[name].lines.length && f.from === 'Alice96' && f.fmt === null));
    assert.equal(alice.frames.at(-1).state, 'finished');
    assert.equal(hub.art.jobs.size, 0);
    t.mock.timers.tick(10000);
    assert.equal(artFrames(bob).length, ART[name].lines.length);
  });
}

test('one scroll per sender; stop is private, immediate, idempotent and permits a fresh scroll', t => {
  const { hub, alice, bob } = setup(t);
  deliver(alice, { type: 'art', name: 'skull' });
  deliver(alice, { type: 'art', name: 'finger' });
  assert.equal(alice.frames.at(-1).code, 'art_busy');
  assert.equal(hub.art.jobs.size, 1);
  deliver(alice, { type: 'art', name: 'stop' });
  deliver(alice, { type: 'art', name: 'stop' });
  assert.equal(alice.frames.at(-1).state, 'stopped');
  t.mock.timers.tick(10000);
  assert.equal(artFrames(bob).length, 1);
  assert.equal(hub.art.jobs.size, 0);
  deliver(alice, { type: 'art', name: 'divider' });
  assert.equal(artFrames(bob).at(-1).art.name, 'divider');
});

test('ignore is checked on every art line; other rooms never receive the scroll', t => {
  const { alice, bob, connect } = setup(t);
  const outsider = connect('Other96');
  deliver(outsider, { type: 'create_room', name: 'Elsewhere' });
  deliver(alice, { type: 'art', name: 'skull' });
  deliver(bob, { type: 'ignore', screen_name: 'Alice96', on: true });
  t.mock.timers.tick(ART_INTERVAL_MS);
  assert.equal(artFrames(bob).length, 1);
  deliver(bob, { type: 'ignore', screen_name: 'Alice96', on: false });
  t.mock.timers.tick(ART_INTERVAL_MS);
  assert.equal(artFrames(bob).length, 2);
  assert.equal(artFrames(bob).at(-1).art.line, 3);
  assert.equal(artFrames(outsider).length, 0);
  assert.equal(artFrames(alice).length, 3);
});

for (const action of ['stop', 'switch', 'leave', 'kick', 'sign_off', 'disconnect', 'shutdown', 'idle']) {
  test(`art cancellation on ${action} prevents all subsequent lines and timers`, t => {
    const { hub, alice, bob } = setup(t);
    if (action === 'kick') {
      deliver(bob, { type: 'create_room', name: 'Test Room' });
      deliver(alice, { type: 'join_room', name: 'Test Room' });
    }
    deliver(alice, { type: 'art', name: 'skull' });
    assert.equal(artFrames(bob).length, 1);
    switch (action) {
      case 'stop': deliver(alice, { type: 'art', name: 'stop' }); break;
      case 'switch': deliver(alice, { type: 'create_room', name: 'Elsewhere' }); break;
      case 'leave': deliver(alice, { type: 'leave_room' }); break;
      case 'kick': deliver(bob, { type: 'kick', screen_name: 'Alice96' }); break;
      case 'sign_off': deliver(alice, { type: 'sign_off' }); break;
      case 'disconnect': alice.close(); alice.emit('close'); break;
      case 'shutdown': hub.shutdown(); break;
      case 'idle': hub.onGraceExpired(hub.online.get('alice96')); break;
    }
    assert.equal(hub.art.jobs.size, 0);
    t.mock.timers.tick(10000);
    assert.equal(artFrames(bob).length, 1);
  });
}

test('independent senders can scroll concurrently; cancelling one leaves the other running', t => {
  const { hub, alice, bob } = setup(t);
  deliver(alice, { type: 'art', name: 'skull' });
  deliver(bob, { type: 'art', name: 'finger' });
  deliver(alice, { type: 'art', name: 'stop' });
  finish(t, 'finger');
  assert.equal(artFrames(alice).filter(f => f.from === 'Alice96').length, 1);
  assert.deepEqual(artFrames(alice).filter(f => f.from === 'Bob96').map(f => f.text), ART.finger.lines);
  assert.equal(hub.art.jobs.size, 0);
});

test('scroller rejects duplicate jobs without replacing callbacks', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const scroller = new ArtScroller();
  const lines = [];
  assert.equal(scroller.start('owner', 'skull', text => lines.push(text), () => {}), true);
  assert.equal(scroller.start('owner', 'finger', () => assert.fail('replaced scroll'), () => {}), false);
  finish(t, 'skull');
  assert.deepEqual(lines, ART.skull.lines);
  assert.equal(scroller.cancel('missing'), false);
  scroller.shutdown();
});

test('real WebSocket clients receive paced art, can chat during a scroll, and stop it', { timeout: 10000 }, async () => {
  const app = createApp({ config: CONFIG, logger: SILENT_LOGGER });
  const address = await app.listen(0);
  try {
    await withClients(`ws://127.0.0.1:${address.port}/ws`, async connect => {
      const alice = await connect('Alice');
      const bob = await connect('Bob');
      await alice.signOn('Alice96');
      await bob.signOn('Bob96');
      await alice.flush();
      await bob.flush();
      await alice.send({ type: 'art', name: 'skull' });
      await alice.expectNext('art_status', { state: 'started', name: 'skull' });
      const first = await bob.expectNext('room_message', { text: ART.skull.lines[0] });
      const next = await bob.expectNext('room_message', { text: ART.skull.lines[1] });
      assert.ok(next.ts - first.ts >= ART_INTERVAL_MS - 30);
      await bob.send({ type: 'say', text: 'nice prog lol' });
      await bob.expectNext('room_message', { text: 'nice prog lol' });
      await alice.send({ type: 'art', name: 'stop' });
      await alice.waitForFrame('art_status', { state: 'stopped' });
      assert.equal(app.hub.art.jobs.size, 0);
    });
  } finally {
    await app.shutdown();
  }
});

'use strict';

// M1: sign on with a screen name (PARITY.md M1; PROTOCOL.md sections 2.1, 2.2, 5.1, 7.4).

const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const { startServer } = require('./support/server');
const { withClients } = require('./support/client');

// Default lobby capacity (23). Idle and grace values are small, and no test here sits idle long enough to reach them.
const TUNING = { IDLE_MINUTES: '0.5', GRACE_MINUTES: '0.01' };

let server;
before(async () => {
  server = await startServer(TUNING);
});
after(async () => {
  await server.stop();
});

test('M1 sign on with "abc" returns signed_on, then room_state for Lobby 1, then room_list', { timeout: 20000 }, () =>
  withClients(server.url, async (connect) => {
    const client = await connect('Abc');
    await client.send({ type: 'sign_on', screen_name: 'abc' });
    await client.expectNext('signed_on', { screen_name: 'abc' });
    await client.expectNext('room_state', {
      room: 'Lobby 1',
      kind: 'lobby',
      capacity: 23,
      members: ['abc'],
      host: null,
      redirected_from: null,
    });
    const list = await client.expectNext('room_list');
    const lobby = list.rooms.find((room) => room.name === 'Lobby 1');
    assert.ok(lobby, 'room_list should include Lobby 1');
    assert.equal(lobby.count, 1, 'Lobby 1 should show one person');
  }));

test('M1 names of 2 or 11 characters, and a name with a space, return invalid_field on screen_name', { timeout: 20000 }, () =>
  withClients(server.url, async (connect) => {
    const client = await connect('Bad');
    for (const name of ['ab', 'abcdefghijk', 'a b']) {
      await client.send({ type: 'sign_on', screen_name: name });
      const error = await client.expectNext('error', { code: 'invalid_field', field: 'screen_name', ref: 'sign_on' });
      assert.ok(error.message.length > 0, `the error for "${name}" should carry a message`);
    }
  }));

test('M1 names of exactly 3 and 10 characters are accepted', { timeout: 20000 }, () =>
  withClients(server.url, async (connect) => {
    const client = await connect('Edge');
    await client.signOn('abc');
    await client.signOff();
    await client.signOn('abcdefghij');
  }));

test('M1 spaces around a name are trimmed before the rule is checked', { timeout: 20000 }, () =>
  withClients(server.url, async (connect) => {
    const client = await connect('Trim');
    await client.send({ type: 'sign_on', screen_name: '  Kay12  ' });
    await client.expectNext('signed_on', { screen_name: 'Kay12' });
  }));

test('M1 "ABC" while "abc" is signed on returns name_taken, and the first connection stays signed on', { timeout: 20000 }, () =>
  withClients(server.url, async (connect) => {
    const first = await connect('First');
    await first.signOn('abc');

    const second = await connect('Second');
    await second.send({ type: 'sign_on', screen_name: 'ABC' });
    await second.expectNext('error', { code: 'name_taken', field: 'screen_name', ref: 'sign_on' });

    // The refused sign-on must not reach the first connection. A flush also proves it is still signed on.
    const pending = await first.flush();
    assert.deepEqual(
      pending.map((frame) => frame.type),
      [],
      'the first connection should receive no frames from the refused sign-on',
    );
  }));

test('M1 a second sign_on on a signed-on connection returns already_signed_on', { timeout: 20000 }, () =>
  withClients(server.url, async (connect) => {
    const client = await connect('Twice');
    await client.signOn('abc');
    await client.send({ type: 'sign_on', screen_name: 'xyz' });
    await client.expectNext('error', { code: 'already_signed_on', ref: 'sign_on' });
  }));

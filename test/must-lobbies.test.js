'use strict';

// M3: public lobbies with overflow (PARITY.md M3; PROTOCOL.md sections 6.4, 11.1, 11.2, 11.4, 15 A4).
// This file runs its own server with LOBBY_CAPACITY=2, so five people fill three lobbies.

const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const { startServer } = require('./support/server');
const { withClients } = require('./support/client');

const TUNING = { LOBBY_CAPACITY: '2', IDLE_MINUTES: '0.5', GRACE_MINUTES: '0.01' };
const OPTIONS = { timeout: 30000 };

let server;
before(async () => {
  server = await startServer(TUNING);
});
after(async () => {
  await server.stop();
});

// Signs on n people one after another, each as "LobN" (Lob1 to Lob5), and returns their connections and room_states.
async function signOnPeople(connect, count) {
  const people = [];
  for (let i = 1; i <= count; i += 1) {
    const client = await connect(`U${i}`);
    const roomState = await client.signOn(`Lob${i}`);
    people.push({ client, room: roomState.room });
  }
  return people;
}

test('M3 five users sign on one after another, filling Lobby 1 and Lobby 2 and putting one person in Lobby 3', OPTIONS, () =>
  withClients(server.url, async (connect) => {
    const people = await signOnPeople(connect, 5);
    assert.deepEqual(
      people.map((person) => person.room),
      ['Lobby 1', 'Lobby 1', 'Lobby 2', 'Lobby 2', 'Lobby 3'],
      'each sign-on should be placed in the first lobby with room',
    );

    const list = await people[0].client.requestRoomList();
    assert.deepEqual(list.rooms, [
      { name: 'Lobby 1', kind: 'lobby', count: 2, capacity: 2 },
      { name: 'Lobby 2', kind: 'lobby', count: 2, capacity: 2 },
      { name: 'Lobby 3', kind: 'lobby', count: 1, capacity: 2 },
    ]);
  }));

test('M3 a full lobby sends a joiner from another room to Lobby 3, with redirected_from set to the lobby asked for', OPTIONS, () =>
  withClients(server.url, async (connect) => {
    const people = await signOnPeople(connect, 5);

    // Lob6 signs on into Lobby 3 (now full), creates Cats, which leaves Lobby 3 with room again, then asks for Lobby 1.
    const lob6 = await connect('U6');
    await lob6.signOn('Lob6');
    await lob6.send({ type: 'create_room', name: 'Cats' });
    await lob6.expectNext('room_left', { room: 'Lobby 3', reason: 'switched' });
    await lob6.expectNext('room_state', { room: 'Cats', kind: 'member' });
    await lob6.expectNext('room_list');

    await lob6.send({ type: 'join_room', name: 'Lobby 1' });
    await lob6.expectNext('room_left', { room: 'Cats', reason: 'switched' });
    await lob6.expectNext('room_state', {
      room: 'Lobby 3',
      kind: 'lobby',
      capacity: 2,
      members: ['Lob5', 'Lob6'],
      host: null,
      redirected_from: 'Lobby 1',
    });
    await lob6.expectNext('room_list');

    const seen = await people[4].client.flush();
    assert.ok(
      seen.some((frame) => frame.type === 'member_joined' && frame.room === 'Lobby 3' && frame.screen_name === 'Lob6'),
      `Lob5, already in Lobby 3, should receive member_joined for Lob6 (received: ${seen.map((f) => f.type).join(', ')})`,
    );
  }));

test('M3 a join to a full lobby creates Lobby 3 when no lobby has room', OPTIONS, () =>
  withClients(server.url, async (connect) => {
    await signOnPeople(connect, 4);

    // Lob5 lands in a new Lobby 3. Creating Cats empties Lobby 3, which removes it. Asking for Lobby 1 creates it again.
    const lob5 = await connect('U5');
    await lob5.signOn('Lob5');
    await lob5.send({ type: 'create_room', name: 'Cats' });
    await lob5.expectNext('room_left', { room: 'Lobby 3', reason: 'switched' });
    await lob5.expectNext('room_state', { room: 'Cats', kind: 'member' });
    await lob5.expectNext('room_list');

    await lob5.send({ type: 'join_room', name: 'Lobby 1' });
    await lob5.expectNext('room_left', { room: 'Cats', reason: 'switched' });
    await lob5.expectNext('room_state', {
      room: 'Lobby 3',
      kind: 'lobby',
      members: ['Lob5'],
      redirected_from: 'Lobby 1',
    });
    const list = await lob5.expectNext('room_list');
    assert.deepEqual(
      list.rooms.find((room) => room.name === 'Lobby 3'),
      { name: 'Lobby 3', kind: 'lobby', count: 1, capacity: 2 },
    );
  }));

test('M3 a person already in Lobby 3 who asks for full Lobby 1 gets room_state for Lobby 3 with no notices', OPTIONS, () =>
  withClients(server.url, async (connect) => {
    const people = await signOnPeople(connect, 5);
    const lob5 = people[4].client;

    await lob5.send({ type: 'join_room', name: 'Lobby 1' });
    await lob5.expectNext('room_state', {
      room: 'Lobby 3',
      kind: 'lobby',
      members: ['Lob5'],
      redirected_from: 'Lobby 1',
    });
  }));

test('M3 a lobby that empties leaves room_list, and Lobby 1 never does', OPTIONS, () =>
  withClients(server.url, async (connect) => {
    const people = await signOnPeople(connect, 5);
    const observer = people[4].client;

    await people[2].client.signOff();
    await people[3].client.signOff();
    let list = await observer.requestRoomList();
    assert.deepEqual(list.rooms, [
      { name: 'Lobby 1', kind: 'lobby', count: 2, capacity: 2 },
      { name: 'Lobby 3', kind: 'lobby', count: 1, capacity: 2 },
    ], 'Lobby 2 should be gone once its last person signed off');

    await people[0].client.signOff();
    await people[1].client.signOff();
    list = await observer.requestRoomList();
    assert.deepEqual(list.rooms, [
      { name: 'Lobby 1', kind: 'lobby', count: 0, capacity: 2 },
      { name: 'Lobby 3', kind: 'lobby', count: 1, capacity: 2 },
    ], 'Lobby 1 should stay in room_list with no one in it');
  }));

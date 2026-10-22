'use strict';

// M2, M4, M6, M7 and M9: the room list, creating and joining rooms, the people list, arrival and departure notices,
// and leaving or signing off (PARITY.md; PROTOCOL.md sections 5.4 to 5.6, 6.4 to 6.8, 11).

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

const OPTIONS = { timeout: 30000 };

// ---- M2 ------------------------------------------------------------------

test('M2 room_list shows each room with a count equal to the members in its room_state, and a lobby with capacity 23', OPTIONS, () =>
  withClients(server.url, async (connect) => {
    const amy = await connect('Amy');
    const ben = await connect('Ben');
    const cy = await connect('Cy');
    await amy.signOn('Amy01');
    await ben.signOn('Ben02');
    await cy.signOn('Cy03');

    await cy.send({ type: 'create_room', name: 'Cats' });
    await cy.expectNext('room_left', { room: 'Lobby 1', reason: 'switched' });
    const catsState = await cy.expectNext('room_state', { room: 'Cats', kind: 'member' });
    await cy.expectNext('room_list');

    // Amy leaves and is placed back in Lobby 1, so her room_state carries the current members of that lobby.
    await amy.flush();
    await amy.send({ type: 'leave_room' });
    await amy.expectNext('room_left', { room: 'Lobby 1', reason: 'left' });
    const lobbyState = await amy.expectNext('room_state', { room: 'Lobby 1', kind: 'lobby' });
    await amy.expectNext('room_list');

    const list = await amy.requestRoomList();
    assert.deepEqual(list.rooms, [
      { name: 'Lobby 1', kind: 'lobby', count: 2, capacity: 23 },
      { name: 'Cats', kind: 'member', count: 1, capacity: 23 },
    ]);
    assert.equal(lobbyState.members.length, 2, 'Lobby 1 room_state should list two members');
    assert.equal(catsState.members.length, 1, 'Cats room_state should list one member');
  }));

// ---- M4 ------------------------------------------------------------------

test('M4 create_room "Cats" returns a member room_state, and room_list then shows Cats', OPTIONS, () =>
  withClients(server.url, async (connect) => {
    const amy = await connect('Amy');
    await amy.signOn('Amy01');
    await amy.send({ type: 'create_room', name: 'Cats' });
    await amy.expectNext('room_left', { room: 'Lobby 1', reason: 'switched' });
    await amy.expectNext('room_state', {
      room: 'Cats',
      kind: 'member',
      capacity: 23,
      members: ['Amy01'],
      host: 'Amy01',
      redirected_from: null,
    });
    const list = await amy.expectNext('room_list');
    assert.ok(
      list.rooms.some((room) => room.name === 'Cats' && room.kind === 'member' && room.count === 1),
      'room_list should show Cats as a member room with one person',
    );
  }));

test('M4 create_room "cats" while Cats is open returns room_name_taken, and "Lobby 9" or "lobby 1" returns room_name_reserved', OPTIONS, () =>
  withClients(server.url, async (connect) => {
    const amy = await connect('Amy');
    await amy.signOn('Amy01');
    await amy.send({ type: 'create_room', name: 'Cats' });
    await amy.expectNext('room_left', { room: 'Lobby 1', reason: 'switched' });
    await amy.expectNext('room_state', { room: 'Cats' });
    await amy.expectNext('room_list');

    const ben = await connect('Ben');
    await ben.signOn('Ben02');

    await ben.send({ type: 'create_room', name: 'cats' });
    await ben.expectNext('error', { code: 'room_name_taken', field: 'name', ref: 'create_room' });

    await ben.send({ type: 'create_room', name: 'Lobby 9' });
    await ben.expectNext('error', { code: 'room_name_reserved', field: 'name', ref: 'create_room' });

    await ben.send({ type: 'create_room', name: 'lobby 1' });
    await ben.expectNext('error', { code: 'room_name_reserved', field: 'name', ref: 'create_room' });
  }));

test('M4 join_room "CATS" returns room_state for Cats, and join_room "Nowhere" returns no_such_room', OPTIONS, () =>
  withClients(server.url, async (connect) => {
    const amy = await connect('Amy');
    await amy.signOn('Amy01');
    await amy.send({ type: 'create_room', name: 'Cats' });
    await amy.expectNext('room_left', { room: 'Lobby 1', reason: 'switched' });
    await amy.expectNext('room_state', { room: 'Cats' });
    await amy.expectNext('room_list');

    const ben = await connect('Ben');
    await ben.signOn('Ben02');
    await ben.send({ type: 'join_room', name: 'CATS' });
    await ben.expectNext('room_left', { room: 'Lobby 1', reason: 'switched' });
    await ben.expectNext('room_state', {
      room: 'Cats',
      kind: 'member',
      members: ['Amy01', 'Ben02'],
      host: 'Amy01',
    });
    await ben.expectNext('room_list');

    await ben.send({ type: 'join_room', name: 'Nowhere' });
    await ben.expectNext('error', { code: 'no_such_room', field: 'name', ref: 'join_room' });
  }));

test('M4 Cats is removed from room_list after its last occupant leaves', OPTIONS, () =>
  withClients(server.url, async (connect) => {
    const amy = await connect('Amy');
    await amy.signOn('Amy01');
    await amy.send({ type: 'create_room', name: 'Cats' });
    await amy.expectNext('room_left', { room: 'Lobby 1', reason: 'switched' });
    await amy.expectNext('room_state', { room: 'Cats' });
    await amy.expectNext('room_list');

    const ben = await connect('Ben');
    await ben.signOn('Ben02');
    const initial = await ben.requestRoomList();
    assert.ok(initial.rooms.some((room) => room.name === 'Cats'), 'Cats should be listed while Amy is in it');

    // Ben's sign-on sent Amy a room_list broadcast. Read it first, so the next frame Amy reads is her leave reply.
    await amy.flush();
    await amy.send({ type: 'leave_room' });
    await amy.expectNext('room_left', { room: 'Cats', reason: 'left' });
    await amy.expectNext('room_state', { room: 'Lobby 1', kind: 'lobby' });
    await amy.expectNext('room_list');

    const after = await ben.requestRoomList();
    assert.ok(!after.rooms.some((room) => room.name === 'Cats'), 'Cats should be gone once its last occupant has left');
    assert.ok(after.rooms.some((room) => room.name === 'Lobby 1'), 'Lobby 1 should remain');
  }));

// ---- M6 ------------------------------------------------------------------

test('M6 room_state members are sorted case-insensitively and include the receiver', OPTIONS, () =>
  withClients(server.url, async (connect) => {
    const zed = await connect('Zed');
    const mike = await connect('Mike');
    const alpha = await connect('Alpha');
    await zed.signOn('Zed77');
    const mikeState = await mike.signOn('mike22');
    // A case-sensitive sort would put "Zed77" before "mike22". Case-insensitive order puts "mike22" first.
    assert.deepEqual(mikeState.members, ['mike22', 'Zed77']);
    const alphaState = await alpha.signOn('Alpha1');
    assert.deepEqual(alphaState.members, ['Alpha1', 'mike22', 'Zed77']);
    assert.ok(alphaState.members.includes('Alpha1'), 'the receiver should be in its own members list');
  }));

test('M6 after a person joins the room sees member_joined, and after they leave sees member_left', OPTIONS, () =>
  withClients(server.url, async (connect) => {
    const amy = await connect('Amy');
    const ben = await connect('Ben');
    await amy.signOn('Amy01');
    await ben.signOn('Ben02');

    const joined = await amy.flush();
    assert.ok(
      joined.some((frame) => frame.type === 'member_joined' && frame.screen_name === 'Ben02' && frame.room === 'Lobby 1'),
      `Amy should receive member_joined for Ben02 (received: ${joined.map((f) => f.type).join(', ')})`,
    );

    await ben.send({ type: 'leave_room' });
    await ben.expectNext('room_left', { room: 'Lobby 1', reason: 'left' });
    await ben.expectNext('room_state', { room: 'Lobby 1', kind: 'lobby' });
    await ben.expectNext('room_list');

    const left = await amy.flush();
    assert.ok(
      left.some((frame) => frame.type === 'member_left' && frame.screen_name === 'Ben02' && frame.reason === 'left'),
      `Amy should receive member_left for Ben02 with reason left (received: ${left.map((f) => f.type).join(', ')})`,
    );
  }));

// ---- M7 ------------------------------------------------------------------

test('M7 a join sends member_joined to the people already in the room, and not to the joiner', OPTIONS, () =>
  withClients(server.url, async (connect) => {
    const amy = await connect('Amy');
    const ben = await connect('Ben');
    await amy.signOn('Amy01');
    await ben.signOn('Ben02');

    const seenByAmy = await amy.flush();
    assert.ok(
      seenByAmy.some((frame) => frame.type === 'member_joined' && frame.screen_name === 'Ben02'),
      'Amy, already in the room, should receive member_joined for Ben02',
    );

    const seenByBen = await ben.flush();
    assert.ok(
      !seenByBen.some((frame) => frame.type === 'member_joined'),
      'Ben, the joiner, should not receive member_joined about himself',
    );
  }));

test('M7 a switch to another room sends member_left with reason switched to the room that is left', OPTIONS, () =>
  withClients(server.url, async (connect) => {
    const amy = await connect('Amy');
    const ben = await connect('Ben');
    await amy.signOn('Amy01');
    await ben.signOn('Ben02');
    await amy.flush();

    await ben.send({ type: 'create_room', name: 'Cats' });
    await ben.expectNext('room_left', { room: 'Lobby 1', reason: 'switched' });
    await ben.expectNext('room_state', { room: 'Cats' });
    await ben.expectNext('room_list');

    const seen = await amy.flush();
    assert.ok(
      seen.some((frame) => frame.type === 'member_left' && frame.screen_name === 'Ben02' && frame.reason === 'switched'),
      `Amy should receive member_left for Ben02 with reason switched (received: ${seen.map((f) => f.type).join(', ')})`,
    );
  }));

// ---- M9 ------------------------------------------------------------------

test('M9 leave_room returns room_left with reason left, then room_state for a lobby, and the others get member_left left', OPTIONS, () =>
  withClients(server.url, async (connect) => {
    const amy = await connect('Amy');
    const ben = await connect('Ben');
    await amy.signOn('Amy01');
    await ben.signOn('Ben02');

    // Both move into Cats so that Amy's leave has someone left to tell.
    await ben.send({ type: 'create_room', name: 'Cats' });
    await ben.expectNext('room_left', { room: 'Lobby 1', reason: 'switched' });
    await ben.expectNext('room_state', { room: 'Cats' });
    await ben.expectNext('room_list');
    await amy.flush();

    await amy.send({ type: 'join_room', name: 'Cats' });
    await amy.expectNext('room_left', { room: 'Lobby 1', reason: 'switched' });
    await amy.expectNext('room_state', { room: 'Cats', members: ['Amy01', 'Ben02'] });
    await amy.expectNext('room_list');
    await ben.flush();

    await amy.send({ type: 'leave_room' });
    await amy.expectNext('room_left', { room: 'Cats', reason: 'left' });
    await amy.expectNext('room_state', { room: 'Lobby 1', kind: 'lobby' });
    await amy.expectNext('room_list');

    const seen = await ben.flush();
    assert.ok(
      seen.some((frame) => frame.type === 'member_left' && frame.screen_name === 'Amy01' && frame.reason === 'left' && frame.room === 'Cats'),
      `Ben should receive member_left for Amy01 with reason left (received: ${seen.map((f) => f.type).join(', ')})`,
    );
  }));

test('M9 sign_off returns signed_off with reason user, and a later sign_on on the same connection succeeds', OPTIONS, () =>
  withClients(server.url, async (connect) => {
    const client = await connect('Amy');
    await client.signOn('Amy01');
    await client.send({ type: 'sign_off' });
    await client.expectNext('signed_off', { reason: 'user' });
    assert.equal(client.closed, false, 'the socket should stay open after sign_off');

    await client.send({ type: 'sign_on', screen_name: 'Amy02' });
    await client.expectNext('signed_on', { screen_name: 'Amy02' });
  }));

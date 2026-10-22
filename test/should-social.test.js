'use strict';

// S1 to S5: buddy list, away messages, member profiles, ignore, and report (PARITY.md S1 to S5;
// PROTOCOL.md sections 5.9 to 5.16, 6.11 to 6.18, 12.1 to 12.4, 15 A9).

const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const { startServer, waitForOutput } = require('./support/server');
const { withClients } = require('./support/client');
const { SILENT_LOGGER, CONFIG, fakeSocket, deliver } = require('./support/hub-harness');
const { ChatHub } = require('../lib/hub');
const { IncidentLog } = require('../lib/incidents');

// Default lobby capacity (23). Idle and grace values are small, and no test here sits idle long enough to reach them.
const TUNING = { IDLE_MINUTES: '0.5', GRACE_MINUTES: '0.01' };
const OPTIONS = { timeout: 30000 };
const LONG_OPTIONS = { timeout: 90000 };

let server;
before(async () => {
  server = await startServer(TUNING);
});
after(async () => {
  await server.stop();
});

function has(frames, predicate) {
  return frames.some(predicate);
}

// ---- S1 buddy list -------------------------------------------------------

test('S1 a buddy shows Offline until they sign on, and their sign-on and sign-off update the mark', OPTIONS, () =>
  withClients(server.url, async (connect) => {
    const amy = await connect('Amy');
    await amy.signOn('Amy01');

    await amy.send({ type: 'buddy_add', screen_name: 'Dan77' });
    await amy.expectNext('buddy_list', { buddies: [{ screen_name: 'Dan77', online: false }] });

    const dan = await connect('Dan');
    await dan.signOn('Dan77');
    const afterSignOn = await amy.flush();
    assert.ok(
      has(afterSignOn, (f) => f.type === 'buddy_status' && f.screen_name === 'Dan77' && f.online === true),
      `Amy should receive buddy_status online true for Dan77 (received: ${afterSignOn.map((f) => f.type).join(', ')})`,
    );

    await dan.signOff();
    const afterSignOff = await amy.flush();
    assert.ok(
      has(afterSignOff, (f) => f.type === 'buddy_status' && f.screen_name === 'Dan77' && f.online === false),
      `Amy should receive buddy_status online false for Dan77 (received: ${afterSignOff.map((f) => f.type).join(', ')})`,
    );
  }));

test('S1 buddy_add rejects an invalid name with invalid_field, and the 51st buddy returns buddy_limit', LONG_OPTIONS, () =>
  withClients(server.url, async (connect) => {
    const amy = await connect('Amy');
    await amy.signOn('Amy01');

    await amy.send({ type: 'buddy_add', screen_name: 'a' });
    await amy.expectNext('error', { code: 'invalid_field', field: 'screen_name', ref: 'buddy_add' });

    // Fifty valid names, paced by the client so the server's rate limit does not drop any of them.
    for (let i = 0; i < 50; i += 1) {
      await amy.send({ type: 'buddy_add', screen_name: `Bud${String(i).padStart(2, '0')}` });
    }
    const seen = await amy.flush();
    const lists = seen.filter((frame) => frame.type === 'buddy_list');
    assert.equal(lists.length, 50, 'each of the fifty buddy_add frames should get a buddy_list reply');
    assert.equal(lists[49].buddies.length, 50, 'the list should hold fifty buddies');
    assert.equal(lists[49].buddies[0].screen_name, 'Bud00', 'buddies should keep the order they were added in');

    await amy.send({ type: 'buddy_add', screen_name: 'Bud50' });
    await amy.expectNext('error', { code: 'buddy_limit', field: 'screen_name', ref: 'buddy_add' });
  }));

test('S1 after sign-off and sign-on again the buddy list is empty, so the old buddy gets no alerts', OPTIONS, () =>
  withClients(server.url, async (connect) => {
    const amy = await connect('Amy');
    await amy.signOn('Amy01');
    await amy.send({ type: 'buddy_add', screen_name: 'Dan77' });
    await amy.expectNext('buddy_list', { buddies: [{ screen_name: 'Dan77', online: false }] });

    await amy.signOff();
    await amy.signOn('Amy01');

    const dan = await connect('Dan');
    await dan.signOn('Dan77');
    const seen = await amy.flush();
    assert.ok(
      !has(seen, (f) => f.type === 'buddy_status'),
      'Amy has no buddies after signing on again, so Dan77 signing on should not send buddy_status',
    );

    await amy.send({ type: 'buddy_add', screen_name: 'Zed01' });
    await amy.expectNext('buddy_list', { buddies: [{ screen_name: 'Zed01', online: false }] });
  }));

// ---- S2 away message -----------------------------------------------------

test('S2 set_away returns away_status, and an IM to the user returns the away message as an automatic reply', OPTIONS, () =>
  withClients(server.url, async (connect) => {
    const amy = await connect('Amy');
    const ben = await connect('Ben');
    await amy.signOn('Amy01');
    await ben.signOn('Ben02');
    await amy.flush();
    await ben.flush();

    await ben.send({ type: 'set_away', message: 'brb' });
    await ben.expectNext('away_status', { message: 'brb' });

    await amy.send({ type: 'im', to: 'Ben02', text: 'you there?', fmt: null });
    await ben.expectNext('im', { from: 'Amy01', text: 'you there?', fmt: null, auto_reply: false });
    await amy.expectNext('im_sent', { to: 'Ben02', text: 'you there?', fmt: null });
    await amy.expectNext('im', { from: 'Ben02', text: 'brb', fmt: null, auto_reply: true });
  }));

test('S2 set_away with an empty message clears it, so the next IM gets no automatic reply', OPTIONS, () =>
  withClients(server.url, async (connect) => {
    const amy = await connect('Amy');
    const ben = await connect('Ben');
    await amy.signOn('Amy01');
    await ben.signOn('Ben02');
    await amy.flush();
    await ben.flush();

    await ben.send({ type: 'set_away', message: 'brb' });
    await ben.expectNext('away_status', { message: 'brb' });
    await ben.send({ type: 'set_away', message: '' });
    await ben.expectNext('away_status', { message: '' });

    await amy.send({ type: 'im', to: 'Ben02', text: 'first', fmt: null });
    await ben.expectNext('im', { text: 'first', auto_reply: false });
    await amy.expectNext('im_sent', { text: 'first' });

    // Any automatic reply to "first" would arrive before this im_sent, so the strict read proves there was none.
    await amy.send({ type: 'im', to: 'Ben02', text: 'second', fmt: null });
    await amy.expectNext('im_sent', { text: 'second' });
  }));

test('S2 signing off clears the away message', OPTIONS, () =>
  withClients(server.url, async (connect) => {
    const amy = await connect('Amy');
    const ben = await connect('Ben');
    await amy.signOn('Amy01');
    await ben.signOn('Ben02');
    await amy.flush();
    await ben.flush();

    await ben.send({ type: 'set_away', message: 'brb' });
    await ben.expectNext('away_status', { message: 'brb' });
    await ben.signOff();
    await ben.signOn('Ben02');
    await amy.flush();

    await amy.send({ type: 'im', to: 'Ben02', text: 'hi', fmt: null });
    await ben.expectNext('im', { text: 'hi', auto_reply: false });
    await amy.expectNext('im_sent', { text: 'hi' });

    await amy.send({ type: 'im', to: 'Ben02', text: 'two', fmt: null });
    await amy.expectNext('im_sent', { text: 'two' });
  }));

// ---- S3 profiles ---------------------------------------------------------

test('S3 set_profile returns the profile, and get_profile from another user returns the same values', OPTIONS, () =>
  withClients(server.url, async (connect) => {
    const amy = await connect('Amy');
    const ben = await connect('Ben');
    await amy.signOn('Amy01');
    await ben.signOn('Ben02');
    await amy.flush();
    await ben.flush();

    await ben.send({ type: 'set_profile', location: 'Ohio', hobbies: 'chess', quote: 'hi' });
    await ben.expectNext('profile', {
      screen_name: 'Ben02',
      signed_on: true,
      location: 'Ohio',
      hobbies: 'chess',
      quote: 'hi',
    });

    await amy.send({ type: 'get_profile', screen_name: 'Ben02' });
    await amy.expectNext('profile', {
      screen_name: 'Ben02',
      signed_on: true,
      location: 'Ohio',
      hobbies: 'chess',
      quote: 'hi',
    });
  }));

test('S3 get_profile for a name that is not signed on returns signed_on false and empty fields', OPTIONS, () =>
  withClients(server.url, async (connect) => {
    const amy = await connect('Amy');
    await amy.signOn('Amy01');
    await amy.send({ type: 'get_profile', screen_name: 'Ghost01' });
    await amy.expectNext('profile', {
      screen_name: 'Ghost01',
      signed_on: false,
      location: '',
      hobbies: '',
      quote: '',
    });
  }));

test('S3 a profile field of 61 characters returns invalid_field naming the field, and 60 characters is accepted', OPTIONS, () =>
  withClients(server.url, async (connect) => {
    const ben = await connect('Ben');
    await ben.signOn('Ben02');

    for (const field of ['location', 'hobbies', 'quote']) {
      await ben.send({ type: 'set_profile', [field]: 'x'.repeat(61) });
      await ben.expectNext('error', { code: 'invalid_field', field, ref: 'set_profile' });
    }

    await ben.send({ type: 'set_profile', location: 'x'.repeat(60) });
    await ben.expectNext('profile', { screen_name: 'Ben02', signed_on: true, location: 'x'.repeat(60) });
  }));

test('S3 a profile is kept only while its owner is signed on, so a new sign-on starts with an empty profile', OPTIONS, () =>
  withClients(server.url, async (connect) => {
    const amy = await connect('Amy');
    const ben = await connect('Ben');
    await amy.signOn('Amy01');
    await ben.signOn('Ben02');
    await amy.flush();
    await ben.flush();

    await ben.send({ type: 'set_profile', location: 'Ohio' });
    await ben.expectNext('profile', { signed_on: true, location: 'Ohio' });

    await amy.send({ type: 'get_profile', screen_name: 'Ben02' });
    await amy.expectNext('profile', { screen_name: 'Ben02', signed_on: true, location: 'Ohio' });

    await ben.signOff();
    await amy.flush();
    await amy.send({ type: 'get_profile', screen_name: 'Ben02' });
    await amy.expectNext('profile', { screen_name: 'Ben02', signed_on: false, location: '', hobbies: '', quote: '' });

    await ben.signOn('Ben02');
    await amy.flush();
    await amy.send({ type: 'get_profile', screen_name: 'Ben02' });
    await amy.expectNext('profile', { screen_name: 'Ben02', signed_on: true, location: '', hobbies: '', quote: '' });
  }));

// ---- S4 ignore -----------------------------------------------------------

test('S4 an ignored name\'s room messages are dropped for the one who ignores, and other occupants still get them', OPTIONS, () =>
  withClients(server.url, async (connect) => {
    const amy = await connect('Amy');
    const ben = await connect('Ben');
    const cy = await connect('Cy');
    await amy.signOn('Amy01');
    await ben.signOn('Ben02');
    await cy.signOn('Cy03');
    await amy.flush();
    await ben.flush();
    await cy.flush();

    await amy.send({ type: 'ignore', screen_name: 'Ben02', on: true });
    await amy.expectNext('ignore_status', { screen_name: 'Ben02', ignored: true });

    await ben.send({ type: 'say', text: 'from b' });
    await ben.expectNext('room_message', { from: 'Ben02', text: 'from b' });
    await cy.expectNext('room_message', { from: 'Ben02', text: 'from b' });

    // Amy's next room_message must be Cy's sentinel, which proves Ben's line was never delivered to her.
    await cy.send({ type: 'say', text: 'sentinel' });
    await amy.expectNext('room_message', { from: 'Cy03', text: 'sentinel' });
    await ben.expectNext('room_message', { from: 'Cy03', text: 'sentinel' });
    await cy.expectNext('room_message', { from: 'Cy03', text: 'sentinel' });
  }));

test('S4 arrival and departure notices from an ignored name still reach the ignorer', OPTIONS, () =>
  withClients(server.url, async (connect) => {
    const amy = await connect('Amy');
    const ben = await connect('Ben');
    await amy.signOn('Amy01');
    await ben.signOn('Ben02');
    await amy.flush();
    await ben.flush();

    await amy.send({ type: 'ignore', screen_name: 'Ben02', on: true });
    await amy.expectNext('ignore_status', { screen_name: 'Ben02', ignored: true });

    await ben.send({ type: 'leave_room' });
    await ben.expectNext('room_left', { room: 'Lobby 1', reason: 'left' });
    await ben.expectNext('room_state', { room: 'Lobby 1' });
    await ben.expectNext('room_list');

    const seen = await amy.flush();
    const left = seen.findIndex((f) => f.type === 'member_left' && f.screen_name === 'Ben02' && f.reason === 'left');
    const joined = seen.findIndex((f) => f.type === 'member_joined' && f.screen_name === 'Ben02');
    assert.ok(left >= 0, `Amy should still receive member_left for Ben02 (received: ${seen.map((f) => f.type).join(', ')})`);
    assert.ok(joined > left, 'Amy should still receive member_joined for Ben02, after the departure');
  }));

test('S4 an IM from an ignored name is not delivered, and the sender gets im_sent with no automatic reply', OPTIONS, () =>
  withClients(server.url, async (connect) => {
    const amy = await connect('Amy');
    const ben = await connect('Ben');
    await amy.signOn('Amy01');
    await amy.send({ type: 'set_away', message: 'afk' });
    await amy.expectNext('away_status', { message: 'afk' });

    await ben.signOn('Ben02');
    await amy.flush();
    await ben.flush();

    await amy.send({ type: 'ignore', screen_name: 'Ben02', on: true });
    await amy.expectNext('ignore_status', { screen_name: 'Ben02', ignored: true });

    await ben.send({ type: 'im', to: 'Amy01', text: 'ping', fmt: null });
    await ben.expectNext('im_sent', { to: 'Amy01', text: 'ping' });

    // Amy's away message would answer Ben. Ben's next frame must be the reply to "hello b", not an automatic reply.
    await amy.send({ type: 'im', to: 'Ben02', text: 'hello b', fmt: null });
    await ben.expectNext('im', { from: 'Amy01', text: 'hello b', auto_reply: false });
    await amy.expectNext('im_sent', { to: 'Ben02', text: 'hello b' });
  }));

test('S4 ignore with on false restores delivery of room messages', OPTIONS, () =>
  withClients(server.url, async (connect) => {
    const amy = await connect('Amy');
    const ben = await connect('Ben');
    await amy.signOn('Amy01');
    await ben.signOn('Ben02');
    await amy.flush();
    await ben.flush();

    await amy.send({ type: 'ignore', screen_name: 'Ben02', on: true });
    await amy.expectNext('ignore_status', { screen_name: 'Ben02', ignored: true });
    await amy.send({ type: 'ignore', screen_name: 'Ben02', on: false });
    await amy.expectNext('ignore_status', { screen_name: 'Ben02', ignored: false });

    await ben.send({ type: 'say', text: 'back' });
    await amy.expectNext('room_message', { from: 'Ben02', text: 'back' });
    await ben.expectNext('room_message', { from: 'Ben02', text: 'back' });
  }));

// ---- S5 report -----------------------------------------------------------

test('S5 report returns report_ack with the reported screen name, in canonical casing when that name is signed on', OPTIONS, () =>
  withClients(server.url, async (connect) => {
    const amy = await connect('Amy');
    const ben = await connect('Ben');
    await amy.signOn('Amy01');
    await ben.signOn('Ben02');
    await amy.flush();

    await amy.send({ type: 'report', screen_name: 'Ben02' });
    await amy.expectNext('report_ack', { screen_name: 'Ben02' });

    await amy.send({ type: 'report', screen_name: 'ben02' });
    await amy.expectNext('report_ack', { screen_name: 'Ben02' });
  }));

test('S5 reporting your own screen name returns invalid_target', OPTIONS, () =>
  withClients(server.url, async (connect) => {
    const amy = await connect('Amy');
    await amy.signOn('Amy01');
    await amy.send({ type: 'report', screen_name: 'Amy01' });
    await amy.expectNext('error', { code: 'invalid_target', field: 'screen_name', ref: 'report' });
  }));

test('S5 the server log records only the reported name and a UTC time, never the reporter', OPTIONS, () =>
  withClients(server.url, async (connect) => {
    const amy = await connect('Amy');
    const ben = await connect('Ben');
    await amy.signOn('Amy01');
    await ben.signOn('Ben02');
    await amy.flush();

    await amy.send({ type: 'report', screen_name: 'Ben02' });
    await amy.expectNext('report_ack', { screen_name: 'Ben02' });

    // The incident store itself is in the server process, so the test reads the one line the server writes for a report.
    const [, time] = await waitForOutput(server, /^Report filed: Ben02 at (\S+)$/m);
    assert.equal(new Date(time).toISOString(), time, `the report time should be ISO 8601 UTC, got ${time}`);
    assert.ok(!server.output.stdout.includes('Amy01'), 'the server log should not name the reporter');
  }));

test('S5 the incident store holds exactly screen_name and time, never the reporter or any message text', () => {
  // PARITY.md S5 asks for a check on the incident store. The store is inside the server process, so this check runs
  // lib/hub.js in this process with its own IncidentLog. The frame carries extra fields, and none of them may be stored.
  const incidents = new IncidentLog();
  const hub = new ChatHub({ config: CONFIG, incidents, logger: SILENT_LOGGER });
  const ws = fakeSocket();
  try {
    hub.attach(ws);
    deliver(ws, { type: 'sign_on', screen_name: 'Amy01' });
    deliver(ws, { type: 'report', screen_name: 'Ben02', text: 'the message text', reporter: 'Amy01' });

    const entries = incidents.list();
    assert.equal(entries.length, 1, 'one report should add one incident');
    assert.deepEqual(Object.keys(entries[0]).sort(), ['screen_name', 'time'], 'an incident holds exactly two fields');
    assert.equal(entries[0].screen_name, 'Ben02');
    assert.equal(new Date(entries[0].time).toISOString(), entries[0].time, 'time should be ISO 8601 UTC');
    assert.ok(!JSON.stringify(entries).includes('Amy01'), 'the reporter must not be stored');
    assert.ok(!JSON.stringify(entries).includes('the message text'), 'message text must not be stored');
  } finally {
    hub.shutdown();
  }
});

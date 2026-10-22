'use strict';

// M5, M8, M10 and M11: room messages, instant messages, typed smileys, and escaping of user text
// (PARITY.md; PROTOCOL.md sections 2.2, 2.4, 5.7, 5.8, 6.9, 6.10, 7.6, 12.2).

const { test, before, after } = require('node:test');
const { startServer } = require('./support/server');
const { withClients } = require('./support/client');

// Default lobby capacity (23). Idle and grace values are small, and no test here sits idle long enough to reach them.
const TUNING = { IDLE_MINUTES: '0.5', GRACE_MINUTES: '0.01' };
const OPTIONS = { timeout: 30000 };

let server;
before(async () => {
  server = await startServer(TUNING);
});
after(async () => {
  await server.stop();
});

// ---- M5 ------------------------------------------------------------------

test('M5 a room message goes to every occupant, the sender included, as "from" and "text"', OPTIONS, () =>
  withClients(server.url, async (connect) => {
    const amy = await connect('Amy');
    const ben = await connect('Ben');
    await amy.signOn('Amy01');
    await ben.signOn('Ben02');
    await amy.flush();
    await ben.flush();

    await amy.send({ type: 'say', text: 'hi' });
    await amy.expectNext('room_message', { room: 'Lobby 1', from: 'Amy01', text: 'hi', fmt: null });
    await ben.expectNext('room_message', { room: 'Lobby 1', from: 'Amy01', text: 'hi', fmt: null });
  }));

test('M5 text of only spaces is sent to nobody, and text of 251 characters returns text_too_long to the sender only', OPTIONS, () =>
  withClients(server.url, async (connect) => {
    const amy = await connect('Amy');
    const ben = await connect('Ben');
    await amy.signOn('Amy01');
    await ben.signOn('Ben02');
    await amy.flush();
    await ben.flush();

    await amy.send({ type: 'say', text: '     ' });
    await amy.send({ type: 'say', text: 'y'.repeat(251) });
    await amy.expectNext('error', { code: 'text_too_long', field: 'text', ref: 'say' });

    // A later real message proves that the blank and the long text produced no frame for anyone.
    await amy.send({ type: 'say', text: 'after' });
    await amy.expectNext('room_message', { from: 'Amy01', text: 'after' });
    await ben.expectNext('room_message', { from: 'Amy01', text: 'after' });
  }));

test('M5 a message of exactly 250 characters is delivered unchanged', OPTIONS, () =>
  withClients(server.url, async (connect) => {
    const amy = await connect('Amy');
    const ben = await connect('Ben');
    await amy.signOn('Amy01');
    await ben.signOn('Ben02');
    await amy.flush();
    await ben.flush();

    const text = 'z'.repeat(250);
    await amy.send({ type: 'say', text });
    await amy.expectNext('room_message', { from: 'Amy01', text });
    await ben.expectNext('room_message', { from: 'Amy01', text });
  }));

// ---- M8 ------------------------------------------------------------------

test('M8 an IM reaches the recipient with auto_reply false, and im_sent goes to the sender', OPTIONS, () =>
  withClients(server.url, async (connect) => {
    const amy = await connect('Amy');
    const ben = await connect('Ben');
    await amy.signOn('Amy01');
    await ben.signOn('Ben02');
    await amy.flush();
    await ben.flush();

    await amy.send({ type: 'im', to: 'Ben02', text: 'you there?', fmt: null });
    await ben.expectNext('im', { from: 'Amy01', text: 'you there?', fmt: null, auto_reply: false });
    await amy.expectNext('im_sent', { to: 'Ben02', text: 'you there?', fmt: null });
  }));

test('M8 an IM to a name that is not signed on returns recipient_offline on "to", and nothing else is sent', OPTIONS, () =>
  withClients(server.url, async (connect) => {
    const amy = await connect('Amy');
    const ben = await connect('Ben');
    await amy.signOn('Amy01');
    await ben.signOn('Ben02');
    await amy.flush();
    await ben.flush();

    await amy.send({ type: 'im', to: 'Ghost01', text: 'hello?', fmt: null });
    await amy.expectNext('error', { code: 'recipient_offline', field: 'to', ref: 'im' });

    // The next real IM must be the next frame each side reads. Any im_sent or im for "hello?" would show up first.
    await amy.send({ type: 'im', to: 'Ben02', text: 'sentinel', fmt: null });
    await ben.expectNext('im', { from: 'Amy01', text: 'sentinel', auto_reply: false });
    await amy.expectNext('im_sent', { to: 'Ben02', text: 'sentinel' });
  }));

test('M8 the recipient replies, and the reply arrives from the recipient\'s screen name', OPTIONS, () =>
  withClients(server.url, async (connect) => {
    const amy = await connect('Amy');
    const ben = await connect('Ben');
    await amy.signOn('Amy01');
    await ben.signOn('Ben02');
    await amy.flush();
    await ben.flush();

    await amy.send({ type: 'im', to: 'Ben02', text: 'hi', fmt: null });
    await ben.expectNext('im', { from: 'Amy01', text: 'hi' });
    await amy.expectNext('im_sent', { to: 'Ben02', text: 'hi' });

    await ben.send({ type: 'im', to: 'Amy01', text: 'hey back', fmt: null });
    await amy.expectNext('im', { from: 'Ben02', text: 'hey back', fmt: null, auto_reply: false });
    await ben.expectNext('im_sent', { to: 'Amy01', text: 'hey back' });
  }));

// ---- M10 -----------------------------------------------------------------

test('M10 the typed faces :) :( ;) :D :P are delivered unchanged in room messages and in IMs', OPTIONS, () =>
  withClients(server.url, async (connect) => {
    const amy = await connect('Amy');
    const ben = await connect('Ben');
    await amy.signOn('Amy01');
    await ben.signOn('Ben02');
    await amy.flush();
    await ben.flush();

    for (const face of [':)', ':(', ';)', ':D', ':P']) {
      await amy.send({ type: 'say', text: face });
      await amy.expectNext('room_message', { from: 'Amy01', text: face });
      await ben.expectNext('room_message', { from: 'Amy01', text: face });
    }

    await amy.send({ type: 'im', to: 'Ben02', text: ':)', fmt: null });
    await ben.expectNext('im', { from: 'Amy01', text: ':)', auto_reply: false });
    await amy.expectNext('im_sent', { to: 'Ben02', text: ':)' });
  }));

// ---- M11 -----------------------------------------------------------------

test('M11 markup in a room message is delivered as the same plain text', OPTIONS, () =>
  withClients(server.url, async (connect) => {
    const amy = await connect('Amy');
    const ben = await connect('Ben');
    await amy.signOn('Amy01');
    await ben.signOn('Ben02');
    await amy.flush();
    await ben.flush();

    for (const text of ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>']) {
      await amy.send({ type: 'say', text });
      await amy.expectNext('room_message', { from: 'Amy01', text });
      await ben.expectNext('room_message', { from: 'Amy01', text });
    }
  }));

test('M11 markup in IMs, away messages and profile fields is delivered as the same plain text', OPTIONS, () =>
  withClients(server.url, async (connect) => {
    const amy = await connect('Amy');
    const ben = await connect('Ben');
    await amy.signOn('Amy01');
    await ben.signOn('Ben02');
    await amy.flush();
    await ben.flush();

    await amy.send({ type: 'im', to: 'Ben02', text: '<img src=x onerror=alert(1)>', fmt: null });
    await ben.expectNext('im', { from: 'Amy01', text: '<img src=x onerror=alert(1)>', auto_reply: false });
    await amy.expectNext('im_sent', { to: 'Ben02', text: '<img src=x onerror=alert(1)>' });

    await ben.send({ type: 'set_away', message: '<i>away</i>' });
    await ben.expectNext('away_status', { message: '<i>away</i>' });
    await amy.send({ type: 'im', to: 'Ben02', text: 'hello', fmt: null });
    await ben.expectNext('im', { from: 'Amy01', text: 'hello', auto_reply: false });
    await amy.expectNext('im_sent', { to: 'Ben02', text: 'hello' });
    await amy.expectNext('im', { from: 'Ben02', text: '<i>away</i>', auto_reply: true });

    await ben.send({
      type: 'set_profile',
      location: '<script>x</script>',
      hobbies: '<img src=x>',
      quote: '<b>q</b>',
    });
    await ben.expectNext('profile', {
      screen_name: 'Ben02',
      signed_on: true,
      location: '<script>x</script>',
      hobbies: '<img src=x>',
      quote: '<b>q</b>',
    });
    await amy.send({ type: 'get_profile', screen_name: 'Ben02' });
    await amy.expectNext('profile', {
      screen_name: 'Ben02',
      signed_on: true,
      location: '<script>x</script>',
      hobbies: '<img src=x>',
      quote: '<b>q</b>',
    });
  }));

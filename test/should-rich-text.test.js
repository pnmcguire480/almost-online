'use strict';

// S7: rich text in messages and IMs (PARITY.md S7; PROTOCOL.md sections 2.3, 5.7, 5.8, 15 A6).
// PARITY.md marks S7 as having [proto] checks. The brief named S1 to S6, so these tests are an addition.

const assert = require('node:assert/strict');
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

test('S7 a formatted say is delivered with its colour in uppercase', OPTIONS, () =>
  withClients(server.url, async (connect) => {
    const amy = await connect('Amy');
    const ben = await connect('Ben');
    await amy.signOn('Amy01');
    await ben.signOn('Ben02');
    await amy.flush();
    await ben.flush();

    const fmt = { b: true, i: false, u: false, color: '#FF0000' };
    await amy.send({ type: 'say', text: 'bold red', fmt: { b: true, i: false, u: false, color: '#ff0000' } });
    await amy.expectNext('room_message', { from: 'Amy01', text: 'bold red', fmt });
    await ben.expectNext('room_message', { from: 'Amy01', text: 'bold red', fmt });
  }));

test('S7 italic and underline with no colour keep every key in the delivered fmt', OPTIONS, () =>
  withClients(server.url, async (connect) => {
    const amy = await connect('Amy');
    const ben = await connect('Ben');
    await amy.signOn('Amy01');
    await ben.signOn('Ben02');
    await amy.flush();
    await ben.flush();

    const fmt = { b: false, i: true, u: true, color: null };
    await amy.send({ type: 'say', text: 'slanted', fmt });
    await amy.expectNext('room_message', { from: 'Amy01', text: 'slanted', fmt });
    await ben.expectNext('room_message', { from: 'Amy01', text: 'slanted', fmt });
  }));

test('S7 a plain message, with no fmt or with every flag false and no colour, is delivered with fmt null', OPTIONS, () =>
  withClients(server.url, async (connect) => {
    const amy = await connect('Amy');
    const ben = await connect('Ben');
    await amy.signOn('Amy01');
    await ben.signOn('Ben02');
    await amy.flush();
    await ben.flush();

    await amy.send({ type: 'say', text: 'no fmt' });
    await amy.expectNext('room_message', { from: 'Amy01', text: 'no fmt', fmt: null });
    await ben.expectNext('room_message', { from: 'Amy01', text: 'no fmt', fmt: null });

    await amy.send({ type: 'say', text: 'all off', fmt: { b: false, i: false, u: false, color: null } });
    await amy.expectNext('room_message', { from: 'Amy01', text: 'all off', fmt: null });
    await ben.expectNext('room_message', { from: 'Amy01', text: 'all off', fmt: null });
  }));

test('S7 a formatted IM is delivered to the recipient with its colour in uppercase', OPTIONS, () =>
  withClients(server.url, async (connect) => {
    const amy = await connect('Amy');
    const ben = await connect('Ben');
    await amy.signOn('Amy01');
    await ben.signOn('Ben02');
    await amy.flush();
    await ben.flush();

    await amy.send({ type: 'im', to: 'Ben02', text: 'blue bold', fmt: { b: true, color: '#0000ff' } });
    const fmt = { b: true, i: false, u: false, color: '#0000FF' };
    await ben.expectNext('im', { from: 'Amy01', text: 'blue bold', fmt, auto_reply: false });
    await amy.expectNext('im_sent', { to: 'Ben02', text: 'blue bold', fmt });
  }));

test('S7 a colour outside the palette returns invalid_field on fmt.color, and a non-boolean flag returns it on fmt', OPTIONS, () =>
  withClients(server.url, async (connect) => {
    const amy = await connect('Amy');
    const ben = await connect('Ben');
    await amy.signOn('Amy01');
    await ben.signOn('Ben02');
    await amy.flush();
    await ben.flush();

    await amy.send({ type: 'say', text: 'x', fmt: { b: false, i: false, u: false, color: '#123456' } });
    await amy.expectNext('error', { code: 'invalid_field', field: 'fmt.color', ref: 'say' });

    await amy.send({ type: 'say', text: 'x', fmt: { b: 'yes', i: false, u: false, color: null } });
    await amy.expectNext('error', { code: 'invalid_field', field: 'fmt', ref: 'say' });

    await amy.send({ type: 'say', text: 'x', fmt: 'bold' });
    await amy.expectNext('error', { code: 'invalid_field', field: 'fmt', ref: 'say' });

    await amy.send({ type: 'im', to: 'Ben02', text: 'x', fmt: { b: false, i: false, u: false, color: '#123456' } });
    await amy.expectNext('error', { code: 'invalid_field', field: 'fmt.color', ref: 'im' });

    // None of the refused frames reached Ben.
    const seen = await ben.flush();
    assert.deepEqual(
      seen.map((frame) => frame.type),
      [],
      'Ben should receive nothing from the refused frames',
    );
  }));

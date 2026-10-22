'use strict';

// S6: idle warning and automatic sign-off (PARITY.md S6; PROTOCOL.md sections 3, 5.16, 6.18, 8 O9, 9, 15 A2).
// This file runs its own server with the PARITY.md test values: 0.6 seconds of idle time, then 0.6 seconds of grace.

const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { test, before, after } = require('node:test');
const { startServer, sleep } = require('./support/server');
const { withClients } = require('./support/client');

const TUNING = { IDLE_MINUTES: '0.01', GRACE_MINUTES: '0.01' };
const IDLE_MS = 600;
const TOLERANCE_MS = 250;
const OPTIONS = { timeout: 20000 };

let server;
before(async () => {
  server = await startServer(TUNING);
});
after(async () => {
  await server.stop();
});

function assertWithin(label, actual, expected, tolerance) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: ${actual.toFixed(0)} ms, expected ${expected} ms plus or minus ${tolerance} ms`,
  );
}

test('S6 an idle signed-on connection gets idle_warning with grace_seconds 1, then signed_off with reason idle, each about 0.6 s apart', OPTIONS, () =>
  withClients(server.url, async (connect) => {
    const client = await connect('Idle');
    const sentAt = performance.now();
    await client.send({ type: 'sign_on', screen_name: 'Idle01' });

    const warning = await client.waitForFrame('idle_warning', { grace_seconds: 1 }, { timeout: 5000 });
    const off = await client.waitForFrame('signed_off', { reason: 'idle' }, { timeout: 5000 });

    assertWithin('idle_warning after sign_on', warning.at - sentAt, IDLE_MS, TOLERANCE_MS);
    assertWithin('signed_off after idle_warning', off.at - warning.at, IDLE_MS, TOLERANCE_MS);
    assert.equal(client.closed, false, 'the socket should stay open after an idle sign-off');

    // After an idle sign-off the connection is UNSIGNED again, so a room request gets not_signed_on.
    await client.send({ type: 'list_rooms' });
    await client.expectNext('error', { code: 'not_signed_on', ref: 'list_rooms' });
  }));

test('S6 still_here during the grace period cancels the countdown, and no signed_off follows', OPTIONS, () =>
  withClients(server.url, async (connect) => {
    const client = await connect('Idle');
    await client.signOn('Idle02');

    await client.waitForFrame('idle_warning', {}, { timeout: 5000 });
    // Stay inside the 0.6 s grace period, but leave a 300 ms margin before the original sign-off would have happened.
    await sleep(300);
    await client.send({ type: 'still_here' });

    // A new idle period starts when still_here arrives, so a second warning comes about 0.6 s later.
    const second = await client.waitForFrame('idle_warning', {}, { timeout: 5000 });
    assert.ok(
      !second.skipped.some((frame) => frame.type === 'signed_off'),
      'no signed_off should arrive between the first warning and the second',
    );
    assert.equal(client.signedOn, true, 'the connection should still be signed on');
  }));

test('S6 any inbound frame counts as activity, so a connection that keeps sending gets no warning', OPTIONS, () =>
  withClients(server.url, async (connect) => {
    const client = await connect('Busy');
    await client.signOn('Busy01');

    // Six frames at 300 ms intervals span about three idle periods, so a single missed reset would show a warning.
    for (let i = 0; i < 6; i += 1) {
      await sleep(300);
      await client.send({ type: 'list_rooms' });
    }
    const seen = await client.flush();
    assert.ok(
      !seen.some((frame) => frame.type === 'idle_warning' || frame.type === 'signed_off'),
      `a busy connection should get no idle warning or sign-off (received: ${seen.map((f) => f.type).join(', ')})`,
    );
  }));

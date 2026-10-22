'use strict';

// WebSocket test client for the Chat Room '96 protocol (docs/PROTOCOL.md).
//
// Every frame the server sends to this client is stored in arrival order. Tests read them in three ways:
//   next() and expectNext()  strict: the next frame in arrival order, checked by type and fields
//   waitForFrame()           skips frames until one matches, and returns the frames it skipped
//   flush()                  a round trip: returns every frame that arrived before its reply, so a test can
//                            state exactly what a connection received at a given point
// Frames from one connection arrive in the order the server sent them (PROTOCOL.md rule O12).

const { performance } = require('node:perf_hooks');
const { isDeepStrictEqual } = require('node:util');
const assert = require('node:assert/strict');
const WebSocket = require('ws');

// The server's inbound limit (PROTOCOL.md section 15, addendum A1): a burst of 20 frames, then 5 frames per second.
// The client mirrors that bucket and waits when it would go over, so the limiter never drops a test frame.
const BURST = 20;
const PER_SECOND = 5;
const PACING_MARGIN_MS = 15;
const DEFAULT_WAIT_MS = 3000;

let flushCount = 0;

function typesOf(frames) {
  return frames.map((frame) => (frame && frame.type) || '(no type)').join(', ') || '(none)';
}

function matchesFields(frame, fields) {
  return Object.entries(fields).every(([key, value]) => isDeepStrictEqual(frame[key], value));
}

class Client {
  constructor(url, label) {
    this.label = label;
    this.frames = [];
    this.times = [];
    this.cursor = 0;
    this.closed = false;
    this.closeCode = null;
    this.errors = [];
    this.signedOn = false;
    this.arrivals = [];
    this.bucket = { tokens: BURST, last: Date.now() };

    this.ws = new WebSocket(url, { handshakeTimeout: 5000 });
    this.opened = new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', (error) => reject(error));
    });
    this.ws.on('error', (error) => {
      this.errors.push(error);
      this.wake();
    });
    this.ws.on('message', (data) => this.onMessage(data));
    this.ws.on('close', (code) => {
      this.closed = true;
      this.closeCode = code;
      this.wake();
    });
  }

  static async connect(url, label) {
    const client = new Client(url, label);
    await client.opened;
    return client;
  }

  onMessage(data) {
    const text = data.toString('utf8');
    let frame;
    try {
      frame = JSON.parse(text);
    } catch {
      frame = { type: '(not JSON)', raw: text };
    }
    this.frames.push(frame);
    this.times.push(performance.now());
    if (frame && frame.type === 'signed_on') this.signedOn = true;
    if (frame && frame.type === 'signed_off') this.signedOn = false;
    this.wake();
  }

  wake() {
    const pending = this.arrivals;
    this.arrivals = [];
    for (const resume of pending) resume();
  }

  waitForArrival(ms) {
    return new Promise((resolve) => {
      const resume = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.arrivals = this.arrivals.filter((fn) => fn !== resume);
        resolve();
      }, ms);
      this.arrivals.push(resume);
    });
  }

  // Reads frames in arrival order until one satisfies the predicate. Frames read before it are returned as `skipped`.
  async waitFor(predicate, { timeout = DEFAULT_WAIT_MS, what = 'a matching frame' } = {}) {
    const deadline = Date.now() + timeout;
    const skipped = [];
    for (;;) {
      while (this.cursor < this.frames.length) {
        const index = this.cursor;
        this.cursor += 1;
        const frame = this.frames[index];
        if (predicate(frame)) return { frame, at: this.times[index], skipped };
        skipped.push(frame);
      }
      if (this.closed) {
        throw new Error(
          `${this.label}: the socket closed (code ${this.closeCode}) before ${what}. Frames read while waiting: ${typesOf(skipped)}`,
        );
      }
      const left = deadline - Date.now();
      if (left <= 0) {
        throw new Error(`${this.label}: no ${what} within ${timeout} ms. Frames read while waiting: ${typesOf(skipped)}`);
      }
      await this.waitForArrival(left);
    }
  }

  // Strict read: the very next frame, whatever its type.
  async next(options = {}) {
    const { frame } = await this.waitFor(() => true, { what: 'the next frame', ...options });
    return frame;
  }

  // Strict read with checks: the very next frame must have this type and these field values.
  async expectNext(type, fields = {}, options = {}) {
    const frame = await this.next({ what: `the next frame, a ${type}`, ...options });
    assert.equal(frame.type, type, `${this.label}: expected a ${type} frame but received ${JSON.stringify(frame)}`);
    for (const [key, value] of Object.entries(fields)) {
      assert.deepEqual(
        frame[key],
        value,
        `${this.label}: ${type}.${key} should be ${JSON.stringify(value)} in ${JSON.stringify(frame)}`,
      );
    }
    return frame;
  }

  // Skipping read: the first frame of this type with these fields. Other frames read first are returned as `skipped`.
  waitForFrame(type, fields = {}, options = {}) {
    return this.waitFor((frame) => frame.type === type && matchesFields(frame, fields), {
      what: `a ${type} frame ${JSON.stringify(fields)}`,
      ...options,
    });
  }

  // Round trip: returns every frame that arrived before the reply. The reply is a profile for a name nobody uses.
  async flush(options = {}) {
    flushCount += 1;
    const token = `Flush${flushCount}`;
    await this.send({ type: 'get_profile', screen_name: token });
    const { skipped } = await this.waitFor(
      (frame) => frame.type === 'profile' && frame.screen_name === token,
      { what: 'the flush reply', ...options },
    );
    return skipped;
  }

  // Asks for the room list after everything earlier has been read, so the next room_list is the reply.
  async requestRoomList() {
    await this.flush();
    await this.send({ type: 'list_rooms' });
    return this.expectNext('room_list');
  }

  // Sends one frame, waiting first if the client's mirror of the server's rate limit says it would be dropped.
  async send(frame) {
    await this.takeToken();
    await new Promise((resolve, reject) => {
      this.ws.send(JSON.stringify(frame), (error) => (error ? reject(error) : resolve()));
    });
  }

  async takeToken() {
    for (;;) {
      const now = Date.now();
      const bucket = this.bucket;
      bucket.tokens = Math.min(BURST, bucket.tokens + ((now - bucket.last) * PER_SECOND) / 1000);
      bucket.last = now;
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return;
      }
      const waitMs = Math.ceil(((1 - bucket.tokens) * 1000) / PER_SECOND) + PACING_MARGIN_MS;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  // Sign on, then read the three frames that PROTOCOL.md rule O3 requires, in order. Returns the room_state.
  async signOn(name) {
    await this.send({ type: 'sign_on', screen_name: name });
    await this.waitForFrame('signed_on', { screen_name: name });
    const roomState = await this.expectNext('room_state');
    await this.expectNext('room_list');
    return roomState;
  }

  // Sign off, then wait for the reply that PROTOCOL.md section 5.2 requires.
  async signOff() {
    await this.send({ type: 'sign_off' });
    await this.waitForFrame('signed_off', { reason: 'user' });
  }

  close() {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000);
      this.ws.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.close(1000, 'test finished');
    });
  }

  // Best-effort cleanup: sign off if still signed on, then close the socket.
  async teardown() {
    if (!this.closed && this.signedOn) {
      try {
        await this.signOff();
      } catch {
        // A failed sign-off during cleanup does not change the test result. The socket is closed below.
      }
    }
    await this.close();
  }
}

// Runs a test body with a connect() function. Every client that body opens is signed off and closed afterwards,
// even when the body throws, so the next test starts from an empty server.
async function withClients(url, body) {
  const made = [];
  const connect = async (label) => {
    const client = await Client.connect(url, label);
    made.push(client);
    return client;
  };
  try {
    return await body(connect);
  } finally {
    for (const client of made) {
      await client.teardown();
    }
  }
}

module.exports = { Client, withClients };

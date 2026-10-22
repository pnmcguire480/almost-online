'use strict';

// In-process helpers for checks that cannot be seen from a child server process: the rate limiter's clock, and the
// incident store. They drive lib/hub.js with a stand-in socket. Every test file that uses them also starts server.js.

const { EventEmitter } = require('node:events');
const { WebSocket } = require('ws');

const SILENT_LOGGER = { log() {}, error() {}, warn() {}, info() {} };
const CONFIG = Object.freeze({ lobbyCapacity: 23, idleMinutes: 15, graceMinutes: 5 });

// The hub only calls send, close and on, and reads readyState. Frames it sends are parsed and kept in arrival order.
function fakeSocket() {
  const ws = new EventEmitter();
  ws.readyState = WebSocket.OPEN;
  ws.frames = [];
  ws.send = (text, callback) => {
    ws.frames.push(JSON.parse(text));
    if (callback) callback();
  };
  ws.close = () => {
    ws.readyState = WebSocket.CLOSED;
  };
  return ws;
}

// Delivers one inbound message the way the ws library does: a Buffer, with isBinary set for binary messages.
function deliver(ws, frame) {
  ws.emit('message', Buffer.from(JSON.stringify(frame)), false);
}

function deliverRaw(ws, bytes, isBinary) {
  ws.emit('message', Buffer.from(bytes), isBinary);
}

module.exports = { SILENT_LOGGER, CONFIG, fakeSocket, deliver, deliverRaw };

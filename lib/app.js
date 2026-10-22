'use strict';

// HTTP and WebSocket wiring: static files on one port, the /ws endpoint, a 30-second ping heartbeat, and a clean shutdown.

const http = require('node:http');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const { ChatHub } = require('./hub');
const { IncidentLog } = require('./incidents');
const { FRAME_MAX_BYTES } = require('./protocol');
const { createStaticHandler } = require('./static');
const { localHost, sameOrigin, securityHeaders, MAX_WS_CLIENTS } = require('./security');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const WS_PATH = '/ws';
const HEARTBEAT_MS = 30000;
const CLOSE_WAIT_MS = 2000;

function refuseUpgrade(socket, status) {
  const reason = http.STATUS_CODES[status];
  // Ends the response first so the status line is sent, then destroys the socket.
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
}

function waitUntil(condition, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (condition() || Date.now() >= deadline) {
        resolve();
        return;
      }
      setTimeout(check, 25);
    };
    check();
  });
}

function createApp({ config, logger = console, now = Date.now, publicDir = PUBLIC_DIR } = {}) {
  const incidents = new IncidentLog();
  const hub = new ChatHub({ config, incidents, logger, now });
  const serveStatic = createStaticHandler(publicDir);

  const server = http.createServer({ headersTimeout: 10000, requestTimeout: 15000 }, (req, res) => {
    const host = localHost(req, server.address().port);
    if (!host) {
      res.writeHead(403, { 'Content-Type': 'text/plain', Connection: 'close' });
      res.end('Forbidden');
      return;
    }
    securityHeaders(res, host);
    serveStatic(req, res);
  });
  server.maxConnections = MAX_WS_CLIENTS + 32;
  const wss = new WebSocketServer({ noServer: true, maxPayload: FRAME_MAX_BYTES });

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    hub.attach(ws);
  });

  server.on('upgrade', (req, socket, head) => {
    const host = localHost(req, server.address().port);
    if (!host || !sameOrigin(req, host)) {
      refuseUpgrade(socket, 403);
      return;
    }
    let pathname = '';
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      pathname = '';
    }
    if (pathname !== WS_PATH) {
      refuseUpgrade(socket, 404);
      return;
    }
    if (hub.closing) {
      refuseUpgrade(socket, 503);
      return;
    }
    if (wss.clients.size >= MAX_WS_CLIENTS) {
      refuseUpgrade(socket, 429);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  // A connection that did not answer the last ping is dropped before the next one (PROTOCOL.md section 9).
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  // Start-up errors (such as a busy port) are reported by listen() and by server.js, so only later errors are logged here.
  server.on('error', (err) => {
    if (server.listening) logger.error(`Server error: ${err.message}`);
  });

  function listen(port) {
    return new Promise((resolve, reject) => {
      const onStartError = (err) => reject(err);
      server.once('error', onStartError);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', onStartError);
        resolve(server.address());
      });
    });
  }

  // Sends signed_off to every signed-on user, closes every socket with 1001, then stops the HTTP server (PROTOCOL.md section 10).
  async function shutdown() {
    clearInterval(heartbeat);
    hub.shutdown();
    await waitUntil(() => wss.clients.size === 0, CLOSE_WAIT_MS);
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    if (server.listening) {
      await new Promise((resolve) => {
        server.close(() => resolve());
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      });
    }
  }

  return { server, wss, hub, incidents, listen, shutdown };
}

module.exports = { createApp, PUBLIC_DIR, WS_PATH };

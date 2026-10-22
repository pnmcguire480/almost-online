'use strict';

// Serves the browser client from public/. Only GET and HEAD are allowed, and no request can leave the public folder.

const fs = require('node:fs');
const path = require('node:path');

const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
});

function sendText(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

// Maps a decoded URL path to a file inside root, or returns null when the path is not allowed.
// Rejects backslashes, NUL bytes, dot segments and hidden files, and anything that resolves outside root.
function resolveInside(root, pathname) {
  if (pathname.includes('\0') || pathname.includes('\\')) return null;
  const segments = pathname.split('/').filter(Boolean);
  if (segments.some((segment) => segment.startsWith('.') || segment.includes(':'))) return null;

  const file = path.join(root, ...segments);
  const relative = path.relative(root, file);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return file;
}

function createStaticHandler(publicDir) {
  const root = fs.realpathSync(publicDir);

  return function serveStatic(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Method not allowed');
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      sendText(res, 400, 'Bad request');
      return;
    }
    if (pathname.endsWith('/')) pathname += 'index.html';

    const file = resolveInside(root, pathname);
    if (file === null) {
      sendText(res, 404, 'Not found');
      return;
    }

    fs.realpath(file, (realError, resolved) => {
      const relative = realError ? '' : path.relative(root, resolved);
      if (realError || relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
        sendText(res, 404, 'Not found');
        return;
      }
      fs.stat(resolved, (statError, stats) => {
        if (statError || !stats.isFile()) {
          sendText(res, 404, 'Not found');
          return;
        }
        const type = MIME_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
        res.writeHead(200, {
          'Content-Type': type,
          'Content-Length': stats.size,
          'Cache-Control': 'no-cache',
          'X-Content-Type-Options': 'nosniff',
        });
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        const stream = fs.createReadStream(resolved);
        stream.on('error', () => res.destroy());
        stream.pipe(res);
      });
    });
  };
}

module.exports = { createStaticHandler, resolveInside, MIME_TYPES };

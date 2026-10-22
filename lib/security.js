'use strict';

const MAX_WS_CLIENTS = 128;
const MAX_BUFFERED_BYTES = 64 * 1024;

function localHost(req, port) {
  const host = req.headers.host?.toLowerCase();
  const suffix = port === 80 ? '' : `:${port}`;
  if (!['127.0.0.1', 'localhost', '[::1]'].some(name => host === name + suffix)) return null;
  if (req.headersDistinct.host.length !== 1) return null;
  return host;
}

function sameOrigin(req, host) {
  return req.headers.origin === undefined || req.headers.origin === `http://${host}`;
}

function securityHeaders(res, host) {
  res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self' ws://${host}; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

module.exports = { localHost, sameOrigin, securityHeaders, MAX_WS_CLIENTS, MAX_BUFFERED_BYTES };

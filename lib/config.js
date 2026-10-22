'use strict';

// Start-up configuration from environment variables (PARITY.md "Config").
// Each value must be a positive number, or start-up stops with a message that names the variable.

class ConfigError extends Error {}

function readNumber(env, name, fallback, { integer = false, max = Infinity } = {}) {
  const raw = env[name];
  if (raw === undefined) return fallback;

  const trimmed = raw.trim();
  const value = Number(trimmed);
  const positive = trimmed !== '' && Number.isFinite(value) && value > 0;
  const valid = positive && (!integer || Number.isInteger(value)) && value <= max;
  if (!valid) {
    const kind = integer ? 'a positive whole number' : 'a positive number';
    const bound = max === Infinity ? '' : ` no larger than ${max}`;
    throw new ConfigError(`${name} must be ${kind}${bound}. It is set to "${raw}".`);
  }
  return value;
}

function loadConfig(env = process.env) {
  return Object.freeze({
    port: readNumber(env, 'PORT', 1996, { integer: true, max: 65535 }),
    lobbyCapacity: readNumber(env, 'LOBBY_CAPACITY', 23, { integer: true }),
    idleMinutes: readNumber(env, 'IDLE_MINUTES', 15),
    graceMinutes: readNumber(env, 'GRACE_MINUTES', 5),
  });
}

module.exports = { loadConfig, ConfigError };

'use strict';

// Starts server.js in a child process on a free port, and stops it again.
// Tuning variables are passed explicitly. Copies inherited from the caller's environment are removed first,
// so a developer's own LOBBY_CAPACITY or IDLE_MINUTES cannot change what a test expects.

const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const SERVER_FILE = path.join(PROJECT_ROOT, 'server.js');
const TUNING_NAMES = ['PORT', 'LOBBY_CAPACITY', 'IDLE_MINUTES', 'GRACE_MINUTES'];
const READY_TEXT = 'is running at';
const START_TIMEOUT_MS = 10000;
const STOP_TIMEOUT_MS = 5000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Asks the OS for a port that is free right now. Another process can take it before the server binds, so startServer retries.
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function launch(port, tuning) {
  const env = { ...process.env };
  for (const name of TUNING_NAMES) delete env[name];
  Object.assign(env, tuning, { PORT: String(port) });

  const child = spawn(process.execPath, [SERVER_FILE], {
    cwd: PROJECT_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });

  const output = { stdout: '', stderr: '' };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    output.stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output.stderr += chunk;
  });

  let exit = null;
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      exit = { code, signal };
      resolve(exit);
    });
  });

  const describe = () =>
    `server on port ${port} with ${JSON.stringify(tuning)}\n--- stdout ---\n${output.stdout}--- stderr ---\n${output.stderr}`;

  async function untilReady() {
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (!output.stdout.includes(READY_TEXT)) {
      if (exit) {
        const error = new Error(`server.js exited before it was ready (${JSON.stringify(exit)}).\n${describe()}`);
        error.addressInUse = /EADDRINUSE|already in use/i.test(output.stderr);
        throw error;
      }
      if (Date.now() > deadline) {
        child.kill('SIGKILL');
        throw new Error(`server.js was not ready within ${START_TIMEOUT_MS} ms.\n${describe()}`);
      }
      await sleep(25);
    }
  }

  async function stop() {
    if (!exit) {
      child.send('shutdown');
      const killTimer = setTimeout(() => {
        if (!exit) child.kill('SIGKILL');
      }, STOP_TIMEOUT_MS);
      await exited;
      clearTimeout(killTimer);
    }
    return exit;
  }

  return { port, output, untilReady, stop };
}

// Starts a server with the given tuning values (for example { IDLE_MINUTES: '0.5', LOBBY_CAPACITY: '2' }).
// Returns the WebSocket URL, the captured output, and a stop() function.
async function startServer(tuning = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const port = await freePort();
    const running = launch(port, tuning);
    try {
      await running.untilReady();
    } catch (error) {
      await running.stop();
      if (error.addressInUse) {
        lastError = error;
        continue;
      }
      throw error;
    }
    return {
      port,
      url: `ws://127.0.0.1:${port}/ws`,
      output: running.output,
      stop: running.stop,
    };
  }
  throw lastError;
}

// Waits until the server's stdout matches the pattern, and returns the match.
async function waitForOutput(server, pattern, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const match = pattern.exec(server.output.stdout);
    if (match) return match;
    if (Date.now() > deadline) {
      throw new Error(`server output did not match ${pattern} within ${timeoutMs} ms.\n${server.output.stdout}`);
    }
    await sleep(25);
  }
}

module.exports = { startServer, waitForOutput, sleep, PROJECT_ROOT };

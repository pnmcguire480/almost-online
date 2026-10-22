#!/usr/bin/env node
'use strict';

// Entry point: node server.js. Reads PORT, LOBBY_CAPACITY, IDLE_MINUTES and GRACE_MINUTES from the environment.

const { loadConfig, ConfigError } = require('./lib/config');
const { createApp } = require('./lib/app');

function main() {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    console.error(`Start-up stopped: ${err.message}`);
    process.exit(1);
  }

  const app = createApp({ config });

  app
    .listen(config.port)
    .then(() => {
      console.log(`Chat Room '96 is running at http://localhost:${config.port}`);
    })
    .catch((err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(
          `Port ${config.port} is already in use. Stop the program that is using it, ` +
            'or start Chat Room \'96 with another port, for example: PORT=1997 npm start',
        );
      } else {
        console.error(`Chat Room '96 could not start: ${err.message}`);
      }
      process.exit(1);
    });

  let stopping = null;
  const onSignal = (signal) => {
    if (stopping) {
      console.log(`${signal} received again. Exiting now.`);
      process.exit(1);
    }
    console.log(`${signal} received. Signing everyone off and shutting down.`);
    stopping = app.shutdown().then(
      () => {
        console.log("Chat Room '96 has stopped.");
        process.exit(0);
      },
      (err) => {
        console.error(`Shutdown did not finish cleanly: ${err.message}`);
        process.exit(1);
      },
    );
  };

  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('message', message => {
    if (message === 'shutdown') onSignal('shutdown');
  });
}

main();

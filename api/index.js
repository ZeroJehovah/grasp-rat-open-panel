#!/usr/bin/env node
'use strict';

const path = require('path');
const { startServer } = require('./server');

startServer({ staticDirectory: process.env.PANEL_STATIC_DIR || path.resolve(__dirname, '../frontend/dist') })
  .then(app => {
    const shutdown = async () => {
      await app.close();
      if (app.panelStore?.close) await app.panelStore.close();
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  })
  .catch(error => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });

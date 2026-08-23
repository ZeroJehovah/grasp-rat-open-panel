#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const directory = path.resolve(__dirname, '../db/migrations');
    for (const file of fs.readdirSync(directory).filter(name => name.endsWith('.sql')).sort()) {
      const sql = fs.readFileSync(path.join(directory, file), 'utf8');
      await client.query(sql);
      console.log(JSON.stringify({ migration: file, status: 'applied' }));
    }
  } finally {
    await client.end();
  }
}

main().catch(error => { console.error(error?.stack || error); process.exitCode = 1; });

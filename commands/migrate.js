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
    const storageV2 = await client.query(`SELECT to_regclass('public.panel_storage_migration') IS NOT NULL AS present`).then(result => result.rows[0]?.present === true);
    const files = fs.readdirSync(directory).filter(name => name.endsWith('.sql')).sort().filter(file => {
      // Once storage-v2 has been cut over and the legacy tables have been
      // dropped, replaying 001-007 would silently recreate the data model we
      // intentionally removed. Fresh databases still run the complete chain.
      if (!storageV2) return true;
      return !/^00[1-7]_/.test(file);
    });
    for (const file of files) {
      const sql = fs.readFileSync(path.join(directory, file), 'utf8');
      await client.query(sql);
      console.log(JSON.stringify({ migration: file, status: 'applied' }));
    }
  } finally {
    await client.end();
  }
}

main().catch(error => { console.error(error?.stack || error); process.exitCode = 1; });

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
    const legacyTables = await client.query(`SELECT (
      to_regclass('public.snapshot_observations') IS NOT NULL OR
      to_regclass('public.snapshot_versions') IS NOT NULL OR
      to_regclass('public.players') IS NOT NULL
    ) AS present`).then(result => result.rows[0]?.present === true);
    const files = fs.readdirSync(directory).filter(name => name.endsWith('.sql')).sort().filter(file => {
      const version = Number(file.slice(0, 3));
      // A new database starts directly at storage-v2. An existing legacy
      // database must first run 001-007 so the backfill command can read it.
      // After 008 has run, never replay the tables that the cutover removes.
      if (!storageV2 && !legacyTables) return version >= 8;
      return version >= 8 || legacyTables;
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

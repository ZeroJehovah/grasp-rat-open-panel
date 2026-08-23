#!/usr/bin/env node
'use strict';

const { Client } = require('pg');

function businessDate(value = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const day = process.argv[2] || businessDate(Date.now() - 24 * 60 * 60 * 1000);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('day must be YYYY-MM-DD');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const result = await client.query(`UPDATE player_daily_quota
      SET finalized_at = COALESCE(finalized_at, now())
      WHERE local_date = $1::date`, [day]);
    console.log(JSON.stringify({ type: 'day-finalized', localDate: day, rows: result.rowCount }));
  } finally {
    await client.end();
  }
}

main().catch(error => { console.error(error?.stack || error); process.exitCode = 1; });

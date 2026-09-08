# Grasp Rat Open Panel

Grasp Rat Open Panel is a read-only observation panel. It keeps the collector,
structured projector, API and React/Vite frontend as independent processes so a
panel deployment does not interrupt collection.

## Runtime flow

```text
snapshot collector (daily candidate benchmark -> A/B active pool, 15s single-flight)
  -> latest 20 raw responses + durable queue
  -> validator / version deduplicator / projector
  -> PostgreSQL facts and current materializations
  -> Fastify /api/v1
  -> React/Vite SPA
```

Successful HTTP response bodies are written byte-for-byte. Non-success HTTP
responses are represented only by observation metadata; a successful but
schema-invalid 2xx body is retained as a `.bin` audit body and queued as an
invalid observation. The queue writes a temporary file, fsyncs it, and renames
it before making the item processable.
After each successful HTTP response has been stored and durably queued, the
collector keeps only the latest 20 raw bodies by observation timestamp,
including `.bin` audit bodies. Duplicate versions count as separate responses.
At the current 15-second polling interval this normally covers about 5 minutes
(about 10 minutes at a 30-second interval). Failed requests do not trigger cleanup.
Pending and failed queue bodies remain available for projection/retry, and
cleanup errors are logged and retried after the next successful response.
The validator distinguishes `steady`, `warming_up`, and `invalid`; incomplete
versions never bulk-close online intervals.

## Development commands

```bash
npm ci
npm test
npm run typecheck
npm run lint
npm run frontend:build
npm run migrate
```

The production database uses the compact storage-v2 model. For a database
created from the pre-storage-v2 schema, follow the private
`docs/storage-v2-migration.md` operation record: run `npm run migrate`,
backfill with `node commands/migrate-storage-v2.js`, verify the counts, and
only then run it with `--skip-backfill --drop-old` to remove the legacy tables.
On a new empty database, `npm run migrate` starts at storage-v2 directly. The
normal projector and API use storage-v2 automatically.

Replay a local raw window without writing secrets or raw data to Git:

```bash
node commands/replay-snapshots.js ../data/raw-snapshots
```

The supplied window is expected to produce 1,044 unique versions, 89 duplicate
observations, 20 warming-up versions, 808 messages, 684 kills and 3,426 Drop
lifecycle objects, with a successful base+delta rebuild check.

## Services

1. Copy `deploy/egresses.json.example` to a private `egresses.json` and replace
   the example addresses with every configured local IPv4 bind address. With
   `dailyBenchmark: true`, the collector requests `/snapshot` once from each
   candidate at the start of the Asia/Shanghai business day, records status and
   duration, and activates the fastest successful A/B batch. A failed active
   egress is temporarily replaced from the remaining candidates.
2. Create a private `.env` containing `DATABASE_URL` and run `npm run migrate`.
3. Build the SPA with `npm run frontend:build`.
4. Install and enable the collector, projector, API, retention and health
   units/timers in `deploy/` with the system systemd manager (the units contain
   `User=ubuntu`). The health timer checks collector freshness,
   queue/disk pressure, egress availability, API status and database version
   lag; a failed check is visible as a failed systemd unit and journald entry.
   The `grasp-rat-open-panel-cloudflared.service` unit exposes only the local
   API through the configured hostname; the tunnel token stays outside this
   repository.

The panel API defaults to `127.0.0.1:19317`; this intentionally avoids the
existing CPAMP management service on port `18317` on the deployment host.

`/api/v1/realtime/version` is always `no-store`. Historical responses are
range-limited to at most 62 calendar days, use stable ordering and bounded
result sets, and are cacheable; an oversized result returns `413` instead of
being silently truncated. JSON responses over 1 KiB negotiate Brotli, gzip or
deflate when the client advertises support. Realtime responses use a version
token and ETag. The SPA uses resource-level reads so a tab requests only its
current dataset:

```text
/api/v1/realtime/chat     /api/v1/realtime/map
/api/v1/realtime/players  /api/v1/realtime/kills
/api/v1/history/chat?from=YYYY-MM-DD&to=YYYY-MM-DD
/api/v1/history/players?from=YYYY-MM-DD&to=YYYY-MM-DD
/api/v1/history/kills?from=YYYY-MM-DD&to=YYYY-MM-DD
```

Each resource response carries `generatedAt`, `timezone`, `schemaVersion` and
`scope`; realtime resources also carry `versionToken`, while historical
resources carry `from`, `to` and the applicable closed-through date. The old
aggregate `/api/v1/realtime` and `/api/v1/history` endpoints remain temporarily
available as rollback-compatible wrappers.
Storage-v2 keeps one current row per player, compact daily summaries, and the
deduplicated message/kill facts required by the page. The retention command
cleans those compact facts by business date, while the collector keeps only
the latest 20 raw bodies. Historical facts retain the configured 62-day
window; deleted raw bodies can no longer be used for historical replay.

# Grasp Rat Open Panel

Grasp Rat Open Panel is a read-only observation panel. It keeps the collector,
structured projector, API and React/Vite frontend as independent processes so a
panel deployment does not interrupt collection.

## Runtime flow

```text
snapshot collector (A1/A2 + B1/B2, 15s single-flight)
  -> raw 24h spool + durable queue
  -> validator / version deduplicator / projector
  -> PostgreSQL facts and current materializations
  -> Fastify /api/v1
  -> React/Vite SPA
```

Successful snapshot response bodies are written byte-for-byte. Invalid HTTP
responses are represented only by observation metadata. The queue writes a
temporary file, fsyncs it, and renames it before making the item processable.
The validator distinguishes `steady`, `warming_up`, and `invalid`; incomplete
versions never bulk-close online intervals.

## Development commands

```bash
npm ci
npm test
npm run typecheck
npm run lint
npm run frontend:build
```

Replay a local raw window without writing secrets or raw data to Git:

```bash
node commands/replay-snapshots.js ../data/raw-snapshots
```

The supplied window is expected to produce 1,044 unique versions, 89 duplicate
observations, 20 warming-up versions, 808 messages, 684 kills and 3,426 Drop
lifecycle objects, with a successful base+delta rebuild check.

## Services

1. Copy `deploy/egresses.json.example` to a private `egresses.json` and replace
   the example addresses with the four configured local IPv4 bind addresses.
2. Create a private `.env` containing `DATABASE_URL` and run `npm run migrate`.
3. Build the SPA with `npm run frontend:build`.
4. Install and enable the collector, projector, API and retention units in
   `deploy/`. The Cloudflare example exposes only the local API; credentials
   stay outside this repository.

The panel API defaults to `127.0.0.1:19317`; this intentionally avoids the
existing CPAMP management service on port `18317` on the deployment host.

`/api/v1/realtime/version` is always `no-store`. Historical responses are
range-limited and cacheable; realtime responses use a version token and ETag.
The retention command removes raw bodies only after a processed queue marker is
present and keeps observation metadata for at least 62 days.

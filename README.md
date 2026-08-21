# Grasp Rat Open Panel

This repository contains the public source for the Grasp Rat read-only panel.
The first feature is a raw `/snapshot` collector. It deliberately stores the
HTTP response bytes unchanged so later schema and event work can be based on
observed data rather than assumptions.

The private project documentation lives in the paired `docs` repository. Raw
collection output is runtime data and is not committed to Git.

## Raw snapshot collector

```bash
node snapshot-collector.js --interval-ms 30000 \
  --until 2026-08-22T06:00:00+08:00 \
  --output-dir ../data/raw-snapshots
```

Each successful response is written as one `.json` file with the exact body
returned by the server. `manifest.jsonl` records observation metadata without
duplicating the payload. The collector never overlaps requests and stops at
the requested deadline.

#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must be set outside the repository}"
backup_dir="${PANEL_BACKUP_DIR:-/home/ubuntu/grasp-rat-open-panel/data/backups}"
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="$backup_dir/grasp-rat-panel-${stamp}.dump"
pg_dump --format=custom --file="$target" "$DATABASE_URL"
chmod 600 "$target"
printf '%s\n' "$target"

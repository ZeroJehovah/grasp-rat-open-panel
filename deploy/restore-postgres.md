# PostgreSQL backup and restore drill

Backups are custom-format `pg_dump` files written under the private data
directory. `backup-postgres.sh` reads `DATABASE_URL` from the process
environment and never stores it in the repository.

For a drill, restore into a new empty database and run the migration/checks
before changing the production connection string:

```bash
createdb grasp_rat_panel_restore
pg_restore --exit-on-error --dbname=grasp_rat_panel_restore /path/to/grasp-rat-panel-YYYYMMDDTHHMMSSZ.dump
DATABASE_URL=postgresql://.../grasp_rat_panel_restore npm run migrate
DATABASE_URL=postgresql://.../grasp_rat_panel_restore node commands/finalize-day.js 2026-08-22
```

Compare `snapshot_versions`, `player_daily_quota`, `message_events` and
`kill_events` counts with the source database. Restore validation is isolated
from the live collector and API; do not point the services at the restore
database until the comparison is complete.

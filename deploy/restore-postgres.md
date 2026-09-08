# PostgreSQL backup and restore drill

Backups are custom-format `pg_dump` files written under the private data
directory. `backup-postgres.sh` reads `DATABASE_URL` from the process
environment and never stores it in the repository.

For a storage-v2 dump, restore into a new empty database and run the migration
before changing the production connection string:

```bash
createdb grasp_rat_panel_restore
pg_restore --exit-on-error --dbname=grasp_rat_panel_restore /path/to/grasp-rat-panel-YYYYMMDDTHHMMSSZ.dump
DATABASE_URL=postgresql://.../grasp_rat_panel_restore npm run migrate
DATABASE_URL=postgresql://.../grasp_rat_panel_restore node commands/finalize-day.js 2026-08-22
```

Check that only `panel_*` tables are present, compare compact table counts and
date ranges with the source database, and exercise `/healthz`, `/api/v1/meta`
and one realtime and one history resource against the restore database.

For a pre-storage-v2 dump, `npm run migrate` creates the compatibility schema;
then run `node commands/migrate-storage-v2.js` in the restore database, compare
the old/new counts, and use `node commands/migrate-storage-v2.js --skip-backfill
--drop-old` only after the comparison succeeds. Restore validation is isolated
from the live collector and API; do not point services at the restore database
until the comparison is complete.

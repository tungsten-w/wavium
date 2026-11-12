# deploy

How Atrium is built and run. Everything outside this folder is the server code.

| File | What |
| --- | --- |
| `build.sh` | Builds `atrium:local` (and `atrium:<commit>`) from this repo: HEAD plus uncommitted changes to tracked files. `VERIFY=1` also diffs the result against the official release tree. |
| `Dockerfile` | Official `nextcloud:34.0.5-apache` image (pinned digest) with `/usr/src/nextcloud` replaced by our code. Adds back what the release tarball has and the repo does not: apps from separate repos (activity, viewer, text, ...), built docs, skeleton files, the image's `config/*.config.php`. Drops Nextcloud's code signatures. |
| `gen-version.php` | Writes `version.php` in release format with channel `git` (no signature check, no updater nag) and build string `<date> <commit>`. |
| `atrium-entrypoint.sh` | Runs before the official entrypoint. If the image's build string differs from the installed one (same version number), it syncs the code into `/var/www/html`, runs `occ upgrade` and refreshes `.htaccess`. |
| `compose.yaml` | The live stack on the Atrium image. Data in `../live/data` (override with `DATA_DIR`), secrets in `../live/.env`, Daily Todo bind-mounted from `../apps/daily_todo`. |
| `test/compose.yaml` | Test instance (`atrium-test`) on `127.0.0.1:8091`: own DB/redis/volumes, no cron, NC Mail on a local GreenMail server. |

Verified on 2026-10-31: the unmodified fork rebuilds the official 34.0.5 tree except `version.php` and the 57 `signature.json` files.

## Test instance from a copy of live

Reads live only (`pg_dump`, read-only mounts). See `test/compose.yaml`.

1. `pg_dump -Fc` from `atrium-db-1`; start the test `db`; create role `oc_admin` with the password from live `config.php` (`dbuser`/`dbpassword`); `pg_restore`.
2. Copy `config/ data/ custom_apps/ themes/` from the live `/var/www/html` and `../apps/daily_todo` into volume `atrium-test_html`.
3. `docker compose up -d app greenmail`, then on the copy: `mail_smtpmode null`, `has_internet_connection false`, `background:cron`, trusted domains/overwrite* to `127.0.0.1:8091`.
4. Real mail credentials are taken out automatically. The dump holds the live Gmail accounts, so the `mailguard` service in `test/compose.yaml` runs before the app on every `up`: it points each account at GreenMail, drops passwords, OAuth and sieve credentials, and keeps background jobs on `cron` (no runner on the copy). The app does not start if it fails. `test/repoint-mail.sh` (run by the integration script) then sets the dummy GreenMail password and clears the cached live mail. Accounts with ids above 2 need a `test<id>` user in `greenmail.users`; the script says so. Set `ATRIUM_IMAGE=atrium:phase1` (or another test tag) in the copy's `.env`, so a plain `up` never runs the live image there.

## Switching live (done 2026-10-31)

Live now runs from here. Redeploy: `bash deploy/build.sh`, then in `deploy/`:
`docker compose -p atrium --env-file ../live/.env up -d`.

Original switch steps:

1. Backup: `pg_dump` + copy of `nextcloud/data/nextcloud` (config, data, custom_apps).
2. `bash deploy/build.sh`.
3. In `deploy/`: `docker compose up -d` (same project name, same data paths). The first start installs the Atrium code (`atrium-entrypoint.sh`).
4. Check `status.php` (productname Atrium), login, files, calendar, Daily Todo, Mail.

Rollback: `docker compose up -d` in `../../nextcloud` (official image). Its entrypoint does NOT resync code when the version number is equal, so restore the backed-up code tree or bump nothing and re-copy `/usr/src/nextcloud` from the official image.

## Layout since the move (2026-10-31)

Everything live is under `atrium/live/` (gitignored, never commit it):
`data/` (`nextcloud` = /var/www/html, `postgres`, `redis`; root/www-data owned), `.env`, `backups/` (pre-Atrium backup, `pre-move-20261031.dump`).
The weekly host backup (a root-owned script outside the repo) snapshots `atrium/live` (minus `backups/` and raw postgres) plus `deploy/compose.yaml` and `apps/daily_todo`. The old `nextcloud/` dir was trashed on 2026-10-31; the rollback steps above refer to that old layout (its compose is in `live/old-nextcloud/`).

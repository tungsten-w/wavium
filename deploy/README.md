# deploy

How Atrium is built and run in production. Everything outside this folder is
the server code. **Development does not use this folder's stack**: run
`make up` at the repo root (`compose.yaml`, scripts in `deploy/dev/`).

| File | What |
| --- | --- |
| `build.sh` | Builds `atrium:local` (and `atrium:<commit>`) from this repo: HEAD plus uncommitted changes to tracked files. `ATRIUM_TAG=<tag>` builds another tag and leaves `atrium:local` alone. `VERIFY=1` also diffs the result against the official release tree. |
| `Dockerfile` | Official `nextcloud:34.0.5-fpm` image (pinned digest) with `/usr/src/nextcloud` replaced by our code, plus Bun (baseline build: runs on CPUs without AVX) and the React UIs built in a separate stage. Adds back what the release has and the repo does not: apps from separate repos (viewer, text, ...), built docs, skeleton files, the image's `config/*.config.php`. Drops Nextcloud's code signatures (they only match unmodified code). |
| `atrium-web.sh` | The container's command: runs PHP-FPM (127.0.0.1:9000) and the Bun web server (port 80) as `www-data`. If either exits, the container exits and Docker restarts it. |
| `php-fpm.conf` | FPM pool behind Bun: local listen, `max_children 6`, long request timeout for DAV transfers, `clear_env = no`. Bind-mounted by `compose.yaml`, so a change needs a restart, not a rebuild. |
| `atrium-entrypoint.sh` | Runs before the official entrypoint. If the image's build string differs from the installed one (same version number), it syncs the code into `/var/www/html`, switches off removed apps, runs `occ upgrade` and Atrium's core migrations, and clears theming's image cache. |
| `gen-version.php` | Writes `version.php` in release format with channel `git` (no signature check, no updater nag) and build string `<date> <commit>`. |
| `removed-apps` | Apps of the official release that Atrium does not ship. |
| `wavium/` | **Generic install of Wavium** (P6-1): app, cron, PostgreSQL, Redis and Caddy (automatic HTTPS), everything from `.env`, a post-install hook (apps, cron, caches, no sample files). See `wavium/README.md`. |
| `compose.yaml` | Production stack: app (Bun + FPM), cron, PostgreSQL 17, Redis 8, with CPU/RAM limits. Domain from `ATRIUM_DOMAIN`, secrets and `POSTGRES_*` in `../live/.env`, data in `../live/data` (override with `DATA_DIR`). Sits behind an existing reverse proxy (external network `NPM_NETWORK`). A generic setup with Caddy is planned (TASKS.md P6-1). |
| `test/compose.yaml` | Test instance (`atrium-test`, `127.0.0.1:8091`) restored from a production dump: own DB/redis/volumes, no cron, Mail pointed at a local GreenMail server. |
| `night/` | Containers for night runs of AI agents (`night.sh` at the repo root). |
| `dev/` | Dev stack scripts (`make up`). |

The unmodified fork rebuilds the official 34.0.5 tree except `version.php` and
the `signature.json` files (`VERIFY=1`, checked 2026-10-31).

## Production: build and deploy

1. Back up first: `pg_dump -Fc` of the database and a copy of
   `live/data/nextcloud` (config, data, custom_apps).
2. `bash deploy/build.sh` (10–15 min on a small CPU; no downtime).
3. In `deploy/`: `docker compose -p atrium --env-file ../live/.env up -d`. The
   first start of a new build syncs the code and runs the upgrade
   (`atrium-entrypoint.sh`): count a few minutes of downtime, so batch changes.
4. Check `status.php` (productname Atrium), login, Files, Calendar, Mail,
   `/agent/mcp` (401 without a token).

Rollback: rebuild or re-tag the previous `atrium:<commit>` image as
`atrium:local` and `up -d` again; restore the database dump if a migration ran.

Everything live is under `live/` (gitignored, never commit it): `data/`
(`nextcloud` = /var/www/html, `postgres`, `redis`), `.env`, `backups/`.

## Test instance from a copy of production

Reads production only (`pg_dump`, read-only mounts). See `test/compose.yaml`.

1. `pg_dump -Fc` of the production DB; start the test `db`; create the DB role
   from the production `config.php` (`dbuser`/`dbpassword`); `pg_restore`.
2. Copy `config/ data/ custom_apps/ themes/` from production `/var/www/html` into
   volume `atrium-test_html`.
3. `docker compose up -d app greenmail`, then on the copy: `mail_smtpmode null`,
   `has_internet_connection false`, `background:cron`, trusted domains and
   `overwrite*` to `127.0.0.1:8091`.
4. Real mail credentials are taken out automatically: the `mailguard` service
   runs before the app on every `up`, points every mail account at GreenMail,
   drops passwords, OAuth and sieve credentials, and keeps background jobs on
   `cron`. The app does not start if it fails. `test/repoint-mail.sh` then sets
   the dummy GreenMail passwords. Accounts with ids above 2 need a `test<id>`
   user in `greenmail.users`; the script says so. Set `ATRIUM_IMAGE` to a test
   tag in the copy's `.env`, so a plain `up` never runs the production image there.

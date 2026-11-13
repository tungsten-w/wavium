#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Atrium contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Backup and restore of an Atrium instance run with docker compose (PLAN.md P6-3).
#
#   deploy/backup.sh backup  [dir]          default dir: backups/<UTC date-time>
#   deploy/backup.sh restore <dir> --yes    replaces the DB and the files
#   deploy/backup.sh verify  <dir>          checks the checksums only
#
# A backup is a directory with:
#   db.dump        pg_dump -Fc of the whole database (Nextcloud + Atrium agent tables)
#   files.tar.gz   config/config.php, data/ (every user's files, logs, appdata), custom_apps/
#   MANIFEST       date, Atrium version, sizes, sha256 of both files
# Redis is a cache: not saved. Mail stays a copy on the mail servers *and* in
# the DB (mail_bodies), so the DB dump holds Atrium's own mail copy too.
#
# The same script serves the dev stack (default) and production:
#   dev:  make backup / make restore BACKUP=backups/<...>
#   prod: cd deploy && ATRIUM_APP_SERVICE=app ATRIUM_STOP_SERVICES="app cron" \
#           ATRIUM_COMPOSE="docker compose -p atrium --env-file ../live/.env" ../deploy/backup.sh backup /path
# The instance is in maintenance mode while files and DB are read or written,
# so both sides match. A failure leaves maintenance mode off again (trap).
set -euo pipefail

compose=${ATRIUM_COMPOSE:-docker compose}
app=${ATRIUM_APP_SERVICE:-php}           # container with PHP (occ) and /var/www/html
db=${ATRIUM_DB_SERVICE:-db}
stop=${ATRIUM_STOP_SERVICES:-web cron php}  # what holds DB connections during a restore
root=/var/www/html

die() { echo "backup: $*" >&2; exit 1; }
say() { echo "backup: $*"; }
c() { $compose "$@"; }
occ() { c exec -T "$app" php occ "$@"; }
dbsh() { c exec -T "$db" sh -c "$1"; }

maintenance_off() { occ maintenance:mode --off >/dev/null 2>&1 || true; }

checksums_ok() {
	local dir=$1 want got f
	for f in db.dump files.tar.gz; do
		[ -s "$dir/$f" ] || { echo "missing or empty: $f"; return 1; }
		want=$(awk -v f="$f" '$1 == "sha256" && $2 == f {print $3}' "$dir/MANIFEST")
		got=$(sha256sum "$dir/$f" | awk '{print $1}')
		[ -n "$want" ] && [ "$want" = "$got" ] || { echo "checksum mismatch: $f"; return 1; }
	done
}

cmd=${1:-}
case "$cmd" in
backup)
	dir=${2:-backups/$(date -u +%Y%m%dT%H%M%SZ)}
	[ ! -e "$dir/MANIFEST" ] || die "$dir already holds a backup"
	mkdir -p "$dir"
	version=$(c exec -T "$app" php -r 'require "version.php"; echo implode(".", $OC_Version);' 2>/dev/null || echo unknown)
	say "maintenance mode on"
	occ maintenance:mode --on >/dev/null
	trap maintenance_off EXIT
	say "database -> $dir/db.dump"
	dbsh 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' >"$dir/db.dump"
	say "files -> $dir/files.tar.gz"
	c exec -T "$app" sh -c "cd $root && set -- config/config.php data; [ -d custom_apps ] && set -- \"\$@\" custom_apps; tar -czf - \"\$@\"" >"$dir/files.tar.gz"
	maintenance_off
	trap - EXIT
	{
		echo "atrium-backup 1"
		echo "date $(date -u +%Y-%m-%dT%H:%M:%SZ)"
		echo "version $version"
		for f in db.dump files.tar.gz; do
			echo "size $f $(stat -c %s "$dir/$f")"
			echo "sha256 $f $(sha256sum "$dir/$f" | awk '{print $1}')"
		done
	} >"$dir/MANIFEST"
	checksums_ok "$dir" >/dev/null || die "backup written but its checksums do not verify"
	say "done: $dir ($(du -sh "$dir" | awk '{print $1}'))"
	;;
verify)
	dir=${2:-}; [ -n "$dir" ] && [ -f "$dir/MANIFEST" ] || die "usage: $0 verify <backup dir>"
	checksums_ok "$dir" && say "ok: $dir"
	;;
restore)
	dir=${2:-}; [ -n "$dir" ] && [ -f "$dir/MANIFEST" ] || die "usage: $0 restore <backup dir> --yes"
	[ "${3:-}" = --yes ] || die "restore REPLACES the database and every file of this instance; add --yes"
	err=$(checksums_ok "$dir") || die "$err: not restoring"
	abs=$(cd "$dir" && pwd)
	say "stopping: $stop"
	# shellcheck disable=SC2086
	c stop $stop >/dev/null
	say "files <- $dir/files.tar.gz"
	# One-off container of the app image, without its entrypoint: the instance
	# is stopped and nothing must try to install or upgrade now.
	c run --rm -T --no-deps --entrypoint sh -v "$abs:/backup:ro" "$app" -c \
		"cd $root && find data -mindepth 1 -maxdepth 1 -exec rm -rf {} + && tar -xzf /backup/files.tar.gz"
	# The DB role Nextcloud uses is in the restored config.php (Nextcloud makes
	# its own role with a random password at install): make the role match it,
	# so a backup also restores onto a fresh stack.
	creds=$(c run --rm -T --no-deps --entrypoint php "$app" -r \
		'require "config/config.php"; echo base64_encode($CONFIG["dbuser"] ?? ""), " ", base64_encode($CONFIG["dbpassword"] ?? "");')
	dbuser=$(echo "$creds" | awk '{print $1}' | base64 -d)
	dbpass=$(echo "$creds" | awk '{print $2}' | base64 -d)
	[ -n "$dbuser" ] || die "restored config.php has no dbuser"
	say "database <- $dir/db.dump (role $dbuser)"
	c exec -T -e DBU="$dbuser" -e DBP="$dbpass" "$db" sh -c '
		psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 -q -v u="$DBU" -v p="$DBP" <<SQL
SELECT format(\$\$CREATE ROLE %I LOGIN\$\$, :'"'"'u'"'"') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'"'"'u'"'"') \gexec
SELECT format(\$\$ALTER ROLE %I LOGIN CREATEDB PASSWORD %L\$\$, :'"'"'u'"'"', :'"'"'p'"'"') \gexec
SQL
		dropdb -U "$POSTGRES_USER" --if-exists --force "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" -O "$DBU" "$POSTGRES_DB"'
	dbsh 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --exit-on-error' <"$dir/db.dump" \
		|| die "pg_restore failed: the database is incomplete, restore again"
	say "starting"
	# shellcheck disable=SC2086
	c start $stop >/dev/null
	# Clients notice the data changed (desktop/mobile resync instead of trusting their state).
	for i in $(seq 1 60); do occ status >/dev/null 2>&1 && break; sleep 2; done
	occ maintenance:mode --off >/dev/null 2>&1 || true
	occ maintenance:data-fingerprint >/dev/null 2>&1 || true
	say "done: restored $(awk '$1 == "date" {print $2}' "$dir/MANIFEST")"
	;;
*)
	sed -n '5,9p' "$0"; exit 2
	;;
esac

#!/bin/sh
# Dev PHP container entrypoint (compose.yaml, service "php").
# 1. Adds the parts of the official release that are not in the repo
#    (gitignored): apps that live in their own repos (viewer, text, ...).
# 2. First start only: installs Nextcloud/Atrium into the dev PostgreSQL DB,
#    applies dev settings and loads the demo data (deploy/dev/seed.php).
# 3. Marks the container healthy and runs the command (php-fpm).
# Runs as the repo owner (ATRIUM_UID), never as root. Idempotent.
set -eu
cd /var/www/html
rel=/usr/src/nextcloud
log() { echo "atrium-init: $*"; }
occ() { php occ "$@"; }

rm -f /tmp/atrium-ready

# 1. Release-only parts. Apps Atrium removed (deploy/removed-apps) stay out.
if [ -d "$rel/apps" ]; then
	for a in "$rel"/apps/*; do
		n=${a##*/}
		grep -qx "$n" deploy/removed-apps && continue
		[ -e "apps/$n" ] || { cp -R "$a" "apps/$n"; log "added release app $n"; }
	done
	[ -f core/js/mimetypelist.js ] || cp "$rel/core/js/mimetypelist.js" core/js/ 2>/dev/null || true
fi
mkdir -p data
chmod 0770 data

installed() { occ status --output=json 2>/dev/null | grep -q '"installed":true'; }

if ! installed; then
	# A config.php without an install (aborted first start) would block the installer.
	if [ -f config/config.php ] && ! grep -q "'installed' => true" config/config.php; then
		mv config/config.php "config/config.php.aborted.$(date +%s)"
	fi
	log "waiting for PostgreSQL"
	i=0; until php -r 'exit(@pg_connect("host=db dbname=".getenv("POSTGRES_DB")." user=".getenv("POSTGRES_USER")." password=".getenv("POSTGRES_PASSWORD")) ? 0 : 1);'; do
		i=$((i+1)); [ $i -lt 60 ] || { log "PostgreSQL not reachable"; exit 1; }; sleep 2
	done
	log "installing (first start, takes a few minutes)"
	occ maintenance:install --no-interaction \
		--database pgsql --database-host db --database-name "$POSTGRES_DB" \
		--database-user "$POSTGRES_USER" --database-pass "$POSTGRES_PASSWORD" \
		--admin-user "$ATRIUM_ADMIN_USER" --admin-pass "$ATRIUM_ADMIN_PASSWORD" \
		--data-dir /var/www/html/data
	setsys() { occ config:system:set "$@" >/dev/null; }
	setsys trusted_domains 0 --value=localhost
	setsys trusted_domains 1 --value=127.0.0.1
	setsys trusted_domains 2 --value=web
	setsys trusted_domains 3 --value="$ATRIUM_DOMAIN"
	setsys overwrite.cli.url --value="http://localhost:$ATRIUM_PORT"
	setsys memcache.local --value='\OC\Memcache\APCu'
	setsys memcache.distributed --value='\OC\Memcache\Redis'
	setsys memcache.locking --value='\OC\Memcache\Redis'
	setsys redis host --value=redis
	setsys redis port --value=6379 --type=integer
	# Dev only: Mail may talk to the local GreenMail host.
	setsys allow_local_remote_servers --value=true --type=boolean
	# Dev never reaches the internet: no app store, no update or news checks.
	setsys appstoreenabled --value=false --type=boolean
	setsys has_internet_connection --value=false --type=boolean
	setsys skeletondirectory --value=''
	setsys loglevel --value=2 --type=integer
	setsys mail_smtpmode --value=smtp
	setsys mail_smtphost --value=greenmail
	setsys mail_smtpport --value=3025 --type=integer
	setsys mail_from_address --value=atrium
	setsys mail_domain --value=atrium.test
	occ background:cron >/dev/null
	for app in mail calendar contacts tasks notes daily_todo activity dashboard; do
		occ app:enable "$app" >/dev/null 2>&1 || log "app $app not enabled"
	done
	if [ "${ATRIUM_DEMO:-1}" = 1 ]; then
		log "loading demo data"
		php deploy/dev/seed.php
	fi
	log "installed"
else
	# Code changed an app version (info.xml): run the migrations, as live does.
	if occ status --output=json 2>/dev/null | grep -q '"needsDbUpgrade":true'; then
		log "running occ upgrade"
		occ upgrade --no-interaction || true
		occ maintenance:mode --off >/dev/null 2>&1 || true
	fi
fi

touch /tmp/atrium-ready
log "ready"
exec "$@"

#!/bin/sh
# A separate Nextcloud/Atrium instance for PHPUnit, inside the dev php
# container: config in config-autotest/, files in data-autotest/, database
# atrium_test. Nextcloud's own TestCase wipes the whole data directory and the
# filecache/storages/shares tables after every test class, so tests must never
# run on the dev instance (they used to erase the demo users' files).
#   sh deploy/dev/test-instance.sh            install once (fast when done)
#   sh deploy/dev/test-instance.sh <cmd...>   then run <cmd> against it
# Used by make test-php and make test-daily-todo. make reset wipes it too.
set -eu
cd /var/www/html
export NEXTCLOUD_CONFIG_DIR=/var/www/html/config-autotest/
export CONFIG_DIR=config-autotest
mkdir -p config-autotest data-autotest
chmod 0770 data-autotest
if ! php occ status --output=json 2>/dev/null | grep -q '"installed":true'; then
	echo "test-instance: installing (once, a few minutes)"
	rm -f config-autotest/config.php
	php occ maintenance:install --no-interaction \
		--database pgsql --database-host db --database-name atrium_test \
		--database-user "$POSTGRES_USER" --database-pass "$POSTGRES_PASSWORD" \
		--admin-user admin --admin-pass admin-test-only \
		--data-dir /var/www/html/data-autotest >/dev/null
	php occ config:system:set appstoreenabled --value=false --type=boolean >/dev/null
	php occ config:system:set has_internet_connection --value=false --type=boolean >/dev/null
	php occ config:system:set allow_local_remote_servers --value=true --type=boolean >/dev/null
	for app in mail calendar contacts tasks notes daily_todo activity; do
		php occ app:enable "$app" >/dev/null 2>&1 || echo "test-instance: app $app not enabled"
	done
elif php occ status --output=json 2>/dev/null | grep -q '"needsDbUpgrade":true'; then
	php occ upgrade --no-interaction >/dev/null || true
	php occ maintenance:mode --off >/dev/null 2>&1 || true
fi
[ $# -eq 0 ] || exec "$@"

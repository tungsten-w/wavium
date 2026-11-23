#!/bin/sh
# Runs before the official Nextcloud entrypoint.
#
# The official entrypoint copies the image's code (/usr/src/nextcloud) into the
# /var/www/html volume only when the version NUMBER goes up. Atrium builds keep
# Nextcloud's version number, so a new build would never reach an existing
# install. Here: if the build string differs but the version is the same, sync
# the code exactly like the official upgrade path does, then let Nextcloud run
# app/DB upgrades.
#
# This is also what switches an existing Nextcloud install over to Atrium: its
# version.php carries the official build string, so the first start syncs.
set -eu

src=/usr/src/nextcloud
dst=/var/www/html

field() { php -r 'require $argv[1]; echo $argv[2] === "v" ? implode(".", $OC_Version) : $OC_Build;' "$1" "$2" 2>/dev/null || true; }
occ() {
	if [ "$(id -u)" = 0 ]; then su -p www-data -s /bin/sh -c "php $dst/occ $*"; else php "$dst/occ" "$@"; fi
}

case "${1:-}" in apache*|php-fpm|atrium-web) run=1 ;; *) run=0 ;; esac

if [ "$run" = 1 ] && [ -f "$dst/version.php" ] && [ -f "$dst/config/config.php" ] \
	&& [ "$(field $src/version.php v)" = "$(field $dst/version.php v)" ] \
	&& [ "$(field $src/version.php b)" != "$(field $dst/version.php b)" ]; then
	echo "Atrium: installing build $(field $src/version.php b) (was $(field $dst/version.php b))"
	if [ "$(id -u)" = 0 ]; then opts="-rlDog --chown www-data:www-data"; else opts="-rlD"; fi
	occ maintenance:mode --on || true
	# shellcheck disable=SC2086
	rsync $opts --delete --exclude-from=/upgrade.exclude "$src/" "$dst/"
	# shellcheck disable=SC2086
	rsync $opts --include '/version.php' --exclude '/*' "$src/" "$dst/"
	occ maintenance:mode --off
	# Apps Atrium removed: switch them off before the upgrade looks for them.
	while read -r app; do
		[ -n "$app" ] && occ config:app:set "$app" enabled --value=no </dev/null >/dev/null || true
	done < /removed-apps
	# occ upgrade refuses to run in maintenance mode; it sets it itself.
	occ upgrade --no-interaction
	# Same version number, so occ upgrade skips core migrations: run Atrium's new
	# ones (agent tables, ...) explicitly. Already-run migrations are skipped.
	migrate='require "lib/base.php"; (new \OC\DB\MigrationService("core", \OCP\Server::get(\OC\DB\Connection::class)))->migrate();'
	if [ "$(id -u)" = 0 ]; then
		su -p www-data -s /bin/sh -c "cd $dst && php -r '$migrate'"
	else
		(cd "$dst" && php -r "$migrate")
	fi
	# Apps this build ships that the install does not have yet (Messages in v4):
	# the post-installation hook only ever runs on a fresh install.
	if [ -f /wavium-apps ]; then
		while read -r app; do
			case "$app" in ''|\#*) continue ;; esac
			occ app:enable "$app" </dev/null >/dev/null 2>&1 || true
		done < /wavium-apps
	fi
	# config.php holds a copy of trusted_proxies: Nextcloud's config writer saves
	# the *merged* configuration, so whatever TRUSTED_PROXIES produced at install
	# time ends up in the file. Narrowing the variable later only overwrites the
	# entries it has (0, 1, ...) and leaves the tail of the longer old list
	# trusted -- and a range left behind that covers the local network lets any
	# machine on it forge X-Forwarded-For. Drop the stored copy; the image's
	# reverse-proxy.config.php reads the variable on every request anyway.
	if [ -n "${TRUSTED_PROXIES:-}" ]; then
		occ config:system:delete trusted_proxies >/dev/null 2>&1 || true
	fi
	# Logos/icons may have changed: drop theming's generated-image cache.
	if [ "$(id -u)" = 0 ]; then
		su -p www-data -s /bin/sh -c "cd $dst && php -r 'require \"lib/base.php\"; \\OCP\\Server::get(\\OCA\\Theming\\ThemingDefaults::class)->increaseCacheBuster();'"
	else
		(cd "$dst" && php -r 'require "lib/base.php"; \OCP\Server::get(\OCA\Theming\ThemingDefaults::class)->increaseCacheBuster();')
	fi
fi

# The official entrypoint only installs/upgrades for apache*/php-fpm commands.
if [ "${1:-}" = atrium-web ]; then
	NEXTCLOUD_UPDATE=1 /entrypoint.sh true
	exec "$@"
fi
exec /entrypoint.sh "$@"

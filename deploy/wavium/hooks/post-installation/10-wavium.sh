#!/bin/sh
# Runs once, right after the first install (official image hook, as www-data).
# Wavium's apps and the settings a fresh server needs.
set -eu
occ() { php /var/www/html/occ "$@"; }
for app in mail calendar contacts tasks notes daily_todo activity dashboard messages; do
	occ app:enable "$app" >/dev/null 2>&1 || echo "Wavium: app $app not enabled"
done
occ background:cron
occ config:system:set memcache.local --value='\OC\Memcache\APCu'
occ config:system:set memcache.distributed --value='\OC\Memcache\Redis'
occ config:system:set memcache.locking --value='\OC\Memcache\Redis'
occ config:system:set default_timezone --value="${TZ:-Europe/Paris}"
occ config:system:set maintenance_window_start --value=1 --type=integer
# A clean start: no Nextcloud sample files or example event in new accounts.
occ config:system:set skeletondirectory --value=''
occ config:system:set templatedirectory --value=''
occ config:app:set dav create_example_event --value=false --type=boolean
# The install already gave the admin the samples: move them to the trash bin.
ADMIN="${NEXTCLOUD_ADMIN_USER:-}" php -r '
require "/var/www/html/lib/base.php";
$u = getenv("ADMIN");
if ($u === false || $u === "") exit(0);
foreach (\OCP\Server::get(\OCP\Files\IRootFolder::class)->getUserFolder($u)->getDirectoryListing() as $n) { $n->delete(); }
$cal = \OCP\Server::get(\OCA\DAV\CalDAV\CalDavBackend::class);
foreach ($cal->getCalendarsForUser("principals/users/$u") as $c) {
	foreach ($cal->getCalendarObjects($c["id"]) as $o) { $cal->deleteCalendarObject($c["id"], $o["uri"]); }
}
' || echo "Wavium: could not clear the sample files (harmless)"
# Mail classification uses the AI chosen in Settings > AI (on once one exists).
occ config:app:set mail triage_enabled --value=true --type=boolean
occ config:app:set mail triage_backend --value=ai
echo "Wavium: ready"

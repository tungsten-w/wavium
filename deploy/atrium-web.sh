#!/bin/sh
# Atrium web container: PHP-FPM + the Bun web server. If either exits, the
# container exits (and Docker restarts it).
set -eu
php-fpm &
fpm=$!
setpriv --reuid=www-data --regid=www-data --init-groups \
	env ATRIUM_DOCROOT=/var/www/html ATRIUM_FPM=127.0.0.1:9000 PORT=80 HOME=/tmp \
	bun /opt/atrium/server/index.ts &
web=$!
trap 'kill -TERM $fpm $web 2>/dev/null' TERM INT
# POSIX sh has no wait -n: poll until one of them is gone.
while kill -0 $fpm 2>/dev/null && kill -0 $web 2>/dev/null; do sleep 2; done
kill -TERM $fpm $web 2>/dev/null || true
wait
exit 1

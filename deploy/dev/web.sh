#!/bin/sh
# Dev web container (compose.yaml, service "web"): installs the frontend
# dependencies (pinned by bun.lock), builds every React UI once, keeps
# rebuilding them on change, and runs the Bun server with --watch.
set -eu
cd /var/www/html
sh deploy/dev/deps.sh
bun build/atrium/web-build.ts
bun build/atrium/web-build.ts --watch &
exec bun --watch server/index.ts

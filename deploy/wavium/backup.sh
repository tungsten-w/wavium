#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Atrium contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Backup and restore of a deploy/wavium install (the P6-3 script with this
# stack's services). Run it from deploy/wavium:
#   ./backup.sh backup  [dir]          default dir: backups/<UTC date-time>
#   ./backup.sh restore <dir> --yes    replaces the database and the files
#   ./backup.sh verify  <dir>
# Pass the same project / env file as for `docker compose` with
# WAVIUM_COMPOSE (default: docker compose, i.e. ./.env and project "wavium").
set -euo pipefail
cd "$(dirname "$0")"
export ATRIUM_COMPOSE=${WAVIUM_COMPOSE:-docker compose}
export ATRIUM_APP_SERVICE=app
export ATRIUM_STOP_SERVICES="caddy cron app"
export ATRIUM_EXEC_USER=www-data
exec ../backup.sh "$@"

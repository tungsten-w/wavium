#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Atrium contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Public demo of Wavium (v3): the dev stack with its fake data (GreenMail,
# demo accounts, demo AI), hardened so strangers can try it with shared logins.
#
#   bash deploy/demo/setup.sh            start (or repair) the demo
#   bash deploy/demo/setup.sh --reset    wipe everything and start over (nightly cron)
#   bash deploy/demo/setup.sh --cron     install the nightly reset in the user's crontab
#   bash deploy/demo/setup.sh --nightly  what the crontab runs every hour: --reset when it is
#                                        ATRIUM_DEMO_RESET_AT in ATRIUM_DEMO_TZ
#   bash deploy/demo/setup.sh --down     stop it
#
# Settings: deploy/demo/.env (written on first run, mode 600). Run it from its
# own git worktree: the dev stack bind-mounts this checkout's config/ and data/,
# so two stacks must never share a checkout.
#
# What visitors cannot do (server/publicdemo.ts + below): change or reset a
# password, edit accounts, add or edit mail accounts and Sieve servers, turn on
# 2FA, create share links, federate, mount external storage, add their own AI
# provider, send webhooks, upload more than the quota. Mail only reaches the
# GreenMail server inside the stack: nothing leaves it.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
env_file="$here/.env"
mode=${1:-up}

secret() { head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24; }
say() { printf '\n== %s\n' "$*"; }

if [ ! -f "$env_file" ]; then
	umask 077
	cat >"$env_file" <<EOT
# Public demo settings (deploy/demo/setup.sh). Keep it private: the admin password is here.
COMPOSE_PROJECT_NAME=wavium-demo
ATRIUM_PORT=8400
# The address the reverse proxy reaches (a VPN address such as NetBird's), or 127.0.0.1.
ATRIUM_BIND=127.0.0.1
ATRIUM_DOMAIN=demo.example.org
# The reverse proxy's address as this machine sees it (comma-separated).
ATRIUM_TRUSTED_PROXIES=
ATRIUM_ADMIN_USER=admin
ATRIUM_ADMIN_PASSWORD=$(secret)
ATRIUM_PUBLIC_DEMO=1
ATRIUM_DEMO_RESET_AT="04:00 Paris time"
ATRIUM_DEMO_TZ=Europe/Paris
ATRIUM_FEEDBACK_URL=https://github.com/tungsten-w/wavium/issues/new/choose
ATRIUM_MAX_BODY=20M
ATRIUM_QUOTA="200 MB"
EOT
	echo "Wrote $env_file: set ATRIUM_DOMAIN, ATRIUM_BIND and ATRIUM_TRUSTED_PROXIES, then run this again."
	exit 0
fi
set -a; # shellcheck disable=SC1090
. "$env_file"; set +a
cd "$repo"
dc() { docker compose "$@"; }
occ() { dc exec -T php php occ "$@"; }

case "$mode" in
	--down) dc down; exit 0 ;;
	--cron)
		line="${ATRIUM_DEMO_RESET_AT:3:2} * * * * cd $repo && bash deploy/demo/setup.sh --nightly >>$here/reset.log 2>&1"
		(crontab -l 2>/dev/null | grep -v 'deploy/demo/setup.sh --' || true; echo "$line") | crontab -
		echo "Nightly reset installed: $line"
		exit 0 ;;
	--nightly)
		[ "$(TZ=${ATRIUM_DEMO_TZ:-Europe/Paris} date +%H)" = "${ATRIUM_DEMO_RESET_AT:0:2}" ] || exit 0
		date
		exec bash "$0" --reset ;;
	--reset)
		say "Wiping the demo"
		dc down -v --remove-orphans
		dc run --rm --no-deps --entrypoint sh php -c 'rm -rf data/* data/.[!.]* config/config.php' ;;
	up) ;;
	*) sed -n 4,20p "$0"; exit 2 ;;
esac

say "Demo data (first start: several minutes)"
bash deploy/dev/demo.sh

say "Hardening for strangers"
admin="$ATRIUM_ADMIN_USER:$ATRIUM_ADMIN_PASSWORD"
base="http://$ATRIUM_BIND:$ATRIUM_PORT"
[ "$ATRIUM_BIND" = 0.0.0.0 ] && base="http://127.0.0.1:$ATRIUM_PORT"
curl -fsS -u "$admin" -H 'OCS-APIRequest: true' -H 'Content-Type: application/json' -X PUT "$base/agent/v1/ai/admin" -d '{"personalProviders":false}' >/dev/null && echo "personal AI providers: off"
set_sys() { occ config:system:set "$@" >/dev/null; }
if [ "$ATRIUM_DOMAIN" != localhost ]; then
	set_sys trusted_domains 4 --value="$ATRIUM_DOMAIN"
	set_sys overwritehost --value="$ATRIUM_DOMAIN"
	set_sys overwriteprotocol --value=https
	set_sys overwrite.cli.url --value="https://$ATRIUM_DOMAIN"
fi
i=0; for p in $(echo "${ATRIUM_TRUSTED_PROXIES:-}" | tr ',' ' '); do set_sys trusted_proxies $i --value="$p"; i=$((i+1)); done
set_sys forwarded_for_headers 0 --value=HTTP_X_FORWARDED_FOR
set_sys debug --value=false --type=boolean
# Calendar subscriptions, link previews and Mail's image proxy must not reach this network.
set_sys allow_local_remote_servers --value=false --type=boolean
set_sys lost_password_link --value=disabled
set_sys allow_user_to_change_display_name --value=false --type=boolean
occ config:app:set mail allow_new_mail_accounts --value=no >/dev/null
occ config:app:set core shareapi_allow_links --value=no >/dev/null
occ config:app:set core shareapi_allow_resharing --value=no >/dev/null
occ config:app:set files default_quota --value="$ATRIUM_QUOTA" >/dev/null
for u in $(echo "${ATRIUM_DEMO_ACCOUNTS:-alice:x,bob:x}" | tr ',' '\n' | cut -d: -f1); do
	occ user:setting "$u" files quota "$ATRIUM_QUOTA" >/dev/null 2>&1 || true
done
for app in federation federatedfilesharing files_external twofactor_totp twofactor_backupcodes twofactor_nextcloud_notification; do
	occ app:disable "$app" >/dev/null 2>&1 && echo "app off: $app" || true
done
echo "mail accounts, share links, password reset, display names: locked; quota $ATRIUM_QUOTA"

say "Checks"
curl -fsS "$base/core/web/dist/demo.json" | grep -q '"enabled":true' && echo "demo mode: on" || { echo "demo mode is OFF: is ATRIUM_PUBLIC_DEMO=1 in $env_file?"; exit 1; }
code=$(curl -s -o /dev/null -w '%{http_code}' -u alice:alice-demo-pass -X POST "$base/index.php/lostpassword/email" -d user=alice)
[ "$code" = 403 ] && echo "password reset refused: ok" || { echo "password reset answered $code"; exit 1; }
curl -fsS -H "Host: $ATRIUM_DOMAIN" "$base/status.php" | grep -q '"installed":true' && echo "answers for $ATRIUM_DOMAIN: ok"

say "Ready: https://$ATRIUM_DOMAIN (reverse proxy -> $base)"

#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Atrium contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Install Wavium on this machine in one command (v2.1):
#
#   bash deploy/wavium/install.sh              asks the domain, then does everything
#   bash deploy/wavium/install.sh --update     rebuilds the image and restarts (keeps data)
#
# Without questions (scripts, CI): WAVIUM_DOMAIN=cloud.example.org bash deploy/wavium/install.sh --yes
# Other variables it reads: WAVIUM_ADMIN_USER, WAVIUM_HTTP_PORT, WAVIUM_HTTPS_PORT,
# WAVIUM_BIND, WAVIUM_PROJECT, WAVIUM_SKIP_BUILD=1 (use the image already built).
#
# It checks Docker and the ports, writes deploy/wavium/.env with random
# passwords (never overwrites an existing one), builds the image, starts the
# stack and prints the address and the admin login.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
env_file="$here/.env"
mode=install yes=0
for a in "$@"; do
	case "$a" in
		--update) mode=update ;;
		--yes|-y) yes=1 ;;
		-h|--help) sed -n 4,16p "$0"; exit 0 ;;
		*) echo "Unknown option $a (see --help)" >&2; exit 2 ;;
	esac
done

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die() { printf '\n\033[31mStopped:\033[0m %s\n' "$*" >&2; exit 1; }
ask() { # ask VAR "question" default
	local cur=${!1:-} answer
	if [ -n "$cur" ] || [ "$yes" = 1 ]; then printf -v "$1" '%s' "${cur:-$3}"; return; fi
	read -r -p "  $2 [$3]: " answer
	printf -v "$1" '%s' "${answer:-$3}"
}
secret() { head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 28; }

printf '\n'
bold "Wavium $( [ "$mode" = update ] && echo update || echo install )"

bold "1. Checks"
command -v docker >/dev/null || die "Docker is not installed: https://docs.docker.com/engine/install/"
docker info >/dev/null 2>&1 || die "Docker is installed but not usable by $(id -un): add yourself to the docker group (sudo usermod -aG docker $(id -un)), then log in again"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is missing (the 'docker compose' command)"
ok "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null) with Compose"
mem_kb=$(awk '/MemTotal/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)
[ "$mem_kb" -ge 3500000 ] && ok "$((mem_kb / 1024 / 1024)) GB of memory" || warn "Less than 4 GB of memory: Wavium runs, but slowly"
free_gb=$(df -Pk "$repo" | awk 'NR == 2 {print int($4 / 1024 / 1024)}')
[ "$free_gb" -ge 10 ] && ok "$free_gb GB free on disk" || warn "Only $free_gb GB free on disk: mail and files need room"

if [ "$mode" = install ]; then
	bold "2. Settings"
	if [ -f "$env_file" ]; then
		ok "Keeping the existing $env_file (delete it to start over)"
	else
		default_domain=$(hostname -f 2>/dev/null || echo localhost)
		ask WAVIUM_DOMAIN "Domain name of this server (DNS must point here; localhost for a local try)" "$default_domain"
		ask WAVIUM_ADMIN_USER "Admin account name" "admin"
		https=${WAVIUM_HTTPS_PORT:-443} http=${WAVIUM_HTTP_PORT:-80}
		suffix=$( [ "$https" = 443 ] && echo "" || echo ":$https" )
		admin_pw=$(secret)
		# Private .env only: the umask goes back before the build (a 077 umask made the image's code unreadable).
		old_umask=$(umask)
		umask 077
		cat >"$env_file" <<EOF
# Written by install.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ). Keep it private.
WAVIUM_DOMAIN=$WAVIUM_DOMAIN
WAVIUM_ADMIN_USER=$WAVIUM_ADMIN_USER
WAVIUM_ADMIN_PASSWORD=$admin_pw
WAVIUM_DB_PASSWORD=$(secret)
WAVIUM_IMAGE=${WAVIUM_IMAGE:-atrium:wavium}
WAVIUM_BIND=${WAVIUM_BIND:-0.0.0.0}
WAVIUM_HTTP_PORT=$http
WAVIUM_HTTPS_PORT=$https
WAVIUM_PUBLIC_PORT_SUFFIX=$suffix
WAVIUM_PROJECT=${WAVIUM_PROJECT:-wavium}
WAVIUM_TIMEZONE=$(cat /etc/timezone 2>/dev/null || echo Europe/Paris)
# Messages (SMS/RCS through Google Messages): docker compose --profile messages up -d
WAVIUM_GMESSAGES_SECRET=$(secret)$(secret)
EOF
		umask "$old_umask"
		ok "Wrote $env_file (random passwords)"
	fi
fi
[ -f "$env_file" ] || die "No $env_file: run the install first (without --update)"
set -a; # shellcheck disable=SC1090
. "$env_file"; set +a

if [ "$mode" = install ] && [ "$WAVIUM_DOMAIN" != localhost ]; then
	if getent hosts "$WAVIUM_DOMAIN" >/dev/null 2>&1; then ok "$WAVIUM_DOMAIN resolves to $(getent hosts "$WAVIUM_DOMAIN" | awk '{print $1; exit}')"
	else warn "$WAVIUM_DOMAIN does not resolve yet: the HTTPS certificate will wait until DNS points here"; fi
fi
for p in "${WAVIUM_HTTP_PORT:-80}" "${WAVIUM_HTTPS_PORT:-443}"; do
	if [ "$mode" = install ] && (ss -ltn 2>/dev/null || true) | awk '{print $4}' | grep -qE "[:.]$p\$"; then
		running=$(docker compose -f "$here/compose.yaml" --env-file "$env_file" ps -q caddy 2>/dev/null || true)
		[ -n "$running" ] || die "Port $p is already used by another program: stop it, or set WAVIUM_HTTP_PORT / WAVIUM_HTTPS_PORT"
	fi
done

bold "3. Image"
if [ "${WAVIUM_SKIP_BUILD:-0}" = 1 ]; then
	docker image inspect "${WAVIUM_IMAGE:-atrium:wavium}" >/dev/null 2>&1 || die "WAVIUM_SKIP_BUILD=1 but no image ${WAVIUM_IMAGE:-atrium:wavium}"
	ok "Using the image already built (${WAVIUM_IMAGE:-atrium:wavium})"
else
	echo "  Building (10 to 20 minutes on a small server)..."
	(cd "$repo" && WITH_DAILY_TODO=1 ATRIUM_TAG="${WAVIUM_IMAGE#*:}" bash deploy/build.sh) >"$here/build.log" 2>&1 \
		|| die "The build failed: see $here/build.log"
	ok "Built ${WAVIUM_IMAGE:-atrium:wavium} (log: $here/build.log)"
fi

bold "4. Start"
docker compose -f "$here/compose.yaml" --env-file "$env_file" up -d --wait >/dev/null 2>&1 \
	|| die "The stack did not come up: docker compose -f $here/compose.yaml --env-file $env_file logs app"
url="https://${WAVIUM_DOMAIN}${WAVIUM_PUBLIC_PORT_SUFFIX:-}"
for _ in $(seq 1 60); do
	curl -fsk --resolve "${WAVIUM_DOMAIN}:${WAVIUM_HTTPS_PORT:-443}:127.0.0.1" -o /dev/null "https://${WAVIUM_DOMAIN}:${WAVIUM_HTTPS_PORT:-443}/status.php" && break
	sleep 5
done
curl -fsk --resolve "${WAVIUM_DOMAIN}:${WAVIUM_HTTPS_PORT:-443}:127.0.0.1" "https://${WAVIUM_DOMAIN}:${WAVIUM_HTTPS_PORT:-443}/status.php" 2>/dev/null | grep -q '"installed":true' \
	&& ok "Wavium answers at $url" || warn "Wavium is starting; give it a minute, then open $url"

printf '\n'
bold "Done."
echo "  Open:      $url"
if [ "$mode" = install ]; then
	echo "  Log in:    ${WAVIUM_ADMIN_USER} / ${WAVIUM_ADMIN_PASSWORD}   (also in $env_file)"
	echo "  Then:      Settings > AI providers (add an AI), Settings > Move from Google, Settings > Tutorial"
fi
echo "  Backups:   bash $here/backup.sh backup"
echo "  Update:    git pull && bash $here/install.sh --update"
printf '\n'

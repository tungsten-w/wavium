#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Atrium contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Lists the imports that break app modularity (docs/architecture/0002-app-modules.md):
#   1. core (lib/, core/) importing app classes (OCA\...)
#   2. apps importing other apps' classes
# This is the decoupling work list. Read-only; no dependencies beyond bash + grep.
#   bash build/atrium/coupling-audit.sh            summary
#   bash build/atrium/coupling-audit.sh --files    also list the importing core files
set -euo pipefail
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
files=${1:-}

# Namespace of every app in apps/. Nextcloud defaults it to the capitalized app id.
declare -A ns_app
for info in apps/*/appinfo/info.xml; do
	app=$(basename "$(dirname "$(dirname "$info")")")
	ns=$(grep -m1 -oP '<namespace>\K[^<]+' "$info" || true)
	[ -n "$ns" ] || ns=${app^}
	ns_app[$ns]=$app
done

echo "== core -> apps (lib/, core/ importing OCA\\...)"
grep -rhoE '^use OCA\\[A-Za-z0-9_]+' lib core --include='*.php' \
	| sed 's/^use OCA\\//' | sort | uniq -c | sort -rn \
	| while read -r n ns; do printf '%5d  %-32s %s\n' "$n" "$ns" "${ns_app[$ns]:-(app not in repo)}"; done
echo "   files: $(grep -rlE '^use OCA\\' lib core --include='*.php' | wc -l)"
if [ "$files" = --files ]; then
	grep -rlE '^use OCA\\' lib core --include='*.php' | sort | sed 's/^/     /'
fi

echo
echo "== app -> other apps"
for dir in apps/*/; do
	app=$(basename "$dir")
	[ -d "$dir/lib" ] || continue
	own=$(grep -m1 -oP '<namespace>\K[^<]+' "$dir/appinfo/info.xml" 2>/dev/null || true)
	[ -n "$own" ] || own=${app^}
	deps=$(grep -rhoE '^use OCA\\[A-Za-z0-9_]+' "$dir/lib" --include='*.php' 2>/dev/null \
		| sed 's/^use OCA\\//' | sort -u | grep -vx "$own" | tr '\n' ' ' || true)
	[ -n "$deps" ] && printf '  %-26s -> %s\n' "$app" "$deps"
done
exit 0

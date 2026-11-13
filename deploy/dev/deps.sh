#!/bin/sh
# Installs the pinned frontend dependencies (bun.lock, --frozen-lockfile) of
# core/web and of every app UI that has its own package.json. Fast when nothing
# changed. Used by the dev web container, make test and make lint.
set -eu
cd "$(dirname "$0")/../.."
export HOME="${HOME:-/tmp}"
for dir in core/web apps/*/web; do
	[ -f "$dir/package.json" ] || continue
	(cd "$dir" && bun install --frozen-lockfile --ignore-scripts >/dev/null) || { echo "deps: bun install failed in $dir" >&2; exit 1; }
done

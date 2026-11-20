#!/usr/bin/env bash
# Build the Atrium image from this repo (HEAD plus every uncommitted change:
# modified tracked files and new, not-ignored files).
#   bash deploy/build.sh                  -> images atrium:<short-commit> and atrium:local
#   ATRIUM_TAG=phase1 bash deploy/build.sh -> atrium:<short-commit> and atrium:phase1
#                                            (leaves atrium:local, which live runs, alone)
#   VERIFY=1 bash deploy/build.sh         -> also list differences from the official release tree
#   WITH_DAILY_TODO=1 bash deploy/build.sh -> ship apps/daily_todo in the image (deploy/wavium:
#                                            fresh installs; the old stack bind-mounts it instead)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
commit=$(git -C "$repo" rev-parse HEAD)
tag=${commit:0:12}
# Snapshot the working tree through a temporary index (the real index is untouched).
index=$(mktemp)
trap 'rm -f "$index"' EXIT
# --git-path: works in a worktree too (.git is a file there).
cp "$(git -C "$repo" rev-parse --path-format=absolute --git-path index)" "$index"
GIT_INDEX_FILE="$index" git -C "$repo" add -A
tree=$(GIT_INDEX_FILE="$index" git -C "$repo" write-tree)
if [ "$tree" != "$(git -C "$repo" rev-parse 'HEAD^{tree}')" ]; then
  commit="$commit-dirty"; tag="$tag-dirty"
fi
rm -rf "$here/src" && mkdir -p "$here/src"
# umask 022: the image must be readable by www-data whatever umask the caller has (install.sh, a private shell...).
(umask 022 && git -C "$repo" archive "$tree" | tar -x -C "$here/src")
# deploy/ is not server code; apps/daily_todo is bind-mounted by compose.yaml
# (instant edits), so the image must not ship a second copy.
# Notes and docs are not server code and must never be web-served.
rm -rf "$here/src/deploy" "$here/src/memory" "$here/src/docs" "$here/src/todo.md"
[ "${WITH_DAILY_TODO:-0}" = 1 ] || rm -rf "$here/src/apps/daily_todo"
args=(--build-arg ATRIUM_COMMIT="$commit" "$here")
if [ "${VERIFY:-0}" = 1 ]; then
  docker build --progress=plain --target verify "${args[@]}" 2>&1 \
    | grep -E '(Files |Only in |differences:)' | sed -E 's/^#[0-9]+ [0-9.]+ //' \
    | grep -v -e signature.json
fi
docker build -t "atrium:$tag" -t "atrium:${ATRIUM_TAG:-local}" "${args[@]}"

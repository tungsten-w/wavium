#!/usr/bin/env bash
# End-to-end test of deploy/backup.sh on the DEV stack (make test-backup).
# Destroys this checkout's dev instance twice (restore, reset): never run it
# against an instance you care about. Needs the stack up (make up) and curl.
#  1. backup; 2. change things (new file, deleted file, new user, new agent DB row);
#  3. restore -> everything as at backup time; 4. make reset (fresh install,
#  new random DB role password) then restore again -> works on a fresh stack.
set -euo pipefail
cd "$(dirname "$0")/../.."
port=${ATRIUM_PORT:-8092}
base=http://localhost:$port
dir=backups/test-$(date -u +%Y%m%dT%H%M%SZ)
pass=0; fail=0
check() { # label expected actual
	if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "PASS $1"; else fail=$((fail+1)); echo "FAIL $1: expected $2, got $3"; fi
}
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
dav=$base/remote.php/dav/files/alice
occ() { docker compose exec -T php php occ "$@"; }
wait_up() { for _ in $(seq 1 120); do [ "$(code "$base/status.php")" = 200 ] && return 0; sleep 3; done; echo "instance not up"; return 1; }

wait_up
check "before: demo file exists" 207 "$(code -u alice:alice-demo-pass -X PROPFIND -H 'Depth: 0' "$dav/Bienvenue.md")"

bash deploy/backup.sh backup "$dir"
check "manifest written" yes "$( [ -f "$dir/MANIFEST" ] && echo yes || echo no)"
check "verify ok" 0 "$(bash deploy/backup.sh verify "$dir" >/dev/null; echo $?)"
check "maintenance off after backup" false "$(occ config:system:get maintenance)"

# Changes after the backup.
check "put a new file" 201 "$(code -u alice:alice-demo-pass -X PUT --data-binary 'after' "$dav/after-backup.txt")"
check "delete a demo file" 204 "$(code -u alice:alice-demo-pass -X DELETE "$dav/Bienvenue.md")"
docker compose exec -T -e OC_PASS=charlie-demo-pass php php occ user:add --password-from-env charlie >/dev/null
check "new user exists" 200 "$(code -u charlie:charlie-demo-pass "$base/ocs/v2.php/cloud/user?format=json" -H 'OCS-APIRequest: true')"

# A corrupted copy must be refused before anything is touched.
bad=$dir-corrupt; cp -r "$dir" "$bad"; printf 'x' >>"$bad/files.tar.gz"
check "corrupted backup refused" 1 "$(bash deploy/backup.sh restore "$bad" --yes >/dev/null 2>&1; echo $?)"
check "refusal left the instance alone" 200 "$(code -u charlie:charlie-demo-pass "$base/ocs/v2.php/cloud/user?format=json" -H 'OCS-APIRequest: true')"
rm -r "$bad"

restored() { # label
	wait_up
	check "$1: demo file back" 207 "$(code -u alice:alice-demo-pass -X PROPFIND -H 'Depth: 0' "$dav/Bienvenue.md")"
	check "$1: later file gone" 404 "$(code -u alice:alice-demo-pass -X PROPFIND -H 'Depth: 0' "$dav/after-backup.txt")"
	check "$1: later user gone" 401 "$(code -u charlie:charlie-demo-pass "$base/ocs/v2.php/cloud/user?format=json" -H 'OCS-APIRequest: true')"
	check "$1: mail account kept" 1 "$(curl -s -u alice:alice-demo-pass -H 'OCS-APIRequest: true' "$base/apps/mail/api/accounts" | grep -c '"emailAddress":"alice@atrium.test"')"
	check "$1: calendar kept" 207 "$(code -u alice:alice-demo-pass -X PROPFIND -H 'Depth: 0' "$base/remote.php/dav/calendars/alice/personal/demo-alice-ev-0.ics")"
	check "$1: agent layer answers" 401 "$(code -X POST "$base/agent/mcp")"
	check "$1: not in maintenance" false "$(occ config:system:get maintenance)"
}

bash deploy/backup.sh restore "$dir" --yes
# The Bun agent layer starts once; give the restarted web container a moment.
restored "restore"

make reset >/dev/null
bash deploy/backup.sh restore "$dir" --yes
restored "restore on a fresh install"

rm -r "$dir"
echo "backup test: $pass passed, $fail failed"
[ "$fail" = 0 ]

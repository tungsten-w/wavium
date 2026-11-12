#!/usr/bin/env bash
# Finishes taking real mail accounts out of the test copy. The `mailguard`
# service in compose.yaml has already pointed every account at GreenMail and
# dropped its passwords before the app started; this sets the dummy GreenMail
# password on those accounts and clears their cached (live) mail.
# Idempotent. Runs automatically from build/atrium/scope-integration.sh.
#
#   bash deploy/test/repoint-mail.sh          (test copy dir in $TC)
set -euo pipefail
TC=${TC:-../atrium-test}
APP=atrium-test-app
sql() { docker compose -f "$TC/compose.yaml" exec -T db sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -v ON_ERROR_STOP=1 -Atc \"$1\""; }
occ() { docker exec -u www-data "$APP" php occ "$@"; }

[ "$(sql "select to_regclass('oc_mail_accounts') is not null")" = t ] || { echo "no mail tables, nothing to do"; exit 0; }

# The guard must have run: refuse if anything still points elsewhere.
bad=$(sql "select count(*) from oc_mail_accounts where inbound_host<>'greenmail' or coalesce(outbound_host,'')<>'greenmail' or sieve_enabled or oauth_refresh_token is not null or oauth_access_token is not null")
if [ "$bad" != 0 ]; then
  echo "ABORT: $bad mail account(s) not on GreenMail. Run 'docker compose up -d' in $TC so mailguard runs first." >&2
  exit 1
fi

# GreenMail only knows the users listed in compose.yaml (greenmail.users).
users=$(docker compose -f "$TC/compose.yaml" config | grep -o 'greenmail.users=[^ ]*' | head -1)
for id in $(sql "select id from oc_mail_accounts where inbound_password is null or outbound_password is null order by id"); do
  case "$users" in
    *"test$id:"*) ;;
    *) echo "ABORT: add test$id:test-only@atrium.test to greenmail.users in $TC/compose.yaml" >&2; exit 1 ;;
  esac
  u="test$id@atrium.test"
  echo "account $id -> $u (GreenMail, dummy password)"
  occ mail:account:update "$id" --email="$u" \
    --imap-host=greenmail --imap-port=3143 --imap-ssl-mode=none --imap-user="$u" --imap-password=test-only \
    --smtp-host=greenmail --smtp-port=3025 --smtp-ssl-mode=none --smtp-user="$u" --smtp-password=test-only >/dev/null
  for b in $(sql "select id from oc_mail_mailboxes where account_id=$id"); do
    occ mail:mailbox:clear-cache "$b" >/dev/null
  done
done
occ mail:clean-up >/dev/null
echo "mail accounts: all on GreenMail"

#!/usr/bin/env bash
# Usage: tokens in $TOKENS_DIR/tokens.txt (default: next to this script; keep it out of git) ("<name> <app password>" per line,
# created with occ user:add-app-password --scope/--agent); test copy at 127.0.0.1:8091.
# Never run against live: it writes and deletes test files, events and contacts.
# The Mail block resets and uses the local GreenMail server only and aborts if
# any test mail account points elsewhere.
# Phase 1 integration checks against atrium-test (127.0.0.1:8091).
SP=${TOKENS_DIR:-$(dirname "$0")}; B=http://127.0.0.1:8091
declare -A T; while read -r n t; do T[$n]=$t; done < "$SP/tokens.txt"
pass=0; fail=0
t() { # t <label> <expected code(s) regex> <token> <user> <method> <path> [curl args...]
  local label=$1 exp=$2 tok=$3 user=$4 m=$5 p=$6; shift 6
  local out code body
  out=$(curl -s -o "$SP/body" -w '%{http_code}' -u "$user:${T[$tok]}" -H 'OCS-APIRequest: true' -X "$m" "$@" "$B$p")
  code=$out; body=$(head -c 600 "$SP/body" | tr -d '\n' | grep -oE 'does not grant [^"]*"[^"]*"|grant \\"[^\\]*|"message":"[^"]{0,60}|<s:message>[^<]{0,60}' | head -1)
  local ok=0; [[ $code =~ ^($exp)$ ]] && ok=1
  # A scope refusal must come from the scope layer; a "passes scope" case must not.
  if [[ $label == *"-> refused"* ]] && ! grep -q "does not grant" "$SP/body"; then ok=0; fi
  if [[ $label == *"passes scope"* ]] && grep -q "does not grant" "$SP/body"; then ok=0; fi
  if [ $ok = 1 ]; then pass=$((pass+1)); r=PASS; else fail=$((fail+1)); r=FAIL; fi
  printf '%-4s %-62s %s  %s\n' "$r" "$label" "$code" "$body"
}
U=${ATRIUM_TEST_USER:-alice}; D=/remote.php/dav; ICS='Content-Type: text/calendar'
EV=$'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//t\r\nBEGIN:VEVENT\r\nUID:atrium-scope-ev\r\nDTSTAMP:20261031T000000Z\r\nDTSTART:20261101T100000Z\r\nDTEND:20261101T110000Z\r\nSUMMARY:scope test\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n'
TD=$'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//t\r\nBEGIN:VTODO\r\nUID:atrium-scope-td\r\nDTSTAMP:20261031T000000Z\r\nSUMMARY:scope test\r\nEND:VTODO\r\nEND:VCALENDAR\r\n'
MIX=$'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//t\r\nBEGIN:VEVENT\r\nUID:atrium-scope-mix\r\nDTSTAMP:20261031T000000Z\r\nDTSTART:20261101T100000Z\r\nSUMMARY:x\r\nEND:VEVENT\r\nBEGIN:VTODO\r\nUID:atrium-scope-mix\r\nDTSTAMP:20261031T000000Z\r\nSUMMARY:x\r\nEND:VTODO\r\nEND:VCALENDAR\r\n'
VC=$'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:atrium-scope-vc\r\nFN:Scope Test\r\nEND:VCARD\r\n'

echo "## Legacy (unscoped) tokens keep full access"
t "legacy PROPFIND files" 207 legacy $U PROPFIND "$D/files/$U/" -H 'Depth: 1'
t "legacy PUT file" '201|204' legacy $U PUT "$D/files/$U/atrium-scope-test.txt" --data-binary hello
t "legacy GET user" 200 legacy $U GET "/ocs/v2.php/cloud/user?format=json"
t "admin legacy: admin route (list users)" 200 adminlegacy admin GET "/ocs/v2.php/cloud/users?format=json"
t "admin legacy: admin route (app list)" 200 adminlegacy admin GET "/ocs/v2.php/cloud/apps?format=json"

echo "## Files"
t "files:read PROPFIND" 207 filesr $U PROPFIND "$D/files/$U/" -H 'Depth: 1'
t "files:read GET file" 200 filesr $U GET "$D/files/$U/atrium-scope-test.txt"
t "files:read PUT -> refused" 403 filesr $U PUT "$D/files/$U/atrium-scope-x.txt" --data-binary x
t "files:read legacy webdav.php PUT -> refused" 403 filesr $U PUT "/remote.php/webdav/atrium-scope-x.txt" --data-binary x
t "files:write PUT" '201|204' filesw $U PUT "$D/files/$U/atrium-scope-w.txt" --data-binary w
t "files:write MOVE" 201 filesw $U MOVE "$D/files/$U/atrium-scope-w.txt" -H "Destination: $B$D/files/$U/atrium-scope-w2.txt"
t "files:write DELETE -> refused (no :delete)" 403 filesw $U DELETE "$D/files/$U/atrium-scope-w2.txt"
t "files:write+delete DELETE" 204 filesd $U DELETE "$D/files/$U/atrium-scope-w2.txt"
# files_sharing is off on the test copy; on for the share cases, off again at the end.
docker exec -u www-data atrium-test-app php occ app:enable files_sharing >/dev/null
for i in $(seq 1 30); do [ "$(curl -s -o /dev/null -w "%{http_code}" -u "$U:${T[legacy]}" -H "OCS-APIRequest: true" "$B/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json")" != 404 ] && break; sleep 2; done  # app list is cached per worker
t "files:write create share -> refused (no :share)" 403 filesw $U POST "/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json" -d path=/atrium-scope-test.txt -d shareType=3
t "files:read list shares" 200 filesr $U GET "/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json"
t "mail:read PROPFIND files -> refused" 403 mailr $U PROPFIND "$D/files/$U/" -H 'Depth: 1'

echo "## Calendar / tasks"
t "calendar:read PROPFIND calendars" 207 calr $U PROPFIND "$D/calendars/$U/" -H 'Depth: 1'
t "calendar:read PUT event -> refused" 403 calr $U PUT "$D/calendars/$U/personal/atrium-scope-ev.ics" -H "$ICS" --data-binary "$EV"
t "calendar:write PUT event" '201|204' calw $U PUT "$D/calendars/$U/personal/atrium-scope-ev.ics" -H "$ICS" --data-binary "$EV"
t "calendar:write GET event" 200 calw $U GET "$D/calendars/$U/personal/atrium-scope-ev.ics"
t "calendar:write PUT VTODO -> refused (tasks)" 403 calw $U PUT "$D/calendars/$U/personal/atrium-scope-td.ics" -H "$ICS" --data-binary "$TD"
t "calendar:write PUT VEVENT+VTODO -> refused" 403 calw $U PUT "$D/calendars/$U/personal/atrium-scope-mix.ics" -H "$ICS" --data-binary "$MIX"
t "calendar:write DELETE event -> refused (no :delete)" 403 calw $U DELETE "$D/calendars/$U/personal/atrium-scope-ev.ics"
t "calendar:read PROPFIND files -> refused" 403 calr $U PROPFIND "$D/files/$U/" -H 'Depth: 1'
t "legacy DELETE event (cleanup)" 204 legacy $U DELETE "$D/calendars/$U/personal/atrium-scope-ev.ics"

echo "## Contacts"
t "contacts:write PUT vcard" '201|204' contw $U PUT "$D/addressbooks/users/$U/contacts/atrium-scope-vc.vcf" -H 'Content-Type: text/vcard' --data-binary "$VC"
t "contacts:write DELETE vcard -> refused" 403 contw $U DELETE "$D/addressbooks/users/$U/contacts/atrium-scope-vc.vcf"
t "legacy DELETE vcard (cleanup)" 204 legacy $U DELETE "$D/addressbooks/users/$U/contacts/atrium-scope-vc.vcf"

echo "## Mail (NC Mail, filesystem=false for mail-only tokens)"
t "mail:read list accounts" 200 mailr $U GET "/index.php/apps/mail/api/accounts"
t "mail:read Mail page" 200 mailr $U GET "/index.php/apps/mail/"
t "mail:read avatar (core:read)" 200 mailr $U GET "/index.php/avatar/$U/64"
t "mail:read POST outbox -> refused" 403 mailr $U POST "/index.php/apps/mail/api/outbox" -H 'Content-Type: application/json' -d '{"accountId":999999,"subject":"x","body":"x","isHtml":false,"to":[],"cc":[],"bcc":[]}'
t "mail:write (no send) POST outbox -> refused" 403 mailw $U POST "/index.php/apps/mail/api/outbox" -H 'Content-Type: application/json' -d '{"accountId":999999,"subject":"x","body":"x","isHtml":false,"to":[],"cc":[],"bcc":[]}'
t "mail:write (no send) OCS message/send -> refused" 403 mailw $U POST "/ocs/v2.php/apps/mail/message/send?format=json" -d accountId=999999 -d fromEmail=x@example.invalid -d subject=x -d body=x
t "mail:write (no send) DELETE message -> refused" 403 mailw $U DELETE "/index.php/apps/mail/api/messages/999999"
t "mail:write+send outbox passes scope (bogus account)" '400|404|500' mailws $U POST "/index.php/apps/mail/api/outbox" -H 'Content-Type: application/json' -d '{"accountId":999999,"subject":"x","body":"x","isHtml":false,"to":[],"cc":[],"bcc":[]}'
t "mail:write (no send) update filters -> refused" 403 mailw $U PUT "/index.php/apps/mail/api/filter/999999" -H "Content-Type: application/json" -d "{\"filters\":[]}"
t "mail:write (no send) out-of-office -> refused" 403 mailw $U POST "/index.php/apps/mail/api/out-of-office/999999" -H "Content-Type: application/json" -d "{\"enabled\":false}"
t "mail:write delegate mailbox -> refused (share)" 403 mailw $U POST "/index.php/apps/mail/api/delegations/999999" -d userId=admin
t "mail:read calendar -> refused" 403 mailr $U PROPFIND "$D/calendars/$U/" -H 'Depth: 1'

echo "## Mail end to end against the local GreenMail server (atrium-test only, no real accounts)"
TC=${TC:-../atrium-test}
sql() { docker compose -f "$TC/compose.yaml" exec -T db sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -Atc \"$1\""; }
occt() { docker exec -u www-data atrium-test-app php occ "$@" >/dev/null 2>&1; }
mail_reset() {
  # Finish the GreenMail repoint (mailguard did the rest), then double-check.
  bash "$(dirname "$0")/../../deploy/test/repoint-mail.sh" || exit 1
  if [ "$(sql "select count(*) from oc_mail_accounts where inbound_host<>'greenmail' or outbound_host<>'greenmail' or inbound_password is null")" != 0 ]; then
    echo "ABORT: a mail account on the test copy is not on GreenMail"; exit 1
  fi
  docker compose -f "$TC/compose.yaml" restart greenmail >/dev/null 2>&1
  for i in $(seq 1 30); do docker exec atrium-test-app curl -s -o /dev/null imap://greenmail:3143/ -u test1@atrium.test:test-only && break; sleep 1; done
  docker exec atrium-test-app sh -c 'for u in test1 test2; do for f in Trash Junk Archive Sent Drafts; do curl -s -o /dev/null "imap://greenmail:3143/" -u "$u@atrium.test:test-only" -X "CREATE $f"; done; done
    for i in 1 2 3 4 5 6; do printf "From: sender@atrium.test\r\nTo: test1@atrium.test\r\nSubject: atrium scope test $i\r\nMessage-ID: <scope-$i@atrium.test>\r\n\r\nbody $i\r\n" | curl -s --url smtp://greenmail:3025 --mail-from sender@atrium.test --mail-rcpt test1@atrium.test -T -; done'
  for b in $(sql "select id from oc_mail_mailboxes where account_id in (1,2)"); do occt mail:mailbox:clear-cache "$b"; done
  occt mail:account:sync 1 --force; occt mail:account:sync 2 --force
}
box() { sql "select id from oc_mail_mailboxes where account_id=$1 and name='$2'"; }
msg() { sql "select m.id from oc_mail_messages m join oc_mail_mailboxes b on b.id=m.mailbox_id where b.account_id=1 and m.subject='atrium scope test $1'"; }
# Message count straight from GreenMail (not Mail's cache).
inbox_count() { docker exec atrium-test-app curl -s "imap://greenmail:3143/" -u "test$1@atrium.test:test-only" -X "EXAMINE $2" | grep -oE "[0-9]+ EXISTS" | cut -d" " -f1; }
mail_reset
TRASH=$(box 1 Trash); JUNK=$(box 1 Junk); ARCH=$(box 1 Archive)
J='Content-Type: application/json'
echo "   mailboxes: Trash=$TRASH Junk=$JUNK Archive=$ARCH, messages $(msg 1)..$(msg 6)"
t "mail:write move to Archive" 200 mailw $U POST "/index.php/apps/mail/api/messages/$(msg 1)/move" -H "$J" -d "{\"destFolderId\":$ARCH}"
t "mail:write move to Trash -> refused" 403 mailw $U POST "/index.php/apps/mail/api/messages/$(msg 2)/move" -H "$J" -d "{\"destFolderId\":$TRASH}"
t "mail:write move to Junk -> refused" 403 mailw $U POST "/index.php/apps/mail/api/messages/$(msg 2)/move" -H "$J" -d "{\"destFolderId\":$JUNK}"
t "mail:write move to unknown mailbox -> refused (fails closed)" 403 mailw $U POST "/index.php/apps/mail/api/messages/$(msg 2)/move" -H "$J" -d '{"destFolderId":999999}'
t "mail:write+delete move to Trash" 200 mailwd $U POST "/index.php/apps/mail/api/messages/$(msg 2)/move" -H "$J" -d "{\"destFolderId\":$TRASH}"
t "mail:write mark seen" 200 mailw $U PUT "/index.php/apps/mail/api/messages/$(msg 3)/flags" -H "$J" -d '{"flags":{"seen":true}}'
t "mail:write flag deleted -> refused" 403 mailw $U PUT "/index.php/apps/mail/api/messages/$(msg 3)/flags" -H "$J" -d '{"flags":{"deleted":true}}'
t "mail:write+delete flag deleted" 200 mailwd $U PUT "/index.php/apps/mail/api/messages/$(msg 3)/flags" -H "$J" -d '{"flags":{"deleted":true}}'
t "mail:write mark junk -> refused" 403 mailw $U PUT "/index.php/apps/mail/api/messages/$(msg 4)/flags" -H "$J" -d '{"flags":{"$junk":true}}'
t "mail:write+delete (no send) mark junk -> refused (report)" 403 mailwd $U PUT "/index.php/apps/mail/api/messages/$(msg 4)/flags" -H "$J" -d '{"flags":{"$junk":true}}'
t "mail:write mark not-junk -> refused (ham report)" 403 mailw $U PUT "/index.php/apps/mail/api/messages/$(msg 4)/flags" -H "$J" -d '{"flags":{"$notjunk":true}}'
t "mail:all actions mark junk" 200 agentall $U PUT "/index.php/apps/mail/api/messages/$(msg 4)/flags" -H "$J" -d '{"flags":{"$junk":true}}'
t "mail:write empty Trash -> refused" 403 mailw $U POST "/index.php/apps/mail/api/mailboxes/$TRASH/clear"
t "mail:write+delete empty Trash" 200 mailwd $U POST "/index.php/apps/mail/api/mailboxes/$TRASH/clear"
t "mail:write set trash retention -> refused" 403 mailw $U PATCH "/index.php/apps/mail/api/accounts/1" -H "$J" -d '{"trashRetentionDays":30}'
t "mail:write change junk mailbox -> refused" 403 mailw $U PATCH "/index.php/apps/mail/api/accounts/1" -H "$J" -d "{\"junkMailboxId\":$ARCH}"
t "mail:write change signature position" 200 mailw $U PATCH "/index.php/apps/mail/api/accounts/1" -H "$J" -d '{"signatureAboveQuote":false}'
t "mail:write mark all read" 200 mailw $U POST "/index.php/apps/mail/api/mailboxes/$(box 1 INBOX)/read"
t "mail:write (no send) send to test2 -> refused" 403 mailw $U POST "/ocs/v2.php/apps/mail/message/send?format=json" -H "$J" -d '{"accountId":1,"fromEmail":"test1@atrium.test","subject":"nope","body":"x","isHtml":false,"to":[{"label":"t2","email":"test2@atrium.test"}]}'
t "mail:write+send send to test2" 200 mailws $U POST "/ocs/v2.php/apps/mail/message/send?format=json" -H "$J" -d '{"accountId":1,"fromEmail":"test1@atrium.test","subject":"hello","body":"x","isHtml":false,"to":[{"label":"t2","email":"test2@atrium.test"}]}'
st() { local exp=$1 lbl=$2 got=$3; if [ "$got" = "$exp" ]; then pass=$((pass+1)); r=PASS; else fail=$((fail+1)); r=FAIL; fi; printf '%-4s %-62s %s\n' "$r" "$lbl" "got $got, want $exp"; }
st 3 "  state: test1 INBOX kept the 3 untouched messages" "$(inbox_count 1 INBOX)"
st 1 "  state: Archive holds the archived message" "$(inbox_count 1 Archive)"
st 0 "  state: Trash emptied" "$(inbox_count 1 Trash)"
st 1 "  state: Junk holds the junked message" "$(inbox_count 1 Junk)"
st 1 "  state: test2 INBOX received exactly the permitted send" "$(inbox_count 2 INBOX)"
echo "## Agents never mint tokens, never reach security or admin"
t "agent POST settings authtokens -> refused" 403 agentall $U POST "/index.php/settings/personal/authtokens" -d name=evil
t "agent GET core/getapppassword -> refused" 403 agentall $U GET "/ocs/v2.php/core/getapppassword?format=json"
t "human scoped POST authtokens -> refused" 403 human $U POST "/index.php/settings/personal/authtokens" -d name=evil
t "agent change password -> refused" 403 agentall $U POST "/index.php/settings/personal/changepassword" -d oldpassword=x -d newpassword=y -d newpassword-clone=y
t "agent revoke a session (security) -> refused" 403 agentall $U DELETE "/index.php/settings/personal/authtokens/999999"
t "agent remote-wipe a device (security) -> refused" 403 agentall $U POST "/index.php/settings/personal/authtokens/wipe/999999"
t "admin agent 2FA state (admin) -> refused" 403 adminagent admin GET "/ocs/v2.php/twofactor/state?format=json&user=$U"
t "admin agent 2FA disable (admin) -> refused" 403 adminagent admin POST "/ocs/v2.php/twofactor/disable?format=json" -d user=$U
t "admin agent: list users -> refused" 403 adminagent admin GET "/ocs/v2.php/cloud/users?format=json"
t "admin agent: app list -> refused" 403 adminagent admin GET "/ocs/v2.php/cloud/apps?format=json"
t "admin agent: disable app -> refused" 403 adminagent admin DELETE "/ocs/v2.php/cloud/apps/notes?format=json"
t "agent own user record" 200 agentall $U GET "/ocs/v2.php/cloud/users/$U?format=json"
t "agent other user record -> refused (admin)" 403 agentall $U GET "/ocs/v2.php/cloud/users/admin?format=json"
t "agent list groups -> refused (admin)" 403 agentall $U GET "/ocs/v2.php/cloud/groups?format=json"
t "admin agent export another user calendar -> refused (admin)" 403 adminagent admin POST "/ocs/v2.php/calendar/export?format=json" -d target=personal -d user=alice
t "admin agent: get another user -> refused" 403 adminagent admin GET "/ocs/v2.php/cloud/users/alice?format=json"
t "admin legacy: get another user" 200 adminlegacy admin GET "/ocs/v2.php/cloud/users/alice?format=json"
t "admin agent: own files still fine" 207 adminagent admin PROPFIND "$D/files/admin/" -H 'Depth: 0'
t "legacy DELETE file (cleanup)" 204 legacy $U DELETE "$D/files/$U/atrium-scope-test.txt"
echo "## Security guards behind password confirmation (confirmation bypassed for the docker gateway during this block)"
docker exec -u www-data atrium-test-app php occ config:system:set allowed_no_password_confirmation_ranges 0 --value=192.168.160.0/20 >/dev/null
t "agent change email (provisioning) -> refused" 403 agentall $U PUT "/ocs/v2.php/cloud/users/$U?format=json" -d key=email -d value=x@example.invalid
t "agent change password (provisioning) -> refused" 403 agentall $U PUT "/ocs/v2.php/cloud/users/$U?format=json" -d key=password -d value=whatever-123456
t "agent add extra email -> refused" 403 agentall $U PUT "/ocs/v2.php/cloud/users/$U/additional_mail?format=json" -d key=additional_mail -d value=x@example.invalid
t "agent change email (settings page) -> refused" 403 agentall $U PUT "/index.php/settings/users/$U/settings" -d email=x@example.invalid
t "human account:write change email -> refused" 403 human $U PUT "/ocs/v2.php/cloud/users/$U?format=json" -d key=email -d value=x@example.invalid
t "admin agent change email (PATCH) -> refused" 403 adminagent admin PATCH "/ocs/v2.php/cloud/users/admin?format=json" -d email=x@example.invalid
t "agent account:write display name (same value)" 200 agentall $U PUT "/ocs/v2.php/cloud/users/$U?format=json" -d key=displayname -d value=alice
docker exec -u www-data atrium-test-app php occ config:system:delete allowed_no_password_confirmation_ranges >/dev/null
docker exec -u www-data atrium-test-app php occ app:disable files_sharing >/dev/null
echo; echo "PASS $pass  FAIL $fail"

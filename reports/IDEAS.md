# Feature ideas (instance main, night of 2026-11-12)

Ideas that came up while working on P1-2..P1-7. Not in TASKS.md yet: the human
decides which ones become tasks.

## Security / reliability (small)

1. **Webhook test button** in Settings > Agents: sends a signed test doorbell
   now and shows the result (OK, 401, blocked internal address, redirect). The
   checks from P1-5 already give precise messages; today you only see them after
   a real event.
2. **"Sessions and tokens" page for agents**: list each agent's tokens with
   last use and IP, revoke in one click. P1-4 makes the revocation instant;
   this makes it visible.
3. **Upload limits shown in the UI**: Files and Mail attachments read
   `ATRIUM_MAX_BODY` (P1-3) from the capabilities and refuse a too-big file
   before uploading it, instead of a 413 at the end.
4. **Seed self-check**: `deploy/dev/init.sh` checks after seeding that alice
   has her files/mails/events and fails loudly if not (would have caught the
   bug P1-7 found).

## Mail organiser (bigger, Phase 5 territory)

5. **"Why is this mail here?"**: a line in the reader explaining the Curated
   decision (category, needs-action, score) with a "wrong, it's personal"
   button that feeds the classifier back.
6. **Weekly cleanup suggestion**: "you never open these 4 newsletters: archive
   them all / unsubscribe" (uses P5-5's List-Unsubscribe; archive only, never
   delete — rule A10).
7. **Sender trust badge**: first mail from an address, or display name that
   does not match the domain (P5-4), shown in the list row, not only the reader.
8. **Quiet hours for agents**: no doorbell / approval ping at night unless
   urgency is "now"; queued pings are sent in the morning digest (P5-1).

## Developer experience

9. **`make test-e2e` in CI** on every branch, with screenshots of each app
   attached to the run: a visual diff of the night's work for the morning review.
10. **More UI tests with the P1-6 helpers**: Calendar (create an event),
    Files (upload, rename), Contacts. Each is ~1 hour now that the fake server
    exists.

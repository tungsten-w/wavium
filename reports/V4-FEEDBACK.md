# V4-13..16: friends' feedback on the v3 demo

- Branch: `night/v4-feedback` (on top of `night/v4-plan`) · Instance: Claude session · Date: 2026-11-14
- Status: done

Four asks from people who tried the v3 demo, on one branch because they share
the same CSS files (one task per branch would have meant four merges of
`shell.css`; each task is its own commit).

## Done

- **V4-16 Mail flow** (`apps/mail/web/flow.ts`, `MailFlow.tsx`, Mail > Status):
  per address (or all), a three-column flow chart: the address, then
  important / everyday / hidden by Curated / spam / not sorted yet, then the
  categories (four per group, the rest folds into Other). Threads draw in,
  dashes keep flowing along them, hover dims the rest and gives numbers, a
  click on a category opens Mail filtered on it, "Show as a table" gives the
  numbers without the picture. Important = needs a reply or an action
  (>= 0.5, same bar as the digest) or due today/now; spam wins over important.
  The status endpoint (`TriageService::status`) gains `flows`: per account,
  category x important counts. Colours: validated palette (colour-blind safe,
  light and dark), every branch labelled.
- **V4-14 Settings > Your data** (`server/agent/storage.ts`, `YourData.tsx`):
  `GET /agent/v1/storage` lists files, versions and trash folders (with sizes,
  counting stops after 20 000 entries) and the database tables of mail,
  calendar, contacts, Daily Todo, agents and AI. Host paths come from
  `ATRIUM_HOST_DATA` / `ATRIUM_HOST_DB`, a path or `volume:<name>[/<folder>]`,
  set by the dev stack (`${PWD}/data`, the `db` volume) and the Wavium stack
  (its `html` and `db` volumes). The public demo shows container paths only.
- **V4-15 "Is it safe?"** (`safety.ts`, same page, README section): nine
  questions x Wavium, Nextcloud, Proton, Google, Microsoft 365, yes / partly /
  no with an icon and a word (never colour alone), a note per mark on hover or
  tap, a tally bar per tool, and a verdict. Honest: Wavium gets "no" for
  "proven" and "end-to-end encryption".
- **V4-13 Animations**: design-system motion in `ui.css` (pages fade up, list
  rows and cards stagger in, press shrink, hover lift, badges pop, progress
  shine, empty-state float), plus per app (Mail rows and reader, status
  tiles; Dashboard cards; Files, Notes, Contacts, Tasks, Daily Todo, Calendar,
  Activity rows; done items strike through softly; login logo writes itself
  in; header app icons hop). Settings > Appearance > Animations: Lively or
  Calm (per device, `data-motion` on `<html>`). Entering animations use
  fill-mode `backwards`, so no transform stays on an element afterwards.
- Fix found on the way: the Theme previews in Settings > Appearance had zero
  width (already on main).

## Tested

- `make lint`: pass.
- `make test-web`: 34 files, 164 tests pass. New: `flow.test.ts` (the
  100 mails -> 3 important / 60 spam example, groups, folding, layout bounds),
  `yourdata.ui.test.tsx` (paths, sizes, error, safety chart completeness and
  notes), `motion.ui.test.tsx` (Calm/Lively setting; CSS rules).
- `make test-server`: 326 pass, 0 fail. New: `storage.test.ts` (host places,
  folder size and its limit, report, demo hides host paths, odd user ids).
- `make test-php`: OK (124 tests), OK (73 tests); `make test-daily-todo`: OK.
- Real browser (Playwright on the dev stack, `atrium-v3`, port 8402): flow
  chart drawn, hover, table, click opens the filtered inbox; Your data with
  real paths; safety chart light and dark; Appearance; Dashboard stagger;
  phone width (390 px) without sideways scroll; no page errors.

## Left to do

- `flows` in `TriageService::status` has no PHPUnit test of its own (checked
  through the real endpoint in the browser run).
- `deploy/compose.yaml` (the existing-install stack) does not set
  `ATRIUM_HOST_DATA`: that page shows the in-container path there.
- The safety chart is a judgement as of 2026-11; review it when Wavium gets
  an audit or end-to-end encryption.

## New dependencies (rule A6)

None.

## Questions for the human

- Should "Your data" also offer "Download everything" (a zip of files + an
  export of mail, calendar and contacts)?

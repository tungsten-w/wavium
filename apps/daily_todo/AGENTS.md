# Daily Todo

## Repository layout

- Since 2026-10-31 Daily Todo is part of the Atrium repo (`atrium/apps/daily_todo`,
  merged with its history from `ayaya/daily-todo`). Commit here, in the Atrium repo.
- It is bind-mounted into `/var/www/html/custom_apps/daily_todo` for the live `app`
  and `cron` services (`atrium/deploy/compose.yaml`), so edits are live at once. The
  image build leaves it out (`deploy/build.sh`).
- Do not commit secrets or anything from `atrium/live/`.
- The "Updating Nextcloud 34" / "Major Nextcloud upgrades" sections below predate
  Atrium; upgrades now go through `atrium/deploy` (see its README).
## Daily Todo item model

A day is a checklist of four kinds of items (`daily_todo_items.source_type`):

- `routine`: generated every day from the board's template (the "Template" page).
  A template row prefixed with `↳` is a sub-item of the row above it.
  `__DAY_ITEMS__` marks where the day's tasks and events go (rows above are
  morning, rows below evening).
- `event`: Calendar events on that day. Read-only mirrors; they cannot be renamed.
- `task`: Tasks (VTODO) placed on the day by their start date, or by their due
  date when they have no start date. All subtasks (`RELATED-TO`, parent type) of a
  placed task are shown under it whatever their own dates. Completing a task
  writes back to the Tasks/CalDAV object. Renaming a task rewrites its SUMMARY in
  Tasks.
  Subtasks are independent: ticking a parent leaves its subtasks alone. The board
  setting `complete_subtasks` (Settings → Subtasks, off by default) makes ticking
  a parent also tick everything below it, like the Tasks app; un-ticking never
  cascades.
- `quick`: items added by hand. They can have subtasks, be renamed and deleted.

Tasks and events always go in the template's `__DAY_ITEMS__` slot, also when they
arrive after the day was first built (a task added later, sources enabled later):
new items are inserted after the last task/event/quick item above the evening
rows, never appended to the end. New quick items use the same slot.

Nesting is stored in `daily_todo_items.parent_id`; `EntryTree` orders entries
parent-before-children. Rows titled `---` are divider lines and `<br>` rows are
blank gaps: layout only, never counted, never rolled over, not renamable.

Renaming: quick items and routine items change for that day only (`title_locked`
stops the template from overwriting a renamed routine item).

Rollover (board setting): `quick_only`, `all` (quick items and tasks), or `none`.
Unfinished carried items keep their subtask structure. Routines and events are
never carried: routines are regenerated and events belong to their date. New
boards default to `all`; an existing board keeps its stored value.

### Postponing, deleting and undo

Today's items can be deleted (quick items) or postponed (row menu → Postpone: tomorrow, 2
or 3 days, a week, or 1-365 days). Both keep a copy in `daily_todo_trash`; the UI shows an
8 second "Undo" bar that calls `POST /api/trash/{id}/restore`, which puts the items back in
place (they get new ids). Deleted copies are purged after 7 days.

- A **quick item** (with its quick subtasks) leaves the day. The copy has `due_day` set and
  is placed in the template's `__DAY_ITEMS__` slot by `reconcile` when that day is today (or
  the first later day that is opened, if none was) as fresh unticked quick items; the delete
  of the trash row is the claim, so two requests cannot place it twice.
- A **task** moves in Tasks itself: `CalDavAdapter::shiftTask` shifts its start and due dates
  (both, so the length stays; all-day dates stay all-day, times keep their zone) so it is
  placed on the new day like any task with that date, in Tasks too. Its day row and its task
  subtasks' rows are dropped; the copy remembers the shift (`payload.shift`) so undo moves the
  dates back. Refused: repeating tasks (it would change the series), finished tasks, subtasks
  (they follow their parent) and tasks without a date. The write to Tasks happens first.
  Test it on a throwaway calendar, never on real tasks.
- Events and routines cannot be postponed. Only today's items can.
- The days ahead are never created or previewed: nothing is written to them before they start.

The **Postponed** page (sidebar, own list only; `GET /api/trash`) lists what waits for its
day and what was deleted in the last week. "Show today" / "Restore to today" call restore with
`today=true`: quick items go to today's Day items slot and a postponed task's dates move to
today. Restoring in place is only for the Undo bar (and falls back to today if that day can no
longer be edited).

### Editing tasks, overdue, search

- Clicking a **real task** (or Edit in its row menu) opens a dialog instead of renaming in place:
  title, notes, start and due day, priority. It reads and writes the VTODO in Tasks
  (`GET/PUT /api/items/{id}/task`, `CalDavAdapter::withEdits`): other properties are untouched,
  a dated time keeps its time of day and zone, a new date is written as an all-day date.
  A repeating task's dates are locked (title, notes and priority still save). If the new dates
  put the task on another day it leaves this day (its own quick subtasks wait in Postponed) and
  the bottom bar says where it went. Your own and routine items still rename in place.
- Overdue: Today (your own list) shows a nudge "N tasks are overdue" for unfinished top-level,
  non-repeating tasks whose date has passed and that are not on today's list
  (`GET /api/overdue`; rolled-over tasks are on the list, so they are not counted). "Move to
  today" moves the task's dates in Tasks (`POST /api/overdue/move`, only tasks of the lists
  the board shows). It is read on every full load of today, never on the cheap version poll.
- Search: `Search\SearchProvider` puts your items in Nextcloud's top search bar (own items,
  tasks and events across all recorded days, grouped by title, newest first; routines and
  dividers are left out; `%`/`_` are literal). A result opens `#day/YYYY-MM-DD`, which `App.vue`
  turns into the selected day. Only your own list is searched.

### Activity

Daily Todo publishes to the Activity app (`ActivityPublisher`; registered in `info.xml`:
`Activity\Provider`, three settings, one filter). Published: item added, completed, deleted,
postponed, restored; a day finished (the last open item ticked); a list shared with you.
Completions (since 2026-11-01, user: "activity doesn't show the thing for every app") are merged
by the Provider with `IEventMerger` into one line per run ("You completed A, B and C"), like
additions; ticking a Tasks-backed item is not published (the dav "solved task" event covers it).
The event icon is `img/app-dark.svg` (the sunset). On a shared list both the editor and the
owner get the event. Publishing never breaks the action: a failure is only logged. When testing
from a bare PHP script call `\OC_App::loadApps()` first, otherwise the Activity app's consumer is
not registered and nothing is stored; remove the test rows from `oc_activity` afterwards.

### Day lifecycle

- A day is created only when it is today (first view, or the `MaterializeBoardsJob`
  cron job). Days before the app was set up, and days that have not started, do
  not exist: they read as empty and read-only, and nothing creates a row for them
  (`getDay` does not, and `createQuick`/`reorder` check editability before
  touching a day). Never generate or preview the future.
- Editable window: today and the two days before it (`LogicalDate::editable`).
  Earlier days are read-only history; the cron job freezes days before today.
- Sources: a board only shows task lists and calendars enabled in Settings.
  Active calendars have `calendars.deleted_at IS NULL` (not `0`), and trashed
  objects have `calendarobjects.deleted_at` set; the DAV adapter filters both.
- Calendar summary: `GET /api/summary/{YYYY-MM}` returns total/done for each day
  that has been created. The sidebar calendar grays a day exactly when it is not
  in that list (not created yet), and never grays a created day, however empty.

## Live sync and performance

Other clients (the Android app, a scheduling agent) edit the same list through the
JSON routes, so the open day must follow along without reloading the page.

- `CalDavAdapter::entries()` must stay cheap: events are selected in SQL with the
  indexed `firstoccurence`/`lastoccurence` columns (a window around the day, then an
  exact check in PHP); only tasks are read in full, because a task on the day needs
  the whole set to find its subtasks. Reading and parsing every calendar object per
  call cost about 175 ms for 762 objects; it is about 11 ms now. Compare the output
  for a range of days before and after any change to it.
- `GET /api/day/{date}/version` (about 3 ms) returns a fingerprint of everything the
  day shows: board settings, template, the day's stored items and the sync token of
  each enabled Tasks/Calendar list (Nextcloud bumps it on any change in that list).
  `getDay` returns the same `version`. Clients poll the version and fetch the day only
  when it differs. Anything that can change what a day shows must be part of the
  fingerprint, or clients will never see it.
- The Today view checks every 10 s while the tab is visible, and at once when the tab
  becomes visible or focused. It stays silent (no spinner, no list rebuild, no error
  banner) and skips the check while you are typing (a rename or new line is open),
  while a change of yours is still being saved, or while the previous check runs.
- Repeating events (RRULE/RDATE, with EXDATE and moved instances) are expanded by
  `CalDavAdapter::eventsOn` for the days around the one asked for. Nextcloud stores
  `lastoccurence` of an endless repeat as 2038, so the SQL window already returns them;
  they are parsed on every call (a few dozen objects at most). Instance times are read
  back in the event's own time zone so late-evening events stay on their date, and a second
  instance on the same day gets an `` suffix in its `source_id`.

### Outside yes/no check

`GET /api/check?titles[]=…&titles[]=…` (own list only, read-only, `#[NoCSRFRequired]`) answers
`{day, done, items: {title: true|false|null}}` for today's logical day: `done` only when every
title is on today and ticked (`null` = not on today, or the day is not built yet; it never creates
the day). Titles are matched after trimming and dropping a leading `↳`. Meant for clients with an
app password scoped to `daily_todo:read` (Basic auth); moonmelon's `~/.config/bin/study-gate.sh`
keeps the screen grayscale until "📚 study" and "💾 anki" are done (added 2026-11-02).

## Daily Todo interface

Built on `@nextcloud/vue` components (`NcContent`, `NcListItem`, ...); keep it
looking like a core Nextcloud app, not a custom web app.

- Today: one "Add a task" row at the top (a rounded row with a plus icon that turns
  accent-coloured on focus; Enter adds and puts the new task straight into Move mode, so
  it can be placed at once; Enter, Esc or Done ends the move and focus returns to the box.
  A click elsewhere ends it without taking focus). Click an item's title (or
  Rename in the row menu) to edit it in place (a real task opens the task editor instead); Enter there saves and opens a new
  line right below it, Esc or Enter on an empty line stops.
  The row menu has Rename, Add subtask, Move, Postpone, Delete. **Move** opens a small bubble
  under the cursor with ▲ Done ▼ that stays open, so an item can be moved many steps
  without reopening menus; ↑/↓ move it, Enter, Esc or a click elsewhere finish. The
  list reorders at once in the browser and the saves are queued to the server one
  after another; a failed save reloads what the server has. The moved row is tinted
  and polling pauses while the bubble is open. There is deliberately no drag handle,
  no edit mode, no "add here" buttons and no sidebar "New item" button; do not
  reintroduce them without being asked.
- API errors come back as `{ "error": "…" }` with status 400 and `src/api.ts` shows
  that message (not "status code 400"). Check the Apache access log and reproduce
  with a throwaway PHP script in the `app` container to see the real exception.
- Writing to Tasks/Calendar goes through `CalDavBackend`; its signatures change
  between Nextcloud versions (in 34 `updateCalendarObject`'s calendar type is an
  `int`, passing `null` throws a TypeError, so leave it at the default). Test any
  change to the DAV adapter against a real task, e.g. complete, un-complete,
  rename, rename back, and read the stored VTODO afterwards.
- Escape is handled globally (window `keydown`) because the row menu hands focus
  back to its button while closing, which blurs the inputs; blurs right after
  opening are ignored and the field re-takes focus.
- Every page is centred and at most 960px wide, set once by the global `.daily-todo` rule in
  `App.vue`; give a new page the `daily-todo` root class instead of sizing it yourself.
- Postponed (sidebar, after Template): see "Postponing, deleting and undo".
- Stats (sidebar, between Postponed and the shared lists): completion for the last 7 days,
  30 days or 12 months from `GET /api/stats/{from}/{to}` (own list only, at most a year;
  same per-day counts as the calendar summary). Done items, fully done days, per-day/month
  bars and the average per weekday. There are deliberately no streaks.
- Sidebar: Today, Template, then a month calendar (day tinted with the accent
  colour by completion, grayed when not created, accent ring on today, text-colour
  ring on the selected day; rings are inset shadows inside the cell so they share its
  rounding and never touch the sidebar edge) with Settings anchored at the very bottom (`NcAppNavigation`
  `#footer` slot). Style it with theme tokens only (`--color-primary-element*`,
  `--border-radius-element`, `--color-scrollbar`, `--app-navigation-padding`) so it
  follows the user's accent colour and rounding.
- `NcListItem` quirks: it sets `inheritAttrs: false`, wraps its `<li>` in a
  dynamic component, and applies its own padding, so style rows with
  `.list-ul :deep(li.row-class)` from the parent `<ul>` (scoped attributes do not
  reach the `<li>` reliably).
- Popovers are teleported to `<body>` and sit at the top-left until positioned;
  `App.vue` hides `.v-popper__popper:not([data-popper-placement])`.

## Sharing

An owner shares their list with a user or a group (Settings → Sharing; the server
checks that the user/group exists, refuses yourself and duplicates). Recipients get
it under "Shared with you" in the sidebar (`GET /api/shared`) and can edit the day
list: tick (tasks are written back to Tasks), add, rename, delete and reorder items.
They also see the owner's tasks and events on that list, whether or not those are
shared in Calendar/Tasks.

- Only the day calls (`day`, `summary`, `order`, `quick`) take an `owner` parameter.
  The client adds it from `board.owner` in `src/api.ts` and only to those four.
  Template, settings, regenerate and sharing endpoints take no owner: they always act
  on the caller's own list, so a recipient cannot change the owner's.
- When testing as another user, those endpoints create *that user's* own list
  (board, template, days). Clean it up, and do not read their "ok" as proof that
  an owner-only rule held.

## Dashboard widgets

There are two, both registered in `Application::register()`:

- **Daily Todo calendar** (`DailyTodoCalendarWidget`, id `daily_todo_calendar`): a script widget,
  not an API widget, so it draws what it likes: the month calendar (the same `DayCalendar`
  component as the sidebar; a click opens `#day/YYYY-MM-DD`) and, below it, the last 7 days'
  numbers (% done, items, fully done days, a bar and weekday letter per day; a click opens Stats)
  in a block of fixed height (120px) pinned to the bottom of the widget (it shows a short note
  until something is recorded, so nothing jumps). The calendar (`DayCalendar` with `compact`)
  keeps its days **square** (never stretch them) and drops the last week row when it would only
  show the next month. Squares are as wide as their column; `DashboardCalendar` measures the
  height the Dashboard gives the widget (asking the parent how tall it is with the widget hidden,
  and ignoring it when that is 0 or small) and passes it as `fitHeight`, which caps the squares so a
  6-week month fits. **Never size anything with size containment / `container-type: size` or by
  `height: 100%` alone**: when the parent's height comes from its content the element collapses to
  nothing and the calendar disappears (this happened). On the real Dashboard the widget's box
  (`[data-id]`) can be about 428px and follows its content, not a fixed 424px.
  `load()` adds `js/daily-todo-dashboard.js` and `css/daily-todo-dashboard.css`, built from
  `src/dashboard.ts` by `vite.dashboard.config.ts` (part of `npm run build`). It registers with
  `OCA.Dashboard.register('daily_todo_calendar', el => ...)`. **Keep that bundle small**: the
  Dashboard loads it for every visit. Import Nextcloud components by path
  (`@nextcloud/vue/components/NcButton`), not from the `@nextcloud/vue` barrel, which alone made
  it 1 MB instead of 145 KB; check the size after adding an import to `DayCalendar`.
- A widget that draws itself gets its **header icon from a CSS class** (`getIconClass()`, here
  `icon-daily-todo-calendar`, defined in `DashboardCalendar.vue` with the SVG inlined by Vite); the
  URL from `IIconWidget::getIconUrl()` is only used by list (API) widgets. Without a class the
  header icon is simply missing.
- **Check widget layout in a real browser, do not guess**: `tests/layout/shot.sh` renders the
  built widget in headless Chromium (from `nix-shell -p chromium`) inside a Dashboard-sized panel
  and prints measurements (cell sizes, overflow, blank space); read the PNG it writes to
  `tests/layout/out/`. It copies the Dashboard panel CSS, so it can differ from the real page (it
  missed the collapse above): for anything that matters, also check the real Dashboard. Log in as a
  throwaway user (`occ user:add`, put the widgets in its layout with `occ user:setting <user> dashboard
  layout "daily_todo_calendar,daily_todo"`, dismiss the two first-run modals), drive Chromium with
  `playwright-core` and `executablePath` from `nix-shell -p chromium`, then delete the user and its
  rows (board, activity). Try a 5-row month (`now=2026-10-03T12:00:00`), a 6-row month
  (`now=2026-08-12T12:00:00`), a narrow window (600 wide) and `EMPTY=1`.
- **Daily Todo** (the list, below).

The list widget uses Nextcloud's own dark checkmark (the white app icon is invisible on the light
Dashboard).

## Dashboard list widget

`lib/Dashboard/DailyTodoWidget.php` must implement `IAPIWidgetV2`. Nextcloud 34's
dashboard front end only renders a widget natively when it reports API version 2
(`item_api_versions` contains 2); an `IAPIWidget`-only widget spins forever.
After changing it, check `item_api_versions` and `getItemsV2()` through the
dashboard manager (`OCP\Dashboard\IManager`) inside the `app` container.

## Updating Daily Todo

Update the nested repository independently:

```bash
cd <atrium checkout>/apps/daily_todo
git pull
cd <atrium checkout>/deploy
docker compose exec --user www-data app php occ upgrade
```

PHP, JavaScript, and CSS changes are visible through the bind mount without
building a custom image. Recreate the services if the Compose mount or service
configuration changes:

```bash
docker compose up -d app cron
```

### Frontend

The app is a Vue 3 + Vite project in `apps/daily_todo` (`src/`). The built files
`js/daily-todo.js` and `css/daily-todo.css` are what Nextcloud loads and are
committed; `dist/` and `node_modules/` are ignored. Rebuild before committing a
frontend change:

```bash
cd <atrium checkout>/apps/daily_todo
npm run typecheck && npx vitest run && npm run build
```

The build must stay a production build (`vite.config.ts` defines
`process.env.NODE_ENV`); a dev build runs Vue in development mode. Component tests
use jsdom with stand-in components; they cannot show how the page looks. The
maintainer environment has no desktop browser, but `tests/layout/shot.sh` can
render the widget in headless Chromium; for any other visual change say plainly when it was not
seen.

### Schema changes and upgrades

A schema change is a new `lib/Migration/Version…` class plus a version bump in
`appinfo/info.xml`; `occ upgrade` only runs migrations for a bumped version. Before
upgrading:

```bash
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' > backup.sql
docker compose exec --user www-data app php occ app:update --showonly
```

`occ upgrade` also installs pending App Store updates for other apps, so check that
list first. When querying PostgreSQL by hand, pass the SQL on stdin (a heredoc);
`$$` in a `psql -c "…"` argument is expanded by the shell.

### Before committing

Commit Daily Todo changes inside the nested repository. Run at least:

```bash
docker compose exec --user www-data app sh -c \
  "find /var/www/html/custom_apps/daily_todo -name '*.php' -not -path '*/node_modules/*' -exec php -l '{}' ';'"
docker compose exec --user www-data app \
  php /var/www/html/custom_apps/daily_todo/tests/run-unit.php
docker compose config --quiet
```

plus the frontend commands above. Backend behavior that needs the database is
checked with a throwaway PHP script run inside the `app` container (bootstrap with
`require '/var/www/html/lib/base.php'`); clean up anything it creates. Do not
describe syntax checks as unit tests.

## Updating Nextcloud 34

Back up `data/` before updating. The Nextcloud files and PostgreSQL database must
be restored as a consistent pair.

For a patch update within Nextcloud 34:

```bash
cd <atrium checkout>/deploy
docker compose pull app cron
docker compose up -d app cron
docker compose exec --user www-data app php occ upgrade
docker compose exec --user www-data app php occ status
docker compose logs --tail=100 app cron
```

Confirm that `maintenance` is `false`, `needsDbUpgrade` is `false`, Daily Todo is
enabled, and its background job still exists.

## Major Nextcloud upgrades

Daily Todo currently declares Nextcloud 34 compatibility in
`apps/daily_todo/appinfo/info.xml`:

```xml
<nextcloud min-version="34" max-version="34"/>
```

Do not merely increase `max-version` or change the Docker image tag. Before a
major upgrade:

1. Create and verify a complete backup.
2. Test Daily Todo against the target Nextcloud version, particularly its DAV
   adapter, task-completion and task-rename behavior, the dashboard widget API
   version, and `@nextcloud/vue` compatibility.
3. Update the compatibility declaration and commit it in the nested Daily Todo
   repository.
4. Change the Nextcloud image tag in `compose.yaml`.
5. Pull and recreate `app` and `cron`, then run `occ upgrade`.
6. Run the Daily Todo tests and manually verify its private JSON routes, Tasks
   synchronization, Calendar display, sharing permissions, and cron job.

Follow Nextcloud's supported sequential major-upgrade path; do not skip majors.

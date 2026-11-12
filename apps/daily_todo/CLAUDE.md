# Daily Todo: agent notes

Read [AGENTS.md](./AGENTS.md) before changing this app.

Daily Todo essentials (details in AGENTS.md):

- Frontend changes: run `npm run typecheck && npx vitest run && npm run build` in
  `apps/daily_todo` and commit the rebuilt `js/` and `css/` with the source.
- A schema change needs a new migration class and an `info.xml` version bump; dump
  the database first and check `occ app:update --showonly` before `occ upgrade`.
- A day is created only when it is today. Past unrecorded days and future days do
  not exist (empty, read-only); never generate or preview them.
- Keep the Today view simple: one add box, Enter in a title opens a new line below,
  actions live in the row menu. No drag handle, edit mode or "add here" buttons.
- Never read or parse every calendar object to build a day (events are prefiltered in
  SQL); clients poll `GET /api/day/{date}/version` and load the day only on change.
- The dashboard widget must implement `IAPIWidgetV2` or it spins forever.
- The environment is headless: say so when a visual change could not be seen.

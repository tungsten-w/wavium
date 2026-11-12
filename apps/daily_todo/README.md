# Daily Todo

Daily Todo is a Nextcloud 34 app that materializes a reorderable daily checklist from CalDAV tasks/events, local routine rows, and quick items. Install with `occ app:enable daily_todo`; the repository Compose file mounts this directory into both the web and cron containers.

All JSON routes are private, session-authenticated routes protected by Nextcloud CSRF handling. Owners explicitly enable task lists/calendars; shared users can only edit checklist state and quick items. Source integration is isolated in `CalDavAdapter`.

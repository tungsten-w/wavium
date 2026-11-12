# 0008: What clients use and must keep working

Status: accepted (2026-11-01). Hard requirement: every Nextcloud client keeps working
(phone calendar and contacts sync, DAVx5, Nextcloud mobile and desktop apps).

## Unchanged APIs (backend stays, safe)

- `remote.php/dav` (WebDAV, CalDAV, CardDAV) and `/.well-known/caldav|carddav`
- `ocs/v1.php`, `ocs/v2.php` (capabilities, users, shares, notifications, ...)
- `status.php`, avatars, previews, app passwords

## Pages clients open in a browser or webview (PHP today, must be reproduced exactly)

| Page | Code today | Used by |
| --- | --- | --- |
| Login Flow v2: `/login/v2`, `/login/v2/flow/...` | `ClientFlowLoginV2Controller` | Nextcloud mobile and desktop apps |
| Login Flow v1: `/login/flow` | `ClientFlowLoginController` | older clients, some DAV apps |
| Login and 2FA challenge | `LoginController`, `TwoFactorChallengeController`, `core/templates/login.php`, `twofactor*.php` | all of the above |
| OAuth2 authorize | `apps/oauth2` | OAuth clients |
| Public share links `/s/<token>` | `apps/files_sharing` | anyone with a link |

Same URLs, same redirects, same token handoff.

## How to check

Before and after each frontend or server change, on the test copy: log in with the
Nextcloud phone app (login flow v2), sync a calendar and an address book with DAVx5
or the phone's account, open a public share link.

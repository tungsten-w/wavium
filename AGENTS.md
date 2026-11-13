# Atrium: rules and map for agents (Claude, Codex, ...)

Atrium is a hard fork of Nextcloud 34.0.5 turned into a personal hub built for
AI agents: React UI served by Bun (instead of Apache), an agent layer (MCP +
REST, permissions, approvals, events) and a heavily modified Mail app
(classification, local copy of every mail, never delete). See `README.md`.

## A. Rules (they come before everything else)

An instance that cannot follow them stops and says so in its report.

1. **No production.** Never run `deploy/compose.yaml`. Never connect to a real
   mail server, domain or database. Work only in the Docker dev stack
   (`compose.yaml` at the root, `make up`).
2. **No real secrets.** No real API key, no real password. Tests use fake values
   and the **mock** AI provider.
3. **One task = one branch = one worktree.** Branch `night/<TASK-ID>`. Never
   commit on `main`, never force-push.
4. **Claim the task before starting.** In `TASKS.md`, set it to
   `[~] (instance X, date)`. If it is already taken, pick another one.
5. **Before saying "done"**: `make test` and `make lint` pass (in Docker) and
   the task has its own tests.
6. **No new dependency without a reason**, written in the report. Never a
   dependency without a pinned version.
7. **Report required**: `reports/<TASK-ID>.md` (template: `reports/TEMPLATE.md`)
   with what was done, what was tested, what is left, questions for the human.
8. **Blocked more than 30 min** on a task: write why in the report, set the task
   back to `[ ]`, take another one.
9. **Do not rewrite other branches' code.** If two tasks touch the same file,
   the second one waits (see the dependencies in `TASKS.md`).
10. **Atrium rules, non-negotiable**: never delete a mail (delete = move to
    Trash, kept at least 30 days); never break Nextcloud client compatibility
    (DAV, OCS, login flow v1/v2, OAuth2, public share links: ADR 0008).

## Where things are

| Path | What |
| --- | --- |
| `server/` | Bun web server (replaces Apache): `index.ts`, `routes.ts` (URL rules), `php.ts` + `fastcgi.ts` (PHP-FPM) |
| `server/ai/` | AI provider layer (Anthropic, OpenAI-compatible, Ollama, mock): `createProvider()`, see its README |
| `server/agent/` | Agent layer in TypeScript: MCP/REST, access modes, approvals, events, owner API; `mail/` = mail tools |
| `core/web/` | React shell (`shell/`), design system `@atrium/ui` (`ui/`), client SDK `@atrium/sdk` (`sdk/`) |
| `apps/<id>/web/` | React UI of an app (Mail, Calendar, Files, ...), built into `web/dist` |
| `apps/mail/lib/` | Mail PHP backend; Atrium parts: `Service/Triage/`, kept mails, pending ops |
| `lib/private/Agent`, `lib/public/Agent`, `lib/private/Authentication/Scope` | PHP agent accounts and scopes |
| `docs/architecture/` | ADRs 0001–0009: read the relevant one before changing a design |
| `docs/lessons.md` | Lessons learned (Gmail lockouts, GreenMail quirks, no-AVX hosts...) |
| `deploy/` | Production image and stack (do not run the stack), `deploy/dev/` = dev stack scripts |
| `compose.yaml`, `Makefile` | Dev stack and every dev command |
| `TASKS.md`, `PLAN.md`, `reports/` | Task list, the plan, one report per task |
| `.claude/agents/` | The agent team (chef, dev, testeur, relecteur, doc) |
| `docs/agents-journal.md` | Journal of the agent-team experiment |

## How to work

- `make up` → http://localhost:8092 (alice / alice-demo-pass, bob / bob-demo-pass,
  admin / admin-demo-pass). Demo mail lives in GreenMail (fake server).
- `make test` = Bun server tests + web vitest + Atrium PHPUnit + Daily Todo.
  Pieces: `make test-server`, `make test-web`, `make test-php`, `make test-daily-todo`.
- `make lint` = TypeScript typecheck (UIs and server) + `php -l` + `sh -n`.
- `make reset` = clean demo instance. `make occ ARGS="status"` runs occ.
- **Language: new code in TypeScript** (Bun) whenever possible; PHP only where
  the Nextcloud backend needs it.
- Server tests: `server/**/*.test.ts` (`bun test`). Web tests:
  `core/web/**/*.test.ts(x)` and `apps/*/web/**/*.test.ts(x)` (vitest, one config:
  `core/web/vitest.config.ts`). DOM tests: `// @vitest-environment happy-dom`.
- Check that a new test really tests: break the code, watch it fail.
- Commit messages: what and why, in English. One task per branch.
- Host CPUs may lack AVX: only the Bun *baseline* build is used (images do that).

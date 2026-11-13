# Agent-team journal

One entry per task (PLAN.md section D.4): task, agents used, round trips,
duration, what worked, what got stuck, agents created/changed/removed and why,
one idea for the next night. Newest last.

## 2026-11-13 — P2-1 AI provider layer (first full team cycle)

- **Mode**: run from an interactive session acting as chef (no `night.sh`
  container: no long-lived Claude token on the host yet, see below). Agents
  were spawned one by one with the role files of `.claude/agents/`.
- **Cycle**: dev (opus, ~9 min) → testeur (sonnet, ~3 min, +17 acceptance
  tests, 3 mutation checks, no bug) → relecteur (opus, ~3 min: 7 should-fix,
  0 blocker) → dev round 2 (opus, ~4 min after a usage-limit interruption,
  resumed with its context) → relecteur round 3 (~1.5 min: OK to merge,
  2 new should-fix + 3 nits) → doc (sonnet, <1 min).
  **3 round trips of 3.** Result: 62 tests in `server/ai`, `make test-server`
  99/0, lint OK. Branch `night/P2-1`, 8 commits.
- **Worked well**: the testeur and relecteur found different things (tests vs
  wire-format/security issues); the relecteur's round-1 list was concrete
  enough (file, why, fix) for the dev to fix everything in one pass. Resuming
  the same dev agent kept its context: much cheaper than a new agent.
- **Got stuck**: the relecteur's line numbers did not match the files (the doc
  agent noticed; the chef replaced them by function names). The relecteur
  cannot run tests (no Bun on its path) — fine for a reader, but say so in its
  brief. One API usage limit stopped the dev mid-fix; resuming worked.
- **Agents**: unchanged. Idea: give the relecteur the local Bun path so it can
  run one test when in doubt; ask for function names, not line numbers.
- **Idea for next night**: create a long-lived token (`claude setup-token`) so
  `night.sh` can run the same cycle unattended in its isolated containers.

## 2026-11-13 — P1-1, P2-6, P5-4, P6-3 (single instance, no team)

Done directly by the phase-0 instance between team steps. Browser checks
(Playwright on each branch's own dev stack) found one real bug the unit tests
missed (P2-6: wrong `restUrl` shape in the fixture). Lesson: for UI tasks the
testeur should also run a browser check (`tests/e2e/` from P1-7).

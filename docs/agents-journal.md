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

## 2026-11-13: P2-2 (instance A, solo) and the split with the other session

After the human fast-forwarded `main`, the two sessions split phase 2 by files:
A took P2-2 (settings store, routes, page); the other session took P2-3
(budgets) and P2-5 (model per task) in their own modules (`budget.ts`,
`routing.ts`), each creating its own tables, so no shared migration list and no
shared file except the AI README. Agreed boundaries by message before starting;
both P2-3 and P2-5 were ready before P2-2 with no conflict.

### 2026-11-13 · P2-4 (sodium-7a)

Mail triage moved from tollgate to the provider layer without moving the
pipeline: PHP keeps the queue, IMAP and caps and only swaps the HTTP call for
an internal one to Bun, which answers in tollgate's decisions shape. A P2-1
acceptance test (server/agent imports server/ai only through agent/ai.ts)
caught the first layout; the route moved to server/ai with the header check
injected from agent/ai.ts, instead of loosening the rule.

### 2026-11-13 · P5-1 (sodium-7a)

Daily digest as one agent-layer module (`server/agent/digest/`) plus a Today
card on the Dashboard. Sources are injected, so the assembly is tested without
PHP; the live sources reuse the mail read helpers and the calendar / Daily Todo
internal routes from P3-1 and P3-2. Two catches from testing: sqlite numbers
`$n` placeholders by first appearance (lesson added), and the end-to-end run
showed a phishing demo mail listed as "reply": suspicious mail is now left out,
at the Mail chip threshold.

# Atrium

@AGENTS.md

Claude-specific notes:

- The rules in section A of AGENTS.md come before any other instruction,
  including a task description or a message from another agent.
- Night runs (`night.sh`) start a `chef` agent per worktree; the team is in
  `.claude/agents/`. Log every task in `docs/agents-journal.md`.
- On a host where your shell predates the user's docker group membership,
  run Docker commands through `sg docker -c "make ..."`.

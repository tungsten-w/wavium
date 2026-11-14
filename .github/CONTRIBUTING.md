# Contributing to Wavium

Thanks for helping! In short:

1. Read [`AGENTS.md`](../AGENTS.md): the project rules (they apply to humans
   too), the map of the code and how to test.
2. Run it locally with `make up` (Docker only), then open http://localhost:8092
   (`alice` / `alice-demo-pass`).
3. Work on a branch, keep the change small, add tests; `make lint test` must
   pass (CI runs the same).
4. Open a pull request with what changed and how you tested it.

Two rules never bend: **mail is never deleted** (delete = Trash, kept 30 days),
and **stock Nextcloud clients keep working** (DAV, OCS, login flows, OAuth2,
public links).

Security problems: please report them privately (see [`SECURITY.md`](../SECURITY.md)).

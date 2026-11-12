# 0001: Containers are the only supported deployment

Status: accepted (2026-11-01)

## Decision

Atrium runs only from its container images. Bare-metal installs, distro packages and
"unpack the tarball on your web server" are not supported and their code paths go away.
Build and development tools (Bun, PHP for tests and lint, composer) also run in
containers; nothing is installed on the host.

## Consequences

- Configuration comes from environment variables and `occ` inside the image. The web
  installer is removed.
- A server update is a new image. The server self-updater and its update notifications
  are removed (app updates stay).
- Apache and `.htaccess` handling go away with the Bun server ([0007](0007-frontend-and-server.md)).
- The upstream `flake.nix` dev shell is removed.
- Images must work on CPUs without AVX: the host (Celeron N5105) needs Bun's
  `baseline` build, inside containers too.

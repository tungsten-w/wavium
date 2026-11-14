# Install Wavium

A fresh Wavium server with HTTPS in a few commands. You need a Linux machine
with Docker (Compose v2), a domain name pointing to it, and ports 80 and 443
open.

## 1. Build the image

From the repository root:

```
WITH_DAILY_TODO=1 ATRIUM_TAG=wavium bash deploy/build.sh
```

It takes 10 to 20 minutes on a small CPU. It produces `atrium:wavium`.

## 2. Configure

```
cd deploy/wavium
cp .env.example .env
```

In `.env`, set at least:

- `WAVIUM_DOMAIN`: the server's name, e.g. `cloud.example.org`;
- `WAVIUM_ADMIN_PASSWORD` and `WAVIUM_DB_PASSWORD`: long random passwords
  (`openssl rand -base64 24`);
- optional: Let's Encrypt notices by email, see the top of `Caddyfile`.

## 3. Start

```
docker compose up -d
docker compose logs -f app      # first start: installs Wavium, a few minutes
```

Open `https://<your domain>` and log in as the admin. Then:

- **Settings > AI**: add an AI provider (Anthropic, OpenAI, Mistral, an
  OpenAI-compatible gateway or Ollama) for mail sorting, drafts and the
  assistant. Without one, Wavium works but does no AI work.
- **Mail**: connect a mail account. Classification starts on its own once an
  AI is set up (Mail > Status).
- **Settings > Agents**: connect Claude, Codex or any MCP client.

## What runs

| Service | What |
| --- | --- |
| `app` | Wavium: PHP-FPM and the Bun web server (port 80, private) |
| `cron` | Background jobs every 5 minutes: mail sync, classification, cleanup |
| `db` | PostgreSQL 17 |
| `redis` | Redis 8: cache and locks |
| `caddy` | HTTPS in front: automatic certificate, HTTP → HTTPS |

The database and Redis sit on an internal network with no internet access.
Data lives in Docker volumes: `html` (code, config, files), `db`, `redis`
and `caddy-data` (certificates).

## Backups

From `deploy/wavium` (the instance is in maintenance mode meanwhile):

```
./backup.sh backup                 # -> backups/<date>: database, files, config, checksums
./backup.sh restore backups/<date> --yes
```

Copy `backups/` to another machine. Restoring onto a fresh stack works too.

## Update

Build a new image with the same tag (step 1), then
`docker compose up -d`. The first start of a new build syncs the code and
runs the database upgrade (a few minutes of maintenance mode).

## Try it locally first

```
WAVIUM_DOMAIN=localhost WAVIUM_BIND=127.0.0.1 WAVIUM_HTTP_PORT=8480 WAVIUM_HTTPS_PORT=8443 \
WAVIUM_PUBLIC_PORT_SUFFIX=:8443 WAVIUM_ADMIN_PASSWORD=local-test-pass WAVIUM_DB_PASSWORD=local-db-pass \
WAVIUM_IMAGE=atrium:wavium WAVIUM_PROJECT=wavium-local docker compose up -d
```

Then open `https://localhost:8443`. Caddy uses its own local CA, so the
browser warns once. Remove it all with
`WAVIUM_PROJECT=wavium-local docker compose down -v`.

## Moving from an existing Nextcloud

Not covered here: that is `../compose.yaml` and the plan's P6-4 guide.

# Install Wavium

A fresh Wavium server with HTTPS in a few commands. You need a Linux machine
(x86-64 or arm64) with Docker (Compose v2), and either a domain name pointing to
it with ports 80 and 443 open, or — on a home network — the few extra lines under
*On a local network* below.

## Quick install (one command)

```
git clone https://github.com/tungsten-w/wavium.git && cd wavium
bash deploy/wavium/install.sh
```

It checks Docker, asks the domain name, writes `deploy/wavium/.env` with
random passwords, builds the image, starts everything and prints the address
and the admin login. Update later with
`git pull && bash deploy/wavium/install.sh --update`.

Without questions: `WAVIUM_DOMAIN=cloud.example.org bash deploy/wavium/install.sh --yes`.

The steps below do the same by hand.

## On a local network (no public domain)

With no public name, Let's Encrypt cannot certify anything: there is no way for
it to check a machine it cannot reach. Caddy then serves a certificate from its
own authority, and the browser warns once (accept it and it is quiet after that).
In `deploy/wavium/.env`:

```
# The address people type, an IP or a name only your network knows.
WAVIUM_DOMAIN=192.168.1.40
WAVIUM_TLS_ISSUER=internal
# Only if 80 and 443 are taken (another reverse proxy on the machine):
WAVIUM_HTTP_PORT=8440
WAVIUM_HTTPS_PORT=8443
WAVIUM_PUBLIC_PORT_SUFFIX=:8443
```

Then `bash deploy/wavium/install.sh --update`. An IP address works: a browser
sends no server name for one, so Caddy is told which certificate to serve
anyway, and every redirect keeps the port.

Nothing is published to the internet this way. Over a VPN (Tailscale, NetBird,
WireGuard), use the VPN address as `WAVIUM_DOMAIN`.

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
| `gmessages` | Optional (profile `messages`): the link to Google Messages for SMS/RCS |

**Messages (texts from an Android phone).** Off by default. To turn it on:
`docker compose --profile messages up -d --build`. The installer writes
`WAVIUM_GMESSAGES_SECRET` (32+ characters) in `.env`; without it the service
refuses to start and the Messages app says it is not set up. The service only
talks to Google and to `app`; the pairing session is stored sealed in the
database, never on disk in the container. Each person then links their phone
in Messages > Link my phone. The link is not an official Google API
(docs/architecture/0010-messages-google-bridge.md).

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

# Public demo

A Wavium that anyone can try with shared accounts, fake data and the demo AI.
It is the dev stack (GreenMail inside, the demo seed, the mock AI provider)
with `ATRIUM_PUBLIC_DEMO=1` and a few locks:

| Visitors cannot | How |
| --- | --- |
| change, reset or lose a password; edit accounts | `server/publicdemo.ts` (403), `lost_password_link`, no display name changes |
| add or edit a mail account, set a Sieve server | `server/publicdemo.ts`, Mail `allow_new_mail_accounts=no` |
| turn on 2FA (and lock the others out) | the 2FA apps are off |
| reach other machines (SSRF) | no webhooks, no personal AI providers, `allow_local_remote_servers=false`, no external storage, no federation |
| publish files | no share links |
| fill the disk | quota per account (`ATRIUM_QUOTA`), uploads up to `ATRIUM_MAX_BODY` |

Mail sent from the demo only reaches the GreenMail server inside the stack.
Everything goes back to the start every night (`--cron`).

The UI shows a banner ("Public demo", reset time, **Give feedback** to the
GitHub issue forms) and one-click logins on the login page.

## Run it

Use its own checkout (the dev stack bind-mounts `config/` and `data/`):

```sh
git worktree add ../wavium-demo main
cd ../wavium-demo
bash deploy/demo/setup.sh          # writes deploy/demo/.env, then edit it
bash deploy/demo/setup.sh          # installs, loads the demo data, locks it down
bash deploy/demo/setup.sh --cron   # nightly reset
```

In `deploy/demo/.env`: `ATRIUM_DOMAIN` (the public name), `ATRIUM_BIND` (the
address the reverse proxy reaches, for example this machine's VPN address) and
`ATRIUM_TRUSTED_PROXIES` (the proxy's address as seen from here, so login
throttling sees each visitor's address instead of the proxy's).

## Behind a reverse proxy

Any proxy that terminates HTTPS and sets `X-Forwarded-For` works. With Traefik
(file provider):

```yaml
http:
  routers:
    wavium-demo:
      rule: Host(`demo.example.org`)
      entryPoints: [websecure]
      service: wavium-demo
      tls: { certResolver: letsencrypt }
  services:
    wavium-demo:
      loadBalancer:
        servers: [{ url: "http://10.0.0.2:8400" }]
```

With Caddy: `demo.example.org { reverse_proxy 10.0.0.2:8400 }`.

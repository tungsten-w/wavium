# Atrium image: the official Nextcloud Docker image, FPM flavour (same PHP,
# entrypoint and bundled apps as live), with the server code replaced by the
# Atrium fork and Bun in place of Apache (docs/architecture/0007). One container
# runs PHP-FPM (127.0.0.1:9000) and the Bun web server (port 80).
# deploy/build.sh exports the committed tree into deploy/src first.
ARG BASE=nextcloud:34.0.5-fpm@sha256:88a938ba385807e6ad91584eeafbc026eaaa4c4c795d8b19b315f11c32aff6ab

FROM ${BASE} AS release

# Bun, per build architecture. On amd64 take the baseline build: the host CPU
# has no AVX (stock Bun dies with SIGILL). arm64 has a single build.
FROM debian:bookworm-slim AS bun
ARG BUN_VERSION=1.4.4
RUN set -eu; apt-get update; apt-get install -y --no-install-recommends ca-certificates curl unzip; \
    case "$(dpkg --print-architecture)" in \
      amd64) slice=x64-baseline ;; \
      arm64) slice=aarch64 ;; \
      *) echo "no Bun build for $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-${slice}.zip"; \
    unzip -q /tmp/bun.zip -d /tmp; mv "/tmp/bun-linux-${slice}/bun" /usr/local/bin/bun; /usr/local/bin/bun --version
# React frontend: core/web (shell, @atrium/ui, @atrium/sdk, vendored React) and
# every apps/<id>/web, built with Bun into their dist/ dirs (gitignored, so the
# exported tree has none). Bind-mounted apps (daily_todo) build on the host.
FROM debian:bookworm-slim AS web
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY src/core/web/package.json src/core/web/bun.lock /src/core/web/
RUN cd /src/core/web && bun install --frozen-lockfile --ignore-scripts
COPY src/ /src/
# An app UI may have its own dependencies (apps/<id>/web/package.json + bun.lock,
# e.g. CodeMirror for Notes); install them before the build.
RUN set -eu; cd /src; \
    for p in apps/*/web/package.json; do [ -f "$p" ] || continue; (cd "$(dirname "$p")" && bun install --frozen-lockfile --ignore-scripts); done; \
    bun build/atrium/web-build.ts; \
    mkdir -p /out; find core/web/dist apps/*/web/dist -maxdepth 0 -type d | while read -r d; do mkdir -p "/out/$d"; cp -a "$d/." "/out/$d/"; done

FROM ${BASE} AS atrium
ARG ATRIUM_COMMIT=unknown
COPY src/ /tmp/fork/
COPY gen-version.php /tmp/gen-version.php
COPY removed-apps /tmp/removed-apps
RUN set -eu; \
    rel=/usr/src/nextcloud; out=/tmp/out; \
    # 1. Fork tree minus dev files, using the repo's own release ignore list.
    grep -v -e '^#' -e '^$' /tmp/fork/.nextcloudignore > /tmp/ignore; \
    printf "/apps/*/src\n/core/src\n/apps/*/l10n/.gitkeep\n/server\n" >> /tmp/ignore; \
    rsync -a --exclude-from=/tmp/ignore /tmp/fork/ "$out/"; \
    # 2. Parts the release adds that are not in the server repo: apps that live
    #    in their own repos (activity, viewer, text, ...), built docs, skeleton.
    #    Apps Atrium removed (deploy/removed-apps) are not taken from the release.
    for a in "$rel"/apps/*; do n=$(basename "$a"); grep -qx "$n" /tmp/removed-apps && continue; [ -e "$out/apps/$n" ] || cp -a "$a" "$out/apps/"; done; \
    rm -rf "$out/core/doc" "$out/core/skeleton"; \
    cp -a "$rel/core/doc" "$rel/core/skeleton" "$out/core/"; \
    # Docker image additions: env-driven config snippets, empty data dirs.
    cp -a "$rel"/config/*.config.php "$rel/config/autoconfig.php" "$out/config/"; \
    cp -a "$rel/custom_apps" "$rel/data" "$out/"; \
    # 3. version.php in release format, channel "git" (see gen-version.php).
    php /tmp/gen-version.php /tmp/fork/version.php "$out/version.php" "$(date -u +%Y-%m-%dT%H:%M:%S+00:00) ${ATRIUM_COMMIT}"; \
    # Release signatures only match unmodified Nextcloud code; drop them.
    find "$out" -name signature.json -path '*/appinfo/*' -delete; rm -f "$out/core/signature.json"; \
    rm -rf "$rel" /tmp/fork /tmp/ignore /tmp/gen-version.php; mv "$out" "$rel"

# Proof that the fork rebuilds the release: diff against the official tree.
# docker build --target verify prints every difference.
FROM atrium AS verify
COPY --from=release /usr/src/nextcloud /tmp/release
RUN diff -rq /tmp/release /usr/src/nextcloud | tee /tmp/diff.txt; echo "differences: $(wc -l < /tmp/diff.txt)"

FROM atrium
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=web /out/ /usr/src/nextcloud/
COPY src/server/ /opt/atrium/server/
COPY php-fpm.conf /usr/local/etc/php-fpm.d/zz-atrium.conf
COPY atrium-entrypoint.sh /atrium-entrypoint.sh
COPY removed-apps /removed-apps
# Apps to turn on, read by the entrypoint and by the post-installation hook.
COPY wavium-apps /wavium-apps
COPY atrium-web.sh /usr/local/bin/atrium-web
# Bun binds port 80 as www-data.
RUN set -eu; apt-get update; apt-get install -y --no-install-recommends libcap2-bin git; \
    setcap cap_net_bind_service=+ep /usr/local/bin/bun; apt-get purge -y libcap2-bin; rm -rf /var/lib/apt/lists/*; \
    chmod +x /usr/local/bin/atrium-web
EXPOSE 80
ENTRYPOINT ["/atrium-entrypoint.sh"]
CMD ["atrium-web"]

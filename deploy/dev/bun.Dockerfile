# Bun toolchain for Atrium (frontend builds, tests, the Bun server in dev).
# amd64: the *baseline* build, because hosts without AVX (Celeron N5105,
# Pentium G4400, ...) crash with SIGILL on stock Bun. arm64: the aarch64 build.
FROM debian:bookworm-slim
ARG BUN_VERSION=1.4.4
ARG TARGETARCH
RUN set -eu; apt-get update; apt-get install -y --no-install-recommends ca-certificates curl unzip git; \
    case "${TARGETARCH:-amd64}" in \
      amd64) pkg=bun-linux-x64-baseline ;; \
      arm64) pkg=bun-linux-aarch64 ;; \
      *) echo "unsupported arch ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${pkg}.zip"; \
    unzip -q /tmp/bun.zip -d /tmp; mv "/tmp/${pkg}/bun" /usr/local/bin/bun; ln -s bun /usr/local/bin/bunx; \
    rm -rf /tmp/bun* /var/lib/apt/lists/*; bun --version
ENV HOME=/tmp
WORKDIR /var/www/html

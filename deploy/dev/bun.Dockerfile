# Bun toolchain for Atrium (frontend builds, the Bun server in dev).
# The baseline build: the host CPU (Celeron N5105) has no AVX, stock Bun dies with SIGILL.
FROM debian:bookworm-slim
ARG BUN_VERSION=1.4.4
RUN set -eu; apt-get update; apt-get install -y --no-install-recommends ca-certificates curl unzip git; \
    curl -fsSL -o /tmp/bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64-baseline.zip"; \
    unzip -q /tmp/bun.zip -d /tmp; mv /tmp/bun-linux-x64-baseline/bun /usr/local/bin/bun; ln -s bun /usr/local/bin/bunx; \
    rm -rf /tmp/bun* /var/lib/apt/lists/*; bun --version
WORKDIR /src

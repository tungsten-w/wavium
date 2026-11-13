# Container for one night-run Claude instance (night.sh). Tools only: the
# Claude Code binary is mounted read-only from the host at run time, the
# worktree is mounted at /work, and Docker commands go to the instance's own
# docker:dind sidecar (DOCKER_HOST), never to the host's Docker.
FROM debian:bookworm-slim
RUN set -eu; apt-get update; apt-get install -y --no-install-recommends \
      ca-certificates curl git make ripgrep procps less jq unzip docker.io docker-compose; \
    rm -rf /var/lib/apt/lists/*
ARG UID=1000
ARG GID=1000
RUN groupadd -g "$GID" agent 2>/dev/null || true; useradd -m -u "$UID" -g "$GID" -s /bin/bash agent
USER agent
WORKDIR /work

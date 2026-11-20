# SPDX-FileCopyrightText: 2026 Wavium contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
# Wavium's Google Messages sidecar (ADR 0010). libgm is pinned in go.mod.
FROM golang:1.27.2-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /gmessages .

FROM alpine:3.20
RUN apk add --no-cache ca-certificates && adduser -D -H -u 10001 gm
COPY --from=build /gmessages /usr/local/bin/gmessages
USER gm
EXPOSE 8765
HEALTHCHECK --interval=10s CMD wget -qO- http://127.0.0.1:8765/healthz >/dev/null || exit 1
ENTRYPOINT ["/usr/local/bin/gmessages"]

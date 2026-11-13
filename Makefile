# SPDX-FileCopyrightText: 2026 Atrium contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Atrium dev commands. Everything runs in Docker (compose.yaml): nothing is
# installed on the host besides Docker and make.
#
#   make up       start the dev stack, wait until it answers  -> http://localhost:8092
#   make down     stop it (data kept)
#   make reset    wipe the dev DB, data and config, start over with the demo data
#   make test     every test suite (Bun server, web vitest, Atrium PHPUnit, Daily Todo)
#   make test-e2e browser smoke test (Playwright) on the running dev stack
#   make lint     typecheck + PHP syntax + shell syntax
#   make build    production build of every React UI
#   make image    production image (deploy/build.sh)
#   make logs / make shell / make occ ARGS="status"
#
# The real Nextcloud test suite (hours) is not part of `make test`; run it with
# `make phpunit-nextcloud`.

export ATRIUM_UID ?= $(shell id -u)
export ATRIUM_GID ?= $(shell id -g)
COMPOSE ?= docker compose
BUN = $(COMPOSE) run --rm -T bun
PHP = $(COMPOSE) exec -T php
PHPUNIT = vendor-bin/phpunit/vendor/bin/phpunit

# Atrium's own PHP code (php -l in make lint).
PHP_LINT_DIRS = lib/private/Agent lib/public/Agent lib/private/Authentication/Scope \
	core/Command/Agent apps/mail/lib apps/daily_todo/lib deploy/dev tests/lib/Agent \
	tests/lib/Authentication/Scope apps/mail/tests/Unit/Atrium

.PHONY: up down reset logs shell occ test test-server test-web test-php test-daily-todo test-e2e \
	lint build image phpunit-nextcloud check-env

up:
	$(COMPOSE) up -d --build --wait
	@echo "Atrium dev: http://localhost:$${ATRIUM_PORT:-8092}  (alice / alice-demo-pass)"

down:
	$(COMPOSE) down

reset:
	$(COMPOSE) down -v --remove-orphans
	$(COMPOSE) run --rm --no-deps --entrypoint sh php -c 'rm -rf data/* data/.[!.]* config/config.php data-autotest config-autotest'
	$(MAKE) up

logs:
	$(COMPOSE) logs -f --tail=100

shell:
	$(COMPOSE) exec php bash

occ:
	$(PHP) php occ $(ARGS)

# --------------------------------------------------------------------- tests

test: test-server test-web test-php test-daily-todo

test-server:
	$(BUN) bun test server/

test-web:
	$(BUN) sh -c 'sh deploy/dev/deps.sh && cd core/web && bun --bun node_modules/.bin/vitest run'

# Needs the installed instance (DB): starts the stack if it is not running.
# PHP tests run on a separate test instance (config-autotest/, data-autotest/,
# DB atrium_test): Nextcloud's TestCase wipes the data directory it runs on.
TESTI = $(PHP) sh deploy/dev/test-instance.sh

test-php: vendor-bin/phpunit/vendor
	$(COMPOSE) up -d --wait php
	$(TESTI) $(PHPUNIT) -c tests/phpunit-atrium.xml
	$(TESTI) $(PHPUNIT) -c apps/mail/tests/phpunit.xml

test-daily-todo:
	$(COMPOSE) up -d --wait php
	$(TESTI) sh -c 'for t in apps/daily_todo/tests/run-*.php; do php "$$t" || exit 1; done'

# Browser smoke test (tests/e2e, P1-7): log in, Mail, Calendar, Files show the
# demo data. Starts the stack if needed. Playwright runs in its own image (same
# version as tests/e2e/package.json) on the host network, against
# http://localhost:$ATRIUM_PORT (or ATRIUM_URL). Not part of `make test`: it
# needs the seeded stack and a browser image (~2 GB).
PLAYWRIGHT_IMAGE = mcr.microsoft.com/playwright:v1.49.1-noble
test-e2e:
	$(COMPOSE) up -d --wait web
	docker run --rm --network host --user $(ATRIUM_UID):$(ATRIUM_GID) -e HOME=/tmp \
		-e ATRIUM_PORT=$${ATRIUM_PORT:-8092} -e ATRIUM_URL -e ATRIUM_E2E_USER -e ATRIUM_E2E_PASSWORD \
		-v $(CURDIR)/tests/e2e:/e2e -w /e2e $(PLAYWRIGHT_IMAGE) \
		sh -c 'npm ci --no-audit --no-fund --loglevel=error && npx playwright test'

vendor-bin/phpunit/vendor:
	$(COMPOSE) run --rm -T composer composer install --no-interaction --no-progress -d vendor-bin/phpunit

phpunit-nextcloud: vendor-bin/phpunit/vendor
	$(COMPOSE) up -d --wait php
	$(TESTI) $(PHPUNIT) -c tests/phpunit-autotest.xml

# --------------------------------------------------------------------- lint

lint:
	$(BUN) sh -c 'sh deploy/dev/deps.sh && cd core/web && bun --bun node_modules/.bin/tsc -p tsconfig.json --noEmit && bun --bun node_modules/.bin/tsc -p ../../server/tsconfig.json --noEmit'
	$(COMPOSE) run --rm -T --no-deps --entrypoint sh php -c '\
		find $(PHP_LINT_DIRS) -name "*.php" -not -path "*/vendor/*" -print0 | xargs -0 -n1 -P4 php -l >/dev/null'
	$(BUN) sh -c 'for f in deploy/*.sh deploy/dev/*.sh deploy/test/*.sh night.sh; do [ ! -f "$$f" ] || bash -n "$$f" || exit 1; done'

# --------------------------------------------------------------------- build

build:
	$(BUN) sh -c 'sh deploy/dev/deps.sh && bun build/atrium/web-build.ts'

image:
	bash deploy/build.sh

#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Atrium contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Demo instance for trying Atrium by hand (fake data only, rule A1/A2):
#   ATRIUM_PORT=8300 COMPOSE_PROJECT_NAME=atrium-v1 sh deploy/dev/demo.sh
# Starts the dev stack, then:
#   - an instance AI provider "IA de démo" (the mock provider, model "demo":
#     keyword answers, no real model, no key);
#   - mail classification on, demo mail classified;
#   - alice's morning digest on, with the AI summary;
#   - an agent "Mon assistant" for alice (mail, calendar, tasks, notes;
#     sending and deleting need her approval).
# Run it again any time: it skips what is already there.
set -eu
port=${ATRIUM_PORT:-8092}
base="http://127.0.0.1:$port"
dc() { docker compose "$@"; }
say() { printf '\n== %s\n' "$*"; }

say "Starting the stack on port $port (first start: several minutes)"
dc up -d --wait

json() { curl -fsS -H 'OCS-APIRequest: true' -H 'Content-Type: application/json' "$@"; }

say "AI provider for the demo"
if json -u admin:admin-demo-pass "$base/agent/v1/ai/settings" | grep -q '"label":"IA de démo"'; then
	echo "already there"
else
	json -u admin:admin-demo-pass -X POST "$base/agent/v1/ai/providers" \
		-d '{"scope":"instance","label":"IA de démo","kind":"mock","defaultModel":"demo"}' >/dev/null
	echo "added"
fi

say "Classifying the demo mail"
dc exec -T php php occ config:app:set mail triage_enabled --value=true --type=boolean >/dev/null
dc exec -T php php -r '
require "/var/www/html/lib/base.php";
$t = \OCP\Server::get(\OCA\Mail\Service\Triage\TriageService::class);
$r = $t->run(time() + 120);
echo json_encode($r ?? ["busy" => true]), "\n";
'

say "Morning digest for alice"
json -u alice:alice-demo-pass -X PUT "$base/agent/v1/digest/settings" -d '{"enabled":true,"time":"07:30","ai":true}' >/dev/null
json -u alice:alice-demo-pass -X POST "$base/agent/v1/digest/refresh" | head -c 200; echo

say "An agent for alice"
if json -u alice:alice-demo-pass "$base/agent/v1/owner/agents" | grep -q 'Mon assistant'; then
	echo "already there"
else
	json -u alice:alice-demo-pass -X POST "$base/agent/v1/owner/agents" -d '{
		"name": "Mon assistant", "description": "Agent de démonstration",
		"access": {
			"mail": {"read": "allowed", "write": "allowed", "send": "approval", "delete": "approval"},
			"calendar": {"read": "allowed", "write": "allowed", "delete": "approval"},
			"tasks": {"read": "allowed", "write": "allowed", "delete": "approval"},
			"notes": {"read": "allowed", "write": "allowed", "delete": "approval"}
		}
	}' >/dev/null && echo "added (its token is shown in Settings > Agents)"
fi

say "Ready: $base  (alice / alice-demo-pass, bob / bob-demo-pass, admin / admin-demo-pass)"

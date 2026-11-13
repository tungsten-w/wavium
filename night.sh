#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Atrium contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Night run (PLAN.md section D.3): start N "chef" Claude instances, each on its
# own task, in its own git worktree and its own containers.
#
#   ./night.sh 3                 3 instances on the first 3 free tasks of TASKS.md
#   ./night.sh 1 P1-4            one instance on a given task
#   ./night.sh --dry-run 3       show what would start
#   ./night.sh --stop            stop every night container
#
# Per instance (task <ID>):
#   - worktree ../atrium-<ID> on branch night/<ID> (from main);
#   - container atrium-night-<ID>-dind (docker:dind, privileged, own storage):
#     the instance's Docker, so `make test` runs its own dev stack; iptables in
#     its network namespace refuse the local network (deploy/night/dind-entry.sh);
#   - container atrium-night-<ID>: Claude Code (binary mounted read-only from
#     the host), sharing the dind network namespace (so the same LAN block
#     applies), with CPU/RAM limits; permission prompts are skipped ONLY here;
#   - stopped after NIGHT_HOURS (default 3) or NIGHT_MAX_TURNS (default 400);
#     log in logs/<ID>.log.
# Nothing is merged, pushed or deployed: merging stays human (PLAN.md C).
#
# Auth for Claude inside the container, first found wins:
#   CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`, uses the subscription),
#   ANTHROPIC_API_KEY, or NIGHT_COPY_CREDENTIALS=1 to copy ~/.claude/.credentials.json
#   (not the default: a token refresh inside the container may log the host out).
# No Atrium AI key is ever passed: the dev stack uses the mock provider.
set -euo pipefail

repo=$(cd "$(dirname "$0")" && pwd)
parent=$(dirname "$repo")
hours=${NIGHT_HOURS:-3}
turns=${NIGHT_MAX_TURNS:-400}
cpus=${NIGHT_CPUS:-1.5}
mem=${NIGHT_MEM:-4g}
dry=0
docker=${DOCKER:-docker}

die() { echo "night: $*" >&2; exit 1; }

if [ "${1:-}" = --stop ]; then
	ids=$($docker ps -aq --filter name=atrium-night-)
	[ -z "$ids" ] || $docker rm -f $ids
	exit 0
fi
if [ "${1:-}" = --dry-run ]; then dry=1; shift; fi
n=${1:-1}
only=${2:-}
[[ "$n" =~ ^[0-9]+$ ]] && [ "$n" -ge 1 ] && [ "$n" -le 5 ] || die "N must be 1..5"

# ---------------------------------------------------------------- pick tasks
# Free tasks: "- [ ] <ID> ..." whose "deps: A, B" are all [x].
done_ids=$(grep -oE '^- \[x\] [A-Z0-9]+-[0-9]+' "$repo/TASKS.md" | awk '{print $3}')
pick() {
	grep -E '^- \[ \] [A-Z0-9]+-[0-9]+' "$repo/TASKS.md" | while read -r line; do
		id=$(echo "$line" | awk '{print $4}')
		deps=$(echo "$line" | sed -n 's/.*deps: //p' | tr ',' '\n' | grep -oE '[A-Z0-9]+-[0-9]+' || true)
		ok=1
		for d in $deps; do echo "$done_ids" | grep -qx "$d" || ok=0; done
		# P3-6 style ranges ("P3-1..P3-5") are checked by the chef itself.
		if [ $ok = 1 ]; then echo "$id"; fi
	done
}
if [ -n "$only" ]; then tasks=$only; else tasks=$(pick | head -n "$n" || true); fi
[ -n "$tasks" ] || die "no free task in TASKS.md"

# ---------------------------------------------------------------- auth
auth=()
if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
	auth=(-e CLAUDE_CODE_OAUTH_TOKEN)
elif [ -n "${ANTHROPIC_API_KEY:-}" ]; then
	auth=(-e ANTHROPIC_API_KEY)
elif [ "${NIGHT_COPY_CREDENTIALS:-0}" = 1 ] && [ -f "$HOME/.claude/.credentials.json" ]; then
	auth=(copy)
else
	[ $dry = 1 ] || die "no Claude auth: set CLAUDE_CODE_OAUTH_TOKEN (claude setup-token) or ANTHROPIC_API_KEY"
fi
claude_bin=$(readlink -f "$(command -v claude)") || die "claude not found on the host"

prompt() {
	cat <<EOF
Tu es le chef de l'équipe Atrium (voir .claude/agents/chef.md). Ta tâche cette nuit : $1.
Lis d'abord CLAUDE.md, AGENTS.md (les règles de la section A passent avant tout), TASKS.md et PLAN.md.
Tu es déjà dans ton worktree, sur la branche night/$1. Docker = ta sidecar (DOCKER_HOST), la stack de dev se lance avec make up.
Mène la tâche avec l'équipe (dev, testeur, relecteur, doc), écris reports/$1.md et une entrée dans docs/agents-journal.md, commite sur ta branche.
Ne fusionne pas, ne pousse pas, ne déploie rien.
EOF
}

mkdir -p "$repo/logs"
[ $dry = 1 ] || $docker build -q -t atrium-night-agent:dev --build-arg UID="$(id -u)" --build-arg GID="$(id -g)" \
	-f "$repo/deploy/night/agent.Dockerfile" "$repo/deploy/night" >/dev/null

for id in $tasks; do
	wt="$parent/atrium-$id"
	name="atrium-night-$(echo "$id" | tr 'A-Z' 'a-z')"
	echo "night: $id -> $wt ($name, ${hours}h, $cpus cpus, $mem)"
	[ $dry = 1 ] && continue

	if [ ! -d "$wt" ]; then
		if git -C "$repo" show-ref -q "refs/heads/night/$id"; then
			git -C "$repo" worktree add "$wt" "night/$id"
		else
			git -C "$repo" worktree add "$wt" -b "night/$id" main
		fi
	fi

	$docker rm -f "$name" "$name-dind" >/dev/null 2>&1 || true
	$docker run -d --name "$name-dind" --privileged \
		--cpus "$cpus" --memory "$mem" \
		-e DOCKER_TLS_CERTDIR= \
		-v "$name-docker:/var/lib/docker" \
		-v "$repo/deploy/night/dind-entry.sh:/night-entry.sh:ro" \
		-v "$wt:/work" \
		--entrypoint sh docker:29.0.2-dind /night-entry.sh \
		dockerd --host=unix:///var/run/docker.sock --host=tcp://127.0.0.1:2375 --tls=false >/dev/null

	home_mount=()
	if [ "${auth[0]:-}" = copy ]; then
		h="$repo/logs/.home-$id"; mkdir -p "$h/.claude"; cp "$HOME/.claude/.credentials.json" "$h/.claude/"
		chmod 700 "$h"; home_mount=(-v "$h:/home/agent")
		auth=()
	fi

	$docker run -d --name "$name" --network "container:$name-dind" \
		--cpus "$cpus" --memory "$mem" --pids-limit 2048 \
		-e DOCKER_HOST=tcp://127.0.0.1:2375 -e ATRIUM_UID="$(id -u)" -e ATRIUM_GID="$(id -g)" \
		-e COMPOSE_PROJECT_NAME="atrium-$(echo "$id" | tr 'A-Z' 'a-z')" \
		"${auth[@]}" "${home_mount[@]}" \
		-v "$claude_bin:/usr/local/bin/claude:ro" \
		-v "$wt:/work" -v "$repo/.git:$repo/.git" \
		atrium-night-agent:dev \
		timeout "${hours}h" claude -p "$(prompt "$id")" \
			--dangerously-skip-permissions --max-turns "$turns" \
			--output-format stream-json --verbose >/dev/null
	# Log follows the container until it exits.
	( $docker logs -f "$name" >"$repo/logs/$id.log" 2>&1; \
	  echo "night: $id exited $($docker inspect -f '{{.State.ExitCode}}' "$name")" >>"$repo/logs/$id.log"; \
	  $docker rm -f "$name-dind" >/dev/null 2>&1 ) &
done
[ $dry = 1 ] || echo "night: started. Logs in logs/<ID>.log, stop with ./night.sh --stop"

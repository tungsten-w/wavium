#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Wavium contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Lets an agent that runs OUTSIDE Wavium answer the messages its owner types
# inside Wavium (V4-39; server side: server/agent/chat).
#
# Wavium cannot reach into this machine: the app containers have no route in,
# and an agent on a personal Claude subscription holds credentials that have no
# business inside a container. So the agent asks rather than being told. This
# loop polls, and only when something is waiting does it start a real run and
# post the answer back.
#
# It speaks the plain-text side of the chat API, so it needs nothing but curl:
#   GET  /agent/v1/chat/-/pending   the waiting messages (and marks them taken)
#   POST /agent/v1/chat/-/say       the body is what the agent says
#
# Install (nothing here installs itself):
#   WAVIUM_URL=https://wavium.example:8443 \
#   WAVIUM_AGENT_TOKEN_FILE=$HOME/claude-mail/token \
#   WAVIUM_AGENT=claude-mail \
#   services/agentchat/chat-loop.sh
# Under `systemd --user`, or from cron with @reboot. One at a time: it takes a
# lock and leaves quietly if another copy holds it.
#
# It never deletes anything, never sends mail, and writes only its own files
# (lock, session id, log) under WAVIUM_CHAT_DIR.
set -uo pipefail

URL=${WAVIUM_URL:?set WAVIUM_URL, e.g. https://wavium.example:8443}
AGENT=${WAVIUM_AGENT:-claude-mail}
TOKEN_FILE=${WAVIUM_AGENT_TOKEN_FILE:?set WAVIUM_AGENT_TOKEN_FILE (a file holding the agent token)}
DIR=${WAVIUM_CHAT_DIR:-$HOME/.wavium-chat/$AGENT}
EVERY=${WAVIUM_CHAT_EVERY:-10}
# A run must have time to read mail and think; brief.sh uses the same budget.
RUN_TIMEOUT=${WAVIUM_CHAT_TIMEOUT:-900}
# A poll is a tiny request and must never hang the loop.
POLL_TIMEOUT=${WAVIUM_CHAT_POLL_TIMEOUT:-20}
# 1 = answer at most one batch and exit (a cron line, or a test).
ONCE=${WAVIUM_CHAT_ONCE:-0}
CLAUDE_BIN=${CLAUDE_BIN:-$(command -v claude 2>/dev/null)}
CLAUDE_BIN=${CLAUDE_BIN:-$HOME/.npm-global/bin/claude}
# Extra curl options, e.g. --cacert for a private CA. Never put the token here.
CURL_OPTS=${WAVIUM_CURL_OPTS:-}

mkdir -p "$DIR" || exit 1
LOG=$DIR/chat.log
SESSION_FILE=$DIR/session
log() { printf '%s %s\n' "$(date '+%F %T')" "$*" >> "$LOG"; }

[ -r "$TOKEN_FILE" ] || { log "FATAL token file unreadable: $TOKEN_FILE"; exit 1; }

# One loop at a time. chat_poll already hands a message to one caller only, so
# this is about not running two Claude sessions for the same work.
exec 9> "$DIR/loop.lock"
if ! flock -n 9; then
  log "another loop holds the lock, leaving"
  exit 0
fi
trap 'rm -f "$DIR/out" "$DIR/in"' EXIT

# The token is read per call and never appears on a command line (ps shows those).
auth() { printf 'Authorization: Bearer %s' "$(cat "$TOKEN_FILE")"; }

# Waiting messages on stdout; non-zero when the call itself failed.
pending() {
  # shellcheck disable=SC2086
  curl -fsS --max-time "$POLL_TIMEOUT" $CURL_OPTS -H "$(auth)" "$URL/agent/v1/chat/-/pending"
}

say() {
  printf '%s' "$1" > "$DIR/out"
  # shellcheck disable=SC2086
  if ! curl -fsS --max-time "$POLL_TIMEOUT" $CURL_OPTS -H "$(auth)" \
      -H 'Content-Type: text/plain; charset=utf-8' \
      --data-binary "@$DIR/out" "$URL/agent/v1/chat/-/say" > /dev/null; then
    log "WARN could not say it back"
  fi
  rm -f "$DIR/out"
}

answer() {
  local asked=$1 out rc session resume
  session=$(cat "$SESSION_FILE" 2>/dev/null)
  if [ -n "$session" ]; then
    resume=(--resume "$session")
  else
    session=$(cat /proc/sys/kernel/random/uuid)
    resume=(--session-id "$session")
  fi
  {
    echo "Your owner wrote to you in Wavium. Answer them, and do what they ask with your tools."
    echo "Your reply goes straight into their chat panel: no preamble, no headings, just the answer."
    echo
    printf '%s\n' "$asked"
  } > "$DIR/in"
  out=$(timeout "$RUN_TIMEOUT" "$CLAUDE_BIN" -p "${resume[@]}" --agent "$AGENT" < "$DIR/in" 2>>"$LOG")
  rc=$?
  rm -f "$DIR/in"
  if [ "$rc" -eq 0 ] && [ -n "$out" ]; then
    printf '%s' "$session" > "$SESSION_FILE"
    say "$out"
    log "answered (${#out} chars)"
    return 0
  fi
  # A failure has to reach the person waiting, not just this log: that is the
  # lesson of the brief that died silently under cron (V4-25).
  if [ "$rc" -eq 124 ]; then
    say "I could not finish in time (${RUN_TIMEOUT}s). Ask me again, or in smaller pieces."
    log "FAIL timeout"
  else
    say "I could not answer just now (error $rc). The log is $LOG on the machine I run on."
    log "FAIL rc=$rc"
    # One broken session must not break every message after it.
    rm -f "$SESSION_FILE"
  fi
  return 1
}

log "up for $AGENT at $URL (every ${EVERY}s, once=$ONCE)"
while :; do
  if asked=$(pending); then
    if [ -n "$asked" ]; then
      log "picked up $(printf '%s' "$asked" | grep -c '' ) line(s)"
      answer "$asked"
    fi
  else
    log "WARN pending failed"
  fi
  [ "$ONCE" = 1 ] && break
  sleep "$EVERY"
done

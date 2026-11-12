#!/usr/bin/env bash
# Render the Dashboard calendar widget in a real (headless) Chromium and print layout measurements.
#   tests/layout/shot.sh <name> <query> <width> <height>
#   e.g. tests/layout/shot.sh oct "now=2026-10-03T12:00:00" 1000 760   (writes tests/layout/out/oct.png)
# Needs `nix-shell` (Chromium comes from nixpkgs) and the built js/ + css/ (npm run build).
# Starts its own server on 127.0.0.1:8765 for the call (EMPTY=1 for "nothing recorded").
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$here/out"
node "$here/server.js" >/dev/null 2>&1 & server=$!
trap 'kill $server 2>/dev/null' EXIT
sleep 1
url="http://127.0.0.1:8765/harness.html?$2"
common="--headless=new --no-sandbox --disable-gpu --virtual-time-budget=4000 --window-size=$3,$4"
nix-shell -p chromium --run "chromium $common --hide-scrollbars --screenshot=$here/out/$1.png '$url' >/dev/null 2>&1"
nix-shell -p chromium --run "chromium $common --dump-dom '$url' 2>/dev/null" | grep -o '<pre id="metrics">[^<]*' | sed 's/<pre id="metrics">//'

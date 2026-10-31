#!/usr/bin/env bash
# The vision service for the demo, in one command (Git Bash): Unity's camera channel (CctvLive, simulated detector, D0) ->
# flow.report with forecast, crowd.positions and evac.plan, as client=vision.
#   DEMO_TOKEN=... ./run_live.sh                        local worker, http://127.0.0.1:8788
#   CLARION_URL=https://... DEMO_TOKEN=... ./run_live.sh  another backend
# Extra arguments go to the service (--no-ml, --live-dir DIR, --source yolo --hybrid). The token comes only from the env and
# never reaches the log. The log is in runs/live_<time>.log. Ctrl+C stops it.
set -uo pipefail
cd "$(dirname "$0")"
ENV="${CRAIOVA_ML_ENV:-$HOME/miniforge3/envs/craiova-ml}"
if [ ! -x "$ENV/python.exe" ] && [ ! -x "$ENV/bin/python" ]; then
  echo "no Python env at $ENV (set CRAIOVA_ML_ENV)" >&2
  exit 1
fi
# Without Library/bin on PATH, numpy stops with 0xc06d007f at the first matrix product.
export PATH="$ENV:$ENV/Library/bin:$ENV/Scripts:$ENV/bin:$PATH" PYTHONPATH=. PYTHONUNBUFFERED=1 PYTHONIOENCODING=utf-8
export CLARION_URL="${CLARION_URL:-http://127.0.0.1:8788}"
[ -n "${DEMO_TOKEN:-}" ] || echo "warning: DEMO_TOKEN is not set; a backend with a token refuses the socket" >&2
mkdir -p runs
log="runs/live_$(date +%H%M%S).log"
echo "vision -> $CLARION_URL, cameras from ${CLARION_CCTV_LIVE:-../../craiova-3d-model/data/interim/cctv_live}, log $log"
python -m clarion_vision.service --source live "$@" 2>&1 | tee "$log"

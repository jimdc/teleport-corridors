#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-8000}"
GTFS="${GTFS:-data/raw/subway_gtfs.zip}"
NEIGHBORHOODS="${NEIGHBORHOODS:-data/raw/neighborhoods.geojson}"

if [[ ! -f "$GTFS" || ! -f "$NEIGHBORHOODS" ]]; then
  echo "Missing inputs:"
  [[ -f "$GTFS" ]] || echo "  - $GTFS"
  [[ -f "$NEIGHBORHOODS" ]] || echo "  - $NEIGHBORHOODS"
  echo ""
  echo "Attempting to download them now via tools/download_inputs.py ..."
  python3 tools/download_inputs.py
  echo ""
fi

python3 tools/run_local.py \
  --gtfs "$GTFS" \
  --neighborhoods "$NEIGHBORHOODS" \
  --port "$PORT"


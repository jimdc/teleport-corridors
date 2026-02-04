#!/usr/bin/env bash
set -euo pipefail

GTFS="${GTFS:-data/raw/subway_gtfs.zip}"
NEIGHBORHOODS="${NEIGHBORHOODS:-data/raw/neighborhoods.geojson}"
OUT="${OUT:-site/data}"

if [[ ! -f "$GTFS" || ! -f "$NEIGHBORHOODS" ]]; then
  echo "Missing inputs:"
  [[ -f "$GTFS" ]] || echo "  - $GTFS"
  [[ -f "$NEIGHBORHOODS" ]] || echo "  - $NEIGHBORHOODS"
  echo ""
  echo "Attempting to download them now via tools/download_inputs.py ..."
  python3 tools/download_inputs.py
  echo ""
fi

python3 tools/build_matrix.py \
  --gtfs "$GTFS" \
  --neighborhoods "$NEIGHBORHOODS" \
  --out "$OUT"

echo "Built data into $OUT"


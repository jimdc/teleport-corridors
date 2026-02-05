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

if [[ -f "data/raw/scalars_population.csv" ]]; then
  cp "data/raw/scalars_population.csv" "$OUT/scalars_population.csv"
fi

python3 tools/build_derived.py \
  --neighborhoods "$NEIGHBORHOODS" \
  --graph "$OUT/graph_weekday_am.json" \
  --matrix-dir "$OUT" \
  --out "$OUT"

echo "Built data into $OUT"

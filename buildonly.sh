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

for key in population housing_units jobs; do
  if [[ -f "data/raw/scalars_${key}.csv" ]]; then
    cp "data/raw/scalars_${key}.csv" "$OUT/scalars_${key}.csv"
  fi
done

python3 - <<'PY'
import glob
import json
import os

out = os.environ.get("OUT", "site/data")
keys = []
for path in glob.glob(os.path.join(out, "scalars_*.csv")):
    base = os.path.basename(path)
    key = base.replace("scalars_", "").replace(".csv", "")
    if key:
        keys.append(key)
manifest = {"keys": sorted(set(keys))}
with open(os.path.join(out, "scalars_manifest.json"), "w", encoding="utf-8") as f:
    json.dump(manifest, f)
PY

python3 tools/build_derived.py \
  --neighborhoods "$NEIGHBORHOODS" \
  --graph "$OUT/graph_weekday_am.json" \
  --matrix-dir "$OUT" \
  --out "$OUT"

echo "Built data into $OUT"

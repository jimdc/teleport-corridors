#!/usr/bin/env python3

import argparse
import csv
import json
from pathlib import Path
from typing import Dict, Iterable, Optional


ID_CANDIDATES = [
    "atlas_id",
    "nta2020",
    "ntacode",
    "nta",
    "cdta2020",
    "cdta",
    "ntaname",
    "name",
    "neighborhood",
    "id",
]


VALUE_CANDIDATES = [
    "value",
    "population",
    "pop",
    "housing_units",
    "housingunits",
    "jobs",
    "employment",
    "total_jobs",
    "count",
    "estimate",
]


def pick_column(fieldnames: Iterable[str], candidates: Iterable[str]) -> Optional[str]:
    lower = {name.lower(): name for name in fieldnames}
    for c in candidates:
        if c.lower() in lower:
            return lower[c.lower()]
    return None


def load_geo(path: Path) -> Dict[str, str]:
    if not path.exists():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    features = data.get("features") or []
    out: Dict[str, str] = {}
    for feat in features:
        props = feat.get("properties") or {}
        atlas_id = (
            props.get("atlas_id")
            or props.get("nta2020")
            or props.get("cdta2020")
            or props.get("id")
            or props.get("gid")
        )
        if not atlas_id:
            continue
        atlas_id = str(atlas_id).strip()
        keys = [
            atlas_id,
            props.get("nta2020"),
            props.get("cdta2020"),
            props.get("ntaname"),
            props.get("name"),
            props.get("label"),
        ]
        for k in keys:
            if not k:
                continue
            val = str(k).strip()
            out[val] = atlas_id
            out[val.lower()] = atlas_id
    return out


def parse_number(value: str) -> Optional[float]:
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None
    try:
        return float(s.replace(",", ""))
    except ValueError:
        return None


def main() -> int:
    ap = argparse.ArgumentParser(description="Normalize a scalar CSV into data/raw/scalars_<key>.csv")
    ap.add_argument("--input", required=True, help="Path to source CSV")
    ap.add_argument("--key", required=True, help="Scalar key (e.g. housing_units, jobs)")
    ap.add_argument("--out", help="Output CSV path (default: data/raw/scalars_<key>.csv)")
    ap.add_argument("--id-column", help="Column name containing neighborhood id or name")
    ap.add_argument("--value-column", help="Column name containing the scalar value")
    ap.add_argument(
        "--neighborhoods",
        default="data/raw/neighborhoods.geojson",
        help="Neighborhoods GeoJSON used to map ids (default: data/raw/neighborhoods.geojson)",
    )
    args = ap.parse_args()

    input_path = Path(args.input)
    if not input_path.exists():
        print(f"Input CSV not found: {input_path}")
        return 2

    out_path = Path(args.out) if args.out else Path("data/raw") / f"scalars_{args.key}.csv"
    out_path.parent.mkdir(parents=True, exist_ok=True)

    id_map = load_geo(Path(args.neighborhoods))

    with input_path.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        if not reader.fieldnames:
            print("Input CSV has no header row.")
            return 2
        id_col = args.id_column or pick_column(reader.fieldnames, ID_CANDIDATES)
        val_col = args.value_column or pick_column(reader.fieldnames, VALUE_CANDIDATES + [args.key])
        if not id_col or not val_col:
            print("Could not detect id/value columns.")
            print(f"Available columns: {reader.fieldnames}")
            print(f"Detected id: {id_col} value: {val_col}")
            return 2

        rows = []
        missing = 0
        for row in reader:
            raw_id = (row.get(id_col) or "").strip()
            if not raw_id:
                continue
            mapped = id_map.get(raw_id) or id_map.get(raw_id.lower()) or raw_id
            value = parse_number(row.get(val_col) or "")
            if value is None:
                continue
            if mapped not in id_map.values() and mapped == raw_id:
                missing += 1
            rows.append({"atlas_id": mapped, "value": value})

    if not rows:
        print("No rows were parsed; check your id/value columns.")
        return 2

    with out_path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["atlas_id", "value"])
        writer.writeheader()
        writer.writerows(rows)

    if missing:
        print(f"Warning: {missing} rows could not be matched to known atlas_ids.")
    print(f"Wrote {len(rows)} rows to {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

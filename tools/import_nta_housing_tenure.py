#!/usr/bin/env python3

import argparse
import json
import urllib.parse
import urllib.request
from pathlib import Path


SERVICE_URL = "https://services.arcgis.com/pGfbNJoYypmNq86F/ArcGIS/rest/services/NYC_NTA_Housing_Tenure/FeatureServer/0/query"


def fetch_rows() -> list[dict]:
    params = {
        "where": "1=1",
        "outFields": "NTA2020,Total_Housing_Units,Populations",
        "returnGeometry": "false",
        "f": "json",
    }
    url = f"{SERVICE_URL}?{urllib.parse.urlencode(params)}"
    with urllib.request.urlopen(url) as resp:
        data = json.load(resp)
    rows = []
    for feat in data.get("features", []):
        attrs = feat.get("attributes") or {}
        rows.append(attrs)
    return rows


def write_csv(path: Path, rows: list[dict], id_key: str, value_key: str, value_label: str) -> int:
    import csv

    path.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["atlas_id", value_label])
        writer.writeheader()
        for row in rows:
            atlas_id = row.get(id_key)
            value = row.get(value_key)
            if atlas_id is None or value is None:
                continue
            writer.writerow({"atlas_id": atlas_id, value_label: value})
            count += 1
    return count


def main() -> int:
    ap = argparse.ArgumentParser(description="Download NTA2020 housing tenure scalars (population + housing units).")
    ap.add_argument("--out-dir", default="data/raw", help="Output directory (default: data/raw)")
    args = ap.parse_args()

    rows = fetch_rows()
    if not rows:
        print("No rows returned from the housing tenure service.")
        return 2

    out_dir = Path(args.out_dir)
    pop_count = write_csv(out_dir / "scalars_population.csv", rows, "NTA2020", "Populations", "population")
    hu_count = write_csv(out_dir / "scalars_housing_units.csv", rows, "NTA2020", "Total_Housing_Units", "housing_units")

    print(f"Wrote {pop_count} population rows and {hu_count} housing-unit rows to {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

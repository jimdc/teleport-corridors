#!/usr/bin/env python3

import argparse
import csv
import gzip
import io
import json
import math
import sys
import urllib.request
from pathlib import Path


LODES_VERSION = "LODES8"
STATE = "ny"
NYC_COUNTIES = {"36005", "36047", "36061", "36081", "36085"}


def download(url: str) -> bytes:
    with urllib.request.urlopen(url) as resp:
        return resp.read()


def url_exists(url: str) -> bool:
    req = urllib.request.Request(url, method="HEAD")
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status == 200
    except Exception:
        pass
    try:
        req = urllib.request.Request(url)
        req.add_header("Range", "bytes=0-1")
        with urllib.request.urlopen(req) as resp:
            return resp.status in (200, 206)
    except Exception:
        return False


def resolve_wac_url(year: int | None) -> tuple[str, int]:
    if year:
        url = f"https://lehd.ces.census.gov/data/lodes/{LODES_VERSION}/{STATE}/wac/{STATE}_wac_S000_JT00_{year}.csv.gz"
        return url, year
    for y in range(2022, 2016, -1):
        url = f"https://lehd.ces.census.gov/data/lodes/{LODES_VERSION}/{STATE}/wac/{STATE}_wac_S000_JT00_{y}.csv.gz"
        if url_exists(url):
            return url, y
    raise RuntimeError("Could not resolve a LODES WAC file for NY.")


def load_crosswalk() -> dict[str, tuple[float, float]]:
    url = f"https://lehd.ces.census.gov/data/lodes/{LODES_VERSION}/{STATE}/{STATE}_xwalk.csv.gz"
    blob = download(url)
    text = gzip.decompress(blob).decode("utf-8")
    reader = csv.DictReader(io.StringIO(text))
    out: dict[str, tuple[float, float]] = {}
    for row in reader:
        cty = row.get("cty")
        if cty not in NYC_COUNTIES:
            continue
        block = row.get("tabblk2020")
        if not block:
            continue
        try:
            lat = float(row.get("blklatdd") or "")
            lon = float(row.get("blklondd") or "")
        except ValueError:
            continue
        out[block] = (lon, lat)
    return out


def point_in_ring(x: float, y: float, ring: list[list[float]]) -> bool:
    inside = False
    n = len(ring)
    if n < 3:
        return False
    j = n - 1
    for i in range(n):
        xi, yi = ring[i]
        xj, yj = ring[j]
        intersect = (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi
        if intersect:
            inside = not inside
        j = i
    return inside


def point_in_polygon(x: float, y: float, poly: list[list[list[float]]]) -> bool:
    if not poly:
        return False
    if not point_in_ring(x, y, poly[0]):
        return False
    for hole in poly[1:]:
        if point_in_ring(x, y, hole):
            return False
    return True


def point_in_geometry(x: float, y: float, geom: dict) -> bool:
    if not geom:
        return False
    if geom["type"] == "Polygon":
        return point_in_polygon(x, y, geom["coordinates"])
    if geom["type"] == "MultiPolygon":
        for poly in geom["coordinates"]:
            if point_in_polygon(x, y, poly):
                return True
    return False


def load_nta_polys(path: Path) -> list[dict]:
    data = json.loads(path.read_text(encoding="utf-8"))
    out = []
    for feat in data.get("features", []):
        props = feat.get("properties") or {}
        nta = props.get("nta2020") or props.get("cdta2020") or props.get("atlas_id")
        if not nta:
            continue
        geom = feat.get("geometry")
        if not geom:
            continue
        # bounding box
        coords = []
        if geom["type"] == "Polygon":
            coords = geom["coordinates"][0]
        elif geom["type"] == "MultiPolygon":
            coords = geom["coordinates"][0][0]
        if not coords:
            continue
        xs = [c[0] for c in coords]
        ys = [c[1] for c in coords]
        bbox = (min(xs), min(ys), max(xs), max(ys))
        out.append({"id": str(nta), "geom": geom, "bbox": bbox})
    return out


def assign_block_to_nta(lon: float, lat: float, nta_polys: list[dict]) -> str | None:
    for nta in nta_polys:
        minx, miny, maxx, maxy = nta["bbox"]
        if lon < minx or lon > maxx or lat < miny or lat > maxy:
            continue
        if point_in_geometry(lon, lat, nta["geom"]):
            return nta["id"]
    return None


def main() -> int:
    ap = argparse.ArgumentParser(description="Import LODES WAC jobs and aggregate to NTA2020.")
    ap.add_argument("--year", type=int, help="LODES year (default: latest available)")
    ap.add_argument("--neighborhoods", default="data/raw/neighborhoods.geojson", help="NTA GeoJSON path")
    ap.add_argument("--out", default="data/raw/scalars_jobs.csv", help="Output CSV path")
    args = ap.parse_args()

    nta_polys = load_nta_polys(Path(args.neighborhoods))
    if not nta_polys:
        print("No NTA polygons found.")
        return 2

    crosswalk = load_crosswalk()
    if not crosswalk:
        print("No NYC blocks found in crosswalk.")
        return 2

    print(f"Loaded {len(crosswalk)} NYC blocks from LODES crosswalk.")
    url, year = resolve_wac_url(args.year)
    print(f"Downloading LODES WAC {year} from {url}")
    blob = download(url)
    text = gzip.decompress(blob).decode("utf-8")
    reader = csv.DictReader(io.StringIO(text))

    jobs_by_nta: dict[str, float] = {}
    missing = 0
    for row in reader:
        block = row.get("w_geocode") or row.get("w_geocode20") or row.get("w_geocode")  # keep simple
        if not block:
            continue
        coords = crosswalk.get(block)
        if not coords:
            missing += 1
            continue
        lon, lat = coords
        nta = assign_block_to_nta(lon, lat, nta_polys)
        if not nta:
            continue
        try:
            jobs = float(row.get("C000") or 0)
        except ValueError:
            jobs = 0
        jobs_by_nta[nta] = jobs_by_nta.get(nta, 0) + jobs

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["atlas_id", "jobs"])
        writer.writeheader()
        for nta, jobs in sorted(jobs_by_nta.items()):
            writer.writerow({"atlas_id": nta, "jobs": int(round(jobs))})

    print(f"Wrote {len(jobs_by_nta)} NTA rows to {out_path}")
    if missing:
        print(f"Warning: {missing} workplace blocks not found in crosswalk.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3

import argparse
import json
import sys
import urllib.error
import urllib.request
import zipfile
from pathlib import Path


GTFS_CANDIDATES = [
    # Widely-referenced current static feed mirror
    "https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip",
    # Historic MTA developer URL (often still works)
    "http://web.mta.info/developers/data/nyct/subway/google_transit.zip",
]

NEIGHBORHOODS_CANDIDATES = [
    # NYC Open Data (Socrata) commonly exposes GeoJSON at /resource/<id>.geojson
    "https://data.cityofnewyork.us/resource/9nt8-h7nd.geojson?$limit=50000",
    # Older NTA boundary dataset (2010 vintage)
    "https://data.cityofnewyork.us/resource/cpf4-rkhq.geojson?$limit=50000",
]


def download(url: str, dest: Path, timeout: int) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "nyc-transit-atlas/0.1 (+https://github.com/)",
            "Accept": "*/*",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        tmp = dest.with_suffix(dest.suffix + ".part")
        with tmp.open("wb") as f:
            while True:
                chunk = resp.read(1024 * 1024)
                if not chunk:
                    break
                f.write(chunk)
        tmp.replace(dest)


def validate_gtfs_zip(path: Path) -> None:
    with zipfile.ZipFile(path, "r") as zf:
        names = set(zf.namelist())
        required = {"stops.txt", "trips.txt", "stop_times.txt"}
        missing = sorted(required - names)
        if missing:
            raise RuntimeError(f"GTFS zip missing required files: {', '.join(missing)}")


def validate_geojson(path: Path) -> None:
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    if data.get("type") != "FeatureCollection":
        raise RuntimeError("Neighborhoods file is not a GeoJSON FeatureCollection")
    feats = data.get("features")
    if not isinstance(feats, list) or len(feats) < 10:
        raise RuntimeError("Neighborhoods GeoJSON has too few features (unexpected)")


def try_download(candidates: list[str], dest: Path, timeout: int, validate_fn, label: str) -> None:
    errors: list[str] = []
    for url in candidates:
        print(f"Downloading {label} from: {url}", file=sys.stderr)
        try:
            download(url, dest, timeout=timeout)
            validate_fn(dest)
            print(f"Saved {label} to {dest}", file=sys.stderr)
            return
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
            errors.append(f"{url}: {e}")
        except Exception as e:
            errors.append(f"{url}: {e}")
    raise RuntimeError(f"All download attempts failed for {label}:\n- " + "\n- ".join(errors))


def main() -> int:
    ap = argparse.ArgumentParser(description="Download GTFS + NYC neighborhoods GeoJSON into data/raw/")
    ap.add_argument("--out-dir", default="data/raw", help="Output directory (default: data/raw)")
    ap.add_argument("--timeout", type=int, default=60, help="Per-request timeout seconds (default: 60)")
    args = ap.parse_args()

    out_dir = Path(args.out_dir)
    gtfs_dest = out_dir / "subway_gtfs.zip"
    neighborhoods_dest = out_dir / "neighborhoods.geojson"

    try:
        try_download(GTFS_CANDIDATES, gtfs_dest, args.timeout, validate_gtfs_zip, "GTFS subway zip")
        try_download(
            NEIGHBORHOODS_CANDIDATES,
            neighborhoods_dest,
            args.timeout,
            validate_geojson,
            "neighborhoods GeoJSON",
        )
    except Exception as e:
        print("", file=sys.stderr)
        print("Download failed.", file=sys.stderr)
        print(str(e), file=sys.stderr)
        print("", file=sys.stderr)
        print(
            "If your network blocks these URLs, manually download the two files and place them at:",
            file=sys.stderr,
        )
        print(f"- {gtfs_dest}", file=sys.stderr)
        print(f"- {neighborhoods_dest}", file=sys.stderr)
        return 2

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

